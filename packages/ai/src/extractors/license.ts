import type { ExtractedField } from "@cred/types/domain";
import { type DocumentContent, type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "medical_license",
  expectedFields: [
    "license_number",
    "state",
    "issue_date",
    "expiration_date",
    "license_status",
    "licensee_name",
    "specialty",
  ],
  typeGuidance: `This is a state medical license. The license_number may include
letters and digits. expiration_date is the most operationally important field —
double-check it. state is the two-letter postal code (e.g., "TX").`,
};

export function extractLicense(
  contents: DocumentContent[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, contents, ...ctx });
}
