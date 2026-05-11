import type { DocumentType, ExtractedField } from "@cred/types/domain";
import { extractAcls } from "./acls.js";
import { extractBls } from "./bls.js";
import { extractBoardCert } from "./boardCert.js";
import { extractDea } from "./dea.js";
import { extractDiploma } from "./diploma.js";
import { extractGovernmentId } from "./governmentId.js";
import { extractLicense } from "./license.js";
import { extractVaccinationRecord } from "./vaccinationRecord.js";

export type ExtractorFn = (
  imageUrls: string[],
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

export function extractByType(
  documentType: DocumentType,
  imageUrls: string[],
  ctx?: { workspaceId?: string | null; documentId?: string },
): Promise<ExtractedField[]> {
  const fn = EXTRACTORS[documentType];
  if (!fn) throw new NoExtractorError(documentType);
  return fn(imageUrls, ctx);
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
