-- 0024_signal_conversation_body_and_extract_idempotency.sql
--
-- Roster Signal · WS E · capture pipeline v0.
--
-- Two small additions to the canonical layer, in one migration because
-- both are consumed by the same extract pipeline this workstream ships:
--
--   1. `signal_conversations.body` — the full normalized text of the
--      conversation touch (an outbound email body, a recruiter case
--      note, …). Previously only the 280-char `summary` lived on the
--      row; the extractor needs stable character offsets for
--      `source_span`, which forces the body to live on the canonical
--      row (not fetched on demand from the source system where byte
--      positions could drift under later edits). Nullable because
--      existing rows pre-date this column and because `revoked`
--      consent state nulls the body out while keeping the row for
--      audit.
--
--   2. `signal_extracts (conversation_id, facet, (source_span->>'start')::int)`
--      partial unique index — the extracts pipeline is idempotent on
--      that triple, so a re-run never duplicates. We make the index
--      partial on `source_span IS NOT NULL` because a synthesized
--      extract without a span (future LLM-derived path) wouldn't
--      share this key shape and shouldn't be gated by it.
--
-- Forward-only. Revert via a new migration.

BEGIN;

ALTER TABLE signal_conversations
  ADD COLUMN IF NOT EXISTS body text;

CREATE UNIQUE INDEX IF NOT EXISTS signal_extracts_conversation_facet_span_uq
  ON signal_extracts (conversation_id, facet, ((source_span->>'start')::int))
  WHERE source_span IS NOT NULL;

COMMIT;
