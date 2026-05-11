import type { ExtractedField } from "@cred/types/domain";
import { type ExtractorSpec, runExtractor } from "./base.js";

const SPEC: ExtractorSpec = {
  documentType: "vaccination_record",
  expectedFields: [
    "patient_name",
    "vaccine_name",
    "manufacturer",
    "lot_number",
    "administration_date",
    "dose_number",
    "administering_provider",
  ],
  typeGuidance: `Vaccination record card or printout. May contain multiple
doses — emit one field set per vaccine_name. Common values for vaccine_name:
"Influenza", "Hepatitis B", "MMR", "Tdap", "COVID-19", "Varicella".`,
};

export function extractVaccinationRecord(
  imageUrls: string[],
  ctx: { workspaceId?: string | null; documentId?: string } = {},
): Promise<ExtractedField[]> {
  return runExtractor({ spec: SPEC, imageUrls, ...ctx });
}
