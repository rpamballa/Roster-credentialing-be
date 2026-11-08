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
 *   3. Backfill `signal_jobs.state` from `facilities.address` (ingest
 *      reader leaves it NULL — see readers/jobs.ts header).
 *   4. Run WS E's `runExtracts` once.
 *   5. Mint a staff session for a chosen operator email so the caller
 *      can curl `/v1/signal/jobs/:id/ranking` with a real cookie.
 *   6. Print a JSON summary with the seeded job ids + the session id
 *      so the caller can pick 2–3 to rank.
 *
 * Output is ONE JSON blob on the last stdout line so the SSH caller
 * can `jq` the result. Everything else goes to stderr.
 */

import { db, schema } from "@cred/db";
import { createSession } from "@cred/auth";
import { runIngestOnce } from "@cred/signal-ingest";
import { runExtracts } from "@cred/signal-extracts";
import { and, eq, sql } from "drizzle-orm";

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

  // 4. Run extracts.
  const extracts = await runExtracts({ workspaceId: ws.id });
  log(
    `extracts: processed=${extracts.conversationsProcessed} inserted=${extracts.extractsInserted} skipped=${extracts.extractsSkipped} bodiesHidden=${extracts.bodiesHidden}`,
  );

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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`FATAL: ${err?.stack ?? String(err)}\n`);
    process.exit(1);
  });
