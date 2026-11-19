/**
 * Signal · ingestion framework · adapter contract
 * -----------------------------------------------
 *
 * The formal surface EVERY adapter implements — the internal
 * `roster-internal` reference adapter plus every external vendor stub
 * (Bullhorn, Avionté, LaborEdge, Salesforce, Gmail, Outlook,
 * RingCentral, Twilio). The scheduler calls this contract and nothing
 * else; adapters are free to call out to the network, handle their own
 * auth refresh, paginate, etc. — none of that leaks into the
 * scheduler.
 *
 * The contract is deliberately narrow:
 *   - `preview(ctx)`                  — dry-run; returns row-count
 *                                       estimates without any writes.
 *   - `sync(ctx, cursor)`             — incremental; returns a NEW
 *                                       cursor and the counts written.
 *   - `backfill(ctx, since)`          — explicit full/range pull.
 *   - `health(ctx)`                   — reachability + credentialing
 *                                       check; also called by the GET
 *                                       /v1/signal/adapters surface.
 *
 * Methods are permitted to throw. The scheduler wraps the call in a
 * `@cred/signal-core` circuit breaker, catches, and writes the error
 * to `signal_adapter_sync_state.last_error`. An adapter that is
 * deliberately not yet implemented should throw
 * `NotImplementedForOnboarding` with structured context — the error
 * message surfaces in the health dashboard so an onboarding engineer
 * sees exactly what's missing (credentials, scopes, environment
 * vars).
 *
 * `cursor` is opaque — adapters define its shape. The scheduler
 * persists whatever the adapter returns from `sync()` into
 * `signal_adapter_sync_state.cursor` (jsonb) and hands it back
 * unchanged on the next run. Keeping it opaque means adding a new
 * adapter never touches the scheduler.
 */

/** Rows the adapter supports emitting — the subset of signal_* shapes. */
export type AdapterCapability =
  | "providers"
  | "jobs"
  | "facilities"
  | "credentials"
  | "conversations";

/** Logger surface — matches what callers inject (observability.logger). */
export interface AdapterLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * Per-call context. Credentials are fetched lazily by the adapter —
 * the scheduler provides a closure (not the plaintext payload) so an
 * adapter that doesn't need them (`roster-internal`) never triggers a
 * DAL read.
 */
export interface AdapterContext {
  workspaceId: string;
  /**
   * Returns the decrypted credential payload for `adapter`, or `null`
   * when no credential row exists. The shape of the payload is
   * adapter-defined; adapters are expected to validate before using.
   *
   * Per-workspace isolation is enforced by the DAL this closure
   * routes through — one workspace cannot ask for another's keys.
   */
  credentials(adapter: string): Promise<Record<string, unknown> | null>;
  logger: AdapterLogger;
}

export interface AdapterPreview {
  providerCount: number;
  jobCount: number;
  facilityCount: number;
  credentialCount: number;
  conversationCount: number;
  /**
   * Rough wall-clock estimate for a full backfill, in minutes. The
   * onboarding UI uses this for the "we'll pull 234 providers,
   * estimated 2 hours" copy. Null when the adapter can't estimate yet.
   */
  estimatedBackfillMinutes: number | null;
}

export interface AdapterSyncResult {
  /**
   * The new cursor to persist on `signal_adapter_sync_state`. Opaque
   * to the scheduler. An adapter that doesn't track a cursor returns
   * `null` (treated as "no change"; the scheduler writes it through
   * verbatim so later reads see exactly what the adapter wrote).
   */
  cursor: unknown;
  /**
   * Per-shape count of rows this sync upserted. Keys match the
   * `AdapterCapability` vocabulary so one adapter's counts are
   * comparable with another's.
   */
  counts: Partial<Record<AdapterCapability, number>>;
  /**
   * Non-fatal observations the adapter wants to surface (e.g.
   * "skipped 3 records with missing specialty"). The scheduler
   * forwards these to logs; they do NOT trip the breaker.
   */
  notes?: string[];
}

export interface AdapterBackfillResult {
  /** New cursor after the backfill. Same contract as `sync`. */
  cursor: unknown;
  counts: Partial<Record<AdapterCapability, number>>;
  notes?: string[];
}

export interface AdapterHealth {
  ok: boolean;
  /** One-line human summary — shown on GET /v1/signal/adapters. */
  detail: string;
  /** Present when `ok` is false. */
  lastError?: string;
  /**
   * Adapter-defined connectivity metadata (API base URL, token
   * expiry, etc). Stays out of the wire response unless the caller
   * opts in — the health surface shows ok/detail only by default.
   */
  diagnostics?: Record<string, unknown>;
}

/** The whole adapter surface. Keep this file the only source of truth. */
export interface AdapterContract {
  /**
   * Stable name — used as the primary key on
   * `signal_adapter_sync_state.adapter`, as the external-system tag
   * on `signal_source_lineage`, and as the lookup key on
   * `signal_adapter_credentials`. Changing a name is a migration.
   */
  readonly name: string;
  /** Which canonical row shapes this adapter can produce. */
  readonly supports: readonly AdapterCapability[];
  /**
   * Scheduler cadence in milliseconds. `null` disables auto-run —
   * the adapter will only sync when triggered manually. Keep the
   * cadence conservative; the onboarding UI's "sync now" button is
   * the escape hatch when a recruiter needs fresher data.
   */
  readonly cadenceMs: number | null;

  preview(ctx: AdapterContext): Promise<AdapterPreview>;
  sync(ctx: AdapterContext, cursor: unknown): Promise<AdapterSyncResult>;
  backfill(ctx: AdapterContext, since: Date): Promise<AdapterBackfillResult>;
  health(ctx: AdapterContext): Promise<AdapterHealth>;
}

/**
 * Thrown by every external-adapter stub until a real customer with
 * that vendor onboards and we wire the integration. The structured
 * `required` payload is what the onboarding engineer will read in
 * logs and in the health dashboard — be specific.
 */
export class NotImplementedForOnboarding extends Error {
  readonly adapter: string;
  readonly required: {
    credentials?: string[];
    scopes?: string[];
    env?: string[];
    docs?: string;
  };

  constructor(
    adapter: string,
    message: string,
    required: NotImplementedForOnboarding["required"] = {},
  ) {
    super(message);
    this.name = "NotImplementedForOnboarding";
    this.adapter = adapter;
    this.required = required;
  }

  /**
   * Flat JSON the logger + health response can serialize without
   * swallowing the structured context.
   */
  toJSON(): Record<string, unknown> {
    return {
      kind: "not_implemented_for_onboarding",
      adapter: this.adapter,
      message: this.message,
      required: this.required,
    };
  }
}
