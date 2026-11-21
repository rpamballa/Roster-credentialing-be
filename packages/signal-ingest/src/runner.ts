/**
 * Signal · ingest runner
 * ----------------------
 *
 * The runner is the only place in this package that writes to Signal
 * tables. Readers return canonical records; the runner:
 *
 *   1. Wraps each reader in a per-reader circuit breaker from
 *      `@cred/signal-core` so a flaky dependency can't crash the
 *      whole sync. The breaker's `errorThreshold` is set low (0.5
 *      with minSamples=2) because each reader is a single bulk call,
 *      not many small ones.
 *
 *   2. Resolves each provider identity via `resolveProvider` (NPI →
 *      email → phone, matching the DAL's ER rules). The returned
 *      `signal_providers.id` is reused across every canonical table
 *      that references the provider, so credentials and conversations
 *      write against the SAME `signal_providers` row.
 *
 *   3. Upserts into `signal_*` through a workspace-scoped DAL and
 *      records lineage on every row via `recordLineage`. Upserts are
 *      idempotent: a second run against unchanged data writes zero
 *      new rows (counted as `rowsSkipped`).
 *
 *   4. Returns a summary. No throws at the top level — errors from
 *      one reader land in `errors[]` and the runner moves on.
 *
 * Idempotency strategy:
 *
 *   - `signal_providers`: `resolveProvider` reuses rows by NPI/email/
 *     phone, so the same upstream identity never creates a new row.
 *   - `signal_jobs` / `signal_credentials` / `signal_conversations`:
 *     we check lineage first — if the (canonical_table, external_id)
 *     tuple already has a canonical row, we UPDATE it in place
 *     (via the lineage pointer) instead of inserting. If not, we
 *     INSERT and record new lineage.
 *
 * That makes lineage the source of truth for "have we seen this
 * external_id before?", which keeps the idempotency check in ONE
 * place (not a per-table unique index).
 */

import { db } from "@cred/db";
import {
  signalConversations,
  signalCredentials,
  signalJobs,
  signalProviders,
  signalSourceLineage,
} from "@cred/db/schema";
import { recordLineage, resolveProvider, withWorkspace } from "@cred/db/signal";
import { CircuitOpenError, createCircuitBreaker } from "@cred/signal-core";
import { type RunExtractsSummary, runExtracts } from "@cred/signal-extracts";
import { and, eq, sql } from "drizzle-orm";
import type {
  ConversationRecord,
  CredentialRecord,
  JobRecord,
  ProviderIdentity,
  ProviderRecord,
  ReaderContext,
  SignalIngestAdapter,
} from "./adapters/types.js";
import { validateFacilityReferences } from "./readers/facilities.js";
import { rosterInternalAdapter } from "./readers/index.js";

export interface IngestGap {
  kind: string;
  detail: string;
}

export interface ReaderError {
  reader: string;
  message: string;
  openedCircuit: boolean;
}

export interface IngestSummary {
  readersRun: string[];
  rowsUpserted: Record<string, number>;
  rowsSkipped: Record<string, number>;
  errors: ReaderError[];
  gaps: IngestGap[];
  /**
   * Result of the post-ingest extract fan-out. Null when the extract
   * pass was disabled via `runExtracts: false` on the options, or
   * when every adapter errored out before we got that far.
   */
  extractsRun: RunExtractsSummary | null;
}

export interface RunIngestOnceOptions {
  workspaceId: string;
  /**
   * Adapters to run. Defaults to [`rosterInternalAdapter`]. External
   * v1 adapters will be concatenated here.
   */
  adapters?: SignalIngestAdapter[];
  /**
   * Error threshold for the per-reader breaker (fraction). 0.5 means
   * "trip on 50% recent-call failure rate". Default 0.5.
   */
  errorThreshold?: number;
  /** Cooldown window after a trip, ms. Default 60_000. */
  cooldownMs?: number;
  /** Minimum samples before trip. Default 2 — readers are called
   *  once per method per run, so a small window is fine. */
  minSamples?: number;
  /** Rolling outcome window. Default 4. */
  windowSize?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /**
   * When `false`, skip the post-ingest fan-out to
   * `@cred/signal-extracts`. Default is `true` — a fresh workspace
   * sync always re-runs extracts so a newly-pulled conversation
   * becomes rankable in the same cycle. Tests that want to assert on
   * conversation rows without the extract pipeline also writing can
   * set this to `false`.
   */
  runExtracts?: boolean;
}

type ReaderName = "providers" | "jobs" | "facilities" | "credentials" | "conversations";

const READER_NAMES: readonly ReaderName[] = [
  "providers",
  "jobs",
  "facilities",
  "credentials",
  "conversations",
] as const;

/**
 * One-shot ingest for `workspaceId`. Safe to run again at any time —
 * second run is a no-op on unchanged data.
 */
export async function runIngestOnce(opts: RunIngestOnceOptions): Promise<IngestSummary> {
  const { workspaceId } = opts;
  const adapters = opts.adapters ?? [rosterInternalAdapter];

  const summary: IngestSummary = {
    readersRun: [],
    rowsUpserted: zeroCounters(),
    rowsSkipped: zeroCounters(),
    errors: [],
    gaps: [],
    extractsRun: null,
  };

  for (const adapter of adapters) {
    const breakers = makeBreakers(adapter.name, opts);
    const ctx: ReaderContext = { workspaceId };

    // Providers FIRST — later readers reuse the resolved signal_providers.id
    // via resolveProvider on the same identity set.
    const providerIdMap = new Map<string, string>();
    await runReader(summary, breakers.providers, "providers", async () => {
      const records = await adapter.readProviders(ctx);
      for (const rec of records) {
        const upsert = await upsertProvider(workspaceId, rec);
        const key = identityKey(toIdentity(rec));
        if (key) providerIdMap.set(key, upsert.providerId);
        if (upsert.created) {
          incr(summary.rowsUpserted, "providers");
        } else {
          incr(summary.rowsSkipped, "providers");
        }
      }
    });

    await runReader(summary, breakers.jobs, "jobs", async () => {
      const records = await adapter.readJobs(ctx);
      for (const rec of records) {
        const result = await upsertJob(workspaceId, adapter.name, rec);
        if (result.created) incr(summary.rowsUpserted, "jobs");
        else incr(summary.rowsSkipped, "jobs");
      }
    });

    await runReader(summary, breakers.facilities, "facilities", async () => {
      // No rows to upsert in v0; call through so the breaker records a
      // successful outcome.
      await adapter.readFacilities(ctx);
      const validation = await validateFacilityReferences(workspaceId);
      if (validation.danglingFacilityIds.length > 0) {
        summary.gaps.push({
          kind: "dangling_facility_reference",
          detail: `signal_jobs referenced ${validation.danglingFacilityIds.length} facility id(s) with no matching row`,
        });
      }
    });

    await runReader(summary, breakers.credentials, "credentials", async () => {
      const records = await adapter.readCredentials(ctx);
      for (const rec of records) {
        const providerId = await resolveForCred(workspaceId, providerIdMap, rec.providerIdentity);
        const result = await upsertCredential(workspaceId, adapter.name, providerId, rec);
        if (result.created) incr(summary.rowsUpserted, "credentials");
        else incr(summary.rowsSkipped, "credentials");
      }
    });

    await runReader(summary, breakers.conversations, "conversations", async () => {
      const records = await adapter.readConversations(ctx);
      if (records.length === 0) {
        summary.gaps.push({
          kind: "no_outbound_conversations",
          detail: `${adapter.name}: no outbound email history found; conversations reader returned 0 rows`,
        });
        return;
      }
      for (const rec of records) {
        let providerId: string | undefined;
        if (rec.providerIdentity) {
          providerId = await resolveForCred(workspaceId, providerIdMap, rec.providerIdentity);
        }
        const result = await upsertConversation(workspaceId, adapter.name, providerId, rec);
        if (result.created) incr(summary.rowsUpserted, "conversations");
        else incr(summary.rowsSkipped, "conversations");
      }
    });
  }

  // Post-ingest extract fan-out. Runs after every adapter so a
  // conversation written in this cycle becomes immediately rankable.
  // Stays inside the same `workspaceId` scope the ingest ran under,
  // so cross-tenant leaks are impossible from this path.
  if (opts.runExtracts !== false) {
    summary.extractsRun = await runExtracts({ workspaceId });
  }

  return summary;
}

// ─── Breakers ─────────────────────────────────────────────────────────

interface Breakers {
  providers: ReturnType<typeof createCircuitBreaker>;
  jobs: ReturnType<typeof createCircuitBreaker>;
  facilities: ReturnType<typeof createCircuitBreaker>;
  credentials: ReturnType<typeof createCircuitBreaker>;
  conversations: ReturnType<typeof createCircuitBreaker>;
}

function makeBreakers(adapterName: string, opts: RunIngestOnceOptions): Breakers {
  const base = {
    errorThreshold: opts.errorThreshold ?? 0.5,
    cooldownMs: opts.cooldownMs ?? 60_000,
    minSamples: opts.minSamples ?? 2,
    windowSize: opts.windowSize ?? 4,
    ...(opts.now ? { now: opts.now } : {}),
  };
  return {
    providers: createCircuitBreaker({ key: `${adapterName}:providers`, ...base }),
    jobs: createCircuitBreaker({ key: `${adapterName}:jobs`, ...base }),
    facilities: createCircuitBreaker({ key: `${adapterName}:facilities`, ...base }),
    credentials: createCircuitBreaker({ key: `${adapterName}:credentials`, ...base }),
    conversations: createCircuitBreaker({ key: `${adapterName}:conversations`, ...base }),
  };
}

/**
 * Exported test seam: build a runner bound to a shared breaker map so
 * a test can trip a specific reader's breaker across multiple calls.
 */
export function makeRunnerWithBreakers(
  breakers: Breakers,
): (adapter: SignalIngestAdapter, workspaceId: string) => Promise<IngestSummary> {
  return async (adapter, workspaceId) => {
    const summary: IngestSummary = {
      readersRun: [],
      rowsUpserted: zeroCounters(),
      rowsSkipped: zeroCounters(),
      errors: [],
      gaps: [],
      extractsRun: null,
    };
    const ctx: ReaderContext = { workspaceId };

    await runReader(summary, breakers.providers, "providers", async () => {
      await adapter.readProviders(ctx);
    });
    await runReader(summary, breakers.jobs, "jobs", async () => {
      await adapter.readJobs(ctx);
    });
    await runReader(summary, breakers.facilities, "facilities", async () => {
      await adapter.readFacilities(ctx);
    });
    await runReader(summary, breakers.credentials, "credentials", async () => {
      await adapter.readCredentials(ctx);
    });
    await runReader(summary, breakers.conversations, "conversations", async () => {
      await adapter.readConversations(ctx);
    });
    return summary;
  };
}

async function runReader(
  summary: IngestSummary,
  breaker: ReturnType<typeof createCircuitBreaker>,
  name: ReaderName,
  work: () => Promise<void>,
): Promise<void> {
  summary.readersRun.push(name);
  try {
    await breaker.run(work);
  } catch (err) {
    const openedCircuit = err instanceof CircuitOpenError || breaker.state() === "open";
    summary.errors.push({
      reader: name,
      message: err instanceof Error ? err.message : String(err),
      openedCircuit,
    });
  }
}

// ─── Upserts (idempotency lives here) ─────────────────────────────────

function toIdentity(rec: ProviderRecord): ProviderIdentity {
  const id: ProviderIdentity = { name: rec.name };
  if (rec.npi) id.npi = rec.npi;
  if (rec.email) id.email = rec.email;
  if (rec.phone) id.phone = rec.phone;
  return id;
}

/**
 * Cache key for a resolved provider identity. We ONLY cache when
 * at least one strong identifier (NPI / email / phone) is present —
 * `resolveProvider` explicitly refuses to match two providers on name
 * alone, so caching by name would defeat that rule. When no strong
 * identifier is present, returns `null` and the caller falls through
 * to a fresh `resolveProvider` call (which will insert a new row).
 */
function identityKey(id: ProviderIdentity): string | null {
  const npi = (id.npi ?? "").toLowerCase();
  const email = (id.email ?? "").toLowerCase();
  const phone = (id.phone ?? "").replace(/\D+/g, "");
  if (!npi && !email && !phone) return null;
  return [`npi=${npi}`, `email=${email}`, `phone=${phone}`].join("|");
}

async function upsertProvider(
  workspaceId: string,
  rec: ProviderRecord,
): Promise<{ providerId: string; created: boolean }> {
  const identity: ProviderIdentity = toIdentity(rec);
  const resolveArgs: Parameters<typeof resolveProvider>[0] = {
    workspaceId,
    name: identity.name,
  };
  if (identity.npi) resolveArgs.npi = identity.npi;
  if (identity.email) resolveArgs.email = identity.email;
  if (identity.phone) resolveArgs.phone = identity.phone;
  const resolved = await resolveProvider(resolveArgs);
  // Enrich specialties / regionPrefs on the signal row if we have
  // them. We only overwrite when a non-empty value is provided — the
  // idempotent re-run keeps the latest shape.
  await db()
    .update(signalProviders)
    .set({
      specialties: rec.specialties ?? [],
      regionPrefs: rec.regionPrefs ?? [],
      ...(rec.rateBand !== undefined ? { rateBand: rec.rateBand } : {}),
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(signalProviders.workspaceId, workspaceId),
        eq(signalProviders.id, resolved.providerId),
      ),
    );
  await recordLineage(db(), {
    workspaceId,
    canonicalTable: "signal_providers",
    canonicalId: resolved.providerId,
    externalSystem: rec.source.externalSystem,
    externalId: rec.source.externalId,
  });
  return { providerId: resolved.providerId, created: resolved.created };
}

async function resolveForCred(
  workspaceId: string,
  cache: Map<string, string>,
  identity: ProviderIdentity,
): Promise<string> {
  const key = identityKey(identity);
  if (key) {
    const cached = cache.get(key);
    if (cached) return cached;
  }
  const resolveArgs: Parameters<typeof resolveProvider>[0] = {
    workspaceId,
    name: identity.name,
  };
  if (identity.npi) resolveArgs.npi = identity.npi;
  if (identity.email) resolveArgs.email = identity.email;
  if (identity.phone) resolveArgs.phone = identity.phone;
  const resolved = await resolveProvider(resolveArgs);
  if (key) cache.set(key, resolved.providerId);
  return resolved.providerId;
}

/**
 * Find an existing canonical row whose lineage matches this
 * (external_system, external_id). If present → UPDATE; if absent →
 * INSERT.
 *
 * The lineage lookup scopes to `workspaceId` so one agency can't
 * see another's canonical_ids (even though signalSourceLineage is
 * stored without RLS — it carries workspace_id and we filter here).
 */
async function findCanonicalByLineage(
  workspaceId: string,
  canonicalTable: string,
  externalSystem: string,
  externalId: string,
): Promise<string | undefined> {
  const rows = await db()
    .select({ canonicalId: signalSourceLineage.canonicalId })
    .from(signalSourceLineage)
    .where(
      and(
        eq(signalSourceLineage.workspaceId, workspaceId),
        eq(signalSourceLineage.canonicalTable, canonicalTable),
        eq(signalSourceLineage.externalSystem, externalSystem),
        eq(signalSourceLineage.externalId, externalId),
      ),
    )
    .limit(1);
  return rows[0]?.canonicalId;
}

async function upsertJob(
  workspaceId: string,
  adapterName: string,
  rec: JobRecord,
): Promise<{ created: boolean }> {
  const existing = await findCanonicalByLineage(
    workspaceId,
    "signal_jobs",
    rec.source.externalSystem,
    rec.source.externalId,
  );
  const scoped = withWorkspace(workspaceId);
  if (existing) {
    await db()
      .update(signalJobs)
      .set({
        facilityId: rec.facilityId,
        specialty: rec.specialty,
        needDate: rec.needDate,
        ...(rec.region !== undefined ? { region: rec.region } : {}),
        ...(rec.pay !== undefined ? { pay: rec.pay } : {}),
        ...(rec.state !== undefined ? { state: rec.state } : {}),
        ...(rec.reqOpenedAt !== undefined ? { reqOpenedAt: rec.reqOpenedAt } : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(signalJobs.workspaceId, workspaceId), eq(signalJobs.id, existing)));
    await recordLineage(db(), {
      workspaceId,
      canonicalTable: "signal_jobs",
      canonicalId: existing,
      externalSystem: adapterName,
      externalId: rec.source.externalId,
    });
    return { created: false };
  }
  const inserted = await scoped.jobs.insert({
    facilityId: rec.facilityId,
    specialty: rec.specialty,
    needDate: rec.needDate,
    ...(rec.region !== undefined ? { region: rec.region } : {}),
    ...(rec.pay !== undefined ? { pay: rec.pay } : {}),
    ...(rec.state !== undefined ? { state: rec.state } : {}),
    ...(rec.reqOpenedAt !== undefined ? { reqOpenedAt: rec.reqOpenedAt } : {}),
  });
  const row = inserted[0];
  if (!row) throw new Error("upsertJob: insert returned no row");
  await recordLineage(db(), {
    workspaceId,
    canonicalTable: "signal_jobs",
    canonicalId: row.id,
    externalSystem: adapterName,
    externalId: rec.source.externalId,
  });
  return { created: true };
}

async function upsertCredential(
  workspaceId: string,
  adapterName: string,
  providerId: string,
  rec: CredentialRecord,
): Promise<{ created: boolean }> {
  const existing = await findCanonicalByLineage(
    workspaceId,
    "signal_credentials",
    rec.source.externalSystem,
    rec.source.externalId,
  );
  if (existing) {
    await db()
      .update(signalCredentials)
      .set({
        providerId,
        type: rec.type,
        state: rec.state,
        ...(rec.issued !== undefined ? { issued: rec.issued } : {}),
        ...(rec.expires !== undefined ? { expires: rec.expires } : {}),
        ...(rec.status !== undefined ? { status: rec.status } : {}),
        ...(rec.earliestStartProjection !== undefined
          ? { earliestStartProjection: rec.earliestStartProjection }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(signalCredentials.workspaceId, workspaceId), eq(signalCredentials.id, existing)),
      );
    await recordLineage(db(), {
      workspaceId,
      canonicalTable: "signal_credentials",
      canonicalId: existing,
      externalSystem: adapterName,
      externalId: rec.source.externalId,
    });
    return { created: false };
  }

  const scoped = withWorkspace(workspaceId);
  const inserted = await scoped.credentials.insert({
    providerId,
    type: rec.type,
    state: rec.state,
    ...(rec.issued !== undefined ? { issued: rec.issued } : {}),
    ...(rec.expires !== undefined ? { expires: rec.expires } : {}),
    ...(rec.status !== undefined ? { status: rec.status } : {}),
    ...(rec.earliestStartProjection !== undefined
      ? { earliestStartProjection: rec.earliestStartProjection }
      : {}),
  });
  const row = inserted[0];
  if (!row) throw new Error("upsertCredential: insert returned no row");
  await recordLineage(db(), {
    workspaceId,
    canonicalTable: "signal_credentials",
    canonicalId: row.id,
    externalSystem: adapterName,
    externalId: rec.source.externalId,
  });
  return { created: true };
}

async function upsertConversation(
  workspaceId: string,
  adapterName: string,
  providerId: string | undefined,
  rec: ConversationRecord,
): Promise<{ created: boolean }> {
  const existing = await findCanonicalByLineage(
    workspaceId,
    "signal_conversations",
    rec.source.externalSystem,
    rec.source.externalId,
  );
  if (existing) {
    await db()
      .update(signalConversations)
      .set({
        providerId: providerId ?? null,
        channel: rec.channel,
        occurredAt: rec.occurredAt,
        ...(rec.summary !== undefined ? { summary: rec.summary } : {}),
        // `body` only overwrites when the reader sends one — a later
        // sync that doesn't carry text doesn't erase the stored copy.
        // A revoke event erases body via the consent handler, not
        // through this path.
        ...(rec.body !== undefined ? { body: rec.body } : {}),
        ...(rec.consentState !== undefined ? { consentState: rec.consentState } : {}),
        ...(rec.sourceRef !== undefined ? { sourceRef: rec.sourceRef } : {}),
      })
      .where(
        and(eq(signalConversations.workspaceId, workspaceId), eq(signalConversations.id, existing)),
      );
    await recordLineage(db(), {
      workspaceId,
      canonicalTable: "signal_conversations",
      canonicalId: existing,
      externalSystem: adapterName,
      externalId: rec.source.externalId,
    });
    return { created: false };
  }

  const scoped = withWorkspace(workspaceId);
  const inserted = await scoped.conversations.insert({
    ...(providerId !== undefined ? { providerId } : {}),
    channel: rec.channel,
    occurredAt: rec.occurredAt,
    ...(rec.summary !== undefined ? { summary: rec.summary } : {}),
    ...(rec.body !== undefined ? { body: rec.body } : {}),
    ...(rec.consentState !== undefined ? { consentState: rec.consentState } : {}),
    ...(rec.sourceRef !== undefined ? { sourceRef: rec.sourceRef } : {}),
  });
  const row = inserted[0];
  if (!row) throw new Error("upsertConversation: insert returned no row");
  await recordLineage(db(), {
    workspaceId,
    canonicalTable: "signal_conversations",
    canonicalId: row.id,
    externalSystem: adapterName,
    externalId: rec.source.externalId,
  });
  return { created: true };
}

// ─── Counter helpers ──────────────────────────────────────────────────

function zeroCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of READER_NAMES) out[name] = 0;
  return out;
}

function incr(counters: Record<string, number>, key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}
