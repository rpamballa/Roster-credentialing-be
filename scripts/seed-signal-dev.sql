-- seed-signal-dev.sql
--
-- Signal v0 · synthetic anesthesia dataset for the platform-default
-- workspace (slug `roster-hc-beta`). The script is deterministic +
-- idempotent — every row has a fixed UUID so re-running the script
-- restores the same world without creating duplicates. Safe to run
-- repeatedly on the dev instance (the shared `roster-prod` VM with
-- no real customers).
--
-- Shape:
--   5 facilities across both IMLC-compact + non-compact states
--   5 facility_profiles (status='approved', one per facility, v1)
--   10 synthetic anesthesia providers (mix of sub-specialties,
--      license states, board-cert states, background-check states)
--   10 provider_workspace_grants (every provider linked to the
--      platform-default workspace)
--   12 open cases/jobs across sub-specialties with mixed need_dates
--   ~40 verification rows (board_cert, dea, acls, immunizations,
--      background_check, drug_screen) per-provider for the WS C
--      credentials reader to pick up
--
-- All rows are inserted via ON CONFLICT DO NOTHING / UPDATE so the
-- script is re-runnable. It does NOT delete anything.

BEGIN;

-- The platform-default workspace is the only tenancy that gets
-- Signal v0. We resolve the id via subquery so the script is
-- portable across environments where the id differs.
--
-- Everything below references :ws via a CTE instead of parameter
-- binding so this file is plain psql-compatible (no psql vars).
DO $$
DECLARE
  ws uuid;
BEGIN
  SELECT id INTO ws FROM workspaces WHERE slug = 'roster-hc-beta';
  IF ws IS NULL THEN
    RAISE EXCEPTION 'platform-default workspace roster-hc-beta not found';
  END IF;

  -- ─── facilities ────────────────────────────────────────────────
  -- Address format `City, STATE ZIP` so the signal_jobs.state
  -- backfill below can parse the state code reliably.
  INSERT INTO facilities (id, name, address) VALUES
    ('a0000001-0000-0000-0000-000000000001', 'Austin Medical Center',          '100 Main St, Austin, TX 78701'),
    ('a0000001-0000-0000-0000-000000000002', 'Denver General Hospital',        '200 Elm Ave, Denver, CO 80202'),
    ('a0000001-0000-0000-0000-000000000003', 'Seattle Children''s Hospital',   '300 Pine St, Seattle, WA 98101'),
    ('a0000001-0000-0000-0000-000000000004', 'Nashville Cardiac Institute',    '400 Oak Rd, Nashville, TN 37203'),
    ('a0000001-0000-0000-0000-000000000005', 'Los Angeles Pain Center',        '500 Palm Blvd, Los Angeles, CA 90001')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address;

  -- ─── facility_profiles ─────────────────────────────────────────
  -- One approved profile per facility. `requirements` is a minimal
  -- JSON that satisfies the NOT NULL constraint — the ingest reader
  -- only cares about the facility_id join; it ignores the payload.
  INSERT INTO facility_profiles (id, facility_id, workspace_id, version, status, requirements, approved_at)
  VALUES
    ('b0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', ws, 1, 'approved', '{"version":1,"state":"TX","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000002', 'a0000001-0000-0000-0000-000000000002', ws, 1, 'approved', '{"version":1,"state":"CO","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000003', ws, 1, 'approved', '{"version":1,"state":"WA","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000004', 'a0000001-0000-0000-0000-000000000004', ws, 1, 'approved', '{"version":1,"state":"TN","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000005', 'a0000001-0000-0000-0000-000000000005', ws, 1, 'approved', '{"version":1,"state":"CA","signalSeed":true}'::jsonb, now())
  ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, requirements = EXCLUDED.requirements;

  -- ─── providers ─────────────────────────────────────────────────
  -- 10 synthetic anesthesia providers. `specialties` contains the
  -- sub-specialty code the match adapter understands (`cardiac`,
  -- `ob`, `pediatric`, `pain`, `general`). `states_licensed`
  -- becomes the provider's licence set via the credentials reader.
  INSERT INTO providers (id, npi, first_name, last_name, email, phone, specialties, states_licensed) VALUES
    ('c0000001-0000-0000-0000-000000000001', '1700000001', 'Alex',    'Morgan',    'alex.morgan@signal-seed.test',    '512-555-0101', ARRAY['anesthesiology','cardiac'],    ARRAY['TX','CO']),
    ('c0000001-0000-0000-0000-000000000002', '1700000002', 'Blair',   'Nguyen',    'blair.nguyen@signal-seed.test',   '512-555-0102', ARRAY['anesthesiology','ob'],         ARRAY['TX','WA']),
    ('c0000001-0000-0000-0000-000000000003', '1700000003', 'Casey',   'Patel',     'casey.patel@signal-seed.test',    '720-555-0103', ARRAY['anesthesiology','pediatric'],  ARRAY['CO','TN']),
    ('c0000001-0000-0000-0000-000000000004', '1700000004', 'Devin',   'Rivera',    'devin.rivera@signal-seed.test',   '206-555-0104', ARRAY['anesthesiology','pain'],       ARRAY['WA','CA']),
    ('c0000001-0000-0000-0000-000000000005', '1700000005', 'Eli',     'Sato',      'eli.sato@signal-seed.test',       '615-555-0105', ARRAY['anesthesiology','general'],    ARRAY['TN']),
    ('c0000001-0000-0000-0000-000000000006', '1700000006', 'Farah',   'Taylor',    'farah.taylor@signal-seed.test',   '213-555-0106', ARRAY['anesthesiology','cardiac'],    ARRAY['CA']),
    ('c0000001-0000-0000-0000-000000000007', '1700000007', 'Grey',    'Umoren',    'grey.umoren@signal-seed.test',    '512-555-0107', ARRAY['anesthesiology','general'],    ARRAY['TX','CO','WA']),
    ('c0000001-0000-0000-0000-000000000008', '1700000008', 'Hayden',  'Vasquez',   'hayden.vasquez@signal-seed.test', '720-555-0108', ARRAY['anesthesiology','ob'],         ARRAY['CO']),
    ('c0000001-0000-0000-0000-000000000009', '1700000009', 'Indra',   'Wyatt',     'indra.wyatt@signal-seed.test',    '615-555-0109', ARRAY['anesthesiology','pediatric'],  ARRAY['TN','TX']),
    ('c0000001-0000-0000-0000-00000000000a', '1700000010', 'Jules',   'Xavier',    'jules.xavier@signal-seed.test',   '206-555-0110', ARRAY['anesthesiology','pain'],       ARRAY['WA','CA','CO'])
  ON CONFLICT (id) DO UPDATE SET
    first_name      = EXCLUDED.first_name,
    last_name       = EXCLUDED.last_name,
    email           = EXCLUDED.email,
    phone           = EXCLUDED.phone,
    specialties     = EXCLUDED.specialties,
    states_licensed = EXCLUDED.states_licensed;

  -- ─── provider_workspace_grants ─────────────────────────────────
  -- Every synthetic provider is granted to the platform-default
  -- workspace so the ingest's inner-join reader finds them.
  INSERT INTO provider_workspace_grants (provider_id, workspace_id)
  SELECT p.id, ws
  FROM providers p
  WHERE p.email LIKE '%@signal-seed.test'
  ON CONFLICT (provider_id, workspace_id) DO NOTHING;

  -- ─── verifications ─────────────────────────────────────────────
  -- One board_cert + dea + acls + immunizations + background_check +
  -- drug_screen per provider. Mix of statuses so the earliest-start
  -- projection has interesting signal.
  INSERT INTO verifications (id, workspace_id, provider_id, type, source, state, license_number, status, verified_at)
  VALUES
    -- Provider 1 (Alex Morgan): fully current, TX+CO IMLC eligible
    ('d0000001-0000-0000-0000-000000000011', ws, 'c0000001-0000-0000-0000-000000000001', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000012', ws, 'c0000001-0000-0000-0000-000000000001', 'dea',              'manual', NULL, 'DEA1000001', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000013', ws, 'c0000001-0000-0000-0000-000000000001', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000014', ws, 'c0000001-0000-0000-0000-000000000001', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000015', ws, 'c0000001-0000-0000-0000-000000000001', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000016', ws, 'c0000001-0000-0000-0000-000000000001', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000017', ws, 'c0000001-0000-0000-0000-000000000001', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    -- Provider 2 (Blair Nguyen): board_cert LAPSED, otherwise ok
    ('d0000001-0000-0000-0000-000000000021', ws, 'c0000001-0000-0000-0000-000000000002', 'board_cert',       'abms',   NULL, NULL, 'lapsed',    now()),
    ('d0000001-0000-0000-0000-000000000022', ws, 'c0000001-0000-0000-0000-000000000002', 'dea',              'manual', NULL, 'DEA1000002', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000023', ws, 'c0000001-0000-0000-0000-000000000002', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000024', ws, 'c0000001-0000-0000-0000-000000000002', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000025', ws, 'c0000001-0000-0000-0000-000000000002', 'background_check', 'manual', NULL, NULL, 'pending',   now()),
    ('d0000001-0000-0000-0000-000000000026', ws, 'c0000001-0000-0000-0000-000000000002', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    -- Provider 3 (Casey Patel): peds, CO+TN
    ('d0000001-0000-0000-0000-000000000031', ws, 'c0000001-0000-0000-0000-000000000003', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000032', ws, 'c0000001-0000-0000-0000-000000000003', 'dea',              'manual', NULL, 'DEA1000003', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000033', ws, 'c0000001-0000-0000-0000-000000000003', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000034', ws, 'c0000001-0000-0000-0000-000000000003', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000035', ws, 'c0000001-0000-0000-0000-000000000003', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000036', ws, 'c0000001-0000-0000-0000-000000000003', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000037', ws, 'c0000001-0000-0000-0000-000000000003', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    -- Provider 4 (Devin Rivera): pain, WA+CA (CA is non-compact)
    ('d0000001-0000-0000-0000-000000000041', ws, 'c0000001-0000-0000-0000-000000000004', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000042', ws, 'c0000001-0000-0000-0000-000000000004', 'dea',              'manual', NULL, 'DEA1000004', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000043', ws, 'c0000001-0000-0000-0000-000000000004', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000044', ws, 'c0000001-0000-0000-0000-000000000004', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000045', ws, 'c0000001-0000-0000-0000-000000000004', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000046', ws, 'c0000001-0000-0000-0000-000000000004', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    -- Provider 5 (Eli Sato): general TN only, acls EXPIRED
    ('d0000001-0000-0000-0000-000000000051', ws, 'c0000001-0000-0000-0000-000000000005', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000052', ws, 'c0000001-0000-0000-0000-000000000005', 'dea',              'manual', NULL, 'DEA1000005', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000053', ws, 'c0000001-0000-0000-0000-000000000005', 'acls',             'manual', NULL, NULL, 'expired',   now()),
    ('d0000001-0000-0000-0000-000000000054', ws, 'c0000001-0000-0000-0000-000000000005', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000055', ws, 'c0000001-0000-0000-0000-000000000005', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000056', ws, 'c0000001-0000-0000-0000-000000000005', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    -- Provider 6 (Farah Taylor): cardiac CA only, NO IMLC
    ('d0000001-0000-0000-0000-000000000061', ws, 'c0000001-0000-0000-0000-000000000006', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000062', ws, 'c0000001-0000-0000-0000-000000000006', 'dea',              'manual', NULL, 'DEA1000006', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000063', ws, 'c0000001-0000-0000-0000-000000000006', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000064', ws, 'c0000001-0000-0000-0000-000000000006', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000065', ws, 'c0000001-0000-0000-0000-000000000006', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000066', ws, 'c0000001-0000-0000-0000-000000000006', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    -- Provider 7 (Grey Umoren): general TX+CO+WA IMLC eligible
    ('d0000001-0000-0000-0000-000000000071', ws, 'c0000001-0000-0000-0000-000000000007', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000072', ws, 'c0000001-0000-0000-0000-000000000007', 'dea',              'manual', NULL, 'DEA1000007', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000073', ws, 'c0000001-0000-0000-0000-000000000007', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000074', ws, 'c0000001-0000-0000-0000-000000000007', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000075', ws, 'c0000001-0000-0000-0000-000000000007', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000076', ws, 'c0000001-0000-0000-0000-000000000007', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000077', ws, 'c0000001-0000-0000-0000-000000000007', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    -- Provider 8 (Hayden Vasquez): OB CO only, drug_screen pending
    ('d0000001-0000-0000-0000-000000000081', ws, 'c0000001-0000-0000-0000-000000000008', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000082', ws, 'c0000001-0000-0000-0000-000000000008', 'dea',              'manual', NULL, 'DEA1000008', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000083', ws, 'c0000001-0000-0000-0000-000000000008', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000084', ws, 'c0000001-0000-0000-0000-000000000008', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000085', ws, 'c0000001-0000-0000-0000-000000000008', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000086', ws, 'c0000001-0000-0000-0000-000000000008', 'drug_screen',      'manual', NULL, NULL, 'pending',   now()),
    -- Provider 9 (Indra Wyatt): pediatric TN+TX
    ('d0000001-0000-0000-0000-000000000091', ws, 'c0000001-0000-0000-0000-000000000009', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000092', ws, 'c0000001-0000-0000-0000-000000000009', 'dea',              'manual', NULL, 'DEA1000009', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000093', ws, 'c0000001-0000-0000-0000-000000000009', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000094', ws, 'c0000001-0000-0000-0000-000000000009', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000095', ws, 'c0000001-0000-0000-0000-000000000009', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000096', ws, 'c0000001-0000-0000-0000-000000000009', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    -- Provider 10 (Jules Xavier): pain WA+CA+CO
    ('d0000001-0000-0000-0000-0000000000a1', ws, 'c0000001-0000-0000-0000-00000000000a', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000a2', ws, 'c0000001-0000-0000-0000-00000000000a', 'dea',              'manual', NULL, 'DEA1000010', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000a3', ws, 'c0000001-0000-0000-0000-00000000000a', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000a4', ws, 'c0000001-0000-0000-0000-00000000000a', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000a5', ws, 'c0000001-0000-0000-0000-00000000000a', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000a6', ws, 'c0000001-0000-0000-0000-00000000000a', 'drug_screen',      'manual', NULL, NULL, 'clear',     now())
  ON CONFLICT (id) DO NOTHING;

  -- ─── cases (= signal_jobs after ingest) ────────────────────────
  -- 12 open requisitions across sub-specialties with varied
  -- target_submission_date (urgent → relaxed). The ingest reader
  -- maps cases → signal_jobs; provider_id on the case row is the
  -- credentialing subject and does NOT influence ranking (which
  -- considers every provider granted to the workspace). We re-use
  -- the seeded synthetic providers so the credentialing FKs hold.
  INSERT INTO cases (id, workspace_id, provider_id, facility_profile_id, facility_profile_version, specialty, purpose, status, opened_at, target_submission_date, blockers) VALUES
    -- Austin TX — urgent, cardiac + general + ob
    ('e0000001-0000-0000-0000-000000000001', ws, 'c0000001-0000-0000-0000-000000000001', 'b0000001-0000-0000-0000-000000000001', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '14 days', CURRENT_DATE + 21, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000002', ws, 'c0000001-0000-0000-0000-000000000007', 'b0000001-0000-0000-0000-000000000001', '1', 'anesthesiology', 'initial_appointment', 'in_progress', now() - interval '21 days', CURRENT_DATE + 30, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000003', ws, 'c0000001-0000-0000-0000-000000000002', 'b0000001-0000-0000-0000-000000000001', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '7 days',  CURRENT_DATE + 45, '[]'::jsonb),
    -- Denver CO — pediatric + ob (compact state)
    ('e0000001-0000-0000-0000-000000000004', ws, 'c0000001-0000-0000-0000-000000000003', 'b0000001-0000-0000-0000-000000000002', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '10 days', CURRENT_DATE + 14, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000005', ws, 'c0000001-0000-0000-0000-000000000008', 'b0000001-0000-0000-0000-000000000002', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '5 days',  CURRENT_DATE + 60, '[]'::jsonb),
    -- Seattle WA — pediatric (compact)
    ('e0000001-0000-0000-0000-000000000006', ws, 'c0000001-0000-0000-0000-000000000004', 'b0000001-0000-0000-0000-000000000003', '1', 'anesthesiology', 'initial_appointment', 'in_progress', now() - interval '28 days', CURRENT_DATE + 7,  '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000007', ws, 'c0000001-0000-0000-0000-000000000009', 'b0000001-0000-0000-0000-000000000003', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '14 days', CURRENT_DATE + 35, '[]'::jsonb),
    -- Nashville TN — cardiac + general
    ('e0000001-0000-0000-0000-000000000008', ws, 'c0000001-0000-0000-0000-000000000001', 'b0000001-0000-0000-0000-000000000004', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '3 days',  CURRENT_DATE + 10, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000009', ws, 'c0000001-0000-0000-0000-000000000005', 'b0000001-0000-0000-0000-000000000004', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '9 days',  CURRENT_DATE + 42, '[]'::jsonb),
    -- Los Angeles CA — pain + cardiac (non-compact)
    ('e0000001-0000-0000-0000-00000000000a', ws, 'c0000001-0000-0000-0000-00000000000a', 'b0000001-0000-0000-0000-000000000005', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '6 days',  CURRENT_DATE + 20, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000000b', ws, 'c0000001-0000-0000-0000-000000000006', 'b0000001-0000-0000-0000-000000000005', '1', 'anesthesiology', 'initial_appointment', 'in_progress', now() - interval '18 days', CURRENT_DATE + 28, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000000c', ws, 'c0000001-0000-0000-0000-000000000004', 'b0000001-0000-0000-0000-000000000005', '1', 'anesthesiology', 'initial_appointment', 'intake',      now() - interval '2 days',  CURRENT_DATE + 55, '[]'::jsonb)
  ON CONFLICT (id) DO UPDATE SET
    target_submission_date = EXCLUDED.target_submission_date,
    status                 = EXCLUDED.status,
    facility_profile_id    = EXCLUDED.facility_profile_id;

  -- ─── case_notes (= signal_conversations via WS E) ──────────────
  -- A handful of structured case_notes so the extracts pipeline
  -- has conversation bodies to pull facets from.
  INSERT INTO case_notes (id, workspace_id, case_id, author_user_id, body, created_at)
  VALUES
    ('f0000001-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Provider Alex Morgan confirmed availability starting the week of ' || to_char(CURRENT_DATE + 21, 'Mon DD, YYYY') || '. Rate expectation: $240/hr. Prefers 7-on 7-off block schedule.', now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Grey Umoren is IMLC-registered and ready for TX / CO / WA placements. Can start within 10 business days of signed privileges.', now() - interval '3 days'),
    ('f0000001-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000006', NULL, 'Devin Rivera: pain fellowship confirmed. CA license active, WA active. Earliest start ' || to_char(CURRENT_DATE + 7, 'Mon DD, YYYY') || '.', now() - interval '1 day')
  ON CONFLICT (id) DO NOTHING;

END $$;

COMMIT;

-- ─── POST-INGEST: backfill signal_jobs.state from facility address ──
-- The WS C jobs reader leaves `signal_jobs.state` NULL (the cases
-- table doesn't carry a state). We derive it from the facility
-- address trailer `City, STATE ZIP`. This runs AFTER the ingest so
-- ranking has a real state to project against.
--
-- This block is in the script so operators can re-run it after any
-- re-ingest without hunting for the SQL.
UPDATE signal_jobs sj
SET state = sub.state
FROM (
  SELECT f.id AS facility_id,
         upper(substring(f.address FROM ',\s*([A-Z]{2})\s+\d{5}\s*$')) AS state
  FROM facilities f
) sub
WHERE sj.facility_id = sub.facility_id
  AND sub.state IS NOT NULL
  AND (sj.state IS NULL OR sj.state <> sub.state);
