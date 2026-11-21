/**
 * `@cred/signal-eval` · harness runner
 * ------------------------------------
 * Given a workspace already seeded with the fixture (via `seedFixture`),
 * call `rankJobCandidates` for each fixture req and compute
 * precision@K against the placeholder top picks.
 *
 * Determinism: we pass a fixed `today` into the ranker (defaulting to
 * the earliest needDate in the fixture minus 60 days) so the
 * projection path uses a stable clock. Same fixture + same ranker +
 * same `today` ⇒ identical result.
 */

import { rankJobCandidates } from "@cred/signal-match";
import type { EvalFixture, EvalFixtureReq } from "./fixture.js";
import { PLACEHOLDER_LABEL_SOURCE, isPlaceholderFixture, loadFixture } from "./fixture.js";
import { mean, precisionAtK } from "./precision.js";
import type { SeedResult } from "./seed.js";
import { seedFixture } from "./seed.js";

export interface RunEvalArgs {
  workspaceId: string;
  /** Pass EITHER `fixture` (already loaded) OR `fixturePath` (loaded here). */
  fixture?: EvalFixture;
  fixturePath?: string;
  k?: number;
  /**
   * Deterministic clock for the ranker. Default: earliest needDate in
   * the fixture minus 60 days — far enough back that no credential
   * cycle binds, and stable across runs because the fixture is pinned.
   */
  today?: Date;
  /**
   * Pre-seeded mapping. If omitted, the harness runs `seedFixture`
   * itself. Callers that want full control (e.g. the leak probe
   * seeding tenant B separately) pass their own mapping.
   */
  seed?: SeedResult;
  /**
   * When true, require `label_source` to be a consultant-grade label
   * (not the engineering-judgment placeholder). Default false.
   * Flip to true in the M10 promotion workflow.
   */
  requireConsultantLabels?: boolean;
}

export interface PerReqResult {
  reqId: string;
  precisionAtK: number;
  rankerTop: string[]; // top-K provider NPIs (fixture picks)
  expectedTop: string[]; // fixture picks
  hits: string[];
  misses: string[];
  /**
   * Reasons attached to the ranker's top-K candidates, keyed by NPI.
   * Lets the CI job print WHY the ranker picked each candidate.
   */
  reasonsMatched: Record<string, string[]>;
}

export interface EvalAggregate {
  meanPrecisionAtK: number;
  passedCount: number;
  failedCount: number;
  perReqPass: Record<string, boolean>;
}

export interface EvalResult {
  workspaceId: string;
  fixtureVersion: string;
  labelSource: string;
  k: number;
  perReq: PerReqResult[];
  aggregate: EvalAggregate;
  /** True when the fixture is a placeholder-labeled v0 fixture. */
  isPlaceholder: boolean;
}

const DEFAULT_K = 3;
/** A req "passes" when the ranker's top-K matches at least one expected pick. */
const PER_REQ_PASS_FLOOR = 1 / 3; // ⌊1 of 3⌋ hits counts as a pass.

export async function runEval(args: RunEvalArgs): Promise<EvalResult> {
  const fixture = args.fixture ?? (args.fixturePath ? loadFixture(args.fixturePath) : undefined);
  if (!fixture) {
    throw new Error("[signal-eval] runEval: pass either `fixture` or `fixturePath`");
  }
  if (args.requireConsultantLabels && isPlaceholderFixture(fixture)) {
    throw new Error(
      `[signal-eval] runEval: fixture label_source is "${PLACEHOLDER_LABEL_SOURCE}" — pass a consultant-labeled fixture, or remove --require-consultant-labels.`,
    );
  }

  const k = args.k ?? DEFAULT_K;
  const seed = args.seed ?? (await seedFixture({ workspaceId: args.workspaceId, fixture }));
  const today = args.today ?? deterministicClock(fixture);

  const perReq: PerReqResult[] = [];
  for (const req of fixture.reqs) {
    const jobId = seed.reqIdToJobId[req.reqId];
    if (!jobId) {
      throw new Error(`[signal-eval] runEval: no seeded jobId for req ${req.reqId}`);
    }
    const ranking = await rankJobCandidates({
      workspaceId: args.workspaceId,
      jobId,
      today,
      dryRun: true, // the eval does NOT snapshot — baselines use repeatable runs.
    });

    const topK = ranking.candidates.slice(0, k);
    const topKAsPicks = topK.map(
      (c) => seed.providerIdToPick[c.providerId] ?? `(unknown:${c.providerId})`,
    );
    const {
      precisionAtK: p,
      hits,
      misses,
    } = precisionAtK({
      ranked: topKAsPicks,
      expected: req.placeholderTopPicks,
      k,
    });
    const reasonsMatched: Record<string, string[]> = {};
    for (const [idx, cand] of topK.entries()) {
      const pick = topKAsPicks[idx];
      if (pick === undefined) continue;
      reasonsMatched[pick] = cand.reasons.map((r) => r.humanPhrasing ?? r.facet.facet);
    }
    perReq.push({
      reqId: req.reqId,
      precisionAtK: p,
      rankerTop: topKAsPicks,
      expectedTop: [...req.placeholderTopPicks],
      hits,
      misses,
      reasonsMatched,
    });
  }

  const perReqPass: Record<string, boolean> = {};
  let passed = 0;
  let failed = 0;
  for (const r of perReq) {
    const pass = r.precisionAtK >= PER_REQ_PASS_FLOOR;
    perReqPass[r.reqId] = pass;
    if (pass) passed++;
    else failed++;
  }

  return {
    workspaceId: args.workspaceId,
    fixtureVersion: fixture.fixture_version,
    labelSource: fixture.label_source,
    k,
    perReq,
    aggregate: {
      meanPrecisionAtK: mean(perReq.map((r) => r.precisionAtK)),
      passedCount: passed,
      failedCount: failed,
      perReqPass,
    },
    isPlaceholder: isPlaceholderFixture(fixture),
  };
}

function deterministicClock(fixture: EvalFixture): Date {
  // Earliest needDate minus 60 days. Stable because the fixture is
  // pinned; far enough back that no plausible credential cycle binds.
  const earliest = fixture.reqs
    .map((r) => new Date(`${r.needDate}T00:00:00Z`).getTime())
    .reduce((acc, t) => (t < acc ? t : acc), Number.POSITIVE_INFINITY);
  const base = Number.isFinite(earliest) ? earliest : Date.UTC(2026, 0, 1);
  return new Date(base - 60 * 86_400_000);
}

// Helper kept here so ad-hoc callers (ops-trigger, tests) can
// treat a req metadata only as input without typing the whole
// EvalFixtureReq shape.
export type RequirementShape = Pick<
  EvalFixtureReq,
  "reqId" | "facilityState" | "subSpecialty" | "needDate" | "payRange"
>;
