// Inline document extraction.
//
// Mirrors `advanceIngestJobInline` (facility-ingest) for the per-document
// extraction pipeline. The Temporal worker (apps/workers) is disabled in
// the staging stack, so the API process runs classify → extract → persist
// inline. The activity bodies are lifted from
// apps/workers/src/activities/extraction.ts so behaviour is identical;
// the only differences are inlining and per-stage independent commits so
// the UI's poller sees real progress.

import { createHash } from "node:crypto";
import {
  classifyDocument,
  extractByType,
  type DocumentContent,
  type SupportedMediaType,
} from "@cred/ai";
import { db, schema } from "@cred/db";
import { audit, logger } from "@cred/observability";
import { getObjectStorage } from "@cred/storage";
import type { DocumentType, ExtractedField } from "@cred/types/domain";
import { eq } from "drizzle-orm";

const AUTO_FILL_THRESHOLD = 0.9;
const FLAG_THRESHOLD = 0.7;
/** Cap inline payloads — Anthropic enforces ~5 MB per block but we leave
 *  headroom and reject anything pathological before we even try. */
const MAX_BYTES = 20 * 1024 * 1024;

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

export interface InlineExtractionContext {
  documentId: string;
  workspaceId: string;
  /** Optional FE-supplied hint — overrides the classifier when present. */
  documentTypeHint?: DocumentType;
}

/**
 * Run the full extraction lifecycle inline. Safe to call as a detached
 * promise (`void advanceDocumentExtractionInline(...)`) — failures are
 * caught and recorded as `extraction_status = 'failed'` on the document
 * row plus an `audit.document.extraction_failed` entry.
 *
 * Steps:
 *   1. Load doc by id (rls: bypass — bg path scoped by documentId).
 *   2. Flip `extractionStatus` to `running`.
 *   3. Classify the document (skipped when `documentTypeHint` is supplied
 *      and not `"other"` — the FE knows the type up-front).
 *   4. Extract typed fields via `extractByType`.
 *   5. Persist `documentType`, `extractedFields`, `extractionStatus`,
 *      `extractedAt`, `contentHash`, `classifierConfidence`. Audit
 *      `document.extracted`.
 *   6. On error: mark `failed` + audit `document.extraction_failed`.
 */
export async function advanceDocumentExtractionInline(
  ctx: InlineExtractionContext,
): Promise<void> {
  // ── 1. load ────────────────────────────────────────────────────────────
  // rls: bypass — background path scoped by documentId; workspace passed
  // explicitly via ctx and used only for audit + AI call routing.
  const rows = await db()
    .select({
      fileUri: schema.documents.fileUri,
      mimeType: schema.documents.mimeType,
      documentType: schema.documents.documentType,
      extractionStatus: schema.documents.extractionStatus,
      providerId: schema.documents.providerId,
    })
    .from(schema.documents)
    .where(eq(schema.documents.id, ctx.documentId))
    .limit(1);
  const doc = rows[0];
  if (!doc) {
    logger.warn({ documentId: ctx.documentId }, "document_extraction_skip_missing");
    return;
  }
  // Idempotency: don't re-run on docs that are already through extraction.
  // We do allow `pending` and `failed` to be re-attempted.
  if (
    doc.extractionStatus === "running" ||
    doc.extractionStatus === "succeeded" ||
    doc.extractionStatus === "needs_review"
  ) {
    logger.info(
      { documentId: ctx.documentId, status: doc.extractionStatus },
      "document_extraction_skip_state",
    );
    return;
  }

  try {
    // ── 2. flip to running ───────────────────────────────────────────────
    // rls: bypass — background updates a known document by id.
    await db()
      .update(schema.documents)
      .set({ extractionStatus: "running" })
      .where(eq(schema.documents.id, ctx.documentId));

    // ── 3. fetch bytes inline (Anthropic refuses non-HTTPS URLs, so the
    //       MinIO/object-storage URL never reaches the model) ────────────
    const content = await loadDocumentContent(doc.fileUri, doc.mimeType);

    // ── 3b. classify (skip when the FE supplied a typed hint) ────────────
    let documentType: DocumentType;
    let classifierConfidence: number;
    if (ctx.documentTypeHint && ctx.documentTypeHint !== "other") {
      documentType = ctx.documentTypeHint;
      classifierConfidence = 1.0;
    } else {
      const classified = await classifyDocument({
        content,
        workspaceId: ctx.workspaceId,
        documentId: ctx.documentId,
      });
      documentType = classified.document_type;
      classifierConfidence = classified.confidence;
    }

    // ── 4. extract typed fields ──────────────────────────────────────────
    const fields: ExtractedField[] = await extractByType(documentType, [content], {
      workspaceId: ctx.workspaceId,
      documentId: ctx.documentId,
    });
    const averageConfidence =
      fields.length === 0 ? 0 : fields.reduce((s, f) => s + f.confidence, 0) / fields.length;

    // ── 5. persist ───────────────────────────────────────────────────────
    const status: "succeeded" | "needs_review" =
      averageConfidence >= AUTO_FILL_THRESHOLD
        ? "succeeded"
        : averageConfidence >= FLAG_THRESHOLD
          ? "needs_review"
          : "needs_review";

    const contentHash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");

    // rls: bypass — background updates a known document by id; tenancy is
    // carried via the workspaceId argument for audit.
    const [updated] = await db()
      .update(schema.documents)
      .set({
        documentType,
        classifierConfidence: Math.round(classifierConfidence * 10_000),
        extractedFields: fields,
        extractionStatus: status,
        extractedAt: new Date(),
        contentHash,
      })
      .where(eq(schema.documents.id, ctx.documentId))
      .returning({ id: schema.documents.id, providerId: schema.documents.providerId });

    if (!updated) throw new Error(`failed to update document ${ctx.documentId}`);

    await audit({
      workspaceId: ctx.workspaceId,
      actorUserId: null,
      actorType: "agent",
      action: "document.extracted",
      targetEntityType: "document",
      targetEntityId: updated.id,
      after: {
        documentType,
        status,
        averageConfidence,
        classifierConfidence,
        providerId: updated.providerId,
      },
    });

    logger.info(
      { documentId: ctx.documentId, status, documentType, averageConfidence },
      "document_extraction_inline_complete",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "extraction_failed";
    logger.error({ err, documentId: ctx.documentId }, "document_extraction_inline_failed");
    try {
      // rls: bypass — failure record off a background path.
      await db()
        .update(schema.documents)
        .set({ extractionStatus: "failed" })
        .where(eq(schema.documents.id, ctx.documentId));
      await audit({
        workspaceId: ctx.workspaceId,
        actorUserId: null,
        actorType: "agent",
        action: "document.extraction_failed",
        targetEntityType: "document",
        targetEntityId: ctx.documentId,
        after: { reason: message.slice(0, 500) },
      });
    } catch (writeErr) {
      logger.error(
        { err: writeErr, documentId: ctx.documentId },
        "document_extraction_failure_write_failed",
      );
    }
  }
}
