-- 0013_password_reset_tokens.sql
--
-- Separate table for password reset tokens — deliberately NOT reusing
-- magic_link_tokens because:
--   • Different TTL policy (reset is 30 min; magic-link is days).
--   • Different consume semantics (single-use, no rate-limit-by-email).
--   • A reset needs to fail closed if the account was deleted between
--     issue and consume; a foreign-key with ON DELETE CASCADE handles
--     that for free.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  request_ip   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_idx
  ON password_reset_tokens (expires_at)
  WHERE consumed_at IS NULL;
