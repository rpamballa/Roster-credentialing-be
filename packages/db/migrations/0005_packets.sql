-- M4: attestations + assembled packets.

CREATE TABLE IF NOT EXISTS attestations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id                uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  docusign_envelope_id   text NOT NULL UNIQUE,
  text                   text NOT NULL,
  status                 text NOT NULL DEFAULT 'sent',
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attestations_case_idx ON attestations(case_id);

CREATE TABLE IF NOT EXISTS packets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  case_id         uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  file_uri        text NOT NULL,
  content_hash    text NOT NULL,
  provenance      jsonb NOT NULL,
  assembled_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at    timestamptz,
  submitted_by    uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS packets_case_idx ON packets(case_id, assembled_at);

ALTER TABLE attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attestations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attestations_tenant_isolation ON attestations;
CREATE POLICY attestations_tenant_isolation ON attestations
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE packets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS packets_tenant_isolation ON packets;
CREATE POLICY packets_tenant_isolation ON packets
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
