import type { ExtractedField } from "@cred/types/domain";
import { type DocumentContent, type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "dea",
  expectedFields: [
    "dea_number",
    "registrant_name",
    "schedule",
    "business_address",
    "issue_date",
    "expiration_date",
  ],
  typeGuidance: `This is a DEA registration certificate. dea_number follows the
format <2 letters><7 digits> (e.g., "BD1234563"). The last digit is a checksum;
do not "correct" it. schedule is a comma-separated list of drug schedules.`,
};

export function extractDea(
  contents: DocumentContent[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, contents, ...ctx });
}
