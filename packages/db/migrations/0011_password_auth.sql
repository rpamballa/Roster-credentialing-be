-- 0011_password_auth.sql
--
-- Foundation for username/password auth alongside magic-link.
--
-- 1) users.password_hash: nullable so existing users (magic-link only)
--    keep working until they set a password. The login endpoint refuses
--    empty hashes with "no password set — use magic-link instead".
--
-- 2) Rename the platform's own workspace to "Roster Healthcare" (drops
--    the beta suffix). Idempotent — only rewrites if the current name
--    is literally "Roster Healthcare Beta".

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash text;

UPDATE workspaces
  SET name = 'Roster Healthcare'
  WHERE name = 'Roster Healthcare Beta';
