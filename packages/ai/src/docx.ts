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

/**
 * Convert a Word document (`.docx` / `.doc`) to semantic HTML for inline
 * display in the review UI. Uses mammoth's built-in style map (h1/h2, p,
 * ul/ol, table, strong, em) — no inline styles, no external references,
 * no scripts. The caller injects the returned HTML via
 * dangerouslySetInnerHTML inside a scoped container.
 *
 * Returns `{ html, warnings }` — warnings names any bits mammoth could
 * not translate cleanly. Non-empty warnings do NOT throw; they're
 * informational so the caller can log.
 *
 * Throws only on: buffer read failure, or empty HTML output.
 */
export async function convertDocxToHtml(
  buffer: Buffer,
): Promise<{ html: string; warnings: string[] }> {
  const { value: html, messages } = await mammoth.convertToHtml({ buffer });
  if (!html || html.trim().length === 0) {
    throw new Error("Word document produced empty HTML");
  }
  return {
    html,
    warnings: messages.map((m) => m.message),
  };
}
