import { randomUUID } from "node:crypto";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { DocumentType } from "@cred/types/domain";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requireWriterOnMutations } from "../middleware/rbac.js";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import { fromFeDocumentType } from "../graphql/mappings.js";
import type { ApiBindings } from "../types.js";

export const cockpitProviderRoutes = new Hono<ApiBindings>();

cockpitProviderRoutes.use(
  "/v1/cockpit/*",
  requireStaffAuth,
  requireTenancy,
  requireWriterOnMutations,
);

const MAX_DOC_BYTES = 50 * 1024 * 1024;

const FE_DOCUMENT_TYPES = [
  "medical_license",
  "dea",
  "board_certification",
  "bls",
  "acls",
  "medical_diploma",
  "government_id",
  "vaccination",
  "malpractice_insurance",
] as const;

const SignUploadBody = z.object({
  documentType: z.enum(FE_DOCUMENT_TYPES),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive().max(MAX_DOC_BYTES),
});

async function ensureGrantedProvider(
  workspaceId: string,
  providerId: string,
): Promise<boolean> {
  // rls: bypass — provider_workspace_grants is the workspace-access table
  // itself; checking it IS the access check.
  const [row] = await db()
    .select({ providerId: schema.providerWorkspaceGrants.providerId })
    .from(schema.providerWorkspaceGrants)
    .where(
      and(
        eq(schema.providerWorkspaceGrants.providerId, providerId),
        eq(schema.providerWorkspaceGrants.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

cockpitProviderRoutes.post(
  "/v1/cockpit/providers/:providerId/documents/sign-upload",
  zValidator("json", SignUploadBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const providerId = c.req.param("providerId");
    const body = c.req.valid("json");

    const granted = await ensureGrantedProvider(c.var.tenancy.workspaceId, providerId);
    if (!granted) return notFoundResponse(c);

    const documentId = randomUUID();
    const key = `documents/${providerId}/${documentId}`;
    const signed = await getObjectStorage().putSignedUrl({
      key,
      contentType: body.mimeType,
      expiresInSeconds: 15 * 60,
    });

    const docType: DocumentType = fromFeDocumentType(body.documentType);
    // rls: bypass — documents are global to a provider, not workspace-scoped.
    // The workspace gate above ensures the actor can act on this provider.
    await db()
      .insert(schema.documents)
      .values({
        id: documentId,
        providerId,
        documentType: docType,
        fileUri: key,
        mimeType: body.mimeType,
        source: "specialist_upload",
        extractionStatus: "pending",
        uploadedBy: auth.session.userId,
      });

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "document.upload_signed",
      targetEntityType: "document",
      targetEntityId: documentId,
      after: { providerId, documentType: docType, sizeBytes: body.sizeBytes },
      requestId: c.var.requestId,
    });

    return c.json({
      documentId,
      uploadUrl: signed.url,
      headers: signed.headers,
      maxBytes: MAX_DOC_BYTES,
    });
  },
);

cockpitProviderRoutes.post(
  "/v1/cockpit/providers/:providerId/documents/:docId/uploaded",
  async (c) => {
    const auth = c.var.staffAuth;
    const providerId = c.req.param("providerId");
    const docId = c.req.param("docId");

    const granted = await ensureGrantedProvider(c.var.tenancy.workspaceId, providerId);
    if (!granted) return notFoundResponse(c);

    // rls: bypass — documents are provider-scoped, workspace-gated above.
    const [doc] = await db()
      .select({ id: schema.documents.id, fileUri: schema.documents.fileUri })
      .from(schema.documents)
      .where(
        and(eq(schema.documents.id, docId), eq(schema.documents.providerId, providerId)),
      )
      .limit(1);
    if (!doc) return notFoundResponse(c);

    const exists = await getObjectStorage().exists(doc.fileUri);
    if (!exists) {
      logger.warn({ docId }, "specialist_upload_missing_object");
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

    await audit({
      workspaceId: c.var.tenancy.workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "document.uploaded",
      targetEntityType: "document",
      targetEntityId: docId,
      after: { providerId, source: "specialist_upload" },
      requestId: c.var.requestId,
    });

    return new Response(null, { status: 204 });
  },
);

function notFoundResponse(c: Context<ApiBindings>): Response {
  return c.json(
    { type: "about:blank", title: "Not Found", status: 404, instance: c.var.requestId },
    404,
  );
}
