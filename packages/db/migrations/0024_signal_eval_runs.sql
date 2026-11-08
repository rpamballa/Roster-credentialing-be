-- 0024_signal_eval_runs.sql
--
-- Durable store for Signal eval harness runs. Each row is a complete
-- report (aggregate + per-req) produced by `POST /v1/signal/eval/runs`
-- or by the CLI's `signal-eval` command. The data is keep-forever —
-- storage is cheap, and a run is a few KB of JSON.
--
-- Tenant boundary is `workspace_id`. We index by (workspace_id,
-- created_at desc) so the cockpit can show the most recent runs
-- without scanning the whole table.
--
-- `aggregate` carries the precision@K summary; `per_req` is the full
-- per-req breakdown (fixture req id, ranker top-K, precision). A
-- recruiter debugging a ranking regression can pull this straight off
-- the row without re-running the harness.
--
-- Forward-only. Revert via a new migration.

BEGIN;

CREATE TABLE IF NOT EXISTS signal_eval_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The conversation row (channel='eval') this run drained, when the
  -- API route triggered the harness. NULL for CLI-initiated runs
  -- (`signal-eval` from the terminal / CI). FK is SET NULL on delete
  -- so a conversation TRUNCATE doesn't vaporize eval history.
  conversation_id uuid REFERENCES signal_conversations(id) ON DELETE SET NULL,
  suite          text NOT NULL,
  fixture        text NOT NULL,
  label_source   text NOT NULL,
  k              integer NOT NULL,
  status         text NOT NULL DEFAULT 'completed',
  mean_precision_at_k numeric(6, 4) NOT NULL,
  passed_count   integer NOT NULL DEFAULT 0,
  failed_count   integer NOT NULL DEFAULT 0,
  aggregate      jsonb NOT NULL DEFAULT '{}'::jsonb,
  per_req        jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_eval_runs_workspace_idx
  ON signal_eval_runs (workspace_id);

CREATE INDEX IF NOT EXISTS signal_eval_runs_workspace_created_idx
  ON signal_eval_runs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS signal_eval_runs_conversation_idx
  ON signal_eval_runs (conversation_id);

COMMIT;
