import { schema, withTenancy } from "@cred/db";
import { getObjectStorage } from "@cred/storage";
import { and, eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { GqlContext } from "../context.js";
import { toFeDocumentType } from "../mappings.js";
import { mapExtractedFields } from "./caseDetail.js";
import type { DocumentReviewGql } from "./types.js";

function mapExtractionStatus(
  status: string,
): "pending" | "processing" | "ready" | "failed" {
  switch (status) {
    case "running":
      return "processing";
    case "succeeded":
    case "needs_review":
      return "ready";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export async function documentReviewResolver(
  _src: unknown,
  args: { caseId: string; documentId: string },
  ctx: GqlContext,
): Promise<DocumentReviewGql | null> {
  const row = await withTenancy(ctx.tenancy, async (tx) => {
    const [cs] = await tx
      .select({ id: schema.cases.id, providerId: schema.cases.providerId, openedAt: schema.cases.openedAt })
      .from(schema.cases)
      .where(
        and(
          eq(schema.cases.id, args.caseId),
          eq(schema.cases.workspaceId, ctx.tenancy.workspaceId),
        ),
      )
      .limit(1);
    if (!cs) return null;

    // The provider table is global; restrict to the document tied to this
    // case's provider so we don't leak cross-case docs.
    const [doc] = await tx
      .select()
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.id, args.documentId),
          eq(schema.documents.providerId, cs.providerId),
        ),
      )
      .limit(1);
    return doc ? { cs, doc } : null;
  });

  if (!row) {
    throw new GraphQLError("document not found", { extensions: { code: "NOT_FOUND" } });
  }

  const signed = await getObjectStorage().getSignedUrl({
    key: row.doc.fileUri,
    expiresInSeconds: 15 * 60,
  });

  const feType = toFeDocumentType(row.doc.documentType) ?? "medical_license";
  const fields = mapExtractedFields(row.doc.extractedFields);

  return {
    document: {
      id: row.doc.id,
      type: feType,
      thumbnailUrl: null,
      pageCount: row.doc.pageCount ?? 1,
      uploadedAt: row.doc.uploadedAt.toISOString(),
      expiresAt: row.doc.expiresAt ? row.doc.expiresAt.toISOString() : null,
      extractionStatus: mapExtractionStatus(row.doc.extractionStatus),
      reusedFromPriorCase: row.doc.uploadedAt.getTime() < row.cs.openedAt.getTime(),
      extractedFields: fields,
    },
    fields,
    sourceUrl: signed.url,
    sourceMimeType: row.doc.mimeType ?? "application/octet-stream",
    pageCount: row.doc.pageCount ?? 1,
  };
}
