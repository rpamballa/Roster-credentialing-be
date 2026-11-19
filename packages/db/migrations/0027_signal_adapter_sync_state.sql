-- 0027_signal_adapter_sync_state.sql
--
-- Roster Signal · WS H · ingestion-framework scheduler state.
--
-- One row per (workspace, adapter). The scheduler reads this row to
-- decide whether an adapter is due, and writes it after every run to
-- record the new cursor + success/failure state. The columns here are
-- the durable mirror of the in-memory circuit breaker from
-- `@cred/signal-core/circuit-breaker` — the breaker drives the live
-- decisions within a process lifetime, this table drives recovery and
-- the health dashboard across restarts.
--
-- Schema choices worth calling out:
--
--   - `cursor jsonb` is deliberately adapter-defined. Bullhorn might
--     store `{ "lastModifiedAt": "2026-11-01T..." }`; Gmail might store
--     `{ "historyId": "123456789" }`; the roster-internal adapter does
--     not use the cursor at all (its readers are flat bulk scans today,
--     matching the v0 runner). The scheduler never introspects the
--     shape — it only persists whatever the adapter hands back.
--
--   - `breaker_state` mirrors `@cred/signal-core`'s three-state machine
--     (closed | open | half_open). It is the ONLY column that is both
--     written by the scheduler AND read by the health dashboard, so
--     keep it text (not an enum) — adapters that want to surface a
--     nuanced state like 'disabled' later should not need a migration.
--
--   - Unique on (workspace_id, adapter) — one row per adapter per
--     workspace. There is no history table; a prior-run audit will
--     come from logs + lineage rows, not from this table.
--
--   - Indices: the scheduler scans `WHERE last_sync_at IS NULL OR
--     last_sync_at < now() - cadence`; the per-workspace index covers
--     the common `runAllDue` path which iterates workspace-by-workspace.
--     A separate index on breaker_state keeps the health dashboard's
--     "what's broken across tenants" query cheap.
--
-- Forward-only. Revert via a new migration.

BEGIN;

CREATE TABLE IF NOT EXISTS signal_adapter_sync_state (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter              text NOT NULL,
  cursor               jsonb,
  last_sync_at         timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  last_error_at        timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  breaker_state        text NOT NULL DEFAULT 'closed',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signal_adapter_sync_state_breaker_state_chk
    CHECK (breaker_state IN ('closed', 'open', 'half_open'))
);

CREATE UNIQUE INDEX IF NOT EXISTS signal_adapter_sync_state_workspace_adapter_uq
  ON signal_adapter_sync_state (workspace_id, adapter);

CREATE INDEX IF NOT EXISTS signal_adapter_sync_state_workspace_idx
  ON signal_adapter_sync_state (workspace_id);

CREATE INDEX IF NOT EXISTS signal_adapter_sync_state_breaker_state_idx
  ON signal_adapter_sync_state (breaker_state);

COMMIT;
