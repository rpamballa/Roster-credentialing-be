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

packetRoutes.use("/v1/cockpit/*", requireStaffAuth, requireTenancy);

// POST /cockpit/cases/:caseId/packet/assemble
packetRoutes.post("/v1/cockpit/cases/:caseId/packet/assemble", async (c) => {
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

// GET /cockpit/cases/:caseId/packet/preview — synthesized preview of every
// field that will print on the packet, derived from the provider's extracted
// document fields against the facility's requirements. The preview is the
// data the cockpit specialist reviews BEFORE clicking Assemble — so it must
// work even when no packet row has been written yet.
//
// Response shape is the contract documented in
// apps/web/lib/types/packet.ts → PacketPreview.
packetRoutes.get("/v1/cockpit/cases/:caseId/packet/preview", async (c) => {
  const caseId = c.req.param("caseId");
  const preview = await withTenancy(c.var.tenancy, async (tx) => {
    const [cs] = await tx
      .select({
        id: schema.cases.id,
        providerId: schema.cases.providerId,
        facilityProfileId: schema.cases.facilityProfileId,
      })
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);
    if (!cs) return null;

    let requirements: FacilityRequirements | null = null;
    if (cs.facilityProfileId) {
      const [profile] = await tx
        .select({ requirements: schema.facilityProfiles.requirements })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, cs.facilityProfileId))
        .limit(1);
      requirements = (profile?.requirements as FacilityRequirements) ?? null;
    }

    const docs = await tx
      .select({
        id: schema.documents.id,
        documentType: schema.documents.documentType,
        extractedFields: schema.documents.extractedFields,
        expiresAt: schema.documents.expiresAt,
      })
      .from(schema.documents)
      .where(eq(schema.documents.providerId, cs.providerId));

    const [pkt] = await tx
      .select({
        id: schema.packets.id,
        fileUri: schema.packets.fileUri,
        assembledAt: schema.packets.assembledAt,
        provenance: schema.packets.provenance,
      })
      .from(schema.packets)
      .where(eq(schema.packets.caseId, caseId))
      .orderBy(desc(schema.packets.assembledAt))
      .limit(1);

    return { docs, requirements, pkt };
  });

  if (!preview) {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }

  const { docs, requirements, pkt } = preview;

  // A document type is critical for submission if the facility requires it,
  // or if it's one of the universal credentialing keystones (license, DEA,
  // board certification). Keep this aligned with the submission checklist
  // keys above and SPEC §5.3.
  const CRITICAL_FALLBACK = new Set(["medical_license", "dea", "board_certification"]);
  const requiredTypes = new Set(
    (requirements?.required_documents ?? []).map((d) => d.type as string),
  );

  // `bbox?: T | undefined` rather than `bbox?: T` because the tsconfig
  // has `exactOptionalPropertyTypes: true`: without the explicit
  // `| undefined` in the union, assigning `bbox: undefined` is an error.
  type PacketField = {
    key: string;
    section: string;
    label: string;
    value: string | null;
    confidence: number | null;
    criticality: "critical" | "standard";
    status: "missing" | "low_confidence" | "ready";
    packetPage: number;
    bbox?: { page: number; bbox: [number, number, number, number] } | undefined;
  };

  const LOW_CONF = 0.8;
  const fields: PacketField[] = [];
  let packetPage = 1;
  for (const d of docs) {
    const docType = d.documentType as string;
    const isCritical =
      requiredTypes.has(docType) || CRITICAL_FALLBACK.has(docType);
    const section = humanizeKey(docType);
    // Tolerate both array and object shapes — same defensive normalization
    // as the GraphQL resolver uses for extractedFields.
    const rawFields = d.extractedFields as unknown;
    const fieldArray = Array.isArray(rawFields)
      ? rawFields
      : rawFields && typeof rawFields === "object"
        ? Object.entries(rawFields as Record<string, { value?: unknown; confidence?: unknown }>).map(
            ([name, entry]) => ({
              name,
              value: entry?.value,
              confidence: typeof entry?.confidence === "number" ? entry.confidence : 0,
              page: 0,
              bbox: [0, 0, 1, 0.1] as [number, number, number, number],
            }),
          )
        : [];

    for (const f of fieldArray as Array<{
      name: string;
      value: unknown;
      confidence: number;
      page?: number;
      bbox?: [number, number, number, number];
    }>) {
      const valueStr =
        f.value === null || f.value === undefined ? null : String(f.value);
      const conf = typeof f.confidence === "number" ? f.confidence : 0;
      const status: PacketField["status"] = !valueStr
        ? "missing"
        : conf < LOW_CONF
          ? "low_confidence"
          : "ready";
      fields.push({
        key: `${docType}.${f.name}`,
        section,
        label: humanizeKey(f.name),
        value: valueStr,
        confidence: conf,
        criticality: isCritical ? "critical" : "standard",
        status,
        packetPage: packetPage++,
        bbox:
          Array.isArray(f.bbox) && typeof f.page === "number"
            ? { page: f.page, bbox: f.bbox }
            : undefined,
      });
    }
  }

  // Add a missing-row for any required document type the provider hasn't
  // uploaded — without these the checklist is misleading. Dedupe by
  // type-then-index to guard against the facility requirements containing
  // multiple entries of the same DocumentType (Opus often maps oddball
  // documents to `other`, producing collisions that crash React with
  // "two children with the same key").
  const seenMissing = new Set<string>();
  let missingIdx = 0;
  for (const req of requirements?.required_documents ?? []) {
    const reqType = req.type as string;
    const present = docs.some((d) => (d.documentType as string) === reqType);
    if (present) continue;
    let key = `missing.${reqType}.document`;
    while (seenMissing.has(key)) {
      missingIdx += 1;
      key = `missing.${reqType}.document.${missingIdx}`;
    }
    seenMissing.add(key);
    fields.push({
      key,
      section: humanizeKey(reqType),
      label: "Document not yet provided",
      value: null,
      confidence: null,
      criticality: "critical",
      status: "missing",
      packetPage: 0,
    });
  }

  const outstandingCriticalKeys = fields
    .filter((f) => f.criticality === "critical" && f.status !== "ready")
    .map((f) => f.key);

  let packetUrl = "";
  let pageCount = 0;
  let generatedAt = new Date().toISOString();
  if (pkt) {
    const signed = await getObjectStorage().getSignedUrl({
      key: pkt.fileUri,
      expiresInSeconds: 15 * 60,
    });
    packetUrl = signed.url;
    pageCount = Math.max(1, (pkt.provenance?.documentIds?.length ?? 1));
    generatedAt = pkt.assembledAt.toISOString();
  }

  return c.json({
    caseId,
    packetUrl,
    packetMimeType: "application/pdf",
    pageCount,
    generatedAt,
    fields,
    outstandingCriticalKeys,
  });
});

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

// GET /cockpit/cases/:caseId/packet — latest packet + a signed download url
packetRoutes.get("/v1/cockpit/cases/:caseId/packet", async (c) => {
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
  "/v1/cockpit/cases/:caseId/packet/submit",
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
