-- 0015_case_notes.sql
--
-- Specialist-facing free-text notes on a case. Audit-adjacent (not
-- immutable) — the note author can delete their own note within a
-- short window. Motivating use-case: handoff between specialists
-- when Case A gets reassigned; the outgoing specialist leaves a
-- "waiting on state board callback, said 3-5 business days" note
-- so the incoming one doesn't restart from zero.

CREATE TABLE IF NOT EXISTS case_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS case_notes_case_created_idx
  ON case_notes (case_id, created_at DESC)
  WHERE deleted_at IS NULL;
