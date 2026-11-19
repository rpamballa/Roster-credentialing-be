#!/usr/bin/env tsx
/**
 * Scheduler entrypoint: run every due (workspace, adapter) once.
 *
 * Usage (from a VM cron, a container entrypoint, or ad-hoc):
 *
 *   tsx packages/signal-ingest/src/bin/scheduler-run-all-due.ts \
 *     --workspaces=<id1>,<id2>   # omit to pull signal_enabled workspaces
 *
 * This is the manual-driver cron glue. A future always-on worker
 * container will import `runAllDue` directly instead; keeping the
 * logic in the function (not this script) means the two paths stay
 * identical.
 */

import { closeDb, db, schema } from "@cred/db";
import { logger } from "@cred/observability";
import { eq } from "drizzle-orm";
import { runAllDue } from "../scheduler.js";

function parseWorkspaces(argv: string[]): string[] | null {
  const flag = argv.find((a) => a.startsWith("--workspaces="));
  if (!flag) return null;
  const list = flag.slice("--workspaces=".length).trim();
  if (!list) return null;
  return list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function listSignalEnabledWorkspaces(): Promise<string[]> {
  const rows = await db()
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.signalEnabled, true));
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const explicit = parseWorkspaces(process.argv.slice(2));
  const workspaceIds = explicit ?? (await listSignalEnabledWorkspaces());
  if (workspaceIds.length === 0) {
    logger.info({}, "scheduler-run-all-due: no signal-enabled workspaces — exit 0");
    return;
  }
  logger.info({ count: workspaceIds.length }, "scheduler-run-all-due: starting");
  const results = await runAllDue({ workspaceIds });
  logger.info(
    {
      ran: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    "scheduler-run-all-due: done",
  );
  for (const r of results) {
    if (!r.ok) {
      logger.warn(
        {
          workspaceId: r.workspaceId,
          adapter: r.adapter,
          error: r.error,
          breakerState: r.breakerState,
        },
        "scheduler-run-all-due: adapter failed",
      );
    }
  }
}

main()
  .catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "scheduler-run-all-due: fatal",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
