-- Workspace-scoped invite tokens for the beta onboarding flow. Sits
-- alongside case_access_tokens (which requires a case_id and covers
-- the per-case invite path). This table lets a cockpit admin invite
-- a provider by email before any case exists.

CREATE TABLE IF NOT EXISTS provider_invite_tokens (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash           text NOT NULL UNIQUE,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email                text NOT NULL,
  full_name            text,
  invited_by_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  redeemed_at          timestamptz,
  provider_id          uuid REFERENCES providers(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_invite_tokens_workspace_idx
  ON provider_invite_tokens(workspace_id);
CREATE INDEX IF NOT EXISTS provider_invite_tokens_email_idx
  ON provider_invite_tokens(workspace_id, email);
