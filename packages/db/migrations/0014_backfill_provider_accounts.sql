-- 0014_backfill_provider_accounts.sql
--
-- Migration 0012 added providers.user_id but deliberately left it null
-- on existing rows. That created an "orphan provider" problem: providers
-- had a providers row (from the older /provider/auth/redeem-invite
-- magic-link path) but no matching users row, so the shared password
-- auth (login, reset) couldn't route them anywhere.
--
-- Concrete symptom: after password reset the FE pushed the provider to
-- /cockpit/pipeline; the cockpit layout requires a memberships row
-- (staff only), didn't find one, and bounced them to
-- /signin?reason=workspace_inactive — a redirect loop.
--
-- This migration heals every existing provider so they can sign in via
-- password reset without further intervention:
--
--   1. Data fix: one provider (Eddie McCray) was invited at his staff
--      email but actually uses a personal Gmail as his provider login.
--      Rewrite that provider row's email to match the address he uses.
--
--   2. Create users rows for every provider whose email isn't already
--      in the users table. email_verified_at is set because the invite
--      that produced the providers row already vouched for the email.
--
--   3. Link providers.user_id to the matching users.id by email.
--
-- The migration is idempotent — re-running is a no-op.

BEGIN;

-- 1. Eddie's provider row uses his personal email, not staff email.
UPDATE providers
SET email = 'emccray23@gmail.com',
    updated_at = now()
WHERE id = 'e81ca99e-0daf-4d3d-8799-ab15166f3cee'
  AND email = 'eddie.mccray@rosterhealthcare.com';

-- 2. Create users rows for grandfathered providers.
INSERT INTO users (email, name, email_verified_at)
SELECT
  lower(p.email),
  NULLIF(TRIM(CONCAT_WS(' ', p.first_name, p.last_name)), ''),
  now()
FROM providers p
LEFT JOIN users u ON lower(u.email) = lower(p.email)
WHERE p.user_id IS NULL
  AND p.email IS NOT NULL
  AND u.id IS NULL
ON CONFLICT (email) DO NOTHING;

-- 3. Link providers.user_id → users.id via email match. Only when the
--    link is currently null (unique index on user_id guards against
--    overwriting an existing link).
UPDATE providers p
SET user_id = u.id,
    updated_at = now()
FROM users u
WHERE p.user_id IS NULL
  AND p.email IS NOT NULL
  AND lower(u.email) = lower(p.email);

COMMIT;
