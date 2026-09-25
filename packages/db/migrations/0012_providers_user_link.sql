-- 0012_providers_user_link.sql
--
-- Providers can now have a user account (login + password) instead of
-- only being reachable via case-scoped magic links. Add the FK.
--
-- Nullable so the current pool of providers (no user account yet) stays
-- valid. A future backfill will mint users rows for grandfathered
-- providers and link them.

ALTER TABLE providers
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- One user represents at most one provider (a provider account isn't a
-- shared login); UNIQUE index enforces that without blocking the
-- fill-in path.
CREATE UNIQUE INDEX IF NOT EXISTS providers_user_id_unique
  ON providers (user_id)
  WHERE user_id IS NOT NULL;
