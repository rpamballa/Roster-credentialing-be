import { describe, expect, it } from "vitest";
import { EXTRACTORS, NoExtractorError, extractByType } from "../src/extractors/index.js";

const REQUIRED = [
  "medical_license",
  "dea",
  "board_certification",
  "bls",
  "acls",
  "medical_school_diploma",
  "government_id",
  "vaccination_record",
] as const;

describe("extractor registry", () => {
  it("has one extractor per required M2 document type", () => {
    for (const t of REQUIRED) {
      expect(EXTRACTORS[t], `missing extractor for ${t}`).toBeDefined();
    }
  });

  it("throws NoExtractorError for an unsupported type", () => {
    expect(() => extractByType("malpractice_insurance", [])).toThrow(NoExtractorError);
  });
});
