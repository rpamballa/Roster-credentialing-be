/**
 * `@cred/signal-learn` · applyOverridesToWeights
 * -----------------------------------------------
 * Replays a workspace's recent `signal_overrides` into per-tenant
 * `signal_weights`. A recruiter promoting a provider nudges each
 * facet-key that appeared in that provider's ranking entry UP; a
 * demotion nudges them DOWN. The ranker reads these weights to bend
 * future rankings toward the workspace's revealed preference.
 *
 * Strict per-tenant isolation: weights are keyed on
 * (`workspace_id`, `facet_key`) with `ON DELETE CASCADE`. Another
 * workspace's override cannot affect this workspace's weights, even
 * if it promoted a provider with the same facet mix.
 *
 * Bounds: new_weight = clamp(current_weight * step, 0.1, 3.0). The
 * multiplicative step is small (±10%) so a single override moves the
 * needle without letting a runaway stream flatten the ranker.
 *
 * Idempotency and cursors: v0 replays every override every run. A
 * future workstream can add a per-workspace watermark table so a
 * scheduled cron only applies new overrides. For now, call it from a
 * nightly job and accept that weights drift toward the geometric mean
 * of all history each invocation — that is the intended behaviour.
 */

import { db, schema } from "@cred/db";
import { type SignalExecutor, withWorkspace } from "@cred/db/signal";
import { type SQL, gte, sql } from "drizzle-orm";

const WEIGHT_UP_STEP = 1.1;
const WEIGHT_DOWN_STEP = 0.9;
const WEIGHT_MIN = 0.1;
const WEIGHT_MAX = 3.0;
const DEFAULT_WEIGHT = 1.0;

export interface ApplyOverridesArgs {
  workspaceId: string;
  /** When set, only overrides at-or-after this time are replayed. */
  since?: Date;
  executor?: SignalExecutor;
}

export interface FacetWeightChange {
  facetKey: string;
  before: number;
  after: number;
}

export interface ApplyOverridesResult {
  workspaceId: string;
  overridesConsidered: number;
  changes: FacetWeightChange[];
}

/** Clamp a multiplicative step to the sane range. */
function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_WEIGHT;
  if (n < WEIGHT_MIN) return WEIGHT_MIN;
  if (n > WEIGHT_MAX) return WEIGHT_MAX;
  return n;
}

function stepFor(direction: string): number {
  const d = direction.trim().toLowerCase();
  if (d === "pin" || d === "promote") return WEIGHT_UP_STEP;
  if (d === "unpin" || d === "demote") return WEIGHT_DOWN_STEP;
  // Unknown direction → no-op multiplier. Keeps the weight stable
  // rather than clamping to the default, which would overwrite
  // existing learned state.
  return 1.0;
}

/**
 * Read the current weights for a workspace into a plain
 * {facet_key → weight} map suitable for the ranker's `weights`
 * param.
 */
export async function readWeights(args: {
  workspaceId: string;
  executor?: SignalExecutor;
}): Promise<Record<string, number>> {
  const exec = args.executor ?? db();
  const scoped = withWorkspace(args.workspaceId, exec);
  const rows = await scoped.weights.list();
  const out: Record<string, number> = {};
  for (const r of rows) {
    const parsed = Number(r.weight);
    out[r.facetKey] = Number.isFinite(parsed) ? parsed : DEFAULT_WEIGHT;
  }
  return out;
}

/**
 * Apply all (or since-filtered) overrides for a workspace into
 * `signal_weights`. Returns the weight deltas for observability.
 */
export async function applyOverridesToWeights(
  args: ApplyOverridesArgs,
): Promise<ApplyOverridesResult> {
  const exec = args.executor ?? db();
  const scoped = withWorkspace(args.workspaceId, exec);

  // Pull the override set up front. We filter by `at >= since` in
  // SQL rather than application code so the per-workspace FK + index
  // on signal_overrides.at carry us through.
  const overridePredicate: SQL | undefined = args.since
    ? gte(schema.signalOverrides.at, args.since)
    : undefined;
  const overrides = await scoped.overrides.list(overridePredicate);

  if (overrides.length === 0) {
    return { workspaceId: args.workspaceId, overridesConsidered: 0, changes: [] };
  }

  // Load every ranking row we might need in one trip, keyed by job.
  // A workspace's job set is small (dozens at most); loading them
  // all is cheaper than one SELECT per override. We pick the most
  // recent ranking per job — a cheap tiebreak since `ranked_at` is
  // indexed.
  const rankingRows = await scoped.rankings.list();
  const latestRankingByJob = new Map<string, (typeof rankingRows)[number]>();
  for (const r of rankingRows) {
    const current = latestRankingByJob.get(r.jobId);
    if (!current || r.rankedAt.getTime() > current.rankedAt.getTime()) {
      latestRankingByJob.set(r.jobId, r);
    }
  }

  // Start from the current weights (clamped). All mutations happen
  // in memory first; the single upsert at the end keeps the write
  // set bounded to one row per touched facet.
  const nextByFacet = new Map<string, number>();
  const beforeByFacet = new Map<string, number>();
  const existing = await scoped.weights.list();
  for (const r of existing) {
    const parsed = Number(r.weight);
    const w = Number.isFinite(parsed) ? parsed : DEFAULT_WEIGHT;
    nextByFacet.set(r.facetKey, w);
    beforeByFacet.set(r.facetKey, w);
  }

  const ensure = (key: string): number => {
    const cur = nextByFacet.get(key);
    if (cur !== undefined) return cur;
    nextByFacet.set(key, DEFAULT_WEIGHT);
    if (!beforeByFacet.has(key)) beforeByFacet.set(key, DEFAULT_WEIGHT);
    return DEFAULT_WEIGHT;
  };

  for (const o of overrides) {
    const step = stepFor(o.direction);
    if (step === 1.0) continue;
    const ranking = latestRankingByJob.get(o.jobId);
    if (!ranking) continue;
    const entry = ranking.entries.find((e) => e.provider_id === o.providerId);
    if (!entry) continue;
    for (const reason of entry.reasons ?? []) {
      const key = reason.code;
      if (!key) continue;
      const cur = ensure(key);
      const proposed = clamp(cur * step);
      nextByFacet.set(key, proposed);
    }
  }

  // Materialize changes. Only rows whose weight actually moved get
  // persisted — a no-op override stream produces no writes.
  const changes: FacetWeightChange[] = [];
  for (const [facetKey, after] of nextByFacet) {
    const before = beforeByFacet.get(facetKey) ?? DEFAULT_WEIGHT;
    if (after !== before) {
      changes.push({ facetKey, before, after });
    }
  }

  // Persist with an UPSERT per changed facet. The `onConflictDoUpdate`
  // target is the unique (workspace_id, facet_key) index.
  for (const change of changes) {
    await exec
      .insert(schema.signalWeights)
      .values({
        workspaceId: args.workspaceId,
        facetKey: change.facetKey,
        weight: change.after.toString(),
      })
      .onConflictDoUpdate({
        target: [schema.signalWeights.workspaceId, schema.signalWeights.facetKey],
        set: { weight: change.after.toString(), updatedAt: sql`now()` },
      });
  }

  return {
    workspaceId: args.workspaceId,
    overridesConsidered: overrides.length,
    changes,
  };
}
