-- seed-signal-dev-overrides.sql
--
-- POST-ingest + POST-ranking seed: writes recruiter overrides against
-- rankings that already exist. Each row ties a seeded (job, provider)
-- pair to a direction (promote / demote) with a human-sounding reason
-- so the WS A learn worker has a meaningful signal to lift weights off.
--
-- We cannot inline these in seed-signal-dev.sql because signal_jobs
-- and signal_providers rows aren't created until the ingest runs
-- (their UUIDs are random — the seed addresses them by external id
-- through signal_source_lineage).
--
-- Idempotent: each override has a deterministic UUID and ON CONFLICT
-- DO NOTHING skips repeats. Direction + reason stay authoritative on
-- the first insert — rewrites happen via a separate operator path.
--
-- IMPORTANT: no explicit BEGIN/COMMIT in this file — orchestrate.ts
-- feeds it to postgres.js's single-statement .execute() which rejects
-- multi-statement transactions. The DO $$ block is implicitly atomic
-- (PL/pgSQL wraps itself in a subtransaction) and psql -f handles it
-- fine on its own.
DO $$
DECLARE
  ws uuid;
BEGIN
  SELECT id INTO ws FROM workspaces WHERE slug = 'roster-hc-beta';
  IF ws IS NULL THEN
    RAISE EXCEPTION 'platform-default workspace roster-hc-beta not found';
  END IF;

  -- Helper: resolve (case external_id, provider NPI) → signal_jobs.id,
  -- signal_providers.id — then insert one override row. Uses a CTE
  -- to localize the lookup join; ON CONFLICT (id) DO NOTHING keeps
  -- the script re-runnable.
  INSERT INTO signal_overrides (id, workspace_id, job_id, provider_id, user_id, direction, reason_text, at, created_at)
  SELECT
    v.override_id::uuid,
    ws,
    sj.id,
    sp.id,
    NULL,
    v.direction,
    v.reason,
    now() - (v.days_ago || ' days')::interval,
    now() - (v.days_ago || ' days')::interval
  FROM (
    VALUES
      -- promote: has history at this facility (Alex Morgan on Austin cardiac)
      ('a1a1a1a1-0000-0000-0000-000000000001', 'e0000001-0000-0000-0000-000000000001', '1700000001', 'promote', 'has history at this facility — strong cardiac fit', 2),
      -- promote: has history at this facility (Alex Morgan on Nashville cardiac)
      ('a1a1a1a1-0000-0000-0000-000000000002', 'e0000001-0000-0000-0000-000000000008', '1700000001', 'promote', 'placed at Nashville Cardiac before — recruiter pick', 1),
      -- promote: strong sub-specialty match (Priya Delgado on Atlanta cardiac)
      ('a1a1a1a1-0000-0000-0000-000000000003', 'e0000001-0000-0000-0000-000000000029', '1700000016', 'promote', 'CT anesthesia fellowship — top fit for Atlanta heart', 3),
      -- promote: has history at this facility (Kai Yamamoto on NY cardiac)
      ('a1a1a1a1-0000-0000-0000-000000000004', 'e0000001-0000-0000-0000-00000000000d', '1700000011', 'promote', 'Manhattan Surgical Center history — local preference', 5),
      -- demote: preferred region doesn''t match (Grey Umoren on LA pain)
      ('a1a1a1a1-0000-0000-0000-000000000005', 'e0000001-0000-0000-0000-00000000000a', '1700000007', 'demote',  'preferred region doesn''t match — stays Texas/Colorado', 4),
      -- demote: ranked too high given schedule conflict (Sage Guzman on NY pain)
      ('a1a1a1a1-0000-0000-0000-000000000006', 'e0000001-0000-0000-0000-00000000000f', '1700000019', 'demote',  'schedule conflict — booked through next month', 6),
      -- demote: overexposed (Priya Delgado on Charlotte cardiac — tenured, but overbooked)
      ('a1a1a1a1-0000-0000-0000-000000000007', 'e0000001-0000-0000-0000-00000000002e', '1700000016', 'demote',  'overbooked on Atlanta/Nashville — defer alternate region', 12),
      -- promote: older signal (Jules Xavier on LA pain — a few weeks ago)
      ('a1a1a1a1-0000-0000-0000-000000000008', 'e0000001-0000-0000-0000-00000000000a', '1700000010', 'promote', 'past client feedback — provider reliable, bump up', 21)
    ) AS v(override_id, ext_job_id, provider_npi, direction, reason, days_ago)
  JOIN signal_source_lineage sl
    ON sl.workspace_id   = ws
   AND sl.canonical_table = 'signal_jobs'
   AND sl.external_system = 'roster-internal'
   AND sl.external_id     = v.ext_job_id
  JOIN signal_jobs sj
    ON sj.id = sl.canonical_id AND sj.workspace_id = ws
  JOIN signal_providers sp
    ON sp.workspace_id = ws AND sp.npi = v.provider_npi
  ON CONFLICT (id) DO NOTHING;
END $$;
