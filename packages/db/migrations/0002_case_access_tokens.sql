-- M2: case-scoped access tokens for the provider mobile-web experience.

CREATE TABLE IF NOT EXISTS case_access_tokens (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL UNIQUE,
  case_id        uuid NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  provider_id    uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);

CREATE INDEX IF NOT EXISTS case_access_tokens_case_idx ON case_access_tokens(case_id);
CREATE INDEX IF NOT EXISTS case_access_tokens_provider_idx ON case_access_tokens(provider_id);

-- Not under RLS: pre-session lookup by hash, like magic_link_tokens.
