import type { ExtractedField } from "@cred/types/domain";
import { type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "medical_school_diploma",
  expectedFields: ["graduate_name", "institution_name", "degree", "graduation_date"],
  typeGuidance: `Medical school diploma. degree is typically "MD" or "DO".
graduation_date may show only the year — extract whatever level of precision
is present and lower confidence accordingly. institution_name is the full
school name as it appears on the diploma.`,
};

export function extractDiploma(
  imageUrls: string[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, imageUrls, ...ctx });
}
