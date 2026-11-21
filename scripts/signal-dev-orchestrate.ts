/**
 * signal-dev-orchestrate.ts
 *
 * One-shot orchestration for bringing Signal v0 to life on the dev
 * instance (the shared roster-prod VM). Intended to be executed
 * INSIDE the api container via:
 *
 *   docker compose exec api tsx scripts/signal-dev-orchestrate.ts
 *
 * Steps (idempotent — safe to re-run):
 *   1. Flip `workspaces.signal_enabled = true` on the platform-default
 *      workspace.
 *   2. Run WS C's `runIngestOnce` for that workspace.
 *   3. Backfill `signal_jobs.state` + `.pay` from the seed values
 *      (ingest leaves them NULL — see readers/jobs.ts header).
 *   4. Run WS E's `runExtracts` once.
 *   5. Rank every signal_job for the workspace so signal_rankings has
 *      a snapshot per job (prereq for applyOverridesToWeights).
 *   6. Apply post-ingest overrides SQL (seed-signal-dev-overrides.sql)
 *      and call applyOverridesToWeights so signal_weights moves off
 *      defaults in a reproducible way.
 *   7. Re-rank two representative seed jobs with the learned weights
 *      (dryRun) so the caller can compare top-3 before/after.
 *   8. Mint a staff session for a chosen operator email so the caller
 *      can curl `/v1/signal/jobs/:id/ranking` with a real cookie.
 *   9. Print a JSON summary with the seeded job ids + the session id
 *      so the caller can pick 2–3 to rank.
 *
 * Output is ONE JSON blob on the last stdout line so the SSH caller
 * can `jq` the result. Everything else goes to stderr.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, schema } from "@cred/db";
import { createSession } from "@cred/auth";
import { runIngestOnce } from "@cred/signal-ingest";
import { runExtracts } from "@cred/signal-extracts";
import { applyOverridesToWeights, readWeights } from "@cred/signal-learn";
import { rankJobCandidates } from "@cred/signal-match";
import { and, eq, sql } from "drizzle-orm";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SAMPLE_JOB_EXTERNAL_IDS = [
  "e0000001-0000-0000-0000-000000000008", // Nashville cardiac — Alex Morgan promoted
  "e0000001-0000-0000-0000-000000000029", // Atlanta cardiac — Priya Delgado promoted
] as const;

function log(msg: string): void {
  process.stderr.write(`[orchestrate] ${msg}\n`);
}

async function main(): Promise<void> {
  const operatorEmail =
    process.env.SIGNAL_DEV_OPERATOR_EMAIL ?? "revanth.pamballa@rosterhealthcare.com";

  // 1. Resolve the platform-default workspace.
  const [ws] = await db()
    .select({ id: schema.workspaces.id, slug: schema.workspaces.slug })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.isPlatformDefault, true))
    .limit(1);
  if (!ws) throw new Error("no platform-default workspace");
  log(`workspace ${ws.slug} (${ws.id})`);

  // Flip signal_enabled on.
  await db()
    .update(schema.workspaces)
    .set({ signalEnabled: true })
    .where(eq(schema.workspaces.id, ws.id));
  log("workspaces.signal_enabled = true");

  // 2. Run ingest.
  const ingest = await runIngestOnce({ workspaceId: ws.id });
  log(
    `ingest: readers=${ingest.readersRun.join(",")} upserted=${JSON.stringify(ingest.rowsUpserted)} errors=${ingest.errors.length}`,
  );
  if (ingest.errors.length > 0) {
    for (const e of ingest.errors) log(`  err[${e.reader}]: ${e.message}`);
  }

  // 3. Backfill signal_jobs.state from facility address trailer
  //    `City, STATE ZIP`. The jobs reader deliberately leaves state
  //    NULL (cases table lacks it); ranking needs it for IMLC lookup
  //    + license checks. We do the backfill here so a re-ingest also
  //    re-populates it.
  const backfill = await db().execute(sql`
    UPDATE signal_jobs sj
    SET state = sub.state
    FROM (
      SELECT f.id AS facility_id,
             upper(substring(f.address FROM ',\\s*([A-Z]{2})\\s+\\d{5}\\s*$')) AS state
      FROM facilities f
    ) sub
    WHERE sj.workspace_id = ${ws.id}
      AND sj.facility_id = sub.facility_id
      AND sub.state IS NOT NULL
      AND (sj.state IS NULL OR sj.state <> sub.state)
    RETURNING sj.id
  `);
  log(`backfilled state on ${backfill.length} signal_jobs rows`);

  // 3b. Backfill signal_jobs.pay from the seed values. cases.pay
  //     doesn't exist, so the jobs reader leaves pay NULL. The seed
  //     SQL carries the same mapping for operators who re-run it
  //     outside this script; this inline version keeps orchestration
  //     self-contained.
  const seedPaySqlPath = resolve(__dirname, "seed-signal-dev.sql");
  // We don't execute the whole seed file here — just the pay CTE. We
  // lift the VALUES list directly from the source of truth so the
  // orchestration script and the seed SQL can't drift.
  const paySeedRows = extractPayValuesFromSeed(readFileSync(seedPaySqlPath, "utf8"));
  if (paySeedRows.length > 0) {
    const values = paySeedRows
      .map(([ext, pay]) => `('${ext}'::text, ${pay.toFixed(2)})`)
      .join(",");
    const payBackfill = await db().execute(sql`
      WITH seed_pay(ext_id, pay) AS (VALUES ${sql.raw(values)})
      UPDATE signal_jobs sj
      SET pay = sub.pay
      FROM seed_pay sub
      JOIN signal_source_lineage sl
        ON sl.canonical_table = 'signal_jobs'
       AND sl.external_system = 'roster-internal'
       AND sl.external_id     = sub.ext_id
      WHERE sj.id = sl.canonical_id
        AND sj.workspace_id = ${ws.id}
        AND (sj.pay IS NULL OR sj.pay::numeric <> sub.pay)
      RETURNING sj.id
    `);
    log(`backfilled pay on ${payBackfill.length} signal_jobs rows (seeded bands)`);
  }

  // 4. Run extracts.
  const extracts = await runExtracts({ workspaceId: ws.id });
  log(
    `extracts: processed=${extracts.conversationsProcessed} inserted=${extracts.extractsInserted} skipped=${extracts.extractsSkipped} bodiesHidden=${extracts.bodiesHidden}`,
  );

  // 4b. Rank every seeded job in the workspace so signal_rankings has
  //     a fresh snapshot per job. applyOverridesToWeights needs the
  //     latest ranking per overridden job to walk the reasons list.
  const allJobs = await db()
    .select({ id: schema.signalJobs.id })
    .from(schema.signalJobs)
    .where(eq(schema.signalJobs.workspaceId, ws.id));
  let ranked = 0;
  for (const j of allJobs) {
    try {
      await rankJobCandidates({ workspaceId: ws.id, jobId: j.id });
      ranked += 1;
    } catch (err) {
      log(`  rank err for job ${j.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log(`ranked ${ranked}/${allJobs.length} signal_jobs`);

  // 4c. Apply the post-ingest overrides SQL. This is a separate file
  //     because signal_jobs / signal_providers rows don't exist until
  //     the ingest has run (their UUIDs are random); we join to
  //     signal_source_lineage / signal_providers.npi to resolve them.
  const overridesSqlPath = resolve(__dirname, "seed-signal-dev-overrides.sql");
  try {
    const overridesSql = readFileSync(overridesSqlPath, "utf8");
    await db().execute(sql.raw(overridesSql));
    log("applied seed-signal-dev-overrides.sql");
  } catch (err) {
    log(`overrides SQL skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4d. Capture weights BEFORE the learn step so we can report the
  //     deltas. Initial state is usually an empty map (ranker falls
  //     back to 1.0 per facet).
  const weightsBefore = await readWeights({ workspaceId: ws.id });

  // 4e. Sample "before" rankings for a couple of representative seeded
  //     jobs, using the pre-learn weights. We look up signal_jobs.id
  //     by their external id via signal_source_lineage so this works
  //     regardless of what UUIDs ingest minted.
  const sampleJobIds = await resolveJobIds(ws.id, SAMPLE_JOB_EXTERNAL_IDS);
  const beforeSamples: SampleRanking[] = [];
  for (const { externalId, jobId } of sampleJobIds) {
    if (!jobId) continue;
    const r = await rankJobCandidates({
      workspaceId: ws.id,
      jobId,
      dryRun: true,
      weights: weightsBefore,
    });
    beforeSamples.push({ externalId, jobId, top3: topN(r.candidates, 3) });
  }

  // 4f. Run the learn worker so signal_weights absorbs the override
  //     set.
  const learn = await applyOverridesToWeights({ workspaceId: ws.id });
  log(
    `learn: considered=${learn.overridesConsidered} changes=${JSON.stringify(learn.changes)}`,
  );

  // 4g. "After" rankings with the new weights.
  const weightsAfter = await readWeights({ workspaceId: ws.id });
  const afterSamples: SampleRanking[] = [];
  for (const { externalId, jobId } of sampleJobIds) {
    if (!jobId) continue;
    const r = await rankJobCandidates({
      workspaceId: ws.id,
      jobId,
      dryRun: true,
      weights: weightsAfter,
    });
    afterSamples.push({ externalId, jobId, top3: topN(r.candidates, 3) });
  }

  // 5. Mint a staff session for the operator so the caller can curl
  //    /v1/signal/* with a real cookie. We re-use the same user's
  //    existing membership — no new memberships created.
  const [user] = await db()
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.email, operatorEmail))
    .limit(1);
  if (!user) throw new Error(`operator user ${operatorEmail} not found`);

  const [mem] = await db()
    .select({ workspaceId: schema.memberships.workspaceId })
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.userId, user.id), eq(schema.memberships.workspaceId, ws.id)),
    )
    .limit(1);
  if (!mem) throw new Error(`operator ${operatorEmail} has no membership on ${ws.slug}`);

  const sid = await createSession({
    userId: user.id,
    email: user.email,
    activeWorkspaceId: mem.workspaceId,
  });
  log(`minted staff session for ${operatorEmail}`);

  // 6. Collect a few interesting job ids (seeded ones live under a
  //    well-known UUID prefix — `e0000001-...`).
  const sampleJobs = await db()
    .select({
      id: schema.signalJobs.id,
      specialty: schema.signalJobs.specialty,
      needDate: schema.signalJobs.needDate,
      state: schema.signalJobs.state,
    })
    .from(schema.signalJobs)
    .where(eq(schema.signalJobs.workspaceId, ws.id))
    .orderBy(schema.signalJobs.needDate)
    .limit(5);

  const providerCount = await db().execute(sql`
    SELECT count(*)::int AS n FROM signal_providers WHERE workspace_id = ${ws.id}
  `);
  const credCount = await db().execute(sql`
    SELECT count(*)::int AS n FROM signal_credentials WHERE workspace_id = ${ws.id}
  `);
  const convoCount = await db().execute(sql`
    SELECT count(*)::int AS n FROM signal_conversations WHERE workspace_id = ${ws.id}
  `);
  const extrCount = await db().execute(sql`
    SELECT count(*)::int AS n FROM signal_extracts WHERE workspace_id = ${ws.id}
  `);

  const result = {
    workspaceId: ws.id,
    workspaceSlug: ws.slug,
    operatorUserId: user.id,
    operatorEmail: user.email,
    sessionId: sid,
    cookieName: "cred_sid",
    counts: {
      signal_providers: (providerCount[0] as { n: number }).n,
      signal_credentials: (credCount[0] as { n: number }).n,
      signal_conversations: (convoCount[0] as { n: number }).n,
      signal_extracts: (extrCount[0] as { n: number }).n,
      signal_jobs: sampleJobs.length > 0 ? "see sampleJobs" : 0,
      signal_rankings: ranked,
    },
    ingestSummary: {
      readersRun: ingest.readersRun,
      rowsUpserted: ingest.rowsUpserted,
      errors: ingest.errors.map((e) => ({ reader: e.reader, message: e.message })),
      gaps: ingest.gaps,
    },
    extractSummary: {
      conversationsProcessed: extracts.conversationsProcessed,
      extractsInserted: extracts.extractsInserted,
      extractsSkipped: extracts.extractsSkipped,
      bodiesHidden: extracts.bodiesHidden,
    },
    learnSummary: {
      overridesConsidered: learn.overridesConsidered,
      changes: learn.changes,
      weightsBefore,
      weightsAfter,
    },
    rankingComparison: {
      before: beforeSamples,
      after: afterSamples,
    },
    sampleJobs: sampleJobs.map((j) => ({
      id: j.id,
      specialty: j.specialty,
      needDate: j.needDate,
      state: j.state,
    })),
  };
  // Last line is a single-line JSON blob for the caller to jq.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// ─── helpers ─────────────────────────────────────────────────────

interface SampleRanking {
  externalId: string;
  jobId: string;
  top3: Array<{ providerId: string; score: number; reasonCodes: string[] }>;
}

function topN(
  cands: Array<{
    providerId: string;
    score: number;
    // Reason from @cred/signal-explain is { facet: { facet: string, ... }, humanPhrasing, ... }.
    reasons: Array<{ facet: { facet: string } }>;
  }>,
  n: number,
): SampleRanking["top3"] {
  return cands.slice(0, n).map((c) => ({
    providerId: c.providerId,
    score: c.score,
    reasonCodes: c.reasons.map((r) => r.facet.facet),
  }));
}

async function resolveJobIds(
  workspaceId: string,
  externalIds: readonly string[],
): Promise<Array<{ externalId: string; jobId: string | null }>> {
  // postgres.js bakes plain arrays as text, not pg arrays — use an
  // inlined VALUES list so we don't need ANY() over an array literal.
  if (externalIds.length === 0) return [];
  const valuesSql = externalIds
    .map((eid) => sql`(${eid})`)
    .reduce<ReturnType<typeof sql> | undefined>((acc, v) => (acc ? sql`${acc}, ${v}` : v), undefined);
  if (!valuesSql) return [];
  const rows = await db().execute<{ external_id: string; canonical_id: string }>(sql`
    SELECT sl.external_id, sl.canonical_id
    FROM signal_source_lineage sl
    JOIN (VALUES ${valuesSql}) AS wanted(ext_id) ON wanted.ext_id = sl.external_id
    WHERE sl.workspace_id = ${workspaceId}
      AND sl.canonical_table = 'signal_jobs'
      AND sl.external_system = 'roster-internal'
  `);
  const found = new Map<string, string>();
  for (const r of rows) found.set(r.external_id, r.canonical_id);
  return externalIds.map((eid) => ({ externalId: eid, jobId: found.get(eid) ?? null }));
}

/**
 * Extract the `('e0…', <pay>),` lines from the seed SQL's pay CTE so
 * orchestrate.ts and the SQL file share a single source of truth.
 * Parsing a known hand-written VALUES block — anything unparseable is
 * skipped silently (the orchestrator just does less pay backfill, the
 * seed file's own CTE still applies on manual re-run).
 */
function extractPayValuesFromSeed(seedSql: string): Array<[string, number]> {
  const re = /\('(e0000001-0000-0000-0000-[0-9a-f]+)'::text,\s*(\d+(?:\.\d+)?)\)/g;
  const out: Array<[string, number]> = [];
  for (const m of seedSql.matchAll(re)) {
    const pay = Number.parseFloat(m[2]);
    if (!Number.isFinite(pay)) continue;
    out.push([m[1], pay]);
  }
  return out;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`FATAL: ${err?.stack ?? String(err)}\n`);
    process.exit(1);
  });
