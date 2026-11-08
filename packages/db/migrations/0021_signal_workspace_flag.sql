-- 0021_signal_workspace_flag.sql
--
-- Per-workspace kill switch for Roster Signal (the recruiter-intelligence
-- product being built alongside credentialing). Adds a single boolean
-- column to `workspaces`.
--
-- Why a column and not a settings-blob key: Signal's kill-switch
-- middleware runs on every `/v1/signal/*` request. A top-level column
-- (indexed-friendly, projected via drizzle's narrow select) keeps that
-- hot path a single scalar read instead of forcing the handler to
-- parse a jsonb blob for every request.
--
-- Defaults to FALSE. Signal is dev-only (gated by SIGNAL_SERVICES_ENABLED
-- at the service level, see packages/config) until the eval harness
-- passes with consultant-labeled data. Flipping this column to true per
-- workspace — plus flipping SIGNAL_SERVICES_ENABLED at the service
-- level — is how we whitelist a tenant onto Signal once we're ready.
--
-- NOT NULL + DEFAULT false means this migration applies cleanly against
-- the current empty prod DB and every existing workspace row
-- (there is one: `roster-hc-beta`) inherits the safe default.

BEGIN;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS signal_enabled BOOLEAN NOT NULL DEFAULT false;

COMMIT;
