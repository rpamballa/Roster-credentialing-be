-- 0023_signal_weights.sql
--
-- Per-workspace facet weights for the Signal ranker's learning loop
-- (WS A · learn worker). Overrides captured in `signal_overrides` are
-- replayed into this table — a promote nudges the matching facet's
-- weight up, a demote nudges it down. The ranker reads these weights
-- when it scores a facet on a candidate, so a workspace's correction
-- history bends its own future rankings.
--
-- Weights are strictly per-tenant. We DO NOT share a classifier across
-- workspaces: different agencies have different sub-specialty mixes,
-- geography preferences and pay bands, and borrowing one tenant's
-- correction history for another is a cross-tenant leak of recruiter
-- judgement. The composite PRIMARY KEY on (workspace_id, facet_key)
-- plus the FK with ON DELETE CASCADE make the isolation a physical
-- property of the table, not just a convention.
--
-- `weight` is a numeric multiplier applied to the facet's base score.
-- 1.0 = no learned adjustment. The learn worker clamps to a sane range
-- (0.1..3.0) so a runaway override stream can't drive a weight to zero
-- or to infinity — see packages/signal-learn/src/apply.ts.

BEGIN;

CREATE TABLE IF NOT EXISTS signal_weights (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  facet_key      text NOT NULL,
  weight         numeric(10, 4) NOT NULL DEFAULT 1.0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per (workspace, facet). The learn worker upserts on this
-- tuple so repeated calls idempotently converge toward the same
-- weight for the same correction history.
CREATE UNIQUE INDEX IF NOT EXISTS signal_weights_workspace_facet_uq
  ON signal_weights (workspace_id, facet_key);

CREATE INDEX IF NOT EXISTS signal_weights_workspace_idx
  ON signal_weights (workspace_id);

COMMIT;
