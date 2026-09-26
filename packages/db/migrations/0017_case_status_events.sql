-- 0017_case_status_events.sql
--
-- Append-only log of case status transitions. cases.status mutates
-- in place, and the audit log is workspace-wide + noisy — this table
-- is per-case, ordered, and cheap to query for "days in stage",
-- "who flipped this and when", and the case detail timeline.

CREATE TABLE IF NOT EXISTS case_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type text NOT NULL DEFAULT 'user',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS case_status_events_case_created_idx
  ON case_status_events (case_id, created_at DESC);
