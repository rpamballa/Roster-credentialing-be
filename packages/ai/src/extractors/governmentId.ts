import type { ExtractedField } from "@cred/types/domain";
import { type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "government_id",
  expectedFields: [
    "full_name",
    "id_type",
    "id_number",
    "date_of_birth",
    "issue_date",
    "expiration_date",
    "issuing_authority",
  ],
  typeGuidance: `Government-issued photo ID — typically a US state driver's
license, state ID, or US passport. id_type is one of "drivers_license",
"state_id", "passport". DO NOT extract any photo, biometric template, or
machine-readable-zone data — only the printed identity fields.`,
};

export function extractGovernmentId(
  imageUrls: string[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, imageUrls, ...ctx });
}
