// Markdown chunker for the agency-local knowledge base.
//
// Strategy:
//   1. Split the document on top-level markdown headings (lines
//      starting with `#`). Each section becomes a chunk "group".
//   2. Inside a section, split on blank-line-separated paragraphs.
//   3. Pack paragraphs into chunks up to `maxTokens`. If a single
//      paragraph exceeds `maxTokens`, fall back to a sliding window
//      over sentences / words so we never emit a chunk larger than
//      the limit.
//   4. Each chunk after the first in a section carries a trailing
//      `overlap` tokens from the prior chunk — gives the embedder
//      and the reader a bit of context across the boundary.
//
// Token count is approximated as whitespace-separated words × 1.3,
// which lines up with the Anthropic / OpenAI rule-of-thumb for
// English prose. Good enough for chunk sizing; we're not billing by
// it.

export interface ChunkOptions {
  /** Target max tokens per chunk. Defaults to 512. */
  maxTokens?: number;
  /** Trailing overlap tokens carried into the next chunk. Defaults to 50. */
  overlap?: number;
}

const WORDS_TO_TOKENS = 1.3;

function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * WORDS_TO_TOKENS);
}

function tokenizeWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function tailWords(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return "";
  const words = tokenizeWords(text);
  // Convert overlap tokens back to approximate word count.
  const wantWords = Math.max(0, Math.round(overlapTokens / WORDS_TO_TOKENS));
  if (wantWords >= words.length) return text;
  return words.slice(words.length - wantWords).join(" ");
}

/**
 * Split a block of plain text (no further markdown structure) into
 * chunks of at most `maxTokens` with `overlap` carry-over.
 */
function slideWindow(text: string, maxTokens: number, overlap: number): string[] {
  const words = tokenizeWords(text);
  if (words.length === 0) return [];
  const wordsPerChunk = Math.max(1, Math.round(maxTokens / WORDS_TO_TOKENS));
  const overlapWords = Math.max(0, Math.round(overlap / WORDS_TO_TOKENS));
  const stride = Math.max(1, wordsPerChunk - overlapWords);

  const out: string[] = [];
  for (let start = 0; start < words.length; start += stride) {
    const end = Math.min(words.length, start + wordsPerChunk);
    out.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
  }
  return out;
}

/**
 * Split a markdown document into chunks.
 *
 * Deterministic: the same input always produces the same list.
 */
export function chunkMarkdown(text: string, options: ChunkOptions = {}): string[] {
  const maxTokens = options.maxTokens ?? 512;
  const overlap = options.overlap ?? 50;
  if (!text?.trim()) return [];

  // Split on headings. Keep the heading with the following section.
  // Simplified: we only split on top-level `#` and `##` to avoid
  // over-fragmenting on lists that start with `###`.
  const lines = text.split(/\r?\n/);
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    const isHeading = /^#{1,2}\s/.test(line);
    if (isHeading && buf.length > 0) {
      sections.push(buf.join("\n"));
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) sections.push(buf.join("\n"));

  const chunks: string[] = [];

  for (const section of sections) {
    const paragraphs = section
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    let pending = "";

    const flush = () => {
      if (pending.trim().length === 0) return;
      // If this chunk is small enough, commit it. Otherwise slide a
      // window over it so we never exceed maxTokens.
      if (estimateTokens(pending) <= maxTokens) {
        chunks.push(pending.trim());
        pending = "";
        return;
      }
      for (const windowChunk of slideWindow(pending, maxTokens, overlap)) {
        chunks.push(windowChunk);
      }
      pending = "";
    };

    for (const para of paragraphs) {
      const candidate = pending.length === 0 ? para : `${pending}\n\n${para}`;
      if (estimateTokens(candidate) <= maxTokens) {
        pending = candidate;
        continue;
      }

      // Candidate overflows. Commit what we have, then handle `para`.
      flush();
      if (estimateTokens(para) <= maxTokens) {
        // Seed next chunk with the overlap tail of the last commit
        // (if any), plus this paragraph.
        const tail =
          overlap > 0 && chunks.length > 0 ? tailWords(chunks[chunks.length - 1]!, overlap) : "";
        pending = tail ? `${tail}\n\n${para}` : para;
      } else {
        // Paragraph alone exceeds max — slide a window over it.
        for (const windowChunk of slideWindow(para, maxTokens, overlap)) {
          chunks.push(windowChunk);
        }
        pending = "";
      }
    }

    flush();
  }

  return chunks;
}
