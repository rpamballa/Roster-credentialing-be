/**
 * Precision@K over a ranked candidate list against an expected set.
 *
 * precisionAtK = |expected ∩ top-K(ranker)| / K
 *
 * We clamp to K (not to min(K, |expected|)) so missing a hit still
 * hurts even when the expected set has fewer entries than K. This
 * matches recruiter intuition: a top-K slot not filled by one of the
 * known-good picks is a real miss.
 */

export interface PrecisionInputs<T> {
  ranked: readonly T[];
  expected: readonly T[];
  k: number;
}

export interface PrecisionOutputs<T> {
  precisionAtK: number;
  hits: T[];
  misses: T[];
  rankerTopK: T[];
}

export function precisionAtK<T>(inputs: PrecisionInputs<T>): PrecisionOutputs<T> {
  if (!Number.isInteger(inputs.k) || inputs.k < 1) {
    throw new Error(`[signal-eval] precisionAtK: k must be a positive integer, got ${inputs.k}`);
  }
  const topK = inputs.ranked.slice(0, inputs.k);
  const expectedSet = new Set<T>(inputs.expected);
  const hits: T[] = [];
  for (const r of topK) {
    if (expectedSet.has(r)) hits.push(r);
  }
  const hitSet = new Set<T>(hits);
  const misses: T[] = [];
  for (const e of inputs.expected) {
    if (!hitSet.has(e)) misses.push(e);
  }
  return {
    precisionAtK: hits.length / inputs.k,
    hits,
    misses,
    rankerTopK: topK,
  };
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
