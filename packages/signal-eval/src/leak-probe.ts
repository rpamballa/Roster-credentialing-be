/**
 * `@cred/signal-eval` · cross-tenant leak probe
 * ---------------------------------------------
 * The ranker's workspace_id filter in `withWorkspace` is the one
 * enforcement point for tenant isolation. If a code path ever skips
 * it, a provider from tenant B could leak into tenant A's ranked
 * output. This probe is a regression test for that failure mode.
 *
 * Procedure:
 *
 *   1. Seed tenant A with the fixture. Run the harness. Snapshot
 *      every req's ranker top-K (providerId AND NPI).
 *   2. Seed tenant B with the SAME fixture but with distinct NPIs
 *      (via `seedFixtureForTenantB`). Tenant B's providers carry
 *      strong signals — matching sub-specialty, matching state,
 *      active credentials, pay band within range — that would
 *      shift A's ranking IF they leaked.
 *   3. Re-run the harness on tenant A. Compare its new rankings to
 *      the step-1 snapshot BYTE-IDENTICALLY (score, earliestStart,
 *      providerId, reasons).
 *
 * A single differing byte on any req means tenant B's rows reached
 * tenant A's scoring path → leak → test fails.
 */

import type { EvalFixture } from "./fixture.js";
import type { EvalResult } from "./runEval.js";
import { runEval } from "./runEval.js";
import type { SeedArgs } from "./seed.js";
import { seedFixture, seedFixtureForTenantB } from "./seed.js";

export interface LeakProbeArgs {
  tenantAWorkspaceId: string;
  tenantBWorkspaceId: string;
  fixture: EvalFixture;
  k?: number;
  today?: Date;
}

export interface LeakProbeDiff {
  reqId: string;
  before: {
    rankerTop: string[];
    perReqPrecision: number;
  };
  after: {
    rankerTop: string[];
    perReqPrecision: number;
  };
}

export interface LeakProbeResult {
  leakDetected: boolean;
  diffs: LeakProbeDiff[];
  tenantABefore: EvalResult;
  tenantAAfter: EvalResult;
}

export async function runLeakProbe(args: LeakProbeArgs): Promise<LeakProbeResult> {
  const { fixture, tenantAWorkspaceId, tenantBWorkspaceId } = args;

  // 1. Seed and rank tenant A alone.
  const seedA = await seedFixture({ workspaceId: tenantAWorkspaceId, fixture });
  const before = await runEval({
    workspaceId: tenantAWorkspaceId,
    fixture,
    seed: seedA,
    ...(args.k !== undefined ? { k: args.k } : {}),
    ...(args.today !== undefined ? { today: args.today } : {}),
  });

  // 2. Seed tenant B with the same fixture + strong signals that
  //    would shift A's ranking if the workspace filter were missing.
  const seedBArgs: SeedArgs = { workspaceId: tenantBWorkspaceId, fixture };
  await seedFixtureForTenantB(seedBArgs);

  // 3. Re-rank tenant A. Nothing about tenant A changed; result MUST
  //    match `before` exactly.
  const after = await runEval({
    workspaceId: tenantAWorkspaceId,
    fixture,
    seed: seedA,
    ...(args.k !== undefined ? { k: args.k } : {}),
    ...(args.today !== undefined ? { today: args.today } : {}),
  });

  const diffs: LeakProbeDiff[] = [];
  const beforeByReq = new Map(before.perReq.map((r) => [r.reqId, r]));
  for (const afterRow of after.perReq) {
    const beforeRow = beforeByReq.get(afterRow.reqId);
    if (!beforeRow) {
      // Should not happen — same fixture, same seed — but surface
      // it as a leak-shaped failure anyway.
      diffs.push({
        reqId: afterRow.reqId,
        before: { rankerTop: [], perReqPrecision: 0 },
        after: {
          rankerTop: afterRow.rankerTop,
          perReqPrecision: afterRow.precisionAtK,
        },
      });
      continue;
    }
    const sameTop =
      beforeRow.rankerTop.length === afterRow.rankerTop.length &&
      beforeRow.rankerTop.every((v, i) => v === afterRow.rankerTop[i]);
    const samePrecision = beforeRow.precisionAtK === afterRow.precisionAtK;
    if (!sameTop || !samePrecision) {
      diffs.push({
        reqId: afterRow.reqId,
        before: {
          rankerTop: beforeRow.rankerTop,
          perReqPrecision: beforeRow.precisionAtK,
        },
        after: {
          rankerTop: afterRow.rankerTop,
          perReqPrecision: afterRow.precisionAtK,
        },
      });
    }
  }

  return {
    leakDetected: diffs.length > 0,
    diffs,
    tenantABefore: before,
    tenantAAfter: after,
  };
}
