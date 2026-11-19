// Embedding for the Signal agency knowledge base.
//
// --------------------------------------------------------------------
// MODEL CHOICE (v0 scaffolding)
// --------------------------------------------------------------------
// @cred/ai does not expose an embeddings API today (it wraps Anthropic
// Messages, which Anthropic itself does not offer embeddings for).
// Rather than wire in a new paid API (Voyage, Cohere, OpenAI…) for the
// scaffolding — the scope note explicitly says "reuse what @cred/ai
// already configures" — this module ships a deterministic
// hashing-based embedder:
//
//   • dimension: 1536 (matches `vector(1536)` in migration 0026 and
//     Voyage-3-large / OpenAI-large so a swap is drop-in later)
//   • algorithm: token-count feature hashing — each whitespace token
//     is hashed into one of 1536 buckets; the bucket count is then
//     L2-normalized. This is `HashingVectorizer` from scikit-learn in
//     ~30 lines.
//
// WHAT IT IS GOOD FOR:
//   • deterministic (unit tests for isolation are stable)
//   • workspace-isolation testing (same chunk text in two workspaces
//     produces the same vector, so a cross-workspace leak would show
//     up on top; the DAL's WHERE clause is what keeps them apart)
//   • bag-of-words similarity that beats nothing, especially for
//     keyword-heavy text (which recruiter playbooks are)
//
// WHAT IT IS NOT GOOD FOR:
//   • semantic similarity ("physician" ~ "doctor"). For that, swap
//     `embedChunks` for a Voyage/Cohere/OpenAI call. The API shape is
//     already `(string[]) => Promise<number[][]>` with a fixed dim.
//
// To upgrade: add a real embedder in `@cred/ai` (e.g. Voyage), then
// change `embedChunks` to call it. No migration needed as long as the
// new embedder's dimension is also 1536.

import { createHash } from "node:crypto";

export const EMBEDDING_DIM = 1536;

/**
 * Deterministic hashing embedder. Exposed for tests / tooling — most
 * callers should use `embedChunks`.
 */
export function embedText(text: string, dim: number = EMBEDDING_DIM): number[] {
  const vector = new Array<number>(dim).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    // Zero vector would break cosine distance (division by zero); emit
    // a tiny constant unit vector so the row remains searchable
    // without special-casing.
    vector[0] = 1;
    return vector;
  }
  for (const token of tokens) {
    // Two independent hashes — one for the bucket, one for the sign —
    // reduces collision bias (signed hashing trick).
    const h1 = createHash("sha256").update(`b:${token}`).digest();
    const h2 = createHash("sha256").update(`s:${token}`).digest();
    const bucket = h1.readUInt32BE(0) % dim;
    const sign = h2.readUInt32BE(0) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  // L2-normalize so cosine distance == dot product and `<=>` returns
  // a well-behaved [0, 2] range.
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i]! / norm;
  }
  return vector;
}

/**
 * Embed a batch of chunks. Current implementation is in-process and
 * synchronous under the hood; kept async so a future Voyage/Cohere
 * swap-in is a one-line change at the call site.
 */
export async function embedChunks(chunks: string[]): Promise<number[][]> {
  return chunks.map((c) => embedText(c));
}

/**
 * Embed a single query string. Thin wrapper around `embedText` kept
 * async for symmetry with `embedChunks`.
 */
export async function embedQuery(query: string): Promise<number[]> {
  return embedText(query);
}

/**
 * Documented, stable model id — written into the knowledge-upload
 * audit log so a future re-embed job knows whether to refresh.
 */
export const EMBEDDING_MODEL_ID = "signal-hashing-v0-1536";
