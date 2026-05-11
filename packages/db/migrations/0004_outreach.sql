-- M4: outreach threads/messages, references, reference access tokens.

CREATE TABLE IF NOT EXISTS outreach_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  recipient_kind  text NOT NULL,
  recipient_name  text,
  recipient_email text,
  recipient_phone text,
  status          text NOT NULL DEFAULT 'active',
  paused_at       timestamptz,
  completed_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_threads_case_idx ON outreach_threads(case_id);
CREATE INDEX IF NOT EXISTS outreach_threads_workspace_idx ON outreach_threads(workspace_id, status);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     uuid NOT NULL REFERENCES outreach_threads(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel       text NOT NULL,
  direction     text NOT NULL,
  template      text,
  body          text,
  metadata      jsonb DEFAULT '{}'::jsonb,
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outreach_messages_thread_idx ON outreach_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS "references" (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id           uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name              text NOT NULL,
  relationship      text,
  email             text,
  phone             text,
  status            text NOT NULL DEFAULT 'pending',
  response_fields   jsonb,
  responded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS references_case_idx ON "references"(case_id);

CREATE TABLE IF NOT EXISTS reference_access_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  reference_id  uuid NOT NULL REFERENCES "references"(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reference_access_tokens_reference_idx ON reference_access_tokens(reference_id);

-- RLS
ALTER TABLE outreach_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_threads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_threads_tenant_isolation ON outreach_threads;
CREATE POLICY outreach_threads_tenant_isolation ON outreach_threads
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE outreach_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE outreach_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outreach_messages_tenant_isolation ON outreach_messages;
CREATE POLICY outreach_messages_tenant_isolation ON outreach_messages
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE "references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "references" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS references_tenant_isolation ON "references";
CREATE POLICY references_tenant_isolation ON "references"
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- reference_access_tokens: pre-session lookup by hash. Not under RLS.
