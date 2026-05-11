-- M5: primary source verifications.

CREATE TABLE IF NOT EXISTS verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id     uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  type            text NOT NULL,
  source          text NOT NULL,
  state           text,
  license_number  text,
  status          text NOT NULL,
  response        jsonb,
  error           text,
  verified_at     timestamptz,
  next_verify_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verifications_provider_idx ON verifications(provider_id, type);
CREATE INDEX IF NOT EXISTS verifications_next_verify_idx ON verifications(next_verify_at);

ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS verifications_tenant_isolation ON verifications;
CREATE POLICY verifications_tenant_isolation ON verifications
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
