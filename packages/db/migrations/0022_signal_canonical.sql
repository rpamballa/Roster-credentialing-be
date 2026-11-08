-- 0022_signal_canonical.sql
--
-- Roster Signal v0 — canonical data layer.
--
-- Signal is the recruiter-intelligence product that ranks providers
-- against open jobs by "earliest realistic start date, then fit". It
-- lives inside the existing credentialing monorepo and reuses the
-- workspaces / facilities / users tables as anchors. Every Signal
-- table is tenant-keyed by `workspace_id` with a FK to workspaces(id).
--
-- Pilot: locum tenens anesthesiology, inside the platform-default
-- workspace (slug `roster-hc-beta`) — see migration 0019.
--
-- Scope of this migration:
--
--   signal_providers        canonical provider identities (Signal's
--                           copy — separate from the credentialing
--                           `providers` table so Signal can merge /
--                           re-shape without disturbing active cases)
--   signal_jobs             open requisitions
--   signal_credentials      license / cert / doc state per provider
--   signal_conversations    recruiter ↔ provider touches, consent-tagged
--   signal_extracts         structured facets pulled out of a conversation
--   signal_rankings         materialized ranked list of providers per job
--   signal_overrides        human overrides on a ranking
--   signal_source_lineage   provenance pointer back to the system a row
--                           was derived from
--
-- Forward-only. Revert via a new migration.

BEGIN;

-- ─── signal_providers ───────────────────────────────────────────────────
--
-- Signal-side canonical provider. Separate from the credentialing
-- `providers` table (which is cross-tenant via grants) because Signal
-- needs to do aggressive entity resolution, merges, and workspace-
-- local re-shaping without touching the row that powers active
-- credentialing cases. Lineage back to the upstream system (incl. the
-- credentialing `providers` row, when applicable) lives in
-- `signal_source_lineage`.
CREATE TABLE IF NOT EXISTS signal_providers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  npi                 text,
  name                text NOT NULL,
  email               text,
  phone               text,
  specialties         jsonb NOT NULL DEFAULT '[]'::jsonb,
  region_prefs        jsonb NOT NULL DEFAULT '[]'::jsonb,
  rate_band           text,
  availability_hint   jsonb,
  -- Each entry is a JSON-encoded snapshot of a provider row that was
  -- merged INTO this one — enough information to reverse the merge
  -- later. Stored as text[] per the WS B spec.
  merged_from         text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_providers_workspace_idx
  ON signal_providers (workspace_id);
-- NPI is nullable at the column level but uniquely identifies a
-- provider within a workspace when present. Partial unique index
-- keeps the ER layer honest without blocking rows that don't yet
-- have an NPI.
CREATE UNIQUE INDEX IF NOT EXISTS signal_providers_workspace_npi_uq
  ON signal_providers (workspace_id, npi)
  WHERE npi IS NOT NULL;
CREATE INDEX IF NOT EXISTS signal_providers_workspace_email_idx
  ON signal_providers (workspace_id, lower(email))
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS signal_providers_workspace_phone_idx
  ON signal_providers (workspace_id, phone)
  WHERE phone IS NOT NULL;

-- ─── signal_jobs ────────────────────────────────────────────────────────
--
-- Open requisitions. facility_id FKs the existing facilities table
-- (a single hospital is referenced by multiple agencies — the
-- credentialing table design — so no workspace scoping on facilities
-- themselves).
CREATE TABLE IF NOT EXISTS signal_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  facility_id      uuid REFERENCES facilities(id) ON DELETE SET NULL,
  specialty        text NOT NULL,
  need_date        date,
  region           text,
  pay              numeric(12, 2),
  state            text,
  req_opened_at    timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_jobs_workspace_idx
  ON signal_jobs (workspace_id);
CREATE INDEX IF NOT EXISTS signal_jobs_workspace_need_date_idx
  ON signal_jobs (workspace_id, need_date);
CREATE INDEX IF NOT EXISTS signal_jobs_facility_idx
  ON signal_jobs (facility_id);

-- ─── signal_credentials ─────────────────────────────────────────────────
--
-- License / cert / doc state per provider. `earliest_start_projection`
-- is the ranker's input signal: {date, confidence, basis[]}.
CREATE TABLE IF NOT EXISTS signal_credentials (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id                   uuid NOT NULL REFERENCES signal_providers(id) ON DELETE CASCADE,
  type                          text NOT NULL,
  state                         text,
  issued                        date,
  expires                       date,
  status                        text,
  earliest_start_projection     jsonb,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_credentials_workspace_idx
  ON signal_credentials (workspace_id);
CREATE INDEX IF NOT EXISTS signal_credentials_provider_idx
  ON signal_credentials (provider_id);
CREATE INDEX IF NOT EXISTS signal_credentials_workspace_type_idx
  ON signal_credentials (workspace_id, type);

-- ─── signal_conversations ──────────────────────────────────────────────
--
-- A recruiter ↔ provider touch. Provider is nullable because a thread
-- may precede entity resolution (inbound email with no resolved
-- identity yet). source_ref carries the pointer back to the origin
-- (email id, Slack message id, phone call id, …).
CREATE TABLE IF NOT EXISTS signal_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id      uuid REFERENCES signal_providers(id) ON DELETE SET NULL,
  channel          text NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  summary          text,
  consent_state    text NOT NULL DEFAULT 'unknown',
  source_ref       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_conversations_workspace_idx
  ON signal_conversations (workspace_id);
CREATE INDEX IF NOT EXISTS signal_conversations_workspace_occurred_at_idx
  ON signal_conversations (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS signal_conversations_provider_idx
  ON signal_conversations (provider_id);

-- ─── signal_extracts ───────────────────────────────────────────────────
--
-- Structured facets lifted out of a conversation (e.g.
-- facet='availability.start_date', value={...}, confidence=0.82,
-- source_span={char_start, char_end}). This is the audit trail every
-- ranking reason can cite.
CREATE TABLE IF NOT EXISTS signal_extracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id    uuid NOT NULL REFERENCES signal_conversations(id) ON DELETE CASCADE,
  facet              text NOT NULL,
  value              jsonb,
  confidence         numeric(5, 4),
  source_span        jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_extracts_workspace_idx
  ON signal_extracts (workspace_id);
CREATE INDEX IF NOT EXISTS signal_extracts_conversation_idx
  ON signal_extracts (conversation_id);
CREATE INDEX IF NOT EXISTS signal_extracts_workspace_facet_idx
  ON signal_extracts (workspace_id, facet);

-- ─── signal_rankings ───────────────────────────────────────────────────
--
-- Materialized ranked list of providers per job. `entries` is a jsonb
-- array of { provider_id, score, reasons[{code, source_lineage}] }.
-- A ranking is immutable — a re-run writes a new row.
CREATE TABLE IF NOT EXISTS signal_rankings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id          uuid NOT NULL REFERENCES signal_jobs(id) ON DELETE CASCADE,
  ranked_at       timestamptz NOT NULL DEFAULT now(),
  entries         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_rankings_workspace_idx
  ON signal_rankings (workspace_id);
CREATE INDEX IF NOT EXISTS signal_rankings_job_ranked_idx
  ON signal_rankings (job_id, ranked_at DESC);

-- ─── signal_overrides ──────────────────────────────────────────────────
--
-- Human overrides on a ranking (pin / unpin a provider for a job),
-- captured with the reason so we can learn from the correction later.
CREATE TABLE IF NOT EXISTS signal_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id          uuid NOT NULL REFERENCES signal_jobs(id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES signal_providers(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  direction       text NOT NULL,
  reason_text     text,
  at              timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_overrides_workspace_idx
  ON signal_overrides (workspace_id);
CREATE INDEX IF NOT EXISTS signal_overrides_job_idx
  ON signal_overrides (job_id);
CREATE INDEX IF NOT EXISTS signal_overrides_provider_idx
  ON signal_overrides (provider_id);

-- ─── signal_source_lineage ─────────────────────────────────────────────
--
-- Every canonical row has a trail back to the external system it was
-- derived from. canonical_table + canonical_id name the Signal row;
-- external_system + external_id name the origin (e.g.
-- ('inbound_emails', <uuid>), ('bullhorn', '12345'), ('resend',
-- 'msg_abc')). A single canonical row may have multiple lineage
-- entries over time (re-syncs); the unique index on the four-tuple
-- below makes record-and-upsert idempotent.
CREATE TABLE IF NOT EXISTS signal_source_lineage (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  canonical_table   text NOT NULL,
  canonical_id      uuid NOT NULL,
  external_system   text NOT NULL,
  external_id       text NOT NULL,
  last_synced       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_source_lineage_workspace_idx
  ON signal_source_lineage (workspace_id);
CREATE INDEX IF NOT EXISTS signal_source_lineage_canonical_idx
  ON signal_source_lineage (canonical_table, canonical_id);
CREATE UNIQUE INDEX IF NOT EXISTS signal_source_lineage_uq
  ON signal_source_lineage
    (workspace_id, canonical_table, canonical_id, external_system, external_id);

COMMIT;
