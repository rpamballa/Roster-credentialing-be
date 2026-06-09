import type { ExtractedField } from "@cred/types/domain";
import { type DocumentContent, type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "acls",
  expectedFields: [
    "holder_name",
    "issuing_organization",
    "issue_date",
    "expiration_date",
    "card_number",
  ],
  typeGuidance: `Advanced Cardiac Life Support card. Distinguish from BLS:
ACLS is for advanced providers and is explicitly labeled "ACLS" or
"Advanced Cardiovascular Life Support".`,
};

export function extractAcls(
  contents: DocumentContent[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, contents, ...ctx });
}
