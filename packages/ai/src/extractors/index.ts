import type { DocumentType, ExtractedField } from "@cred/types/domain";
import type { DocumentContent } from "./base.js";
import { extractAcls } from "./acls.js";
import { extractBls } from "./bls.js";
import { extractBoardCert } from "./boardCert.js";
import { extractDea } from "./dea.js";
import { extractDiploma } from "./diploma.js";
import { extractGovernmentId } from "./governmentId.js";
import { extractLicense } from "./license.js";
import { extractVaccinationRecord } from "./vaccinationRecord.js";

export type ExtractorFn = (
  contents: DocumentContent[],
  ctx?: { workspaceId?: string | null; documentId?: string },
) => Promise<ExtractedField[]>;

export const EXTRACTORS: Partial<Record<DocumentType, ExtractorFn>> = {
  medical_license: extractLicense,
  dea: extractDea,
  board_certification: extractBoardCert,
  bls: extractBls,
  acls: extractAcls,
  medical_school_diploma: extractDiploma,
  government_id: extractGovernmentId,
  vaccination_record: extractVaccinationRecord,
};

export class NoExtractorError extends Error {
  constructor(readonly documentType: DocumentType) {
    super(`no extractor registered for document type: ${documentType}`);
    this.name = "NoExtractorError";
  }
}

/**
 * Dispatch to the per-type extractor with the document supplied inline as
 * base64 + mediaType. Anthropic rejects http:// URLs ("Only HTTPS URLs are
 * supported"), so callers that hold an internal MinIO/object-storage URL
 * must fetch the bytes first and pass them in.
 */
export function extractByType(
  documentType: DocumentType,
  contents: DocumentContent[],
  ctx?: { workspaceId?: string | null; documentId?: string },
): Promise<ExtractedField[]> {
  const fn = EXTRACTORS[documentType];
  if (!fn) throw new NoExtractorError(documentType);
  return fn(contents, ctx);
}

export {
  extractAcls,
  extractBls,
  extractBoardCert,
  extractDea,
  extractDiploma,
  extractGovernmentId,
  extractLicense,
  extractVaccinationRecord,
};
export type { DocumentContent, ImageMediaType, DocumentMediaType, SupportedMediaType } from "./base.js";
