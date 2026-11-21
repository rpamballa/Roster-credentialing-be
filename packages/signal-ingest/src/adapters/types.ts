/**
 * Signal · Connector plane · adapter contracts
 * --------------------------------------------
 *
 * An "adapter" is anything that can produce rows for the Signal
 * canonical tables. For v0, the single adapter is `roster-internal` —
 * readers that query Roster's own `providers`, `cases`, `verifications`,
 * `outreach_messages` tables (because the seed agency IS Roster).
 *
 * The external adapters named in the README (Bullhorn, Twilio, Resend
 * inbound, etc.) are deferred to v1 — but we design their SURFACE now
 * so the runner never learns new shapes when we wire them up. Each
 * external adapter must implement this interface; the runner iterates
 * `readers[*]` and asks each one for its rows.
 *
 * SHAPES — these are the canonical shapes the runner expects a reader
 * to return. Writing to `signal_*` tables and recording lineage is the
 * runner's job (not the reader's), so a reader never needs a DB handle
 * of its own. This separation keeps external adapters pure network/
 * transform code and lets us unit-test them without a database.
 *
 * NOTE: lineage is REQUIRED on every row — a canonical row with no
 * lineage would be unexplainable in the ranker's "why did this candidate
 * surface?" report. Every reader must populate `source.externalSystem`
 * and `source.externalId` for every row it yields.
 */

/** External-system pointer written to `signal_source_lineage`. */
export interface SourceRef {
  externalSystem: string;
  externalId: string;
}

// ─── Canonical row shapes (input to the runner, not the DB row types) ──
//
// Each shape names the external-system fields the runner needs to
// upsert + the ER identifiers used to deduplicate. They are the
// SUBSET of `signal_*.$inferInsert` a reader produces; the runner
// stamps workspaceId and timestamps.

export interface ProviderRecord {
  name: string;
  /** Primary identifier for entity resolution — preferred when present. */
  npi?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  specialties: string[];
  regionPrefs?: string[] | undefined;
  rateBand?: string | undefined;
  source: SourceRef;
}

export interface JobRecord {
  /** The already-resolved `facilities.id` the signal_jobs FK should point at. May be null. */
  facilityId: string | null;
  specialty: string;
  /** YYYY-MM-DD; signal_jobs.needDate is a DATE. */
  needDate: string | null;
  region?: string | undefined;
  /** Decimal string (numeric(12,2)). */
  pay?: string | undefined;
  state?: string | undefined;
  reqOpenedAt?: Date | undefined;
  source: SourceRef;
}

export interface FacilityRecord {
  /**
   * v0 does NOT create a `signal_facilities` table — signal_jobs
   * references `facilities.id` directly. `readFacilities` therefore
   * returns the existing facility ids a reader observed; the runner's
   * validator step checks every referenced id resolves.
   */
  facilityId: string;
  source: SourceRef;
}

export interface CredentialRecord {
  /**
   * The reader decides (via the identifiers it has) which provider
   * this credential belongs to. The runner passes it through
   * `resolveProvider` to land on a `signal_providers.id`.
   */
  providerIdentity: ProviderIdentity;
  type: string;
  /** Two-letter state, or null for non-state creds (DEA, board cert, etc.). */
  state: string | null;
  issued?: string | null | undefined;
  expires?: string | null | undefined;
  status?: string | null | undefined;
  /** JSON blob written verbatim to `signal_credentials.earliest_start_projection`. */
  earliestStartProjection?: Record<string, unknown> | undefined;
  source: SourceRef;
}

export interface ConversationRecord {
  providerIdentity?: ProviderIdentity | undefined;
  channel: string;
  occurredAt: Date;
  summary?: string | undefined;
  /**
   * Full normalized text of the conversation touch. Written to
   * `signal_conversations.body` and used by the extracts pipeline as
   * the stable substrate for character offsets.
   */
  body?: string | undefined;
  consentState?: string | undefined;
  sourceRef?: Record<string, unknown> | undefined;
  source: SourceRef;
}

/**
 * The identifier set an adapter has for a provider. The runner feeds
 * it directly to `resolveProvider` — if NPI is present we match on
 * NPI; otherwise email, then phone, then insert.
 */
export interface ProviderIdentity {
  name: string;
  npi?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
}

// ─── The adapter surface ───────────────────────────────────────────────

export interface ReaderContext {
  workspaceId: string;
}

/**
 * The surface every adapter — internal (`roster-internal`) and the
 * deferred external ones — must satisfy. Methods are allowed to
 * return an empty array; the runner treats "no rows" and "not
 * implemented" identically so stubs are a first-class state.
 *
 * NOTE: these return ALL rows to the runner. For v0 the dataset is
 * small (seed agency only). The v1 external adapters that can return
 * millions of rows will add `since?: Date` + batching to this surface.
 * We'll add the cursor param then; the signature intentionally stays
 * batch-flat today.
 */
export interface SignalIngestAdapter {
  /** Stable name for this adapter — used in lineage's `externalSystem`. */
  readonly name: string;
  readProviders(ctx: ReaderContext): Promise<ProviderRecord[]>;
  readJobs(ctx: ReaderContext): Promise<JobRecord[]>;
  readFacilities(ctx: ReaderContext): Promise<FacilityRecord[]>;
  readCredentials(ctx: ReaderContext): Promise<CredentialRecord[]>;
  readConversations(ctx: ReaderContext): Promise<ConversationRecord[]>;
}
