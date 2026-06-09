import {
  ReferenceTokenConsumedError,
  ReferenceTokenInvalidError,
  consumeReferenceToken,
  previewReferenceToken,
} from "@cred/auth";
import { db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { ApiBindings } from "../types.js";

export const referenceRoutes = new Hono<ApiBindings>();

const SubmitSchema = z.object({
  token: z.string().min(32).max(256),
  answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

// ─── GET /reference/:token ─────────────────────────────────────────────────
// Public, anonymous preview of the reference form context. Used by the FE
// landing page to show the responder what they're attesting to before they
// fill the form. Does NOT consume the token — submit consumes it.
referenceRoutes.get("/reference/:token", async (c) => {
  const token = c.req.param("token");
  if (!token || token.length < 32 || token.length > 256) {
    return c.json(
      {
        type: "https://errors.cred/reference/invalid-token",
        title: "Invalid reference token",
        status: 400,
        instance: c.var.requestId,
      },
      400,
    );
  }

  try {
    const { referenceId, workspaceId, caseId } = await previewReferenceToken(token);

    // Lookup is keyed by trusted ids from the token. rls: bypass.
    const [refRow] = await db()
      .select({
        name: schema.references.name,
        relationship: schema.references.relationship,
        email: schema.references.email,
      })
      .from(schema.references)
      .where(eq(schema.references.id, referenceId))
      .limit(1);
    if (!refRow) {
      return c.json(
        {
          type: "https://errors.cred/reference/invalid-token",
          title: "Invalid reference token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }

    const [caseRow] = await db()
      .select({
        providerId: schema.cases.providerId,
        facilityProfileId: schema.cases.facilityProfileId,
        specialty: schema.cases.specialty,
      })
      .from(schema.cases)
      .where(eq(schema.cases.id, caseId))
      .limit(1);

    const [workspaceRow] = await db()
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    let providerFirstName = "";
    let providerLastName = "";
    if (caseRow?.providerId) {
      const [provRow] = await db()
        .select({
          firstName: schema.providers.firstName,
          lastName: schema.providers.lastName,
        })
        .from(schema.providers)
        .where(eq(schema.providers.id, caseRow.providerId))
        .limit(1);
      providerFirstName = provRow?.firstName ?? "";
      providerLastName = provRow?.lastName ?? "";
    }

    let facilityName = "";
    if (caseRow?.facilityProfileId) {
      const [profRow] = await db()
        .select({ facilityId: schema.facilityProfiles.facilityId })
        .from(schema.facilityProfiles)
        .where(eq(schema.facilityProfiles.id, caseRow.facilityProfileId))
        .limit(1);
      if (profRow) {
        const [fac] = await db()
          .select({ name: schema.facilities.name })
          .from(schema.facilities)
          .where(eq(schema.facilities.id, profRow.facilityId))
          .limit(1);
        facilityName = fac?.name ?? "";
      }
    }

    return c.json({
      referenceName: refRow.name,
      referenceRelationship: refRow.relationship ?? null,
      referenceEmail: refRow.email ?? null,
      providerFirstName,
      providerLastName,
      providerFullName: `${providerFirstName} ${providerLastName}`.trim(),
      facilityName,
      workspaceName: workspaceRow?.name ?? "",
      specialty: caseRow?.specialty ?? "",
      // questions the FE form must render — keeping the contract explicit so
      // the BE and FE can't drift.
      questions: [
        {
          id: "worked_with_recent",
          kind: "yes_no",
          prompt: "Have you worked with this provider in the last 24 months?",
          required: true,
        },
        {
          id: "claims_or_discipline",
          kind: "yes_no",
          prompt:
            "Are you aware of any malpractice claims or disciplinary actions involving this provider?",
          required: true,
        },
        {
          id: "would_recommend",
          kind: "yes_no",
          prompt: "Would you recommend this provider for the privileges requested?",
          required: true,
        },
        {
          id: "notes",
          kind: "text",
          prompt: "Anything we should know",
          required: false,
        },
        {
          id: "attestation",
          kind: "attestation",
          prompt: "I attest that the above is accurate to the best of my knowledge",
          required: true,
        },
      ],
    });
  } catch (err) {
    if (err instanceof ReferenceTokenConsumedError) {
      // 410 Gone — token existed, has been consumed, will never be valid again.
      return c.json(
        {
          type: "https://errors.cred/reference/already-used",
          title: "This reference link has already been used",
          status: 410,
          instance: c.var.requestId,
        },
        410,
      );
    }
    if (err instanceof ReferenceTokenInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/reference/invalid-token",
          title: "Invalid or expired reference token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }
});

referenceRoutes.post("/reference/submit", zValidator("json", SubmitSchema), async (c) => {
  const { token, answers } = c.req.valid("json");
  try {
    const { referenceId, workspaceId } = await consumeReferenceToken(token);

    await withTenancy({ workspaceId, userId: null }, async (tx) => {
      await tx
        .update(schema.references)
        .set({
          status: "completed",
          responseFields: answers,
          respondedAt: new Date(),
        })
        .where(eq(schema.references.id, referenceId));
    });

    // Legacy event name kept for backwards compat with any existing log
    // queries.
    await audit({
      workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "reference.responded",
      targetEntityType: "reference",
      targetEntityId: referenceId,
      after: { fieldCount: Object.keys(answers).length },
      requestId: c.var.requestId,
    });
    // Persona-test-plan §3: the cockpit timeline expects a
    // `reference.completed` event when the form is submitted.
    await audit({
      workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "reference.completed",
      targetEntityType: "reference",
      targetEntityId: referenceId,
      after: { fieldCount: Object.keys(answers).length },
      requestId: c.var.requestId,
    });

    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof ReferenceTokenInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/reference/invalid-token",
          title: "Invalid or expired reference token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }
});
