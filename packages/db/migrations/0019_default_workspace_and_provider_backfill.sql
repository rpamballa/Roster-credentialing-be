-- 0019_default_workspace_and_provider_backfill.sql
--
-- Product rule: every provider lives in at least one workspace. When
-- no specific workspace is named at account-creation time, the
-- provider lands in the platform's default workspace (the
-- "Roster Healthcare" tenant, slug `roster-hc-beta`). This was decided
-- in product but never enforced: ensureProviderAccount took
-- workspaceId as a required parameter, no fallback existed, and
-- migration 0014 only healed the users+providers linkage — not the
-- grants table. Result: a class of providers (grandfathered
-- magic-link redeems, any future code path that forgot to pass a
-- workspace) ended up with zero provider_workspace_grants rows and
-- was invisible to every Cockpit UI.
--
-- This migration does three things:
--
--   1. Adds workspaces.is_platform_default + a unique partial index so
--      exactly one workspace can hold the flag.
--
--   2. Marks the existing Roster Healthcare workspace as the default.
--      The slug is pinned to the row that exists in prod today
--      (roster-hc-beta). The UPDATE is a no-op on dev/staging where
--      that slug isn't present; those environments will mark their
--      own default via seed.
--
--   3. Backfills provider_workspace_grants for every provider that
--      currently has zero grants, pointing at whichever workspace is
--      the platform default. Idempotent (ON CONFLICT DO NOTHING on
--      the composite primary key).
--
-- The code-side change that makes this permanent lives in
-- packages/auth/src/provider-account.ts (ensureProviderAccount's
-- workspaceId becomes optional, defaulting to the platform-default
-- workspace via getDefaultWorkspaceId()). The migration + the code
-- change ship together.

BEGIN;

-- 1. Column + uniqueness invariant (at most one default workspace).
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS is_platform_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_only_one_platform_default
  ON workspaces ((1))
  WHERE is_platform_default;

-- 2. Mark prod's Roster Healthcare workspace as the platform default.
--    No-op outside prod.
UPDATE workspaces
   SET is_platform_default = true
 WHERE slug = 'roster-hc-beta'
   AND is_platform_default = false;

-- 3. Backfill: every provider with zero grants gets a grant to the
--    platform-default workspace, if one is configured. If no default
--    is configured (dev/staging seeding hasn't run), this is a no-op
--    and the invariant check further down is skipped.
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
  SELECT 1
  FROM provider_workspace_grants g
  WHERE g.provider_id = p.id
)
ON CONFLICT (provider_id, workspace_id) DO NOTHING;

-- Invariant check: after this migration, if a platform default is
-- configured, no provider may have zero grants. Raise on violation so
-- a bad deploy fails loudly rather than silently leaving records
-- stranded. Skipped when no default is configured (dev/staging that
-- haven't seeded one yet).
DO $$
DECLARE
  default_count INT;
  stranded_count INT;
BEGIN
  SELECT COUNT(*) INTO default_count FROM workspaces WHERE is_platform_default;
  IF default_count = 0 THEN
    RAISE NOTICE 'No platform-default workspace configured; skipping stranded-provider check.';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO stranded_count
    FROM providers p
   WHERE NOT EXISTS (
     SELECT 1 FROM provider_workspace_grants g WHERE g.provider_id = p.id
   );
  IF stranded_count > 0 THEN
    RAISE EXCEPTION 'migration 0019 invariant failed: % providers still have zero grants after backfill', stranded_count;
  END IF;
END
$$;

COMMIT;
