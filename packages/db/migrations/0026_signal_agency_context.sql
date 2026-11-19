-- 0026_signal_agency_context.sql
--
-- Roster Signal · agency-local context storage.
--
-- Every agency Signal onboards generates artifacts we need to persist
-- *per-workspace* and never, ever leak across tenants:
--
--   1. `signal_workspace_config`   — append-only key/value settings
--      (field mappings, playbooks, narrative provider context, etc).
--      Latest row per (workspace_id, scope, key) wins on read; the
--      history stays for audit and rollback.
--
--   2. `signal_knowledge_documents` + `signal_knowledge_chunks` —
--      the onboarding knowledge base. Each uploaded markdown doc is
--      chunked, embedded, and stored for workspace-scoped vector
--      search. The `workspace_id` on `signal_knowledge_chunks` is
--      denormalized from its parent document so the IVFFlat vector
--      index can be filtered by workspace in the query planner
--      without a join.
--
--   3. `signal_adapter_credentials` — encrypted third-party API
--      credentials per adapter (bullhorn, gmail, twilio, …). The
--      ciphertext is produced by HKDF-derived per-workspace AES-256-
--      GCM at the app tier (see packages/signal-knowledge/src/
--      credentials.ts). DB-level dump never carries plaintext.
--
--   4. `signal_onboarding_gaps` — the running log of "we learned
--      something we can't model yet". Status enum tracks resolution.
--
-- Shared design choices:
--   - Every table references `workspaces(id) ON DELETE CASCADE`.
--     Dropping a workspace erases its Signal context.
--   - Every table has a `workspace_id` index for the scoped DAL's
--     `WHERE workspace_id = ?` predicate (see
--     `packages/db/src/signal/tenant-scoped.ts`).
--   - pgvector is enabled at the top of the file. The IVFFlat index
--     is created with 100 lists, a reasonable default for small-to-
--     medium corpora (~10k chunks per workspace); revisit when a
--     workspace blows past that.
--
-- Forward-only. Revert via a new migration.

BEGIN;

-- pgvector — required for `vector(1536)` and the IVFFlat index.
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────────────
-- signal_workspace_config
--
-- Append-only — a PUT inserts a new row rather than overwriting. The
-- scoped DAL's read picks `created_at DESC` and the first row wins.
-- Keeping history makes the "what did we tell Signal last Tuesday"
-- question answerable without a backup.
CREATE TABLE IF NOT EXISTS signal_workspace_config (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid       NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope       text        NOT NULL,
  key         text        NOT NULL,
  value       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS signal_workspace_config_workspace_idx
  ON signal_workspace_config (workspace_id);

-- Composite index that supports the "latest value" lookup pattern:
-- `WHERE workspace_id = ? AND scope = ? AND key = ? ORDER BY created_at DESC LIMIT 1`.
CREATE INDEX IF NOT EXISTS signal_workspace_config_lookup_idx
  ON signal_workspace_config (workspace_id, scope, key, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- signal_knowledge_documents
--
-- The "big picture" markdown each agency uploads during onboarding —
-- playbooks, SOPs, style guides, placement histories, narrative
-- context. Chunks + embeddings live in the child table.
--
-- Soft-delete via `deleted_at` so an accidental DELETE doesn't lose
-- the embedded corpus. The scoped DAL filters `deleted_at IS NULL` on
-- `list()` and `findById()`.
CREATE TABLE IF NOT EXISTS signal_knowledge_documents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title          text        NOT NULL,
  body_markdown  text        NOT NULL,
  tags           text[]      NOT NULL DEFAULT '{}'::text[],
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  deleted_at     timestamptz
);

CREATE INDEX IF NOT EXISTS signal_knowledge_documents_workspace_idx
  ON signal_knowledge_documents (workspace_id);

CREATE INDEX IF NOT EXISTS signal_knowledge_documents_workspace_live_idx
  ON signal_knowledge_documents (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- signal_knowledge_chunks
--
-- `workspace_id` is denormalized from the parent document so the
-- vector similarity query can filter by workspace in a single
-- predicate (no join). This is load-bearing for isolation: the
-- IVFFlat vector index returns the nearest-N chunks across the index;
-- without a workspace_id predicate on the index-side, a top-N search
-- could return another agency's chunks before the WHERE clause even
-- ran. We instead filter by workspace in the WHERE, which the planner
-- can push down.
--
-- Dimension 1536 matches the OpenAI / Voyage-3 family. The scaffolding
-- ships a deterministic hashing embedder at this dimension so a real
-- embedder (Voyage, Cohere, …) can be dropped in later without a
-- re-migration. See packages/signal-knowledge/src/embedding.ts.
CREATE TABLE IF NOT EXISTS signal_knowledge_chunks (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid        NOT NULL REFERENCES signal_knowledge_documents(id) ON DELETE CASCADE,
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  chunk_index   int         NOT NULL,
  chunk_text    text        NOT NULL,
  embedding     vector(1536) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_knowledge_chunks_workspace_idx
  ON signal_knowledge_chunks (workspace_id);

CREATE INDEX IF NOT EXISTS signal_knowledge_chunks_document_idx
  ON signal_knowledge_chunks (document_id);

-- Vector similarity index. `vector_cosine_ops` matches the search
-- helper's `<=>` operator. `lists = 100` is a conservative IVFFlat
-- default — pgvector's rule of thumb is `rows / 1000` for small
-- corpora; a workspace with 100k+ chunks should REINDEX with a larger
-- list count. The index is not partitioned by workspace, but the
-- scoped DAL always includes `WHERE workspace_id = ?` which Postgres
-- combines with the index scan.
CREATE INDEX IF NOT EXISTS signal_knowledge_chunks_embedding_ivfflat
  ON signal_knowledge_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ─────────────────────────────────────────────────────────────────────
-- signal_adapter_credentials
--
-- Encrypted third-party API credentials per adapter. One row per
-- (workspace, adapter) — a PUT replaces the payload and bumps
-- payload_version + rotated_at. `encrypted_payload` is bytea
-- produced by packages/signal-knowledge/src/credentials.ts (AES-256-
-- GCM, key HKDF-derived from SESSION_SECRET + workspace_id). The
-- plaintext NEVER appears in a DB dump nor in any HTTP response —
-- only the in-process ingestion runner decrypts it.
CREATE TABLE IF NOT EXISTS signal_adapter_credentials (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  adapter            text        NOT NULL,
  encrypted_payload  bytea       NOT NULL,
  payload_version    int         NOT NULL DEFAULT 1,
  rotated_at         timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, adapter)
);

CREATE INDEX IF NOT EXISTS signal_adapter_credentials_workspace_idx
  ON signal_adapter_credentials (workspace_id);

-- ─────────────────────────────────────────────────────────────────────
-- signal_onboarding_gap_status enum
--
-- open      → raised, nothing done yet
-- planned   → on the roadmap
-- wontfix   → explicitly decided not to address
-- resolved  → shipped, product now handles it
CREATE TYPE signal_onboarding_gap_status AS ENUM ('open', 'planned', 'wontfix', 'resolved');

-- ─────────────────────────────────────────────────────────────────────
-- signal_onboarding_gaps
--
-- The "we noticed this during onboarding but don't handle it yet" log.
-- Used by the onboarding runbook agent and by product to triage
-- follow-up work. `raised_by` nulls out when the user is deleted so
-- the gap row stays — the content is the product-level signal.
CREATE TABLE IF NOT EXISTS signal_onboarding_gaps (
  id            uuid                            PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid                            NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         text                            NOT NULL,
  body_markdown text                            NOT NULL,
  status        signal_onboarding_gap_status    NOT NULL DEFAULT 'open',
  raised_by     uuid                            REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz                     NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

CREATE INDEX IF NOT EXISTS signal_onboarding_gaps_workspace_idx
  ON signal_onboarding_gaps (workspace_id);

CREATE INDEX IF NOT EXISTS signal_onboarding_gaps_workspace_status_idx
  ON signal_onboarding_gaps (workspace_id, status);

COMMIT;
