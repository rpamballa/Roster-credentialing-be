import mammoth from "mammoth";

/**
 * Extract plain-text contents from a Word document (`.docx` or the legacy
 * `.doc` binary format — mammoth handles both).
 *
 * Used by the facility-ingest path so a `.docx` upload can be fed to
 * `parseFacilityPacket` as text. Loses page layout, so bbox citations are
 * unavailable — the model's `bbox_citation` fields in the response will be
 * absent. Acceptable for the beta text-heavy compliance-doc flow.
 *
 * Throws when the document contains no extractable text (encrypted, empty,
 * or exotic-format file).
 */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const extracted = await mammoth.extractRawText({ buffer });
  const text = extracted.value.trim();
  if (!text) throw new Error("Word document contained no extractable text");
  return text;
}
