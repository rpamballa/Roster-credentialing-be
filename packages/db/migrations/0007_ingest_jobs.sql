-- Cockpit facility ingest pipeline. An ingest job tracks the lifecycle of a
-- specialist-uploaded privileging packet from signed-PUT through Opus parse.

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  facility_id           uuid REFERENCES facilities(id) ON DELETE SET NULL,
  uploaded_doc_uri      text NOT NULL,
  mime_type             text NOT NULL,
  size_bytes            integer NOT NULL,
  specialty_hint        text,
  detected_specialty    text,
  status                text NOT NULL DEFAULT 'uploaded',
  facility_profile_id   uuid REFERENCES facility_profiles(id) ON DELETE SET NULL,
  error                 text,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingest_jobs_workspace_idx ON ingest_jobs(workspace_id, status);
CREATE INDEX IF NOT EXISTS ingest_jobs_facility_idx ON ingest_jobs(facility_id);

ALTER TABLE ingest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ingest_jobs_tenant_isolation ON ingest_jobs;
CREATE POLICY ingest_jobs_tenant_isolation ON ingest_jobs
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
