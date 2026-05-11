import { createAttestationEnvelope } from "@cred/auth";
import { db, schema, withTenancy } from "@cred/db";
import { audit, logger } from "@cred/observability";
import type { FacilityRequirements } from "@cred/types";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import type { ApiBindings } from "../types.js";

export const attestationRoutes = new Hono<ApiBindings>();

// Cockpit-initiated: send all required attestations as DocuSign envelopes.
attestationRoutes.use("/cockpit/cases/:caseId/attestations/*", requireStaffAuth, requireTenancy);

attestationRoutes.post("/cockpit/cases/:caseId/attestations/send", async (c) => {
  const caseId = c.req.param("caseId");
  const auth = c.var.staffAuth;

  const data = await withTenancy(c.var.tenancy, async (tx) => {
    const [cs] = await tx.select().from(schema.cases).where(eq(schema.cases.id, caseId)).limit(1);
    if (!cs?.facilityProfileId) return null;

    const [profile] = await tx
      .select({ requirements: schema.facilityProfiles.requirements })
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.id, cs.facilityProfileId))
      .limit(1);
    if (!profile) return null;

    const [provider] = await tx
      .select({
        firstName: schema.providers.firstName,
        lastName: schema.providers.lastName,
        email: schema.providers.email,
      })
      .from(schema.providers)
      .where(eq(schema.providers.id, cs.providerId))
      .limit(1);
    if (!provider?.email) return null;

    return {
      case: cs,
      requirements: profile.requirements as FacilityRequirements,
      provider,
    };
  });

  if (!data) {
    return c.json(
      {
        type: "about:blank",
        title: "Case is missing provider, facility profile, or provider email",
        status: 409,
        instance: c.var.requestId,
      },
      409,
    );
  }

  const created: Array<{ envelopeId: string; text: string }> = [];
  for (const att of data.requirements.attestations) {
    const { envelopeId } = await createAttestationEnvelope({
      attestationText: att.text,
      signerEmail: data.provider.email ?? "",
      signerName: `${data.provider.firstName} ${data.provider.lastName}`,
      caseId,
      workspaceId: c.var.tenancy.workspaceId,
    });
    created.push({ envelopeId, text: att.text });
  }

  await withTenancy(c.var.tenancy, async (tx) => {
    for (const e of created) {
      await tx.insert(schema.attestations).values({
        workspaceId: c.var.tenancy.workspaceId,
        caseId,
        docusignEnvelopeId: e.envelopeId,
        text: e.text,
        status: "sent",
      });
    }
  });

  await audit({
    workspaceId: c.var.tenancy.workspaceId,
    actorUserId: auth.session.userId,
    actorType: "user",
    action: "attestation.sent",
    targetEntityType: "case",
    targetEntityId: caseId,
    after: { count: created.length },
    requestId: c.var.requestId,
  });

  return c.json({ ok: true, sent: created.length });
});

// DocuSign Connect webhook — fires when an envelope status changes. Updates
// the matching attestation row to `completed` when fully signed. Verification
// of the connect signature is wired by config in production.
const DocusignEventSchema = z.object({
  data: z.object({
    envelopeId: z.string(),
    envelopeSummary: z
      .object({
        status: z.string(),
      })
      .optional(),
  }),
  event: z.string(),
});

attestationRoutes.post("/webhooks/docusign", zValidator("json", DocusignEventSchema), async (c) => {
  const payload = c.req.valid("json");
  const envelopeId = payload.data.envelopeId;
  const status = payload.data.envelopeSummary?.status?.toLowerCase();
  if (status !== "completed") {
    logger.info({ envelopeId, status }, "docusign_event_ignored");
    return c.json({ ok: true });
  }

  // rls: bypass — webhook is anonymous; lookup the attestation by
  // envelope id and set its workspace context.
  const [row] = await db()
    .select({ id: schema.attestations.id, workspaceId: schema.attestations.workspaceId })
    .from(schema.attestations)
    .where(eq(schema.attestations.docusignEnvelopeId, envelopeId))
    .limit(1);
  if (!row) {
    logger.warn({ envelopeId }, "docusign_envelope_not_tracked");
    return c.json({ ok: true });
  }

  await withTenancy({ workspaceId: row.workspaceId, userId: null }, async (tx) => {
    await tx
      .update(schema.attestations)
      .set({ status: "completed", completedAt: new Date() })
      .where(
        and(
          eq(schema.attestations.id, row.id),
          eq(schema.attestations.workspaceId, row.workspaceId),
        ),
      );
  });

  await audit({
    workspaceId: row.workspaceId,
    actorUserId: null,
    actorType: "agent",
    action: "attestation.completed",
    targetEntityType: "attestation",
    targetEntityId: row.id,
    after: { envelopeId },
    requestId: c.var.requestId,
  });

  return c.json({ ok: true });
});
