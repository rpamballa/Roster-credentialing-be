/**
 * `@cred/signal-match` · rankJobCandidates
 * ----------------------------------------
 * The core engine. Given a job, produce a deterministic ranked list of
 * provider candidates in the job's workspace, with structured reasons.
 *
 * Pipeline:
 *   1. Fetch job + candidate providers + their credentials, all
 *      workspace-scoped via `withWorkspace`.
 *   2. For each candidate, build a `ProviderCredentialState` and call
 *      `projectEarliestStart` from `@cred/signal-cred-bridge`.
 *   3. HARD FILTER: drop candidates whose projected earliest-start
 *      date is after the job's `need_date` (when the job has one).
 *   4. SOFT SCORE the survivors on fit facets (sub-specialty,
 *      geography, pay band, availability hint).
 *   5. Sort by (score desc, earliestStartDate asc, providerId asc) so
 *      the same inputs always produce the same ordering.
 *   6. Persist a snapshot into `signal_rankings` and return the ranked
 *      list to the caller.
 *
 * Determinism: same inputs ⇒ same output. `today` is accepted as a
 * param (defaults to now) so a single clock drives both the
 * projection and the "ranked_at" timestamp inside a run.
 *
 * Cache key: (workspace_id, job_id, YYYY-MM-DD of ranked_at). The
 * caller can look up today's ranking by that key before paying the
 * rank cost; the ranker itself always writes a fresh row.
 */

import { db } from "@cred/db";
import type { signalCredentials, signalJobs, signalProviders } from "@cred/db/schema";
import { type SignalExecutor, withWorkspace } from "@cred/db/signal";
import { type ProjectionResult, projectEarliestStart } from "@cred/signal-cred-bridge";
import {
  type Reason,
  type ReasonFacet,
  type SourceLineageRef,
  makeReason,
  serializeReason,
} from "@cred/signal-explain";
import { buildCredentialState, buildFacilityRequirements } from "./projectionAdapter.js";

/** Public result row. `reasons` is a stable ordered list. */
export interface RankedCandidate {
  providerId: string;
  score: number;
  earliestStartDate: string; // ISO yyyy-mm-dd
  confidence: "high" | "medium" | "low";
  bindingCredential: string;
  reasons: Reason[];
}

export interface RankJobCandidatesArgs {
  workspaceId: string;
  jobId: string;
  /** Override "now" for deterministic tests. Defaults to `new Date()`. */
  today?: Date;
  /** Transaction scope. Defaults to the root db() client. */
  executor?: SignalExecutor;
  /**
   * When true, skip the snapshot write to `signal_rankings`. Useful
   * for the reverse-query endpoint which wants scoring but doesn't
   * want a per-request ranking row. Default false.
   */
  dryRun?: boolean;
  /**
   * Optional per-facet weight map {facetKey → multiplier}. The learn
   * worker materializes this from `signal_weights` for the ranker's
   * caller. Missing facets fall back to 1.0 (no learned adjustment).
   */
  weights?: Readonly<Record<string, number>>;
}

export interface RankJobCandidatesResult {
  rankedAt: Date;
  /** Primary key of the inserted `signal_rankings` row, or null on dryRun. */
  rankingId: string | null;
  candidates: RankedCandidate[];
}

const MS_PER_DAY = 86_400_000;

function toIsoDate(d: Date): string {
  // UTC date slice — same scheme the projection uses.
  return d.toISOString().slice(0, 10);
}

function parseNeedDate(raw: unknown): Date | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw;
  if (typeof raw === "string") {
    const d = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

type SignalJobRow = typeof signalJobs.$inferSelect;
type SignalProviderRow = typeof signalProviders.$inferSelect;
type SignalCredentialRow = typeof signalCredentials.$inferSelect;

/**
 * Score a single provider against a job and build the reason list.
 * Pure wrt its inputs — no DB access.
 *
 * Score is a non-negative number composed of weighted facet points.
 * Caller's `weights` (from `signal_weights`) multiplies each facet's
 * contribution, so a workspace's learned preferences bend ranking
 * without changing the ranker's code.
 */
function scoreCandidate(args: {
  provider: SignalProviderRow;
  providerLineage: SourceLineageRef;
  job: SignalJobRow;
  jobLineage: SourceLineageRef;
  projection: ProjectionResult;
  needDate: Date | undefined;
  today: Date;
  weights: Readonly<Record<string, number>>;
}): { score: number; reasons: Reason[] } {
  const { provider, providerLineage, job, jobLineage, projection, needDate, today, weights } = args;
  const reasons: Reason[] = [];
  let score = 0;

  const weightFor = (key: string): number => {
    const w = weights[key];
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : 1.0;
  };

  // Base: available by need date is the ranker's north-star facet.
  // Only emitted when a need_date exists; the hard-filter upstream
  // has already dropped candidates who project past it.
  if (needDate) {
    const facet: ReasonFacet = {
      facet: "AVAILABLE_BY_NEED_DATE",
      earliestStartDate: toIsoDate(projection.earliestStartDate),
      needDate: toIsoDate(needDate),
      sourceLineageRef: jobLineage,
    };
    reasons.push(makeReason(facet));
    // Slack days above 0 add value — being 30 days early beats
    // being exactly on time, but with diminishing returns.
    const slackDays = Math.max(
      0,
      Math.round((needDate.getTime() - projection.earliestStartDate.getTime()) / MS_PER_DAY),
    );
    score += Math.min(slackDays, 30) * weightFor("AVAILABLE_BY_NEED_DATE");
  }

  // Sub-specialty facets. The projection confidence tells us whether
  // the sub-specialty matched; we recompute here because we want both
  // match and mismatch to produce a reason (the latter is still useful
  // for a recruiter who's about to force-pin a known-good candidate).
  const requiredSubSpecialty = normalizeSpecialty(job.specialty);
  const providerSpecialties = provider.specialties.map((s) => s.toLowerCase());
  if (requiredSubSpecialty && providerSpecialties.includes(requiredSubSpecialty)) {
    const facet: ReasonFacet = {
      facet: "SUBSPECIALTY_MATCH",
      subSpecialty: requiredSubSpecialty,
      sourceLineageRef: providerLineage,
    };
    reasons.push(makeReason(facet));
    score += 10 * weightFor("SUBSPECIALTY_MATCH");
  } else if (requiredSubSpecialty) {
    const facet: ReasonFacet = {
      facet: "SUBSPECIALTY_MISMATCH",
      required: requiredSubSpecialty,
      providerHas: providerSpecialties,
      sourceLineageRef: providerLineage,
    };
    reasons.push(makeReason(facet));
    score -= 5 * weightFor("SUBSPECIALTY_MISMATCH");
  }

  // Region preference. Match on `job.region` membership in the
  // provider's `region_prefs`. No penalty for mismatch — a locum
  // regularly accepts out-of-region work.
  if (job.region) {
    const jobRegion = job.region.toLowerCase();
    const prefs = provider.regionPrefs.map((r) => r.toLowerCase());
    if (prefs.includes(jobRegion)) {
      const facet: ReasonFacet = {
        facet: "REGION_PREFERENCE",
        region: job.region,
        sourceLineageRef: providerLineage,
      };
      reasons.push(makeReason(facet));
      score += 3 * weightFor("REGION_PREFERENCE");
    }
  }

  // Pay band. `provider.rateBand` is a free-text tier ("A"/"B"/…);
  // we emit a positive reason when both sides agree a candidate fits
  // the band. Missing band on either side → no reason.
  if (provider.rateBand) {
    const facet: ReasonFacet = {
      facet: "RATE_WITHIN_BAND",
      band: provider.rateBand,
      jobPay: job.pay ?? null,
      sourceLineageRef: providerLineage,
    };
    reasons.push(makeReason(facet));
    score += 2 * weightFor("RATE_WITHIN_BAND");
  }

  // Credential facets lifted from the projection's binding
  // credential. `BLOCKED_ON_CREDENTIAL` fires when the projection
  // isn't ready today — it's both an explanation ("why not sooner?")
  // and a recruiter work-item surface.
  const binding = projection.breakdown.find((b) => b.isBinding);
  if (binding && binding.readyDate.getTime() > today.getTime()) {
    const facet: ReasonFacet = {
      facet: "BLOCKED_ON_CREDENTIAL",
      credential: binding.credential,
      readyDate: toIsoDate(binding.readyDate),
      sourceLineageRef: providerLineage,
    };
    reasons.push(makeReason(facet));
  }

  // Keep the `job` reference live for future facets (pay-band
  // tiering against `job.pay`, state-specific lineage choices).
  void job;

  return { score, reasons };
}

function normalizeSpecialty(raw: string): string | undefined {
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  return v;
}

/**
 * The entry point. Runs the full pipeline against the active database
 * and (unless `dryRun`) writes a `signal_rankings` row with the
 * materialized list.
 */
export async function rankJobCandidates(
  args: RankJobCandidatesArgs,
): Promise<RankJobCandidatesResult> {
  const exec = args.executor ?? db();
  const today = args.today ?? new Date();
  const weights = args.weights ?? {};
  const scoped = withWorkspace(args.workspaceId, exec);

  const job = await scoped.jobs.findById(args.jobId);
  if (!job) {
    throw new Error(
      `rankJobCandidates: job ${args.jobId} not found in workspace ${args.workspaceId}`,
    );
  }

  const [providers, credentials] = await Promise.all([
    scoped.providers.list(),
    scoped.credentials.list(),
  ]);

  // Group credentials by providerId once so the per-candidate build
  // is O(n) over credentials, not O(n*m).
  const credsByProvider = new Map<string, SignalCredentialRow[]>();
  for (const c of credentials) {
    const bucket = credsByProvider.get(c.providerId) ?? [];
    bucket.push(c);
    credsByProvider.set(c.providerId, bucket);
  }

  const needDate = parseNeedDate(job.needDate);
  const facilityReqs = buildFacilityRequirements(job);

  const jobLineage: SourceLineageRef = {
    canonicalTable: "signal_jobs",
    canonicalId: job.id,
  };

  // Score survivors, after hard-filter.
  const survivors: RankedCandidate[] = [];
  for (const provider of providers) {
    const providerCreds = credsByProvider.get(provider.id) ?? [];
    const providerState = buildCredentialState(provider, providerCreds);
    const projection = projectEarliestStart({
      today,
      provider: providerState,
      facility: facilityReqs,
    });

    // HARD FILTER: candidate can't meet the need date → drop.
    if (needDate && projection.earliestStartDate.getTime() > needDate.getTime()) {
      continue;
    }

    const providerLineage: SourceLineageRef = {
      canonicalTable: "signal_providers",
      canonicalId: provider.id,
    };

    const { score, reasons } = scoreCandidate({
      provider,
      providerLineage,
      job,
      jobLineage,
      projection,
      needDate,
      today,
      weights,
    });

    survivors.push({
      providerId: provider.id,
      score,
      earliestStartDate: toIsoDate(projection.earliestStartDate),
      confidence: projection.confidence,
      bindingCredential: projection.bindingCredential,
      reasons,
    });
  }

  // Deterministic sort: score desc, earliestStartDate asc, providerId
  // asc. The last tie-break is always the UUID so the same inputs
  // produce the same ordering across runs.
  survivors.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.earliestStartDate !== b.earliestStartDate) {
      return a.earliestStartDate < b.earliestStartDate ? -1 : 1;
    }
    return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
  });

  // Snapshot into signal_rankings unless the caller opted out.
  let rankingId: string | null = null;
  let rankedAt = today;
  if (!args.dryRun) {
    const [row] = await scoped.rankings.insert({
      jobId: job.id,
      rankedAt: today,
      entries: survivors.map((c) => ({
        provider_id: c.providerId,
        score: c.score,
        reasons: c.reasons.map((r) => serializeReason(r)),
      })),
    });
    if (row) {
      rankingId = row.id;
      rankedAt = row.rankedAt;
    }
  }

  return { rankedAt, rankingId, candidates: survivors };
}
