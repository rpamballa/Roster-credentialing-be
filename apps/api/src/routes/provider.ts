import { createHash, randomUUID } from "node:crypto";
import { CaseAccessInvalidError, createProviderSession, redeemCaseAccessToken } from "@cred/auth";
import { env } from "@cred/config";
import { db, schema, withTenancy } from "@cred/db";
import { audit } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import { ExtractedFieldsSchema } from "@cred/types/domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import { SESSION_COOKIE, requireProviderAuth } from "../middleware/session.js";
import { requireProviderTenancy } from "../middleware/tenancy.js";
import { advanceDocumentExtractionInline } from "../services/documentExtractionInline.js";
import type { ApiBindings } from "../types.js";

export const providerRoutes = new Hono<ApiBindings>();

// ─── auth: redeem a case access token, mint a provider session ───────────
const RedeemSchema = z.object({ token: z.string().min(32).max(256) });
providerRoutes.post("/provider/auth/redeem", zValidator("json", RedeemSchema), async (c) => {
  try {
    const { caseId, providerId, workspaceId } = await redeemCaseAccessToken(
      c.req.valid("json").token,
    );
    const sid = await createProviderSession({
      providerId,
      caseId,
      caseWorkspaceId: workspaceId,
    });
    setCookie(c, SESSION_COOKIE, sid, {
      httpOnly: true,
      secure: env().NODE_ENV === "production",
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    await audit({
      workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "auth.provider_invite.redeemed",
      targetEntityType: "case",
      targetEntityId: caseId,
      after: { providerId },
      requestId: c.var.requestId,
    });
    return c.json({ ok: true, caseId, providerId });
  } catch (err) {
    if (err instanceof CaseAccessInvalidError) {
      return c.json(
        {
          type: "https://errors.cred/provider/invalid-token",
          title: "Invalid or expired case access token",
          status: 400,
          instance: c.var.requestId,
        },
        400,
      );
    }
    throw err;
  }
});

// ─── auth: preview — peek at the case behind a token without consuming it ─
// The provider invite landing page (apps/web/app/(provider)/invite/[token])
// uses this to show "Hello, Aanya — Northstar has invited you to Mercy
// Memorial". The token is NOT consumed here; redemption only happens on the
// /provider/auth/redeem call when the user clicks Begin.
const PreviewSchema = z.object({ token: z.string().min(32).max(256) });
providerRoutes.post("/provider/auth/preview", zValidator("json", PreviewSchema), async (c) => {
  const { token } = c.req.valid("json");
  const hash = createHash("sha256").update(token).digest("hex");

  // rls: bypass — pre-session lookup by token hash + case/provider/workspace
  // joins. The whole point of this endpoint is to operate without a session.
  const [row] = await db()
    .select({
      caseId: schema.caseAccessTokens.caseId,
      providerId: schema.caseAccessTokens.providerId,
      facilityProfileId: schema.cases.facilityProfileId,
      workspaceId: schema.cases.workspaceId,
      targetSubmissionDate: schema.cases.targetSubmissionDate,
      firstName: schema.providers.firstName,
      workspaceName: schema.workspaces.name,
    })
    .from(schema.caseAccessTokens)
    .innerJoin(schema.cases, eq(schema.cases.id, schema.caseAccessTokens.caseId))
    .innerJoin(schema.providers, eq(schema.providers.id, schema.cases.providerId))
    .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.cases.workspaceId))
    .where(
      and(
        eq(schema.caseAccessTokens.tokenHash, hash),
        isNull(schema.caseAccessTokens.revokedAt),
        sql`${schema.caseAccessTokens.expiresAt} > now()`,
      ),
    )
    .limit(1);

  if (!row) {
    return c.json(
      {
        type: "https://errors.cred/provider/invalid-token",
        title: "Invalid or expired case access token",
        status: 400,
        instance: c.var.requestId,
      },
      400,
    );
  }

  // Look up the facility name. The cases table stores facility_profile_id
  // without a FK (M2 sequencing), so we resolve the profile → facility join
  // in a second query rather than threading it through the join above.
  let facilityName = "your facility";
  if (row.facilityProfileId) {
    const [fp] = await db()
      .select({ facilityId: schema.facilityProfiles.facilityId })
      .from(schema.facilityProfiles)
      .where(eq(schema.facilityProfiles.id, row.facilityProfileId))
      .limit(1);
    if (fp) {
      const [f] = await db()
        .select({ name: schema.facilities.name })
        .from(schema.facilities)
        .where(eq(schema.facilities.id, fp.facilityId))
        .limit(1);
      if (f?.name) facilityName = f.name;
    }
  }

  return c.json({
    providerFirstName: row.firstName,
    workspaceName: row.workspaceName,
    facilityName,
    totalSteps: 8,
    stepHighlights: [
      "Capture your license, DEA, and board certification",
      "Confirm AI-extracted fields with a tap",
      "Add two professional references",
      "E-sign your attestation",
    ],
    targetDate: row.targetSubmissionDate ?? null,
  });
});

// All routes below need the provider session and the case's workspace
// tenancy context.
providerRoutes.use("/provider/uploads/*", requireProviderAuth, requireProviderTenancy);
providerRoutes.use("/provider/case/*", requireProviderAuth, requireProviderTenancy);
providerRoutes.use("/provider/documents/*", requireProviderAuth, requireProviderTenancy);

// ─── POST /provider/uploads/initiate ─────────────────────────────────────
const InitiateUploadSchema = z.object({
  contentType: z.string().min(1).max(128),
  originalFilename: z.string().min(1).max(255).optional(),
});
providerRoutes.post(
  "/provider/uploads/initiate",
  zValidator("json", InitiateUploadSchema),
  async (c) => {
    const auth = c.var.providerAuth;
    const { contentType, originalFilename } = c.req.valid("json");
    const key = `uploads/${auth.session.caseId}/${randomUUID()}`;
    const presign = await getObjectStorage().putSignedUrl({
      key,
      contentType,
      expiresInSeconds: 15 * 60,
    });
    return c.json({
      uploadId: key,
      url: presign.url,
      method: presign.method,
      headers: presign.headers,
      expiresAt: presign.expiresAt.toISOString(),
      originalFilename: originalFilename ?? null,
    });
  },
);

// ─── POST /provider/uploads/complete ─────────────────────────────────────
const CompleteUploadSchema = z.object({
  uploadId: z.string().min(1).max(512),
  originalFilename: z.string().max(255).optional(),
  mimeType: z.string().min(1).max(128),
  pageCount: z.number().int().positive().max(2000).optional(),
});
providerRoutes.post(
  "/provider/uploads/complete",
  zValidator("json", CompleteUploadSchema),
  async (c) => {
    const auth = c.var.providerAuth;
    const tenancy = c.var.tenancy;
    const body = c.req.valid("json");

    const exists = await getObjectStorage().exists(body.uploadId);
    if (!exists) {
      return c.json(
        {
          type: "https://errors.cred/upload/missing",
          title: "Upload not found in object storage",
          status: 409,
          instance: c.var.requestId,
        },
        409,
      );
    }

    const documentId = await withTenancy(tenancy, async (tx) => {
      const [row] = await tx
        .insert(schema.documents)
        .values({
          providerId: auth.session.providerId,
          documentType: "other", // classifier will overwrite
          fileUri: body.uploadId,
          originalFilename: body.originalFilename ?? null,
          mimeType: body.mimeType,
          pageCount: body.pageCount ?? null,
          source: "provider_upload",
          extractionStatus: "pending",
        })
        .returning({ id: schema.documents.id });
      if (!row) throw new Error("failed to insert document");
      return row.id;
    });

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.uploaded",
      targetEntityType: "document",
      targetEntityId: documentId,
      after: {
        providerId: auth.session.providerId,
        caseId: auth.session.caseId,
        source: "provider_upload",
      },
      requestId: c.var.requestId,
    });

    // Inline extraction — see services/documentExtractionInline.ts. The
    // Temporal worker is disabled in the staging stack, and the activity
    // bodies were lifted directly so behaviour is identical. Detached
    // promise: the handler returns immediately and the FE polls.
    void advanceDocumentExtractionInline({
      documentId,
      workspaceId: tenancy.workspaceId,
    });

    return c.json({ documentId, extractionStatus: "pending" });
  },
);

// ─── GET /provider/case/:caseId ──────────────────────────────────────────
providerRoutes.get("/provider/case/:caseId", async (c) => {
  const auth = c.var.providerAuth;
  const tenancy = c.var.tenancy;
  const caseIdParam = c.req.param("caseId");

  if (caseIdParam !== auth.session.caseId) {
    return c.json(
      { type: "about:blank", title: "Forbidden", status: 403, instance: c.var.requestId },
      403,
    );
  }

  const detail = await withTenancy(tenancy, async (tx) => {
    const [caseRow] = await tx
      .select()
      .from(schema.cases)
      .where(eq(schema.cases.id, caseIdParam))
      .limit(1);
    if (!caseRow) return null;

    const documents = await tx
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.providerId, caseRow.providerId));

    return { caseRow, documents };
  });

  if (!detail) {
    return c.json(
      { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
      404,
    );
  }

  // Document reuse (PROMPT M2 §6.7): mark documents that are already on file
  // and still valid. A document is reusable when it was uploaded before this
  // case opened and hasn't expired. M3 will add facility-requirement-aware
  // reuse (matched against the case's requirements checklist).
  const now = Date.now();
  const annotated = detail.documents.map((d) => {
    const isOnFile =
      d.uploadedAt.getTime() < detail.caseRow.openedAt.getTime() &&
      (d.expiresAt === null || d.expiresAt.getTime() > now);
    return {
      id: d.id,
      documentType: d.documentType,
      extractionStatus: d.extractionStatus,
      originalFilename: d.originalFilename,
      uploadedAt: d.uploadedAt,
      expiresAt: d.expiresAt,
      confirmedAt: d.confirmedAt,
      fields: d.extractedFields,
      already_on_file: isOnFile,
    };
  });

  return c.json({
    case: {
      id: detail.caseRow.id,
      status: detail.caseRow.status,
      specialty: detail.caseRow.specialty,
      purpose: detail.caseRow.purpose,
      targetSubmissionDate: detail.caseRow.targetSubmissionDate,
    },
    documents: annotated,
  });
});

// ─── POST /provider/documents/:documentId/confirm ────────────────────────
const ConfirmDocSchema = z.object({
  fields: ExtractedFieldsSchema,
});
providerRoutes.post(
  "/provider/documents/:documentId/confirm",
  zValidator("json", ConfirmDocSchema),
  async (c) => {
    const auth = c.var.providerAuth;
    const tenancy = c.var.tenancy;
    const documentId = c.req.param("documentId");
    const { fields } = c.req.valid("json");

    const updated = await withTenancy(tenancy, async (tx) => {
      const [doc] = await tx
        .select({
          providerId: schema.documents.providerId,
          before: schema.documents.extractedFields,
        })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.id, documentId),
            eq(schema.documents.providerId, auth.session.providerId),
          ),
        )
        .limit(1);
      if (!doc) return null;

      const [row] = await tx
        .update(schema.documents)
        .set({
          extractedFields: fields,
          confirmedAt: new Date(),
          extractionStatus: "succeeded",
        })
        .where(eq(schema.documents.id, documentId))
        .returning({ id: schema.documents.id });
      return { id: row?.id, before: doc.before };
    });

    if (!updated?.id) {
      return c.json(
        { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
        404,
      );
    }

    await audit({
      workspaceId: tenancy.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.confirmed",
      targetEntityType: "document",
      targetEntityId: updated.id,
      before: { extractedFields: updated.before },
      after: { extractedFields: fields, providerId: auth.session.providerId },
      requestId: c.var.requestId,
    });

    return c.json({ ok: true });
  },
);
