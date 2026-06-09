import type { ExtractedField } from "@cred/types/domain";
import { type DocumentContent, type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "board_certification",
  expectedFields: [
    "diplomate_name",
    "specialty",
    "certifying_board",
    "issue_date",
    "expiration_date",
    "certificate_number",
    "moc_status",
  ],
  typeGuidance: `This is a specialty board certification (ABMS, AOA, or
equivalent). certifying_board is the issuing organization. moc_status describes
Maintenance of Certification — often "Meeting MOC requirements" or a date.`,
};

export function extractBoardCert(
  contents: DocumentContent[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, contents, ...ctx });
}
