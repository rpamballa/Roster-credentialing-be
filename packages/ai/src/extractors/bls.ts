import type { ExtractedField } from "@cred/types/domain";
import { type DocumentContent, type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "bls",
  expectedFields: [
    "holder_name",
    "issuing_organization",
    "issue_date",
    "expiration_date",
    "card_number",
  ],
  typeGuidance: `Basic Life Support card, typically AHA or Red Cross.
issuing_organization should be normalized to one of: "AHA", "Red Cross", "ASHI".`,
};

export function extractBls(
  contents: DocumentContent[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, contents, ...ctx });
}
