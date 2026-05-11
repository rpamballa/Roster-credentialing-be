-- M2: providers (cross-tenant via grants), documents, cases, ai_calls.

-- ─── enums ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE document_type AS ENUM (
    'medical_license', 'dea', 'board_certification', 'bls', 'acls',
    'medical_school_diploma', 'government_id', 'vaccination_record',
    'malpractice_insurance', 'cv', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_source AS ENUM (
    'provider_upload', 'facility_email', 'reference_form',
    'psv_pull', 'specialist_upload'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE extraction_status AS ENUM (
    'pending', 'running', 'succeeded', 'needs_review', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE case_status AS ENUM (
    'intake', 'in_progress', 'awaiting_provider', 'awaiting_references',
    'ready_for_review', 'submitted', 'completed', 'withdrawn'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE case_purpose AS ENUM ('privileging', 'initial_appointment', 'reappointment');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── providers (cross-tenant) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  npi               text UNIQUE,
  first_name        text NOT NULL,
  last_name         text NOT NULL,
  dob               date,
  ssn_encrypted     text,
  email             text,
  phone             text,
  specialties       text[] NOT NULL DEFAULT '{}',
  states_licensed   text[] NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_active_at    timestamptz
);
CREATE INDEX IF NOT EXISTS providers_email_idx ON providers(email);

CREATE TABLE IF NOT EXISTS provider_workspace_grants (
  provider_id   uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (provider_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS provider_workspace_grants_workspace_idx
  ON provider_workspace_grants(workspace_id);

-- ─── documents (provider-scoped, gated by grants) ────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id              uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  document_type            document_type NOT NULL,
  file_uri                 text NOT NULL,
  content_hash             text,
  original_filename        text,
  mime_type                text,
  page_count               integer,
  uploaded_at              timestamptz NOT NULL DEFAULT now(),
  uploaded_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  source                   document_source NOT NULL,
  extraction_status        extraction_status NOT NULL DEFAULT 'pending',
  extracted_fields         jsonb,
  extracted_at             timestamptz,
  confirmed_at             timestamptz,
  confirmed_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at               timestamptz,
  classifier_confidence    integer
);
CREATE INDEX IF NOT EXISTS documents_provider_idx ON documents(provider_id);
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(provider_id, document_type);
CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(content_hash);

-- ─── cases (workspace-scoped) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cases (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider_id                 uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  facility_profile_id         uuid,
  facility_profile_version    text,
  specialty                   text NOT NULL,
  purpose                     case_purpose NOT NULL,
  status                      case_status NOT NULL DEFAULT 'intake',
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  target_submission_date      date,
  submitted_at                timestamptz,
  completed_at                timestamptz,
  assigned_specialist_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  blockers                    jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS cases_workspace_status_idx ON cases(workspace_id, status);
CREATE INDEX IF NOT EXISTS cases_provider_idx ON cases(provider_id);

-- ─── ai_calls (cost + accuracy log) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_calls (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  task                   text NOT NULL,
  model                  text NOT NULL,
  model_version          text NOT NULL,
  input_tokens           integer NOT NULL,
  output_tokens          integer NOT NULL,
  cached_input_tokens    integer NOT NULL DEFAULT 0,
  latency_ms             integer NOT NULL,
  stop_reason            text,
  confidence_bp          integer,
  related_entity_type    text,
  related_entity_id      uuid,
  error                  text,
  prompt_snapshot        jsonb,
  response_snapshot      jsonb,
  timestamp              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_task_idx ON ai_calls(task, timestamp);
CREATE INDEX IF NOT EXISTS ai_calls_entity_idx ON ai_calls(related_entity_type, related_entity_id);

-- ─── RLS (PROMPT §4.1) ───────────────────────────────────────────────────

-- provider_workspace_grants: scoped to workspace.
ALTER TABLE provider_workspace_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_workspace_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pwg_tenant_isolation ON provider_workspace_grants;
CREATE POLICY pwg_tenant_isolation ON provider_workspace_grants
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- providers: visible iff the current workspace has a grant. The providers
-- table itself is cross-tenant; RLS makes the workspace boundary explicit.
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS providers_via_grants ON providers;
CREATE POLICY providers_via_grants ON providers
  USING (
    id IN (
      SELECT g.provider_id FROM provider_workspace_grants g
      WHERE g.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

-- documents: scoped via the provider grant.
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_via_grants ON documents;
CREATE POLICY documents_via_grants ON documents
  USING (
    provider_id IN (
      SELECT g.provider_id FROM provider_workspace_grants g
      WHERE g.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    provider_id IN (
      SELECT g.provider_id FROM provider_workspace_grants g
      WHERE g.workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

-- cases: workspace-scoped directly.
ALTER TABLE cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cases_tenant_isolation ON cases;
CREATE POLICY cases_tenant_isolation ON cases
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);

-- ai_calls is intentionally NOT under RLS — it is a cost/accuracy ledger
-- written by the @cred/ai chokepoint. Workspace association is by column.
