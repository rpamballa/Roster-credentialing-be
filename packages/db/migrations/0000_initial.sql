-- M1 foundation: workspaces, users, memberships, magic_link_tokens, audit_log.
-- Forward-only (PROMPT §6.3). To revert a change, write a new migration.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── enums ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE workspace_type AS ENUM ('agency', 'hospital', 'solo_provider');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'specialist', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE actor_type AS ENUM ('user', 'agent', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── workspaces ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspaces (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type               workspace_type NOT NULL,
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  email_in_address   text UNIQUE,
  settings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_status     text NOT NULL DEFAULT 'trial',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ─── users ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  name                text,
  email_verified_at   timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ─── memberships ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS memberships (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role          membership_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS memberships_workspace_idx ON memberships(workspace_id);

-- ─── magic_link_tokens ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS magic_link_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash      text NOT NULL UNIQUE,
  email           text NOT NULL,
  redirect_path   text,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  request_ip      text
);

CREATE INDEX IF NOT EXISTS magic_link_tokens_email_idx ON magic_link_tokens(email);

-- ─── audit_log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type          actor_type NOT NULL,
  action              text NOT NULL,
  target_entity_type  text NOT NULL,
  target_entity_id    uuid NOT NULL,
  before_state        jsonb,
  after_state         jsonb,
  ip_address          text,
  user_agent          text,
  request_id          text,
  timestamp           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_workspace_time_idx ON audit_log(workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log(target_entity_type, target_entity_id);

-- ─── RLS policies (PROMPT §4.1, SPEC §5.2) ───────────────────────────────
-- The application sets `app.current_workspace_id` via SET LOCAL inside one
-- tenancy middleware. Raw SQL that bypasses it requires `-- rls: bypass`.

-- workspaces: a row is visible iff the current workspace context equals its id.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_tenant_isolation ON workspaces;
CREATE POLICY workspaces_tenant_isolation ON workspaces
  USING (id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- memberships: scoped by workspace.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memberships_tenant_isolation ON memberships;
CREATE POLICY memberships_tenant_isolation ON memberships
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- audit_log: scoped by workspace. Cross-workspace audit reads require an
-- explicit `// rls: bypass` justification.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_log_tenant_isolation ON audit_log;
CREATE POLICY audit_log_tenant_isolation ON audit_log
  USING (
    workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );

-- users and magic_link_tokens are intentionally NOT under RLS — they are
-- looked up by email pre-session (no workspace context exists yet). Access
-- to user rows by other users is gated at the service layer via memberships.
