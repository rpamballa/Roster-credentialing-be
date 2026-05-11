import { db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { FacilityRequirements } from "@cred/types";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import { PacketAssemblyError, assemblePacket } from "../services/packetAssembly.js";
import type { ApiBindings } from "../types.js";

export const packetRoutes = new Hono<ApiBindings>();

packetRoutes.use("/cockpit/*", requireStaffAuth, requireTenancy);

// POST /cockpit/cases/:caseId/packet/assemble
packetRoutes.post("/cockpit/cases/:caseId/packet/assemble", async (c) => {
  const auth = c.var.staffAuth;
  const caseId = c.req.param("caseId");
  try {
    const result = await assemblePacket({
      caseId,
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof PacketAssemblyError) {
      return c.json(
        {
          type: `https://errors.cred/packet/${err.code}`,
          title: err.message,
          status: err.code === "case_not_found" ? 404 : 409,
          instance: c.var.requestId,
        },
        err.code === "case_not_found" ? 404 : 409,
      );
    }
    throw err;
  }
});

// GET /cockpit/cases/:caseId/packet — latest packet + a signed download url
packetRoutes.get("/cockpit/cases/:caseId/packet", async (c) => {
  const caseId = c.req.param("caseId");
  const row = await withTenancy(c.var.tenancy, async (tx) => {
    const [pkt] = await tx
      .select()
      .from(schema.packets)
      .where(eq(schema.packets.caseId, caseId))
      .orderBy(desc(schema.packets.assembledAt))
      .limit(1);
    return pkt ?? null;
  });
  if (!row) {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }
  const signed = await getObjectStorage().getSignedUrl({
    key: row.fileUri,
    expiresInSeconds: 15 * 60,
  });
  return c.json({
    packetId: row.id,
    contentHash: row.contentHash,
    assembledAt: row.assembledAt,
    submittedAt: row.submittedAt,
    provenance: row.provenance,
    downloadUrl: signed.url,
    downloadExpiresAt: signed.expiresAt,
  });
});

// PROMPT M4 §6.6 — structured submission checklist gate. The cockpit must
// confirm each item before submission is enabled. We require the exact same
// keys here in the request body.
const SUBMISSION_CHECKLIST_KEYS = [
  "license_confirmed",
  "dea_confirmed",
  "board_cert_confirmed",
  "attestation_signed",
] as const;
const ChecklistSchema = z.object(
  Object.fromEntries(SUBMISSION_CHECKLIST_KEYS.map((k) => [k, z.literal(true)])) as Record<
    (typeof SUBMISSION_CHECKLIST_KEYS)[number],
    z.ZodLiteral<true>
  >,
);

const SubmitSchema = z.object({
  packetId: z.string().uuid(),
  checklist: ChecklistSchema,
  submissionMethod: z.enum(["platform", "email", "fax", "portal", "download"]).optional(),
});

packetRoutes.post(
  "/cockpit/cases/:caseId/packet/submit",
  zValidator("json", SubmitSchema),
  async (c) => {
    const auth = c.var.staffAuth;
    const caseId = c.req.param("caseId");
    const body = c.req.valid("json");

    // Verify required facility-mandated attestations are signed before
    // allowing submission. Pull current requirements + attestations.
    const blocked = await withTenancy(c.var.tenancy, async (tx) => {
      const [pkt] = await tx
        .select({ id: schema.packets.id, submittedAt: schema.packets.submittedAt })
        .from(schema.packets)
        .where(and(eq(schema.packets.id, body.packetId), eq(schema.packets.caseId, caseId)))
        .limit(1);
      if (!pkt) return { code: "packet_not_found" as const };
      if (pkt.submittedAt) return { code: "already_submitted" as const };

      const [cs] = await tx
        .select({ facilityProfileId: schema.cases.facilityProfileId })
        .from(schema.cases)
        .where(eq(schema.cases.id, caseId))
        .limit(1);
      if (!cs?.facilityProfileId) return { code: "missing_facility_profile" as const };

      const [profile] = await tx
        .select({ requirements: schema.facilityProfiles.requirements })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, cs.facilityProfileId))
        .limit(1);
      if (!profile) return { code: "missing_facility_profile" as const };
      const reqs = profile.requirements as FacilityRequirements;

      if (reqs.attestations.length > 0) {
        const completed = await tx
          .select({ status: schema.attestations.status })
          .from(schema.attestations)
          .where(eq(schema.attestations.caseId, caseId));
        const allSigned =
          completed.length >= reqs.attestations.length &&
          completed.every((a) => a.status === "completed");
        if (!allSigned) return { code: "attestations_pending" as const };
      }
      return null;
    });

    if (blocked) {
      const status = blocked.code === "packet_not_found" ? 404 : 409;
      return c.json(
        {
          type: `https://errors.cred/submission/${blocked.code}`,
          title: blocked.code.replace(/_/g, " "),
          status,
          instance: c.var.requestId,
        },
        status,
      );
    }

    await withTenancy(c.var.tenancy, async (tx) => {
      await tx
        .update(schema.packets)
        .set({ submittedAt: new Date(), submittedBy: auth.session.userId })
        .where(eq(schema.packets.id, body.packetId));
      await tx
        .update(schema.cases)
        .set({ status: "submitted", submittedAt: new Date() })
        .where(eq(schema.cases.id, caseId));
    });

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "packet.submitted",
      targetEntityType: "packet",
      targetEntityId: body.packetId,
      after: { caseId, submissionMethod: body.submissionMethod ?? "download" },
      requestId: c.var.requestId,
    });

    return c.json({ ok: true });
  },
);
