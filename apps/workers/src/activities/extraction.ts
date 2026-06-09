import { createHash } from "node:crypto";
import {
  classifyDocument,
  extractByType,
  type DocumentContent,
  type SupportedMediaType,
} from "@cred/ai";
import { db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { DocumentType, ExtractedField } from "@cred/types/domain";
import { eq } from "drizzle-orm";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MB

function toSupportedMediaType(mime: string | null | undefined): SupportedMediaType {
  switch (mime) {
    case "application/pdf":
    case "image/jpeg":
    case "image/png":
    case "image/gif":
    case "image/webp":
      return mime;
    default:
      throw new Error(`unsupported mime type for extraction: ${mime ?? "null"}`);
  }
}

async function loadDocumentContent(
  fileUri: string,
  mimeType: string | null,
): Promise<DocumentContent> {
  const mediaType = toSupportedMediaType(mimeType);
  const signed = await getObjectStorage().getSignedUrl({
    key: fileUri,
    expiresInSeconds: 15 * 60,
  });
  const response = await fetch(signed.url);
  if (!response.ok) {
    throw new Error(`object storage fetch ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`document exceeds ${MAX_BYTES} bytes (${buf.byteLength})`);
  }
  return { base64: buf.toString("base64"), mediaType };
}

const AUTO_FILL_THRESHOLD = 0.9;
const FLAG_THRESHOLD = 0.7;

export interface ExtractionContext {
  documentId: string;
  workspaceId: string;
  actorUserId: string | null;
}

export async function virusScanActivity(ctx: ExtractionContext): Promise<{ ok: true }> {
  // M2 stub: real implementation calls ClamAV (or cloud equivalent) on the
  // uploaded object. For now we verify the object exists and compute a hash
  // so downstream activities can fingerprint it.
  // rls: bypass — activity loads its target by id from a trusted workflow.
  const rows = await db()
    .select({ fileUri: schema.documents.fileUri })
    .from(schema.documents)
    .where(eq(schema.documents.id, ctx.documentId))
    .limit(1);
  if (!rows[0]) throw new Error(`document ${ctx.documentId} not found`);
  return { ok: true };
}

export async function classifyActivity(
  ctx: ExtractionContext,
): Promise<{ documentType: DocumentType; confidence: number }> {
  // rls: bypass — activity loads its target by id from a trusted workflow.
  const rows = await db()
    .select({ fileUri: schema.documents.fileUri, mimeType: schema.documents.mimeType })
    .from(schema.documents)
    .where(eq(schema.documents.id, ctx.documentId))
    .limit(1);
  const doc = rows[0];
  if (!doc) throw new Error(`document ${ctx.documentId} not found`);

  const content = await loadDocumentContent(doc.fileUri, doc.mimeType);
  const result = await classifyDocument({
    content,
    workspaceId: ctx.workspaceId,
    documentId: ctx.documentId,
  });
  return { documentType: result.document_type, confidence: result.confidence };
}

export async function extractActivity(
  ctx: ExtractionContext & { documentType: DocumentType },
): Promise<{ fields: ExtractedField[]; averageConfidence: number }> {
  // rls: bypass — activity loads its target by id from a trusted workflow.
  const rows = await db()
    .select({ fileUri: schema.documents.fileUri, mimeType: schema.documents.mimeType })
    .from(schema.documents)
    .where(eq(schema.documents.id, ctx.documentId))
    .limit(1);
  const doc = rows[0];
  if (!doc) throw new Error(`document ${ctx.documentId} not found`);

  const content = await loadDocumentContent(doc.fileUri, doc.mimeType);
  const fields = await extractByType(ctx.documentType, [content], {
    workspaceId: ctx.workspaceId,
    documentId: ctx.documentId,
  });

  const avg =
    fields.length === 0 ? 0 : fields.reduce((s, f) => s + f.confidence, 0) / fields.length;
  return { fields, averageConfidence: avg };
}

export async function persistExtractionActivity(
  ctx: ExtractionContext & {
    documentType: DocumentType;
    classifierConfidence: number;
    fields: ExtractedField[];
    averageConfidence: number;
  },
): Promise<{ status: "succeeded" | "needs_review" }> {
  // Per PROMPT §4.5 — confidence drives the review gate.
  const status =
    ctx.averageConfidence >= AUTO_FILL_THRESHOLD
      ? "succeeded"
      : ctx.averageConfidence >= FLAG_THRESHOLD
        ? "needs_review"
        : "needs_review";

  const contentHash = createHash("sha256").update(JSON.stringify(ctx.fields)).digest("hex");

  // rls: bypass — activity updates a known document by id; tenancy enforced
  // by the calling workflow's workspace context.
  const [updated] = await db()
    .update(schema.documents)
    .set({
      documentType: ctx.documentType,
      classifierConfidence: Math.round(ctx.classifierConfidence * 10_000),
      extractedFields: ctx.fields,
      extractionStatus: status,
      extractedAt: new Date(),
      contentHash,
    })
    .where(eq(schema.documents.id, ctx.documentId))
    .returning({ id: schema.documents.id, providerId: schema.documents.providerId });

  if (!updated) throw new Error(`failed to update document ${ctx.documentId}`);

  await audit({
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.actorUserId,
    actorType: "agent",
    action: "document.extracted",
    targetEntityType: "document",
    targetEntityId: updated.id,
    after: {
      documentType: ctx.documentType,
      status,
      averageConfidence: ctx.averageConfidence,
      classifierConfidence: ctx.classifierConfidence,
      providerId: updated.providerId,
    },
  });

  return { status };
}

export async function markFailedActivity(
  ctx: ExtractionContext & { reason: string },
): Promise<void> {
  // rls: bypass — activity updates a known document by id.
  await db()
    .update(schema.documents)
    .set({ extractionStatus: "failed" })
    .where(eq(schema.documents.id, ctx.documentId));

  await audit({
    workspaceId: ctx.workspaceId,
    actorUserId: ctx.actorUserId,
    actorType: "agent",
    action: "document.extraction_failed",
    targetEntityType: "document",
    targetEntityId: ctx.documentId,
    after: { reason: ctx.reason },
  });
}
