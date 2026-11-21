/**
 * Reverse query: given a provider, what openings in the workspace are
 * they a fit for? Reuses the forward ranker in `dryRun` mode and
 * keeps per-job entries where this provider cleared the hard filter.
 *
 * Deliberately does NOT write to `signal_rankings` — that table is
 * keyed on job, not provider, so we don't want provider-side queries
 * to produce one row per provider per job every time a recruiter
 * opens their dashboard.
 */

import { db } from "@cred/db";
import { type SignalExecutor, withWorkspace } from "@cred/db/signal";
import type { Reason } from "@cred/signal-explain";
import { rankJobCandidates } from "./rank.js";

export interface ProviderOpeningFit {
  jobId: string;
  score: number;
  earliestStartDate: string;
  confidence: "high" | "medium" | "low";
  bindingCredential: string;
  reasons: Reason[];
}

export interface RankProviderOpeningsArgs {
  workspaceId: string;
  providerId: string;
  today?: Date;
  executor?: SignalExecutor;
  weights?: Readonly<Record<string, number>>;
}

export interface RankProviderOpeningsResult {
  openings: ProviderOpeningFit[];
}

/**
 * For each open job in the workspace, project this provider against
 * the facility, keep the ones where the hard filter passed, and sort
 * by score desc + earliest-start asc + jobId asc.
 */
export async function rankProviderOpenings(
  args: RankProviderOpeningsArgs,
): Promise<RankProviderOpeningsResult> {
  const exec = args.executor ?? db();
  const today = args.today ?? new Date();
  const weights = args.weights ?? {};
  const scoped = withWorkspace(args.workspaceId, exec);

  const jobs = await scoped.jobs.list();

  const openings: ProviderOpeningFit[] = [];
  for (const job of jobs) {
    // rankJobCandidates does the heavy lifting against ALL providers in
    // the workspace. For reverse queries we only need this provider's
    // row in the result; a per-job single-provider shortcut would be
    // slightly faster but would duplicate the projection code path and
    // drift from the forward ranker.
    const result = await rankJobCandidates({
      workspaceId: args.workspaceId,
      jobId: job.id,
      today,
      executor: exec,
      dryRun: true,
      weights,
    });
    const match = result.candidates.find((c) => c.providerId === args.providerId);
    if (match) {
      openings.push({
        jobId: job.id,
        score: match.score,
        earliestStartDate: match.earliestStartDate,
        confidence: match.confidence,
        bindingCredential: match.bindingCredential,
        reasons: match.reasons,
      });
    }
  }

  openings.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.earliestStartDate !== b.earliestStartDate) {
      return a.earliestStartDate < b.earliestStartDate ? -1 : 1;
    }
    return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
  });

  return { openings };
}
