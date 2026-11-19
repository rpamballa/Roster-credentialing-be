/**
 * The `roster-internal` adapter — Signal's v0 reference implementation
 * of `AdapterContract`.
 *
 * Wraps the five internal readers (providers / jobs / facilities /
 * credentials / conversations) that WS C built against Roster's own
 * tables (apps/providers/cases/facilities/credentials/outreach). The
 * readers still return canonical `signal_*` shapes exactly as before —
 * this adapter is the thin shim that slots them into the new
 * ingestion framework so the scheduler can treat them uniformly with
 * future external adapters.
 *
 * `sync()` here is a full bulk pass (no cursor) because the five
 * readers already scan Roster's own tables in bulk. Running them a
 * second time is a no-op on unchanged data — the existing runner's
 * lineage-based idempotency handles that. Wiring this into
 * `runIngestOnce` keeps WS C's contracts intact.
 */

import { runIngestOnce } from "../runner.js";
import { rosterInternalAdapter as internalReaders } from "../readers/index.js";
import type {
  AdapterBackfillResult,
  AdapterCapability,
  AdapterContext,
  AdapterContract,
  AdapterHealth,
  AdapterPreview,
  AdapterSyncResult,
} from "./contract.js";

/** Stable name — must match the lineage `external_system` WS C used. */
export const ROSTER_INTERNAL = "roster-internal" as const;

async function previewInternal(ctx: AdapterContext): Promise<AdapterPreview> {
  const readerCtx = { workspaceId: ctx.workspaceId };
  const [providers, jobs, facilities, credentials, conversations] = await Promise.all([
    internalReaders.readProviders(readerCtx),
    internalReaders.readJobs(readerCtx),
    internalReaders.readFacilities(readerCtx),
    internalReaders.readCredentials(readerCtx),
    internalReaders.readConversations(readerCtx),
  ]);
  const total =
    providers.length +
    jobs.length +
    facilities.length +
    credentials.length +
    conversations.length;
  // 500 rows/min is a conservative throughput floor for the current
  // bulk-scan readers — real numbers will land once the first external
  // adapter runs against a 10k-row dataset.
  const estimatedBackfillMinutes = total > 0 ? Math.max(1, Math.ceil(total / 500)) : 0;
  return {
    providerCount: providers.length,
    jobCount: jobs.length,
    facilityCount: facilities.length,
    credentialCount: credentials.length,
    conversationCount: conversations.length,
    estimatedBackfillMinutes,
  };
}

async function syncInternal(ctx: AdapterContext, _cursor: unknown): Promise<AdapterSyncResult> {
  const summary = await runIngestOnce({ workspaceId: ctx.workspaceId });
  const counts: Partial<Record<AdapterCapability, number>> = {
    providers: summary.rowsUpserted.providers ?? 0,
    jobs: summary.rowsUpserted.jobs ?? 0,
    facilities: summary.rowsUpserted.facilities ?? 0,
    credentials: summary.rowsUpserted.credentials ?? 0,
    conversations: summary.rowsUpserted.conversations ?? 0,
  };
  const notes: string[] = [];
  for (const err of summary.errors) {
    notes.push(`${err.reader}: ${err.message}${err.openedCircuit ? " [breaker opened]" : ""}`);
  }
  for (const gap of summary.gaps) {
    notes.push(`${gap.kind}: ${gap.detail}`);
  }
  // Only surface an adapter-level error when EVERY reader fell over —
  // partial success is still success for the scheduler's purposes.
  if (summary.errors.length > 0 && summary.errors.length === summary.readersRun.length) {
    throw new Error(
      `roster-internal: every reader errored — ${summary.errors
        .map((e) => `${e.reader}:${e.message}`)
        .join("; ")}`,
    );
  }
  return { cursor: null, counts, notes };
}

async function backfillInternal(ctx: AdapterContext, _since: Date): Promise<AdapterBackfillResult> {
  const sync = await syncInternal(ctx, null);
  return {
    cursor: sync.cursor,
    counts: sync.counts,
    ...(sync.notes ? { notes: sync.notes } : {}),
  };
}

async function healthInternal(_ctx: AdapterContext): Promise<AdapterHealth> {
  return {
    ok: true,
    detail: "roster-internal reads Roster's own tables; always available.",
  };
}

export const rosterInternalAdapter: AdapterContract = {
  name: ROSTER_INTERNAL,
  supports: ["providers", "jobs", "facilities", "credentials", "conversations"] as const,
  cadenceMs: 60 * 60 * 1000,
  preview: previewInternal,
  sync: syncInternal,
  backfill: backfillInternal,
  health: healthInternal,
};
