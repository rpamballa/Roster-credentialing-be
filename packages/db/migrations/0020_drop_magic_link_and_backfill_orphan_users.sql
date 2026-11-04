-- 0020_drop_magic_link_and_backfill_orphan_users.sql
--
-- Two related cleanups that ship together:
--
-- 1. DROP TABLE magic_link_tokens. The /auth/magic-link/* endpoints
--    were removed in the same PR (see apps/api/src/routes/auth.ts).
--    The flow upserted a users row WITHOUT ever creating a providers
--    row, which is how shanthanramidi@gmail.com ended up visible on
--    /welcome but invisible in every Cockpit providers list — her
--    account chain stopped at users.
--
-- 2. Backfill: for every users row with NO membership AND NO
--    providers row, materialize a providers row + a grant to the
--    platform-default workspace. These are the "orphan users" the
--    magic-link flow produced in the past; without this backfill,
--    migration 0019's invariant isn't enough.
--
-- The invariant check at the end asserts both:
--   (a) zero orphan users left
--   (b) zero stranded providers (also covered by 0019)
--
-- Forward-only; revert by writing a new migration.

BEGIN;

-- 1. Backfill providers + grants for orphan users BEFORE we drop the
--    magic_link_tokens table, so a diagnostic query can still cross-
--    reference which orphans came from magic-link if needed. The
--    order doesn't actually matter — they touch different tables — but
--    keeping the data-healing step first makes the intent legible.

-- Create a providers row for every users row that's clearly not staff
-- (no memberships) and has no existing providers row. We derive the
-- first_name from the users.name when present, else from the email's
-- local-part (title-cased), matching the convention
-- ensureProviderAccount uses for anonymous invites.
INSERT INTO providers (email, first_name, last_name, user_id)
SELECT
  u.email,
  COALESCE(
    NULLIF(split_part(COALESCE(u.name, ''), ' ', 1), ''),
    initcap(split_part(u.email, '@', 1))
  ),
  COALESCE(
    NULLIF(
      trim(substring(COALESCE(u.name, '') from position(' ' in u.name || ' ') + 1)),
      ''
    ),
    ''
  ),
  u.id
FROM users u
LEFT JOIN memberships m ON m.user_id = u.id
LEFT JOIN providers p ON p.user_id = u.id
WHERE m.user_id IS NULL
  AND p.user_id IS NULL
  -- info@rosterhealthcare.com is a service mailbox, not a provider.
  -- Exclude it so the backfill doesn't materialize a bogus provider.
  AND lower(u.email) <> 'info@rosterhealthcare.com'
ON CONFLICT DO NOTHING;

-- Grant the newly-materialized (and any still-grantless) providers to
-- the platform-default workspace. Same CROSS JOIN LATERAL pattern as
-- 0019 — a no-op in envs with no default configured.
INSERT INTO provider_workspace_grants (provider_id, workspace_id, granted_at, granted_by)
SELECT
  p.id,
  dw.id,
  now(),
  NULL
FROM providers p
CROSS JOIN LATERAL (
  SELECT id FROM workspaces WHERE is_platform_default LIMIT 1
) dw
WHERE NOT EXISTS (
  SELECT 1 FROM provider_workspace_grants g WHERE g.provider_id = p.id
)
ON CONFLICT (provider_id, workspace_id) DO NOTHING;

-- 2. Drop magic_link_tokens. Any in-flight magic-link token is
--    invalidated — acceptable because the endpoints that consume
--    them were removed in the same PR, so no new ones were issued
--    and the client can't verify an old one anyway.
DROP TABLE IF EXISTS magic_link_tokens;

-- Invariants: enforce the product rules this PR is here to establish.
DO $$
DECLARE
  default_count INT;
  orphan_users INT;
  stranded_providers INT;
BEGIN
  SELECT COUNT(*) INTO default_count FROM workspaces WHERE is_platform_default;
  IF default_count = 0 THEN
    RAISE NOTICE 'No platform-default workspace configured; skipping orphan-user and stranded-provider checks.';
    RETURN;
  END IF;

  -- No users row may have (no membership AND no providers row), with
  -- the service-mailbox carve-out we applied above.
  SELECT COUNT(*) INTO orphan_users
    FROM users u
    LEFT JOIN memberships m ON m.user_id = u.id
    LEFT JOIN providers p ON p.user_id = u.id
   WHERE m.user_id IS NULL
     AND p.user_id IS NULL
     AND lower(u.email) <> 'info@rosterhealthcare.com';
  IF orphan_users > 0 THEN
    RAISE EXCEPTION 'migration 0020 invariant failed: % orphan users (no membership, no providers row) after backfill', orphan_users;
  END IF;

  -- No providers row may have zero grants. (Also enforced by 0019 at
  -- its own completion; re-asserted here because we just inserted new
  -- providers rows.)
  SELECT COUNT(*) INTO stranded_providers
    FROM providers p
   WHERE NOT EXISTS (
     SELECT 1 FROM provider_workspace_grants g WHERE g.provider_id = p.id
   );
  IF stranded_providers > 0 THEN
    RAISE EXCEPTION 'migration 0020 invariant failed: % providers still have zero grants after backfill', stranded_providers;
  END IF;
END
$$;

COMMIT;
