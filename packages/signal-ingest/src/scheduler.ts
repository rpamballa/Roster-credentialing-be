/**
 * Signal · ingestion framework · scheduler
 * ----------------------------------------
 *
 * The scheduler orchestrates per-(workspace, adapter) runs. It:
 *
 *   1. Loads the sync-state row from `signal_adapter_sync_state`.
 *      Creates one on first run.
 *   2. Hands the adapter its cursor + a credentials-lookup closure.
 *   3. Wraps the call in a `@cred/signal-core` circuit breaker so a
 *      flaky vendor cannot melt the API process.
 *   4. On success: writes the new cursor, resets failure counters,
 *      and closes the DB breaker column.
 *   5. On failure: increments `consecutive_failures`, writes
 *      `last_error`, and — after three consecutive failures — flips
 *      `breaker_state` to 'open'. Subsequent runs short-circuit with
 *      a `BreakerOpenInDbError` without invoking the adapter.
 *
 * The three-strike DB breaker mirrors (but is separate from) the
 * in-memory circuit breaker. In-memory handles bursts within a
 * process lifetime; DB handles outages across restarts and surfaces
 * the "stuck" state to the health dashboard.
 *
 * `runOnce` is safe to call from a route handler, a cron job, or a
 * manual `tsx` invocation. `runAllDue` is the cron entrypoint: it
 * enumerates every (workspace, adapter) pair whose last sync is
 * older than the adapter's cadence and runs them one at a time.
 *
 * DAL: the scheduler talks to `signal_adapter_sync_state` directly
 * with a workspace_id predicate on every query — not via the shared
 * `withWorkspace()` DAL. That keeps this file independent of the
 * parallel agency-context work landing in `withWorkspace`.
 *
 * Credential plumbing: adapters receive credentials via the
 * `credentials(adapter)` closure on `AdapterContext`. The
 * implementation reads from `signal_adapter_credentials` (migration
 * 0026, parallel agent). Until that migration + its decryption
 * helper land upstream, the raw encrypted bytes are forwarded; the
 * lookup returns `null` when the table is missing so `roster-internal`
 * (which doesn't call `credentials()`) keeps working and external
 * stubs still report 'not configured' cleanly.
 */

import { sql as rawSql } from "drizzle-orm";
import { db } from "@cred/db";
import { signalAdapterSyncState } from "@cred/db/schema/signal/adapterSyncState";
import { CircuitOpenError, createCircuitBreaker } from "@cred/signal-core";
import { logger } from "@cred/observability";
import type {
  AdapterContext,
  AdapterContract,
  AdapterHealth,
  AdapterLogger,
  AdapterPreview,
  AdapterSyncResult,
} from "./adapters/contract.js";
import { NotImplementedForOnboarding } from "./adapters/contract.js";
import {
  type AdapterRegistry,
  defaultAdapterRegistry,
  UnknownAdapterError,
} from "./adapters/registry.js";

/** How many consecutive failures flip the DB breaker to 'open'. */
export const DB_BREAKER_TRIP_AT = 3;

export type DbBreakerState = "closed" | "open" | "half_open";

export class BreakerOpenInDbError extends Error {
  readonly adapter: string;
  readonly workspaceId: string;
  constructor(adapter: string, workspaceId: string) {
    super(`adapter '${adapter}' is open on signal_adapter_sync_state (workspace=${workspaceId})`);
    this.name = "BreakerOpenInDbError";
    this.adapter = adapter;
    this.workspaceId = workspaceId;
  }
}

export interface RunOnceOptions {
  workspaceId: string;
  adapter: string;
  /** Override the registry (tests pass a trimmed one). */
  registry?: AdapterRegistry;
  /**
   * When true, even if the DB breaker is open, run anyway. The
   * route's reset handler flips the row back to 'closed' explicitly;
   * this flag is for a scripted "break the glass" retry only.
   */
  forceThroughBreaker?: boolean;
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface RunOnceResult {
  workspaceId: string;
  adapter: string;
  ok: boolean;
  /** When `ok` is false. */
  error?: string;
  breakerState: DbBreakerState;
  cursor: unknown;
  counts: AdapterSyncResult["counts"] | null;
  notes: string[];
  /** When the adapter errored because it's a not-yet-wired stub. */
  notImplemented?: {
    adapter: string;
    required: NotImplementedForOnboarding["required"];
  };
}

/**
 * Run a single (workspace, adapter) sync. Always resolves — errors
 * are reported on the returned `ok` flag + `error` string. Caller
 * decides HTTP status.
 */
export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const now = opts.now ?? (() => new Date());
  const registry = opts.registry ?? defaultAdapterRegistry;
  const adapter = registry.get(opts.adapter);
  const log = logger.child({
    workspaceId: opts.workspaceId,
    adapter: adapter.name,
    scope: "signal.scheduler.runOnce",
  });

  const state = await loadOrInitState(opts.workspaceId, adapter.name);

  if (state.breakerState === "open" && !opts.forceThroughBreaker) {
    log.warn(
      { breakerState: state.breakerState, consecutiveFailures: state.consecutiveFailures },
      "adapter breaker open in DB — skipping run",
    );
    return {
      workspaceId: opts.workspaceId,
      adapter: adapter.name,
      ok: false,
      error: new BreakerOpenInDbError(adapter.name, opts.workspaceId).message,
      breakerState: "open",
      cursor: state.cursor ?? null,
      counts: null,
      notes: [],
    };
  }

  const breaker = createCircuitBreaker({
    key: `scheduler:${adapter.name}:${opts.workspaceId}`,
    errorThreshold: 0.5,
    cooldownMs: 30_000,
    minSamples: 2,
    windowSize: 4,
  });

  const adapterLogger: AdapterLogger = {
    info: (obj, msg) => log.info(obj, msg),
    warn: (obj, msg) => log.warn(obj, msg),
    error: (obj, msg) => log.error(obj, msg),
  };
  const ctx: AdapterContext = {
    workspaceId: opts.workspaceId,
    credentials: makeCredentialLookup(opts.workspaceId),
    logger: adapterLogger,
  };

  try {
    const result = await breaker.run(() => adapter.sync(ctx, state.cursor ?? null));
    await markSuccess(opts.workspaceId, state.id, now(), result);
    const refreshed = await findStateById(opts.workspaceId, state.id);
    return {
      workspaceId: opts.workspaceId,
      adapter: adapter.name,
      ok: true,
      breakerState: (refreshed?.breakerState as DbBreakerState) ?? "closed",
      cursor: result.cursor ?? refreshed?.cursor ?? null,
      counts: result.counts,
      notes: result.notes ?? [],
    };
  } catch (err) {
    const openedCircuit = err instanceof CircuitOpenError || breaker.state() === "open";
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err: serializeError(err),
        inMemoryBreakerOpen: openedCircuit,
      },
      "adapter sync failed",
    );
    const nextFailures = state.consecutiveFailures + 1;
    const tripBreaker = nextFailures >= DB_BREAKER_TRIP_AT;
    await markFailure(opts.workspaceId, state.id, now(), message, nextFailures, tripBreaker);
    const refreshed = await findStateById(opts.workspaceId, state.id);
    const out: RunOnceResult = {
      workspaceId: opts.workspaceId,
      adapter: adapter.name,
      ok: false,
      error: message,
      breakerState: (refreshed?.breakerState as DbBreakerState) ?? "closed",
      cursor: state.cursor ?? null,
      counts: null,
      notes: [],
    };
    if (err instanceof NotImplementedForOnboarding) {
      out.notImplemented = { adapter: err.adapter, required: err.required };
    }
    return out;
  }
}

export interface PreviewOptions {
  workspaceId: string;
  adapter: string;
  registry?: AdapterRegistry;
}

export interface PreviewResult {
  workspaceId: string;
  adapter: string;
  ok: boolean;
  preview: AdapterPreview | null;
  error?: string;
  notImplemented?: {
    adapter: string;
    required: NotImplementedForOnboarding["required"];
  };
}

/**
 * Dry-run: pull `adapter.preview()` without any writes. Does NOT
 * touch `signal_adapter_sync_state` — a preview is a read-only
 * operation that the onboarding UI calls to render "we'll pull 234
 * providers" copy, and failing a preview must not advance the
 * durable breaker.
 */
export async function preview(opts: PreviewOptions): Promise<PreviewResult> {
  const registry = opts.registry ?? defaultAdapterRegistry;
  const adapter = registry.get(opts.adapter);
  const log = logger.child({
    workspaceId: opts.workspaceId,
    adapter: adapter.name,
    scope: "signal.scheduler.preview",
  });
  const ctx: AdapterContext = {
    workspaceId: opts.workspaceId,
    credentials: makeCredentialLookup(opts.workspaceId),
    logger: {
      info: (obj, msg) => log.info(obj, msg),
      warn: (obj, msg) => log.warn(obj, msg),
      error: (obj, msg) => log.error(obj, msg),
    },
  };
  try {
    const p = await adapter.preview(ctx);
    return {
      workspaceId: opts.workspaceId,
      adapter: adapter.name,
      ok: true,
      preview: p,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const out: PreviewResult = {
      workspaceId: opts.workspaceId,
      adapter: adapter.name,
      ok: false,
      preview: null,
      error: message,
    };
    if (err instanceof NotImplementedForOnboarding) {
      out.notImplemented = { adapter: err.adapter, required: err.required };
    }
    return out;
  }
}

export interface HealthOptions {
  workspaceId: string;
  adapter: string;
  registry?: AdapterRegistry;
}

export interface AdapterHealthReport extends AdapterHealth {
  adapter: string;
  workspaceId: string;
  /** Live snapshot of signal_adapter_sync_state, when a row exists. */
  cursor: unknown;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  breakerState: DbBreakerState;
}

export async function adapterHealth(opts: HealthOptions): Promise<AdapterHealthReport> {
  const registry = opts.registry ?? defaultAdapterRegistry;
  const adapter = registry.get(opts.adapter);
  const ctx: AdapterContext = {
    workspaceId: opts.workspaceId,
    credentials: makeCredentialLookup(opts.workspaceId),
    logger: logger.child({
      workspaceId: opts.workspaceId,
      adapter: adapter.name,
      scope: "signal.scheduler.health",
    }),
  };
  const [state, health] = await Promise.all([
    findState(opts.workspaceId, adapter.name),
    runHealthSafely(adapter, ctx),
  ]);
  return {
    ...health,
    adapter: adapter.name,
    workspaceId: opts.workspaceId,
    cursor: state?.cursor ?? null,
    lastSyncAt: state?.lastSyncAt ? state.lastSyncAt.toISOString() : null,
    lastSuccessAt: state?.lastSuccessAt ? state.lastSuccessAt.toISOString() : null,
    lastErrorAt: state?.lastErrorAt ? state.lastErrorAt.toISOString() : null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    breakerState: (state?.breakerState as DbBreakerState) ?? "closed",
  };
}

async function runHealthSafely(
  adapter: AdapterContract,
  ctx: AdapterContext,
): Promise<AdapterHealth> {
  try {
    return await adapter.health(ctx);
  } catch (err) {
    return {
      ok: false,
      detail: `${adapter.name}: health() threw`,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ResetStateOptions {
  workspaceId: string;
  adapter: string;
  registry?: AdapterRegistry;
}

/**
 * Emergency reset: clears the cursor + breaker on this (workspace,
 * adapter) row. Does NOT touch the canonical `signal_*` tables.
 * Intended for the "break the glass" manual recovery path.
 */
export async function resetAdapterState(opts: ResetStateOptions): Promise<void> {
  const registry = opts.registry ?? defaultAdapterRegistry;
  const adapter = registry.get(opts.adapter);
  const existing = await findState(opts.workspaceId, adapter.name);
  if (existing) {
    await db().execute(rawSql`
      UPDATE signal_adapter_sync_state
      SET cursor = NULL,
          last_error = NULL,
          last_error_at = NULL,
          consecutive_failures = 0,
          breaker_state = 'closed',
          updated_at = now()
      WHERE workspace_id = ${opts.workspaceId} AND adapter = ${adapter.name}
    `);
  } else {
    await db().execute(rawSql`
      INSERT INTO signal_adapter_sync_state (workspace_id, adapter, consecutive_failures, breaker_state)
      VALUES (${opts.workspaceId}, ${adapter.name}, 0, 'closed')
      ON CONFLICT (workspace_id, adapter) DO NOTHING
    `);
  }
}

export interface RunAllDueOptions {
  workspaceIds: string[];
  registry?: AdapterRegistry;
  now?: () => Date;
}

/**
 * Iterate (workspace, adapter) pairs whose `last_sync_at` is older
 * than the adapter's cadence (or null) and run each one. Serial —
 * concurrency across adapters is a v1 improvement once the first
 * real external adapter lands and tells us whether the DB connection
 * pool can handle it.
 *
 * Adapters with `cadenceMs === null` are skipped — they only run on
 * manual triggers.
 */
export async function runAllDue(opts: RunAllDueOptions): Promise<RunOnceResult[]> {
  const registry = opts.registry ?? defaultAdapterRegistry;
  const now = opts.now ?? (() => new Date());
  const out: RunOnceResult[] = [];
  for (const workspaceId of opts.workspaceIds) {
    const rows = await findStates(workspaceId);
    const byAdapter = new Map(rows.map((r) => [r.adapter, r]));
    for (const adapter of registry.all()) {
      if (adapter.cadenceMs === null) continue;
      const state = byAdapter.get(adapter.name);
      const last = state?.lastSyncAt ? state.lastSyncAt.getTime() : 0;
      if (now().getTime() - last < adapter.cadenceMs) continue;
      const result = await runOnce({
        workspaceId,
        adapter: adapter.name,
        registry,
        ...(opts.now ? { now: opts.now } : {}),
      });
      out.push(result);
    }
  }
  return out;
}

// ─── DAL helpers (raw SQL; workspace_id on every predicate) ──────────

type SyncStateRow = typeof signalAdapterSyncState.$inferSelect;

async function rowsFromExecute(result: unknown): Promise<SyncStateRow[]> {
  const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return (list as Array<Record<string, unknown>>).map(mapRow);
}

function mapRow(r: Record<string, unknown>): SyncStateRow {
  // Column names come back snake_case from the driver; drizzle's
  // $inferSelect expects camelCase. Normalize here so the rest of the
  // file sees a stable shape.
  return {
    id: r.id as string,
    workspaceId: (r.workspace_id ?? r.workspaceId) as string,
    adapter: r.adapter as string,
    cursor: (r.cursor ?? null) as SyncStateRow["cursor"],
    lastSyncAt: toDate(r.last_sync_at ?? r.lastSyncAt),
    lastSuccessAt: toDate(r.last_success_at ?? r.lastSuccessAt),
    lastError: (r.last_error ?? r.lastError ?? null) as string | null,
    lastErrorAt: toDate(r.last_error_at ?? r.lastErrorAt),
    consecutiveFailures: Number(r.consecutive_failures ?? r.consecutiveFailures ?? 0),
    breakerState: (r.breaker_state ?? r.breakerState) as string,
    createdAt: toDate(r.created_at ?? r.createdAt) ?? new Date(0),
    updatedAt: toDate(r.updated_at ?? r.updatedAt) ?? new Date(0),
  };
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") return new Date(v);
  return null;
}

async function findState(workspaceId: string, adapter: string): Promise<SyncStateRow | undefined> {
  const result = await db().execute(rawSql`
    SELECT * FROM signal_adapter_sync_state
    WHERE workspace_id = ${workspaceId} AND adapter = ${adapter}
    LIMIT 1
  `);
  return (await rowsFromExecute(result))[0];
}

async function findStateById(
  workspaceId: string,
  id: string,
): Promise<SyncStateRow | undefined> {
  const result = await db().execute(rawSql`
    SELECT * FROM signal_adapter_sync_state
    WHERE workspace_id = ${workspaceId} AND id = ${id}
    LIMIT 1
  `);
  return (await rowsFromExecute(result))[0];
}

async function findStates(workspaceId: string): Promise<SyncStateRow[]> {
  const result = await db().execute(rawSql`
    SELECT * FROM signal_adapter_sync_state
    WHERE workspace_id = ${workspaceId}
  `);
  return rowsFromExecute(result);
}

async function loadOrInitState(workspaceId: string, adapter: string): Promise<SyncStateRow> {
  const existing = await findState(workspaceId, adapter);
  if (existing) return existing;
  const result = await db().execute(rawSql`
    INSERT INTO signal_adapter_sync_state (workspace_id, adapter, consecutive_failures, breaker_state)
    VALUES (${workspaceId}, ${adapter}, 0, 'closed')
    ON CONFLICT (workspace_id, adapter) DO UPDATE SET updated_at = now()
    RETURNING *
  `);
  const [row] = await rowsFromExecute(result);
  if (!row) throw new Error("loadOrInitState: insert returned no row");
  return row;
}

async function markSuccess(
  workspaceId: string,
  id: string,
  at: Date,
  result: AdapterSyncResult,
): Promise<void> {
  const cursorJson = JSON.stringify(result.cursor ?? null);
  await db().execute(rawSql`
    UPDATE signal_adapter_sync_state
    SET cursor = ${cursorJson}::jsonb,
        last_sync_at = ${at.toISOString()}::timestamptz,
        last_success_at = ${at.toISOString()}::timestamptz,
        last_error = NULL,
        last_error_at = NULL,
        consecutive_failures = 0,
        breaker_state = 'closed',
        updated_at = now()
    WHERE workspace_id = ${workspaceId} AND id = ${id}
  `);
}

async function markFailure(
  workspaceId: string,
  id: string,
  at: Date,
  message: string,
  nextFailures: number,
  trip: boolean,
): Promise<void> {
  const nextState = trip ? "open" : "closed";
  const clipped = message.slice(0, 2_000);
  await db().execute(rawSql`
    UPDATE signal_adapter_sync_state
    SET last_sync_at = ${at.toISOString()}::timestamptz,
        last_error = ${clipped},
        last_error_at = ${at.toISOString()}::timestamptz,
        consecutive_failures = ${nextFailures},
        breaker_state = ${nextState},
        updated_at = now()
    WHERE workspace_id = ${workspaceId} AND id = ${id}
  `);
}

// ─── Credential plumbing ─────────────────────────────────────────────

/**
 * Per-workspace credential-reader closure. We look up the encrypted
 * payload directly from `signal_adapter_credentials` and forward it
 * to the caller. Decryption lives on the adapter side (adapters can
 * use `@cred/signal-knowledge`'s `decryptCredential` once that
 * package stabilises).
 *
 * The SQL stays tenant-scoped: the WHERE clause pins workspace_id to
 * the context's workspaceId, so one workspace cannot read another's
 * credentials even if the adapter name is passed in verbatim from an
 * HTTP param.
 */
function makeCredentialLookup(
  workspaceId: string,
): (adapter: string) => Promise<Record<string, unknown> | null> {
  return async (adapter: string) => {
    try {
      const result = await db().execute(rawSql`
        SELECT encrypted_payload, payload_version
        FROM signal_adapter_credentials
        WHERE workspace_id = ${workspaceId} AND adapter = ${adapter}
        LIMIT 1
      `);
      const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
      const row = list[0] as { encrypted_payload: Buffer; payload_version: number } | undefined;
      if (!row) return null;
      // TODO(#155): decrypt via @cred/signal-knowledge's
      // `decryptCredential` once that package ships. For now we
      // forward the ciphertext so an adapter can implement its own
      // decryption at the call site.
      return {
        __ciphertext: row.encrypted_payload,
        __payloadVersion: row.payload_version,
      };
    } catch (err) {
      // `signal_adapter_credentials` is owned by migration 0026
      // (parallel agent). If that migration hasn't run yet, treat
      // credentials as absent so the external stubs keep reporting
      // `not configured` without failing the whole run.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        { workspaceId, adapter, err: message },
        "credential lookup failed (table missing? migration 0026 pending?) — treating as not configured",
      );
      return null;
    }
  };
}

// ─── Error serializer ────────────────────────────────────────────────

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof NotImplementedForOnboarding) return err.toJSON();
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return { value: String(err) };
}

// ─── Re-exports ──────────────────────────────────────────────────────

export { UnknownAdapterError };
export { NotImplementedForOnboarding } from "./adapters/contract.js";
