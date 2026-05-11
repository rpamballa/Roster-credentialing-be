-- M3: facility ingestion.

CREATE TABLE IF NOT EXISTS facilities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  address     text,
  ein         text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS facility_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id           uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version               integer NOT NULL,
  status                text NOT NULL DEFAULT 'draft',
  source_packet_uri     text,
  source_email_id       uuid,
  requirements          jsonb NOT NULL,
  approved_at           timestamptz,
  approved_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS facility_profiles_facility_workspace_idx
  ON facility_profiles(facility_id, workspace_id, version);
CREATE INDEX IF NOT EXISTS facility_profiles_workspace_status_idx
  ON facility_profiles(workspace_id, status);

CREATE TABLE IF NOT EXISTS facility_profile_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_profile_id  uuid NOT NULL REFERENCES facility_profiles(id) ON DELETE CASCADE,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  requirements         jsonb NOT NULL,
  approved_at          timestamptz NOT NULL,
  approved_by          uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS facility_profile_versions_profile_idx
  ON facility_profile_versions(facility_profile_id, version);

CREATE TABLE IF NOT EXISTS training_corrections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  facility_profile_id  uuid REFERENCES facility_profiles(id) ON DELETE SET NULL,
  document_id          uuid,
  field_path           text NOT NULL,
  before               jsonb,
  after                jsonb NOT NULL,
  corrected_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  corrected_at         timestamptz NOT NULL DEFAULT now(),
  source_task          text
);
CREATE INDEX IF NOT EXISTS training_corrections_workspace_idx
  ON training_corrections(workspace_id, corrected_at);
CREATE INDEX IF NOT EXISTS training_corrections_profile_idx
  ON training_corrections(facility_profile_id);

CREATE TABLE IF NOT EXISTS inbound_emails (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  recipient         text NOT NULL,
  from_address      text NOT NULL,
  subject           text,
  raw_payload_uri   text NOT NULL,
  attachment_keys   jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  parsed_at         timestamptz,
  parse_status      text NOT NULL DEFAULT 'received'
);
CREATE INDEX IF NOT EXISTS inbound_emails_recipient_idx ON inbound_emails(recipient, received_at);
CREATE INDEX IF NOT EXISTS inbound_emails_workspace_idx ON inbound_emails(workspace_id, received_at);

-- ─── RLS ─────────────────────────────────────────────────────────────────

-- facilities: not workspace-scoped, no PHI. No RLS.

-- facility_profiles: workspace-scoped.
ALTER TABLE facility_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facility_profiles_tenant_isolation ON facility_profiles;
CREATE POLICY facility_profiles_tenant_isolation ON facility_profiles
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE facility_profile_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility_profile_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fpv_tenant_isolation ON facility_profile_versions;
CREATE POLICY fpv_tenant_isolation ON facility_profile_versions
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

ALTER TABLE training_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_corrections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tc_tenant_isolation ON training_corrections;
CREATE POLICY tc_tenant_isolation ON training_corrections
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- inbound_emails: workspace_id is nullable until the recipient is resolved.
-- Allow visibility once the workspace is set.
ALTER TABLE inbound_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_emails FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inbound_emails_tenant_isolation ON inbound_emails;
CREATE POLICY inbound_emails_tenant_isolation ON inbound_emails
  USING (
    workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id IS NULL
    OR workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
  );
