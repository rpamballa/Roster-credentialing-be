-- seed-signal-dev.sql
--
-- Signal v0 · synthetic anesthesia dataset for the platform-default
-- workspace (slug `roster-hc-beta`). Deterministic + idempotent —
-- every row has a fixed UUID so re-running restores the same world
-- without creating duplicates. Safe to run repeatedly on the dev
-- instance (the shared `roster-prod` VM with no real customers).
--
-- Shape (v2 expansion):
--   15 facilities across a wide mix of IMLC-compact + non-compact
--      states (CA, TX, NY, FL, WA, CO, TN, IL, GA, MA, AZ, NC, PA,
--      OH, MI)
--   15 facility_profiles (status='approved', one per facility, v1)
--   25 synthetic anesthesia providers (mix of sub-specialties,
--      license states, board-cert states, background-check states,
--      IMLC eligibility, state_csr coverage per state)
--   25 provider_workspace_grants (every provider granted to the
--      platform-default workspace)
--   37 open/in-progress cases/jobs across sub-specialties with
--      varied need_dates (urgent 14-21d / mid 28-45d / comfortable
--      60-120d)
--   ~165 verification rows (board_cert, dea, state_csr, acls,
--      immunizations, background_check, drug_screen, imlc) —
--      per-state state_csr coverage makes earliest-start
--      projections diverge sensibly (a TX-licensed provider with
--      an active TX CSR projects ~14d for a TX job; one without
--      projects ~45d, filtering out of urgent windows).
--   15 case_notes with rich text so WS E extracts fire across all
--      five v0 facets (REGION_PREFERENCE, TIMING_WINDOW,
--      RATE_EXPECTATION, SUBSPECIALTY_INTEREST, AVAILABILITY_SIGNAL)
--
-- All rows are inserted via ON CONFLICT DO UPDATE / NOTHING so the
-- script is re-runnable. It does NOT delete anything.
--
-- v0 → v2 migration notes:
--   - Existing 10 providers (UUIDs c0000001-…-01…-0a) are preserved;
--     their license / sub-specialty assignments are updated in place
--     and new state_csr rows are added so earliest-start projections
--     diverge per-state. Existing cases are updated to carry
--     canonical sub-specialty tokens (cardiac/ob/pediatric/pain/
--     general) so the ranker's SUBSPECIALTY_MATCH facet and the
--     bridge's sub-specialty confidence scoring both fire.

BEGIN;

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
  -- backfill (end of file) can parse the state code reliably.
  INSERT INTO facilities (id, name, address) VALUES
    -- v0 (original 5)
    ('a0000001-0000-0000-0000-000000000001', 'Austin Medical Center',           '100 Main St, Austin, TX 78701'),
    ('a0000001-0000-0000-0000-000000000002', 'Denver General Hospital',         '200 Elm Ave, Denver, CO 80202'),
    ('a0000001-0000-0000-0000-000000000003', 'Seattle Children''s Hospital',    '300 Pine St, Seattle, WA 98101'),
    ('a0000001-0000-0000-0000-000000000004', 'Nashville Cardiac Institute',     '400 Oak Rd, Nashville, TN 37203'),
    ('a0000001-0000-0000-0000-000000000005', 'Los Angeles Pain Center',         '500 Palm Blvd, Los Angeles, CA 90001'),
    -- v2 additions (10 more, across IMLC-compact + non-compact)
    ('a0000001-0000-0000-0000-000000000006', 'Manhattan Surgical Center',       '600 Broadway, New York, NY 10012'),
    ('a0000001-0000-0000-0000-000000000007', 'Miami Women''s Hospital',         '700 Collins Ave, Miami, FL 33139'),
    ('a0000001-0000-0000-0000-000000000008', 'Chicago West Hospital',           '800 N State St, Chicago, IL 60610'),
    ('a0000001-0000-0000-0000-000000000009', 'Phoenix Desert Medical',          '900 Camelback Rd, Phoenix, AZ 85012'),
    ('a0000001-0000-0000-0000-00000000000a', 'Boston Metro Hospital',           '100 Longwood Ave, Boston, MA 02115'),
    ('a0000001-0000-0000-0000-00000000000b', 'Atlanta Heart Center',            '110 Peachtree St, Atlanta, GA 30303'),
    ('a0000001-0000-0000-0000-00000000000c', 'Cleveland Memorial Hospital',     '120 Euclid Ave, Cleveland, OH 44114'),
    ('a0000001-0000-0000-0000-00000000000d', 'Charlotte Regional Medical',      '130 Trade St, Charlotte, NC 28202'),
    ('a0000001-0000-0000-0000-00000000000e', 'Detroit Riverside Hospital',      '140 Jefferson Ave, Detroit, MI 48226'),
    ('a0000001-0000-0000-0000-00000000000f', 'Philadelphia Children''s East',   '150 Market St, Philadelphia, PA 19103')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address;

  -- ─── facility_profiles ─────────────────────────────────────────
  INSERT INTO facility_profiles (id, facility_id, workspace_id, version, status, requirements, approved_at)
  VALUES
    ('b0000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', ws, 1, 'approved', '{"version":1,"state":"TX","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000002', 'a0000001-0000-0000-0000-000000000002', ws, 1, 'approved', '{"version":1,"state":"CO","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000003', 'a0000001-0000-0000-0000-000000000003', ws, 1, 'approved', '{"version":1,"state":"WA","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000004', 'a0000001-0000-0000-0000-000000000004', ws, 1, 'approved', '{"version":1,"state":"TN","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000005', 'a0000001-0000-0000-0000-000000000005', ws, 1, 'approved', '{"version":1,"state":"CA","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000006', 'a0000001-0000-0000-0000-000000000006', ws, 1, 'approved', '{"version":1,"state":"NY","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000007', 'a0000001-0000-0000-0000-000000000007', ws, 1, 'approved', '{"version":1,"state":"FL","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000008', 'a0000001-0000-0000-0000-000000000008', ws, 1, 'approved', '{"version":1,"state":"IL","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-000000000009', 'a0000001-0000-0000-0000-000000000009', ws, 1, 'approved', '{"version":1,"state":"AZ","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-00000000000a', 'a0000001-0000-0000-0000-00000000000a', ws, 1, 'approved', '{"version":1,"state":"MA","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-00000000000b', 'a0000001-0000-0000-0000-00000000000b', ws, 1, 'approved', '{"version":1,"state":"GA","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-00000000000c', 'a0000001-0000-0000-0000-00000000000c', ws, 1, 'approved', '{"version":1,"state":"OH","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-00000000000d', 'a0000001-0000-0000-0000-00000000000d', ws, 1, 'approved', '{"version":1,"state":"NC","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-00000000000e', 'a0000001-0000-0000-0000-00000000000e', ws, 1, 'approved', '{"version":1,"state":"MI","signalSeed":true}'::jsonb, now()),
    ('b0000001-0000-0000-0000-00000000000f', 'a0000001-0000-0000-0000-00000000000f', ws, 1, 'approved', '{"version":1,"state":"PA","signalSeed":true}'::jsonb, now())
  ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, requirements = EXCLUDED.requirements;

  -- ─── providers ─────────────────────────────────────────────────
  -- 25 synthetic anesthesia providers. `specialties` includes the
  -- `anesthesiology` tag plus the canonical sub-specialty token the
  -- bridge understands (`cardiac` / `ob` / `pediatric` / `pain` /
  -- `general`). `states_licensed` becomes the provider's licence
  -- set via the credentials reader.
  INSERT INTO providers (id, npi, first_name, last_name, email, phone, specialties, states_licensed) VALUES
    -- v0 (preserved)
    ('c0000001-0000-0000-0000-000000000001', '1700000001', 'Alex',     'Morgan',     'alex.morgan@signal-seed.test',     '512-555-0101', ARRAY['anesthesiology','cardiac'],    ARRAY['TX','CO']),
    ('c0000001-0000-0000-0000-000000000002', '1700000002', 'Blair',    'Nguyen',     'blair.nguyen@signal-seed.test',    '512-555-0102', ARRAY['anesthesiology','ob'],         ARRAY['TX','WA']),
    ('c0000001-0000-0000-0000-000000000003', '1700000003', 'Casey',    'Patel',      'casey.patel@signal-seed.test',     '720-555-0103', ARRAY['anesthesiology','pediatric'],  ARRAY['CO','TN']),
    ('c0000001-0000-0000-0000-000000000004', '1700000004', 'Devin',    'Rivera',     'devin.rivera@signal-seed.test',    '206-555-0104', ARRAY['anesthesiology','pain'],       ARRAY['WA','CA']),
    ('c0000001-0000-0000-0000-000000000005', '1700000005', 'Eli',      'Sato',       'eli.sato@signal-seed.test',        '615-555-0105', ARRAY['anesthesiology','general'],    ARRAY['TN']),
    ('c0000001-0000-0000-0000-000000000006', '1700000006', 'Farah',    'Taylor',     'farah.taylor@signal-seed.test',    '213-555-0106', ARRAY['anesthesiology','cardiac'],    ARRAY['CA']),
    ('c0000001-0000-0000-0000-000000000007', '1700000007', 'Grey',     'Umoren',     'grey.umoren@signal-seed.test',     '512-555-0107', ARRAY['anesthesiology','general'],    ARRAY['TX','CO','WA']),
    ('c0000001-0000-0000-0000-000000000008', '1700000008', 'Hayden',   'Vasquez',    'hayden.vasquez@signal-seed.test',  '720-555-0108', ARRAY['anesthesiology','ob'],         ARRAY['CO']),
    ('c0000001-0000-0000-0000-000000000009', '1700000009', 'Indra',    'Wyatt',      'indra.wyatt@signal-seed.test',     '615-555-0109', ARRAY['anesthesiology','pediatric'],  ARRAY['TN','TX']),
    ('c0000001-0000-0000-0000-00000000000a', '1700000010', 'Jules',    'Xavier',     'jules.xavier@signal-seed.test',    '206-555-0110', ARRAY['anesthesiology','pain'],       ARRAY['WA','CA','CO']),
    -- v2 additions (15 more)
    ('c0000001-0000-0000-0000-00000000000b', '1700000011', 'Kai',      'Yamamoto',   'kai.yamamoto@signal-seed.test',    '212-555-0111', ARRAY['anesthesiology','cardiac'],    ARRAY['NY','NJ']),
    ('c0000001-0000-0000-0000-00000000000c', '1700000012', 'Luna',     'Zabala',     'luna.zabala@signal-seed.test',     '305-555-0112', ARRAY['anesthesiology','ob'],         ARRAY['FL','GA']),
    ('c0000001-0000-0000-0000-00000000000d', '1700000013', 'Mira',     'Abbas',      'mira.abbas@signal-seed.test',      '617-555-0113', ARRAY['anesthesiology','pediatric'],  ARRAY['MA','NY']),
    ('c0000001-0000-0000-0000-00000000000e', '1700000014', 'Niko',     'Brennan',    'niko.brennan@signal-seed.test',    '312-555-0114', ARRAY['anesthesiology','pain'],       ARRAY['IL','OH','MI']),
    ('c0000001-0000-0000-0000-00000000000f', '1700000015', 'Omar',     'Choi',       'omar.choi@signal-seed.test',       '602-555-0115', ARRAY['anesthesiology','general'],    ARRAY['AZ','CO','IL']),
    ('c0000001-0000-0000-0000-000000000010', '1700000016', 'Priya',    'Delgado',    'priya.delgado@signal-seed.test',   '404-555-0116', ARRAY['anesthesiology','cardiac'],    ARRAY['GA','TN']),
    ('c0000001-0000-0000-0000-000000000011', '1700000017', 'Quinn',    'Erikson',    'quinn.erikson@signal-seed.test',   '216-555-0117', ARRAY['anesthesiology','ob'],         ARRAY['OH','PA']),
    ('c0000001-0000-0000-0000-000000000012', '1700000018', 'Ravi',     'Fonseca',    'ravi.fonseca@signal-seed.test',    '704-555-0118', ARRAY['anesthesiology','general'],    ARRAY['NC','GA','TN']),
    ('c0000001-0000-0000-0000-000000000013', '1700000019', 'Sage',     'Guzman',     'sage.guzman@signal-seed.test',     '215-555-0119', ARRAY['anesthesiology','pain'],       ARRAY['PA','NY']),
    ('c0000001-0000-0000-0000-000000000014', '1700000020', 'Tariq',    'Hart',       'tariq.hart@signal-seed.test',      '313-555-0120', ARRAY['anesthesiology','cardiac'],    ARRAY['MI','OH']),
    ('c0000001-0000-0000-0000-000000000015', '1700000021', 'Uma',      'Ibrahim',    'uma.ibrahim@signal-seed.test',     '212-555-0121', ARRAY['anesthesiology','general'],    ARRAY['NY','TX']),
    ('c0000001-0000-0000-0000-000000000016', '1700000022', 'Vera',     'Juarez',     'vera.juarez@signal-seed.test',     '305-555-0122', ARRAY['anesthesiology','ob'],         ARRAY['FL','CA']),
    ('c0000001-0000-0000-0000-000000000017', '1700000023', 'Will',     'Khan',       'will.khan@signal-seed.test',       '617-555-0123', ARRAY['anesthesiology','general'],    ARRAY['MA','PA']),
    ('c0000001-0000-0000-0000-000000000018', '1700000024', 'Xian',     'Lopez',      'xian.lopez@signal-seed.test',      '512-555-0124', ARRAY['anesthesiology','pediatric'],  ARRAY['TX','GA','IL']),
    ('c0000001-0000-0000-0000-000000000019', '1700000025', 'Yael',     'Monroe',     'yael.monroe@signal-seed.test',     '720-555-0125', ARRAY['anesthesiology','pain'],       ARRAY['CO','WA','AZ']),
    -- v3 additions: lifecycle-breadth (NEWLY ONBOARDED — within last 2 weeks)
    ('c0000001-0000-0000-0000-00000000001a', '1700000026', 'Zoe',      'Alvarado',   'zoe.alvarado@signal-seed.test',    '512-555-0126', ARRAY['anesthesiology','cardiac'],    ARRAY['TX']),
    ('c0000001-0000-0000-0000-00000000001b', '1700000027', 'Ari',      'Bello',      'ari.bello@signal-seed.test',       '305-555-0127', ARRAY['anesthesiology','ob'],         ARRAY['FL']),
    ('c0000001-0000-0000-0000-00000000001c', '1700000028', 'Bodhi',    'Cho',        'bodhi.cho@signal-seed.test',       '617-555-0128', ARRAY['anesthesiology','pediatric'],  ARRAY['MA'])
  ON CONFLICT (id) DO UPDATE SET
    first_name      = EXCLUDED.first_name,
    last_name       = EXCLUDED.last_name,
    email           = EXCLUDED.email,
    phone           = EXCLUDED.phone,
    specialties     = EXCLUDED.specialties,
    states_licensed = EXCLUDED.states_licensed;

  -- ─── lifecycle breadth: created_at timestamps ──────────────────
  -- New onboards (within last 2 weeks) — minimal verifications,
  -- pending background checks.
  UPDATE providers SET created_at = now() - interval '5 days'  WHERE id = 'c0000001-0000-0000-0000-00000000001a';
  UPDATE providers SET created_at = now() - interval '9 days'  WHERE id = 'c0000001-0000-0000-0000-00000000001b';
  UPDATE providers SET created_at = now() - interval '12 days' WHERE id = 'c0000001-0000-0000-0000-00000000001c';
  -- Long-tenured providers (> 6 months in platform) — bump three
  -- of the existing cohort back in time so the ranker sees a mix.
  UPDATE providers SET created_at = now() - interval '14 months' WHERE id = 'c0000001-0000-0000-0000-000000000001'; -- Alex Morgan
  UPDATE providers SET created_at = now() - interval '18 months' WHERE id = 'c0000001-0000-0000-0000-000000000007'; -- Grey Umoren
  UPDATE providers SET created_at = now() - interval '11 months' WHERE id = 'c0000001-0000-0000-0000-00000000000a'; -- Jules Xavier
  UPDATE providers SET created_at = now() - interval '13 months' WHERE id = 'c0000001-0000-0000-0000-000000000010'; -- Priya Delgado
  UPDATE providers SET created_at = now() - interval '9 months'  WHERE id = 'c0000001-0000-0000-0000-00000000000f'; -- Omar Choi

  -- ─── provider_workspace_grants ─────────────────────────────────
  INSERT INTO provider_workspace_grants (provider_id, workspace_id)
  SELECT p.id, ws
  FROM providers p
  WHERE p.email LIKE '%@signal-seed.test'
  ON CONFLICT (provider_id, workspace_id) DO NOTHING;

  -- ─── verifications ─────────────────────────────────────────────
  -- Per-provider: board_cert, dea, acls, immunizations,
  -- background_check, drug_screen. Plus state_csr rows for each
  -- state where the provider holds an active controlled-substance
  -- registration (covers ~60-80% of their licensed states so some
  -- states project 0d, others project +45d). Plus IMLC active for
  -- providers who are compact-eligible.
  INSERT INTO verifications (id, workspace_id, provider_id, type, source, state, license_number, status, verified_at)
  VALUES
    -- ── Provider 1 (Alex Morgan): cardiac, TX+CO, IMLC-eligible, fully current
    ('d0000001-0000-0000-0000-000000000011', ws, 'c0000001-0000-0000-0000-000000000001', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000012', ws, 'c0000001-0000-0000-0000-000000000001', 'dea',              'manual', NULL, 'DEA1000001', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000013', ws, 'c0000001-0000-0000-0000-000000000001', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000014', ws, 'c0000001-0000-0000-0000-000000000001', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000015', ws, 'c0000001-0000-0000-0000-000000000001', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000016', ws, 'c0000001-0000-0000-0000-000000000001', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000017', ws, 'c0000001-0000-0000-0000-000000000001', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000018', ws, 'c0000001-0000-0000-0000-000000000001', 'state_csr',        'manual', 'TX', 'CSR-TX-001',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000019', ws, 'c0000001-0000-0000-0000-000000000001', 'state_csr',        'manual', 'CO', 'CSR-CO-001',  'active',   now()),
    -- ── Provider 2 (Blair Nguyen): ob, TX+WA, board cert LAPSED (filtered from most jobs via +365d)
    ('d0000001-0000-0000-0000-000000000021', ws, 'c0000001-0000-0000-0000-000000000002', 'board_cert',       'abms',   NULL, NULL, 'lapsed',    now()),
    ('d0000001-0000-0000-0000-000000000022', ws, 'c0000001-0000-0000-0000-000000000002', 'dea',              'manual', NULL, 'DEA1000002', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000023', ws, 'c0000001-0000-0000-0000-000000000002', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000024', ws, 'c0000001-0000-0000-0000-000000000002', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000025', ws, 'c0000001-0000-0000-0000-000000000002', 'background_check', 'manual', NULL, NULL, 'pending',   now()),
    ('d0000001-0000-0000-0000-000000000026', ws, 'c0000001-0000-0000-0000-000000000002', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000027', ws, 'c0000001-0000-0000-0000-000000000002', 'state_csr',        'manual', 'TX', 'CSR-TX-002',  'active',   now()),
    -- ── Provider 3 (Casey Patel): pediatric, CO+TN (both IMLC-compact), IMLC-eligible
    ('d0000001-0000-0000-0000-000000000031', ws, 'c0000001-0000-0000-0000-000000000003', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000032', ws, 'c0000001-0000-0000-0000-000000000003', 'dea',              'manual', NULL, 'DEA1000003', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000033', ws, 'c0000001-0000-0000-0000-000000000003', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000034', ws, 'c0000001-0000-0000-0000-000000000003', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000035', ws, 'c0000001-0000-0000-0000-000000000003', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000036', ws, 'c0000001-0000-0000-0000-000000000003', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000037', ws, 'c0000001-0000-0000-0000-000000000003', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000038', ws, 'c0000001-0000-0000-0000-000000000003', 'state_csr',        'manual', 'CO', 'CSR-CO-003',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000039', ws, 'c0000001-0000-0000-0000-000000000003', 'state_csr',        'manual', 'TN', 'CSR-TN-003',  'active',   now()),
    -- ── Provider 4 (Devin Rivera): pain, WA+CA (WA compact, CA not), NO IMLC
    ('d0000001-0000-0000-0000-000000000041', ws, 'c0000001-0000-0000-0000-000000000004', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000042', ws, 'c0000001-0000-0000-0000-000000000004', 'dea',              'manual', NULL, 'DEA1000004', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000043', ws, 'c0000001-0000-0000-0000-000000000004', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000044', ws, 'c0000001-0000-0000-0000-000000000004', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000045', ws, 'c0000001-0000-0000-0000-000000000004', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000046', ws, 'c0000001-0000-0000-0000-000000000004', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000047', ws, 'c0000001-0000-0000-0000-000000000004', 'state_csr',        'manual', 'WA', 'CSR-WA-004',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000048', ws, 'c0000001-0000-0000-0000-000000000004', 'state_csr',        'manual', 'CA', 'CSR-CA-004',  'active',   now()),
    -- ── Provider 5 (Eli Sato): general, TN only, ACLS EXPIRED (minor delta, not binding)
    ('d0000001-0000-0000-0000-000000000051', ws, 'c0000001-0000-0000-0000-000000000005', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000052', ws, 'c0000001-0000-0000-0000-000000000005', 'dea',              'manual', NULL, 'DEA1000005', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000053', ws, 'c0000001-0000-0000-0000-000000000005', 'acls',             'manual', NULL, NULL, 'expired',   now()),
    ('d0000001-0000-0000-0000-000000000054', ws, 'c0000001-0000-0000-0000-000000000005', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000055', ws, 'c0000001-0000-0000-0000-000000000005', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000056', ws, 'c0000001-0000-0000-0000-000000000005', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000057', ws, 'c0000001-0000-0000-0000-000000000005', 'state_csr',        'manual', 'TN', 'CSR-TN-005',  'active',   now()),
    -- ── Provider 6 (Farah Taylor): cardiac, CA only, no IMLC — CA-only pool
    ('d0000001-0000-0000-0000-000000000061', ws, 'c0000001-0000-0000-0000-000000000006', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000062', ws, 'c0000001-0000-0000-0000-000000000006', 'dea',              'manual', NULL, 'DEA1000006', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000063', ws, 'c0000001-0000-0000-0000-000000000006', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000064', ws, 'c0000001-0000-0000-0000-000000000006', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000065', ws, 'c0000001-0000-0000-0000-000000000006', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000066', ws, 'c0000001-0000-0000-0000-000000000006', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000067', ws, 'c0000001-0000-0000-0000-000000000006', 'state_csr',        'manual', 'CA', 'CSR-CA-006',  'active',   now()),
    -- ── Provider 7 (Grey Umoren): general, TX+CO+WA, IMLC-eligible, state_csr for CO+WA only (TX needs new csr)
    ('d0000001-0000-0000-0000-000000000071', ws, 'c0000001-0000-0000-0000-000000000007', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000072', ws, 'c0000001-0000-0000-0000-000000000007', 'dea',              'manual', NULL, 'DEA1000007', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000073', ws, 'c0000001-0000-0000-0000-000000000007', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000074', ws, 'c0000001-0000-0000-0000-000000000007', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000075', ws, 'c0000001-0000-0000-0000-000000000007', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000076', ws, 'c0000001-0000-0000-0000-000000000007', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000077', ws, 'c0000001-0000-0000-0000-000000000007', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000078', ws, 'c0000001-0000-0000-0000-000000000007', 'state_csr',        'manual', 'CO', 'CSR-CO-007',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000079', ws, 'c0000001-0000-0000-0000-000000000007', 'state_csr',        'manual', 'WA', 'CSR-WA-007',  'active',   now()),
    -- ── Provider 8 (Hayden Vasquez): ob, CO only, drug_screen PENDING (minor delta, +7d)
    ('d0000001-0000-0000-0000-000000000081', ws, 'c0000001-0000-0000-0000-000000000008', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000082', ws, 'c0000001-0000-0000-0000-000000000008', 'dea',              'manual', NULL, 'DEA1000008', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000083', ws, 'c0000001-0000-0000-0000-000000000008', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000084', ws, 'c0000001-0000-0000-0000-000000000008', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000085', ws, 'c0000001-0000-0000-0000-000000000008', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000086', ws, 'c0000001-0000-0000-0000-000000000008', 'drug_screen',      'manual', NULL, NULL, 'pending',   now()),
    ('d0000001-0000-0000-0000-000000000087', ws, 'c0000001-0000-0000-0000-000000000008', 'state_csr',        'manual', 'CO', 'CSR-CO-008',  'active',   now()),
    -- ── Provider 9 (Indra Wyatt): pediatric, TN+TX, state_csr for TN only (TX needs new csr → +45d)
    ('d0000001-0000-0000-0000-000000000091', ws, 'c0000001-0000-0000-0000-000000000009', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000092', ws, 'c0000001-0000-0000-0000-000000000009', 'dea',              'manual', NULL, 'DEA1000009', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000093', ws, 'c0000001-0000-0000-0000-000000000009', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000094', ws, 'c0000001-0000-0000-0000-000000000009', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000095', ws, 'c0000001-0000-0000-0000-000000000009', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000096', ws, 'c0000001-0000-0000-0000-000000000009', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000097', ws, 'c0000001-0000-0000-0000-000000000009', 'state_csr',        'manual', 'TN', 'CSR-TN-009',  'active',   now()),
    -- ── Provider 10 (Jules Xavier): pain, WA+CA+CO, state_csr for all three
    ('d0000001-0000-0000-0000-0000000000a1', ws, 'c0000001-0000-0000-0000-00000000000a', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000a2', ws, 'c0000001-0000-0000-0000-00000000000a', 'dea',              'manual', NULL, 'DEA1000010', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000a3', ws, 'c0000001-0000-0000-0000-00000000000a', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000a4', ws, 'c0000001-0000-0000-0000-00000000000a', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000a5', ws, 'c0000001-0000-0000-0000-00000000000a', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000a6', ws, 'c0000001-0000-0000-0000-00000000000a', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000a7', ws, 'c0000001-0000-0000-0000-00000000000a', 'state_csr',        'manual', 'WA', 'CSR-WA-010',  'active',   now()),
    ('d0000001-0000-0000-0000-0000000000a8', ws, 'c0000001-0000-0000-0000-00000000000a', 'state_csr',        'manual', 'CA', 'CSR-CA-010',  'active',   now()),
    ('d0000001-0000-0000-0000-0000000000a9', ws, 'c0000001-0000-0000-0000-00000000000a', 'state_csr',        'manual', 'CO', 'CSR-CO-010',  'active',   now()),
    -- ── Provider 11 (Kai Yamamoto): cardiac, NY+NJ (neither compact), no IMLC, NY CSR only
    ('d0000001-0000-0000-0000-0000000000b1', ws, 'c0000001-0000-0000-0000-00000000000b', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000b2', ws, 'c0000001-0000-0000-0000-00000000000b', 'dea',              'manual', NULL, 'DEA1000011', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000b3', ws, 'c0000001-0000-0000-0000-00000000000b', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000b4', ws, 'c0000001-0000-0000-0000-00000000000b', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000b5', ws, 'c0000001-0000-0000-0000-00000000000b', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000b6', ws, 'c0000001-0000-0000-0000-00000000000b', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000b7', ws, 'c0000001-0000-0000-0000-00000000000b', 'state_csr',        'manual', 'NY', 'CSR-NY-011',  'active',   now()),
    -- ── Provider 12 (Luna Zabala): ob, FL+GA (FL non-compact, GA compact), no IMLC, both CSR
    ('d0000001-0000-0000-0000-0000000000c1', ws, 'c0000001-0000-0000-0000-00000000000c', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000c2', ws, 'c0000001-0000-0000-0000-00000000000c', 'dea',              'manual', NULL, 'DEA1000012', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000c3', ws, 'c0000001-0000-0000-0000-00000000000c', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000c4', ws, 'c0000001-0000-0000-0000-00000000000c', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000c5', ws, 'c0000001-0000-0000-0000-00000000000c', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000c6', ws, 'c0000001-0000-0000-0000-00000000000c', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000c7', ws, 'c0000001-0000-0000-0000-00000000000c', 'state_csr',        'manual', 'FL', 'CSR-FL-012',  'active',   now()),
    ('d0000001-0000-0000-0000-0000000000c8', ws, 'c0000001-0000-0000-0000-00000000000c', 'state_csr',        'manual', 'GA', 'CSR-GA-012',  'active',   now()),
    -- ── Provider 13 (Mira Abbas): pediatric, MA+NY (neither compact), no IMLC, MA CSR only
    ('d0000001-0000-0000-0000-0000000000d1', ws, 'c0000001-0000-0000-0000-00000000000d', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000d2', ws, 'c0000001-0000-0000-0000-00000000000d', 'dea',              'manual', NULL, 'DEA1000013', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000d3', ws, 'c0000001-0000-0000-0000-00000000000d', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000d4', ws, 'c0000001-0000-0000-0000-00000000000d', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000d5', ws, 'c0000001-0000-0000-0000-00000000000d', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000d6', ws, 'c0000001-0000-0000-0000-00000000000d', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000d7', ws, 'c0000001-0000-0000-0000-00000000000d', 'state_csr',        'manual', 'MA', 'CSR-MA-013',  'active',   now()),
    -- ── Provider 14 (Niko Brennan): pain, IL+OH+MI (all compact), IMLC-eligible, IL+OH CSR (MI missing)
    ('d0000001-0000-0000-0000-0000000000e1', ws, 'c0000001-0000-0000-0000-00000000000e', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000e2', ws, 'c0000001-0000-0000-0000-00000000000e', 'dea',              'manual', NULL, 'DEA1000014', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000e3', ws, 'c0000001-0000-0000-0000-00000000000e', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000e4', ws, 'c0000001-0000-0000-0000-00000000000e', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000e5', ws, 'c0000001-0000-0000-0000-00000000000e', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000e6', ws, 'c0000001-0000-0000-0000-00000000000e', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000e7', ws, 'c0000001-0000-0000-0000-00000000000e', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000e8', ws, 'c0000001-0000-0000-0000-00000000000e', 'state_csr',        'manual', 'IL', 'CSR-IL-014',  'active',   now()),
    ('d0000001-0000-0000-0000-0000000000e9', ws, 'c0000001-0000-0000-0000-00000000000e', 'state_csr',        'manual', 'OH', 'CSR-OH-014',  'active',   now()),
    -- ── Provider 15 (Omar Choi): general, AZ+CO+IL (all compact), IMLC-eligible, all CSR
    ('d0000001-0000-0000-0000-0000000000f1', ws, 'c0000001-0000-0000-0000-00000000000f', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-0000000000f2', ws, 'c0000001-0000-0000-0000-00000000000f', 'dea',              'manual', NULL, 'DEA1000015', 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000f3', ws, 'c0000001-0000-0000-0000-00000000000f', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000f4', ws, 'c0000001-0000-0000-0000-00000000000f', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-0000000000f5', ws, 'c0000001-0000-0000-0000-00000000000f', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000f6', ws, 'c0000001-0000-0000-0000-00000000000f', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-0000000000f7', ws, 'c0000001-0000-0000-0000-00000000000f', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-0000000000f8', ws, 'c0000001-0000-0000-0000-00000000000f', 'state_csr',        'manual', 'AZ', 'CSR-AZ-015',  'active',   now()),
    ('d0000001-0000-0000-0000-0000000000f9', ws, 'c0000001-0000-0000-0000-00000000000f', 'state_csr',        'manual', 'CO', 'CSR-CO-015',  'active',   now()),
    ('d0000001-0000-0000-0000-0000000000fa', ws, 'c0000001-0000-0000-0000-00000000000f', 'state_csr',        'manual', 'IL', 'CSR-IL-015',  'active',   now()),
    -- ── Provider 16 (Priya Delgado): cardiac, GA+TN (both compact), IMLC-eligible, both CSR
    ('d0000001-0000-0000-0000-000000000101', ws, 'c0000001-0000-0000-0000-000000000010', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000102', ws, 'c0000001-0000-0000-0000-000000000010', 'dea',              'manual', NULL, 'DEA1000016', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000103', ws, 'c0000001-0000-0000-0000-000000000010', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000104', ws, 'c0000001-0000-0000-0000-000000000010', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000105', ws, 'c0000001-0000-0000-0000-000000000010', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000106', ws, 'c0000001-0000-0000-0000-000000000010', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000107', ws, 'c0000001-0000-0000-0000-000000000010', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000108', ws, 'c0000001-0000-0000-0000-000000000010', 'state_csr',        'manual', 'GA', 'CSR-GA-016',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000109', ws, 'c0000001-0000-0000-0000-000000000010', 'state_csr',        'manual', 'TN', 'CSR-TN-016',  'active',   now()),
    -- ── Provider 17 (Quinn Erikson): ob, OH+PA (both compact), IMLC-eligible, OH CSR only
    ('d0000001-0000-0000-0000-000000000111', ws, 'c0000001-0000-0000-0000-000000000011', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000112', ws, 'c0000001-0000-0000-0000-000000000011', 'dea',              'manual', NULL, 'DEA1000017', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000113', ws, 'c0000001-0000-0000-0000-000000000011', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000114', ws, 'c0000001-0000-0000-0000-000000000011', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000115', ws, 'c0000001-0000-0000-0000-000000000011', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000116', ws, 'c0000001-0000-0000-0000-000000000011', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000117', ws, 'c0000001-0000-0000-0000-000000000011', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000118', ws, 'c0000001-0000-0000-0000-000000000011', 'state_csr',        'manual', 'OH', 'CSR-OH-017',  'active',   now()),
    -- ── Provider 18 (Ravi Fonseca): general, NC+GA+TN, IMLC-eligible (compact: GA, TN), all CSR
    ('d0000001-0000-0000-0000-000000000121', ws, 'c0000001-0000-0000-0000-000000000012', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000122', ws, 'c0000001-0000-0000-0000-000000000012', 'dea',              'manual', NULL, 'DEA1000018', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000123', ws, 'c0000001-0000-0000-0000-000000000012', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000124', ws, 'c0000001-0000-0000-0000-000000000012', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000125', ws, 'c0000001-0000-0000-0000-000000000012', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000126', ws, 'c0000001-0000-0000-0000-000000000012', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000127', ws, 'c0000001-0000-0000-0000-000000000012', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000128', ws, 'c0000001-0000-0000-0000-000000000012', 'state_csr',        'manual', 'NC', 'CSR-NC-018',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000129', ws, 'c0000001-0000-0000-0000-000000000012', 'state_csr',        'manual', 'GA', 'CSR-GA-018',  'active',   now()),
    ('d0000001-0000-0000-0000-00000000012a', ws, 'c0000001-0000-0000-0000-000000000012', 'state_csr',        'manual', 'TN', 'CSR-TN-018',  'active',   now()),
    -- ── Provider 19 (Sage Guzman): pain, PA+NY (PA compact), no IMLC, PA CSR only
    ('d0000001-0000-0000-0000-000000000131', ws, 'c0000001-0000-0000-0000-000000000013', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000132', ws, 'c0000001-0000-0000-0000-000000000013', 'dea',              'manual', NULL, 'DEA1000019', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000133', ws, 'c0000001-0000-0000-0000-000000000013', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000134', ws, 'c0000001-0000-0000-0000-000000000013', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000135', ws, 'c0000001-0000-0000-0000-000000000013', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000136', ws, 'c0000001-0000-0000-0000-000000000013', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000137', ws, 'c0000001-0000-0000-0000-000000000013', 'state_csr',        'manual', 'PA', 'CSR-PA-019',  'active',   now()),
    -- ── Provider 20 (Tariq Hart): cardiac, MI+OH (both compact), IMLC-eligible, MI CSR only
    ('d0000001-0000-0000-0000-000000000141', ws, 'c0000001-0000-0000-0000-000000000014', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000142', ws, 'c0000001-0000-0000-0000-000000000014', 'dea',              'manual', NULL, 'DEA1000020', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000143', ws, 'c0000001-0000-0000-0000-000000000014', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000144', ws, 'c0000001-0000-0000-0000-000000000014', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000145', ws, 'c0000001-0000-0000-0000-000000000014', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000146', ws, 'c0000001-0000-0000-0000-000000000014', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000147', ws, 'c0000001-0000-0000-0000-000000000014', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000148', ws, 'c0000001-0000-0000-0000-000000000014', 'state_csr',        'manual', 'MI', 'CSR-MI-020',  'active',   now()),
    -- ── Provider 21 (Uma Ibrahim): general, NY+TX, no IMLC, both CSR
    ('d0000001-0000-0000-0000-000000000151', ws, 'c0000001-0000-0000-0000-000000000015', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000152', ws, 'c0000001-0000-0000-0000-000000000015', 'dea',              'manual', NULL, 'DEA1000021', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000153', ws, 'c0000001-0000-0000-0000-000000000015', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000154', ws, 'c0000001-0000-0000-0000-000000000015', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000155', ws, 'c0000001-0000-0000-0000-000000000015', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000156', ws, 'c0000001-0000-0000-0000-000000000015', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000157', ws, 'c0000001-0000-0000-0000-000000000015', 'state_csr',        'manual', 'NY', 'CSR-NY-021',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000158', ws, 'c0000001-0000-0000-0000-000000000015', 'state_csr',        'manual', 'TX', 'CSR-TX-021',  'active',   now()),
    -- ── Provider 22 (Vera Juarez): ob, FL+CA (neither compact), no IMLC, FL CSR only
    ('d0000001-0000-0000-0000-000000000161', ws, 'c0000001-0000-0000-0000-000000000016', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000162', ws, 'c0000001-0000-0000-0000-000000000016', 'dea',              'manual', NULL, 'DEA1000022', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000163', ws, 'c0000001-0000-0000-0000-000000000016', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000164', ws, 'c0000001-0000-0000-0000-000000000016', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000165', ws, 'c0000001-0000-0000-0000-000000000016', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000166', ws, 'c0000001-0000-0000-0000-000000000016', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000167', ws, 'c0000001-0000-0000-0000-000000000016', 'state_csr',        'manual', 'FL', 'CSR-FL-022',  'active',   now()),
    -- ── Provider 23 (Will Khan): general, MA+PA (PA compact), no IMLC, both CSR
    ('d0000001-0000-0000-0000-000000000171', ws, 'c0000001-0000-0000-0000-000000000017', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000172', ws, 'c0000001-0000-0000-0000-000000000017', 'dea',              'manual', NULL, 'DEA1000023', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000173', ws, 'c0000001-0000-0000-0000-000000000017', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000174', ws, 'c0000001-0000-0000-0000-000000000017', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000175', ws, 'c0000001-0000-0000-0000-000000000017', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000176', ws, 'c0000001-0000-0000-0000-000000000017', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000177', ws, 'c0000001-0000-0000-0000-000000000017', 'state_csr',        'manual', 'MA', 'CSR-MA-023',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000178', ws, 'c0000001-0000-0000-0000-000000000017', 'state_csr',        'manual', 'PA', 'CSR-PA-023',  'active',   now()),
    -- ── Provider 24 (Xian Lopez): pediatric, TX+GA+IL, IMLC (compact GA, IL), all CSR
    ('d0000001-0000-0000-0000-000000000181', ws, 'c0000001-0000-0000-0000-000000000018', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000182', ws, 'c0000001-0000-0000-0000-000000000018', 'dea',              'manual', NULL, 'DEA1000024', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000183', ws, 'c0000001-0000-0000-0000-000000000018', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000184', ws, 'c0000001-0000-0000-0000-000000000018', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000185', ws, 'c0000001-0000-0000-0000-000000000018', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000186', ws, 'c0000001-0000-0000-0000-000000000018', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000187', ws, 'c0000001-0000-0000-0000-000000000018', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000188', ws, 'c0000001-0000-0000-0000-000000000018', 'state_csr',        'manual', 'TX', 'CSR-TX-024',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000189', ws, 'c0000001-0000-0000-0000-000000000018', 'state_csr',        'manual', 'GA', 'CSR-GA-024',  'active',   now()),
    ('d0000001-0000-0000-0000-00000000018a', ws, 'c0000001-0000-0000-0000-000000000018', 'state_csr',        'manual', 'IL', 'CSR-IL-024',  'active',   now()),
    -- ── Provider 25 (Yael Monroe): pain, CO+WA+AZ (all compact), IMLC-eligible, CO+AZ CSR only (WA missing → +45d for WA)
    ('d0000001-0000-0000-0000-000000000191', ws, 'c0000001-0000-0000-0000-000000000019', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-000000000192', ws, 'c0000001-0000-0000-0000-000000000019', 'dea',              'manual', NULL, 'DEA1000025', 'active',    now()),
    ('d0000001-0000-0000-0000-000000000193', ws, 'c0000001-0000-0000-0000-000000000019', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000194', ws, 'c0000001-0000-0000-0000-000000000019', 'immunizations',    'manual', NULL, NULL, 'complete',  now()),
    ('d0000001-0000-0000-0000-000000000195', ws, 'c0000001-0000-0000-0000-000000000019', 'background_check', 'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000196', ws, 'c0000001-0000-0000-0000-000000000019', 'drug_screen',      'manual', NULL, NULL, 'clear',     now()),
    ('d0000001-0000-0000-0000-000000000197', ws, 'c0000001-0000-0000-0000-000000000019', 'imlc',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-000000000198', ws, 'c0000001-0000-0000-0000-000000000019', 'state_csr',        'manual', 'CO', 'CSR-CO-025',  'active',   now()),
    ('d0000001-0000-0000-0000-000000000199', ws, 'c0000001-0000-0000-0000-000000000019', 'state_csr',        'manual', 'AZ', 'CSR-AZ-025',  'active',   now()),
    -- ── Provider 26 (Zoe Alvarado): cardiac, TX only, NEWLY ONBOARDED (minimal creds, pending background check)
    ('d0000001-0000-0000-0000-00000000011a', ws, 'c0000001-0000-0000-0000-00000000001a', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-00000000011b', ws, 'c0000001-0000-0000-0000-00000000001a', 'dea',              'manual', NULL, 'DEA1000026', 'active',    now()),
    ('d0000001-0000-0000-0000-00000000011c', ws, 'c0000001-0000-0000-0000-00000000001a', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-00000000011d', ws, 'c0000001-0000-0000-0000-00000000001a', 'background_check', 'manual', NULL, NULL, 'pending',   now()),
    -- intentionally NO immunizations / drug_screen / state_csr → projection stays well in the future
    -- ── Provider 27 (Ari Bello): ob, FL only, NEWLY ONBOARDED
    ('d0000001-0000-0000-0000-00000000012b', ws, 'c0000001-0000-0000-0000-00000000001b', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-00000000012c', ws, 'c0000001-0000-0000-0000-00000000001b', 'dea',              'manual', NULL, 'DEA1000027', 'active',    now()),
    ('d0000001-0000-0000-0000-00000000012d', ws, 'c0000001-0000-0000-0000-00000000001b', 'background_check', 'manual', NULL, NULL, 'pending',   now()),
    -- missing ACLS, immunizations, drug_screen, state_csr → still being onboarded
    -- ── Provider 28 (Bodhi Cho): pediatric, MA only, NEWLY ONBOARDED
    ('d0000001-0000-0000-0000-00000000013b', ws, 'c0000001-0000-0000-0000-00000000001c', 'board_cert',       'abms',   NULL, NULL, 'certified', now()),
    ('d0000001-0000-0000-0000-00000000013c', ws, 'c0000001-0000-0000-0000-00000000001c', 'dea',              'manual', NULL, 'DEA1000028', 'active',    now()),
    ('d0000001-0000-0000-0000-00000000013d', ws, 'c0000001-0000-0000-0000-00000000001c', 'acls',             'manual', NULL, NULL, 'active',    now()),
    ('d0000001-0000-0000-0000-00000000013e', ws, 'c0000001-0000-0000-0000-00000000001c', 'immunizations',    'manual', NULL, NULL, 'pending',   now()),
    ('d0000001-0000-0000-0000-00000000013f', ws, 'c0000001-0000-0000-0000-00000000001c', 'background_check', 'manual', NULL, NULL, 'pending',   now())
  ON CONFLICT (id) DO NOTHING;

  -- ─── lifecycle breadth (lapsed credentials being re-upped) ─────
  -- Flip two tenured but NOT-override-targeted providers to
  -- "renewal in flight" so the ranker's BLOCKED_ON_CREDENTIAL facet
  -- fires visibly without knocking the promote-override candidates
  -- out of their rankings:
  --   Hayden Vasquez (provider 8, ob/CO): drug_screen pending → ACLS
  --     expired (pending renewal row added).
  --   Yael Monroe (provider 25, pain/CO+WA+AZ): board_cert pending.
  INSERT INTO verifications (id, workspace_id, provider_id, type, source, state, license_number, status, verified_at)
  VALUES
    ('d0000001-0000-0000-0000-00000000080b', ws, 'c0000001-0000-0000-0000-000000000008', 'acls',             'manual', NULL, NULL, 'expired',   now() - interval '21 days'),
    ('d0000001-0000-0000-0000-00000000080c', ws, 'c0000001-0000-0000-0000-000000000008', 'acls',             'manual', NULL, NULL, 'pending',   now() - interval '2 days'),
    ('d0000001-0000-0000-0000-00000000019a', ws, 'c0000001-0000-0000-0000-000000000019', 'board_cert',       'abms',   NULL, NULL, 'pending',   now() - interval '5 days')
  ON CONFLICT (id) DO NOTHING;

  -- ─── cases (= signal_jobs after ingest) ────────────────────────
  -- 37 open requisitions. `specialty` carries the canonical sub-
  -- specialty token the bridge understands; sub-specialty match
  -- bonuses in the ranker fire off it directly. Mixed need_dates
  -- across urgent (14-21d) / mid (28-45d) / comfortable (60-120d)
  -- so the hard-filter on earliest-start-vs-need-date meaningfully
  -- separates candidates by urgency.
  INSERT INTO cases (id, workspace_id, provider_id, facility_profile_id, facility_profile_version, specialty, purpose, status, opened_at, target_submission_date, blockers) VALUES
    -- Austin TX — cardiac/general/ob, varied urgency (TX non-compact)
    ('e0000001-0000-0000-0000-000000000001', ws, 'c0000001-0000-0000-0000-000000000001', 'b0000001-0000-0000-0000-000000000001', '1', 'cardiac',   'initial_appointment', 'intake',      now() - interval '14 days', CURRENT_DATE + 21, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000002', ws, 'c0000001-0000-0000-0000-000000000007', 'b0000001-0000-0000-0000-000000000001', '1', 'general',   'initial_appointment', 'in_progress', now() - interval '21 days', CURRENT_DATE + 30, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000003', ws, 'c0000001-0000-0000-0000-000000000002', 'b0000001-0000-0000-0000-000000000001', '1', 'ob',        'initial_appointment', 'intake',      now() - interval '7 days',  CURRENT_DATE + 45, '[]'::jsonb),
    -- Denver CO — pediatric + ob (compact)
    ('e0000001-0000-0000-0000-000000000004', ws, 'c0000001-0000-0000-0000-000000000003', 'b0000001-0000-0000-0000-000000000002', '1', 'pediatric', 'initial_appointment', 'intake',      now() - interval '10 days', CURRENT_DATE + 21, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000005', ws, 'c0000001-0000-0000-0000-000000000008', 'b0000001-0000-0000-0000-000000000002', '1', 'ob',        'initial_appointment', 'intake',      now() - interval '5 days',  CURRENT_DATE + 60, '[]'::jsonb),
    -- Seattle WA — pediatric (compact)
    ('e0000001-0000-0000-0000-000000000006', ws, 'c0000001-0000-0000-0000-000000000004', 'b0000001-0000-0000-0000-000000000003', '1', 'pain',      'initial_appointment', 'in_progress', now() - interval '28 days', CURRENT_DATE + 14, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000007', ws, 'c0000001-0000-0000-0000-000000000009', 'b0000001-0000-0000-0000-000000000003', '1', 'pediatric', 'initial_appointment', 'intake',      now() - interval '14 days', CURRENT_DATE + 35, '[]'::jsonb),
    -- Nashville TN — cardiac + general (compact)
    ('e0000001-0000-0000-0000-000000000008', ws, 'c0000001-0000-0000-0000-000000000001', 'b0000001-0000-0000-0000-000000000004', '1', 'cardiac',   'initial_appointment', 'intake',      now() - interval '3 days',  CURRENT_DATE + 18, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000009', ws, 'c0000001-0000-0000-0000-000000000005', 'b0000001-0000-0000-0000-000000000004', '1', 'general',   'initial_appointment', 'intake',      now() - interval '9 days',  CURRENT_DATE + 42, '[]'::jsonb),
    -- Los Angeles CA — pain + cardiac (non-compact)
    ('e0000001-0000-0000-0000-00000000000a', ws, 'c0000001-0000-0000-0000-00000000000a', 'b0000001-0000-0000-0000-000000000005', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '6 days',  CURRENT_DATE + 20, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000000b', ws, 'c0000001-0000-0000-0000-000000000006', 'b0000001-0000-0000-0000-000000000005', '1', 'cardiac',   'initial_appointment', 'in_progress', now() - interval '18 days', CURRENT_DATE + 28, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000000c', ws, 'c0000001-0000-0000-0000-000000000004', 'b0000001-0000-0000-0000-000000000005', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '2 days',  CURRENT_DATE + 55, '[]'::jsonb),
    -- NY — cardiac + general (non-compact)
    ('e0000001-0000-0000-0000-00000000000d', ws, 'c0000001-0000-0000-0000-00000000000b', 'b0000001-0000-0000-0000-000000000006', '1', 'cardiac',   'initial_appointment', 'intake',      now() - interval '4 days',  CURRENT_DATE + 18, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000000e', ws, 'c0000001-0000-0000-0000-000000000015', 'b0000001-0000-0000-0000-000000000006', '1', 'general',   'initial_appointment', 'in_progress', now() - interval '12 days', CURRENT_DATE + 40, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000000f', ws, 'c0000001-0000-0000-0000-000000000013', 'b0000001-0000-0000-0000-000000000006', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '6 days',  CURRENT_DATE + 90, '[]'::jsonb),
    -- Miami FL — ob + general (non-compact)
    ('e0000001-0000-0000-0000-000000000020', ws, 'c0000001-0000-0000-0000-00000000000c', 'b0000001-0000-0000-0000-000000000007', '1', 'ob',        'initial_appointment', 'intake',      now() - interval '8 days',  CURRENT_DATE + 20, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000021', ws, 'c0000001-0000-0000-0000-000000000016', 'b0000001-0000-0000-0000-000000000007', '1', 'ob',        'initial_appointment', 'in_progress', now() - interval '20 days', CURRENT_DATE + 45, '[]'::jsonb),
    -- Chicago IL — pain + general (compact)
    ('e0000001-0000-0000-0000-000000000022', ws, 'c0000001-0000-0000-0000-00000000000e', 'b0000001-0000-0000-0000-000000000008', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '5 days',  CURRENT_DATE + 15, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000023', ws, 'c0000001-0000-0000-0000-00000000000f', 'b0000001-0000-0000-0000-000000000008', '1', 'general',   'initial_appointment', 'intake',      now() - interval '11 days', CURRENT_DATE + 70, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000024', ws, 'c0000001-0000-0000-0000-000000000018', 'b0000001-0000-0000-0000-000000000008', '1', 'pediatric', 'initial_appointment', 'in_progress', now() - interval '15 days', CURRENT_DATE + 30, '[]'::jsonb),
    -- Phoenix AZ — general + pain (compact)
    ('e0000001-0000-0000-0000-000000000025', ws, 'c0000001-0000-0000-0000-00000000000f', 'b0000001-0000-0000-0000-000000000009', '1', 'general',   'initial_appointment', 'intake',      now() - interval '3 days',  CURRENT_DATE + 22, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000026', ws, 'c0000001-0000-0000-0000-000000000019', 'b0000001-0000-0000-0000-000000000009', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '7 days',  CURRENT_DATE + 80, '[]'::jsonb),
    -- Boston MA — pediatric + general (non-compact)
    ('e0000001-0000-0000-0000-000000000027', ws, 'c0000001-0000-0000-0000-00000000000d', 'b0000001-0000-0000-0000-00000000000a', '1', 'pediatric', 'initial_appointment', 'intake',      now() - interval '9 days',  CURRENT_DATE + 30, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000028', ws, 'c0000001-0000-0000-0000-000000000017', 'b0000001-0000-0000-0000-00000000000a', '1', 'general',   'initial_appointment', 'in_progress', now() - interval '13 days', CURRENT_DATE + 100, '[]'::jsonb),
    -- Atlanta GA — cardiac + general (compact). Note +21 day window
    -- so a temp-privileges candidate (14-day cycle) clears comfortably
    -- and overrides for this job have a ranking entry to land on.
    ('e0000001-0000-0000-0000-000000000029', ws, 'c0000001-0000-0000-0000-000000000010', 'b0000001-0000-0000-0000-00000000000b', '1', 'cardiac',   'initial_appointment', 'intake',      now() - interval '4 days',  CURRENT_DATE + 21, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000002a', ws, 'c0000001-0000-0000-0000-000000000012', 'b0000001-0000-0000-0000-00000000000b', '1', 'general',   'initial_appointment', 'intake',      now() - interval '6 days',  CURRENT_DATE + 60, '[]'::jsonb),
    -- Cleveland OH — ob + pain (compact)
    ('e0000001-0000-0000-0000-00000000002b', ws, 'c0000001-0000-0000-0000-000000000011', 'b0000001-0000-0000-0000-00000000000c', '1', 'ob',        'initial_appointment', 'intake',      now() - interval '2 days',  CURRENT_DATE + 18, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000002c', ws, 'c0000001-0000-0000-0000-00000000000e', 'b0000001-0000-0000-0000-00000000000c', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '7 days',  CURRENT_DATE + 45, '[]'::jsonb),
    -- Charlotte NC — general + cardiac (non-compact)
    ('e0000001-0000-0000-0000-00000000002d', ws, 'c0000001-0000-0000-0000-000000000012', 'b0000001-0000-0000-0000-00000000000d', '1', 'general',   'initial_appointment', 'intake',      now() - interval '5 days',  CURRENT_DATE + 28, '[]'::jsonb),
    ('e0000001-0000-0000-0000-00000000002e', ws, 'c0000001-0000-0000-0000-000000000010', 'b0000001-0000-0000-0000-00000000000d', '1', 'cardiac',   'initial_appointment', 'in_progress', now() - interval '16 days', CURRENT_DATE + 110, '[]'::jsonb),
    -- Detroit MI — cardiac + general (compact)
    ('e0000001-0000-0000-0000-00000000002f', ws, 'c0000001-0000-0000-0000-000000000014', 'b0000001-0000-0000-0000-00000000000e', '1', 'cardiac',   'initial_appointment', 'intake',      now() - interval '4 days',  CURRENT_DATE + 20, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000030', ws, 'c0000001-0000-0000-0000-00000000000e', 'b0000001-0000-0000-0000-00000000000e', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '8 days',  CURRENT_DATE + 55, '[]'::jsonb),
    -- Philadelphia PA — pain + ob (compact)
    ('e0000001-0000-0000-0000-000000000031', ws, 'c0000001-0000-0000-0000-000000000013', 'b0000001-0000-0000-0000-00000000000f', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '3 days',  CURRENT_DATE + 14, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000032', ws, 'c0000001-0000-0000-0000-000000000011', 'b0000001-0000-0000-0000-00000000000f', '1', 'ob',        'initial_appointment', 'in_progress', now() - interval '18 days', CURRENT_DATE + 75, '[]'::jsonb),
    -- Extra high-touch comfortable-timeline cases across under-represented sub-specialties
    ('e0000001-0000-0000-0000-000000000033', ws, 'c0000001-0000-0000-0000-00000000000e', 'b0000001-0000-0000-0000-000000000008', '1', 'pain',      'initial_appointment', 'intake',      now() - interval '1 days',  CURRENT_DATE + 120, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000034', ws, 'c0000001-0000-0000-0000-00000000000d', 'b0000001-0000-0000-0000-000000000006', '1', 'pediatric', 'initial_appointment', 'intake',      now() - interval '4 days',  CURRENT_DATE + 65, '[]'::jsonb),
    ('e0000001-0000-0000-0000-000000000035', ws, 'c0000001-0000-0000-0000-000000000016', 'b0000001-0000-0000-0000-000000000007', '1', 'ob',        'initial_appointment', 'intake',      now() - interval '2 days',  CURRENT_DATE + 95, '[]'::jsonb)
  ON CONFLICT (id) DO UPDATE SET
    target_submission_date = EXCLUDED.target_submission_date,
    status                 = EXCLUDED.status,
    facility_profile_id    = EXCLUDED.facility_profile_id,
    specialty              = EXCLUDED.specialty;

  -- ─── case_notes (= signal_conversations via WS E) ──────────────
  -- Rich text per note so the WS E extractor fires across all five
  -- v0 facets:
  --   REGION_PREFERENCE   — state names + preference verbs
  --   TIMING_WINDOW       — ISO dates + "starting in <month>"
  --   RATE_EXPECTATION    — "$X/hr" / "$X per hour"
  --   SUBSPECIALTY_INTEREST — cardiac / OB / peds / pain tokens
  --   AVAILABILITY_SIGNAL — available / booked until / not available
  INSERT INTO case_notes (id, workspace_id, case_id, author_user_id, body, created_at)
  VALUES
    ('f0000001-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', NULL,
      'Provider Alex Morgan confirmed availability starting the week of ' || to_char(CURRENT_DATE + 21, 'Mon DD, YYYY') ||
      '. Rate expectation: $240/hr. Prefers 7-on 7-off block schedule. Strong cardiac anesthesia background and open to Texas or Colorado placements.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000002', NULL,
      'Grey Umoren is IMLC-registered and ready for TX / CO / WA placements. Can start within 10 business days of signed privileges. Prefers general anesthesia cases, available immediately.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000006', NULL,
      'Devin Rivera: pain management fellowship confirmed. California license active, Washington active. Earliest start ' || to_char(CURRENT_DATE + 14, 'Mon DD, YYYY') ||
      '. Target rate $280/hr. Pain clinic experience + chronic pain cases.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000004', ws, 'e0000001-0000-0000-0000-000000000008', NULL,
      'Alex Morgan is open to the Nashville cardiac assignment. Strong CT anesthesia and heart cases. Available ' || to_char(CURRENT_DATE + 18, 'YYYY-MM-DD') ||
      '. Comp expectation around $260 per hour.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000005', ws, 'e0000001-0000-0000-0000-00000000000a', NULL,
      'Jules Xavier available in California and Colorado. Pain management specialist with regional anesthesia experience. Rate: $255/hr. Open to LA or Denver blocks.',
      now() - interval '4 days'),
    ('f0000001-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-00000000000d', NULL,
      'Kai Yamamoto based in New York, cardiac anesthesia specialist. No IMLC compact, but local to NYC. Available from ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') ||
      '. Target pay: $300/hr given cardiothoracic case mix.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-00000000000e', NULL,
      'Uma Ibrahim: based in New York, licensed in Texas. Open to Manhattan general anesthesia work. Available immediately. Rate: $225/hr.',
      now() - interval '5 days'),
    ('f0000001-0000-0000-0000-000000000020', ws, 'e0000001-0000-0000-0000-000000000020', NULL,
      'Luna Zabala: OB anesthesia specialist in Miami, Florida. Available starting in ' || to_char(CURRENT_DATE + 20, 'Month YYYY') ||
      '. Preference for L&D and obstetric cases. $235/hr target.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-000000000022', ws, 'e0000001-0000-0000-0000-000000000022', NULL,
      'Niko Brennan available for Chicago pain clinic work. IMLC-eligible (Illinois compact). Pain management with regional blocks experience. Available ' ||
      to_char(CURRENT_DATE + 15, 'YYYY-MM-DD') || '. Rate: $270/hr.',
      now() - interval '4 days'),
    ('f0000001-0000-0000-0000-000000000025', ws, 'e0000001-0000-0000-0000-000000000025', NULL,
      'Omar Choi: IMLC compact (AZ, CO, IL). Open to Phoenix general anesthesia blocks. Available starting ' ||
      to_char(CURRENT_DATE + 22, 'YYYY-MM-DD') || '. Rate: $230 per hour. Available immediately.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000027', ws, 'e0000001-0000-0000-0000-000000000027', NULL,
      'Mira Abbas: pediatric anesthesia (children''s anesthesia background), based in Massachusetts. Boston Metro assignment fits preference. Available ' ||
      to_char(CURRENT_DATE + 30, 'YYYY-MM-DD') || '. Comp around $265/hr.',
      now() - interval '6 days'),
    ('f0000001-0000-0000-0000-000000000029', ws, 'e0000001-0000-0000-0000-000000000029', NULL,
      'Priya Delgado: cardiac anesthesia (CT anesthesia fellowship). IMLC compact — covers Georgia + Tennessee. Open to Atlanta heart cases. Available ' ||
      to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || '. Expected rate: $285/hr.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-00000000002b', ws, 'e0000001-0000-0000-0000-00000000002b', NULL,
      'Quinn Erikson: obstetric anesthesia, based in Ohio. Prefers L&D-heavy assignments. Available from ' ||
      to_char(CURRENT_DATE + 18, 'YYYY-MM-DD') || '. Rate: $240 per hour. Not available weekends.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-00000000002f', ws, 'e0000001-0000-0000-0000-00000000002f', NULL,
      'Tariq Hart: cardiac anesthesiologist in Michigan. Heart transplant and CTS anesthesia background. IMLC-eligible. Available ' ||
      to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || '. Target rate: $295 per hour.',
      now() - interval '4 days'),
    ('f0000001-0000-0000-0000-000000000031', ws, 'e0000001-0000-0000-0000-000000000031', NULL,
      'Sage Guzman: pain clinic experience in Pennsylvania. Open to Philadelphia pain management assignment. Booked until ' ||
      to_char(CURRENT_DATE + 7, 'YYYY-MM-DD') || ', then available. Rate: $250/hr.',
      now() - interval '1 day'),
    -- ── v3 additions: 3-6 case_notes per active case, varied text ──
    -- Alex Morgan — Austin cardiac journey (2 extra beyond f...001)
    ('f0000001-0000-0000-0000-000000000101', ws, 'e0000001-0000-0000-0000-000000000001', NULL,
      'Follow-up with Alex: he confirmed Texas CSR renewal is in hand. Rate expectation now $245/hr for cardiac blocks. Would prefer a 7-on/7-off schedule. Available immediately once the privileging packet is cleared.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000102', ws, 'e0000001-0000-0000-0000-000000000001', NULL,
      'Rate negotiation update: Alex floated $260/hr given the cardiothoracic case mix. Facility CMO approved up to $255 per hour. Closing on the offer this week.',
      now() - interval '12 hours'),
    -- Grey Umoren — Austin general journey
    ('f0000001-0000-0000-0000-000000000103', ws, 'e0000001-0000-0000-0000-000000000002', NULL,
      'Grey: IMLC eligible, Texas CSR missing. Will file CSR paperwork this week. Expected turnaround 30-45 days. Rate band $210-$230 per hour. Open to extended coverage.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000104', ws, 'e0000001-0000-0000-0000-000000000002', NULL,
      'Coverage preference update: Grey wants a mix of Texas and Colorado blocks through Q1 next year. Available January through March. Rate: $220/hr.',
      now() - interval '1 day'),
    -- Devin Rivera — Seattle pain journey
    ('f0000001-0000-0000-0000-000000000105', ws, 'e0000001-0000-0000-0000-000000000006', NULL,
      'Scheduling conversation: Devin prefers chronic pain cases, less interest in acute. Target rate $285/hr. Available in Seattle starting ' || to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || '.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000106', ws, 'e0000001-0000-0000-0000-000000000006', NULL,
      'Credential check-in: Devin''s Washington license + state_csr active. California license in good standing. Pain management fellowship confirmed. Rate $280/hr settled.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000107', ws, 'e0000001-0000-0000-0000-000000000006', NULL,
      'Preference captured: Devin is NOT available weekends. Prefers blocks of 10 consecutive days. Looking at Seattle through April.',
      now() - interval '6 hours'),
    -- Alex Morgan — Nashville cardiac journey
    ('f0000001-0000-0000-0000-000000000108', ws, 'e0000001-0000-0000-0000-000000000008', NULL,
      'Nashville CT anesthesia opportunity. Alex has strong heart/CT background. IMLC covers Tennessee. Target rate $265/hr. Available ' || to_char(CURRENT_DATE + 18, 'YYYY-MM-DD') || '.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000109', ws, 'e0000001-0000-0000-0000-000000000008', NULL,
      'Rate conversation: Alex floated $270 per hour given the acuity. Facility ceiling is $260/hr. Scheduling tentative start date mid-month.',
      now() - interval '8 hours'),
    -- Jules Xavier — LA pain journey
    ('f0000001-0000-0000-0000-00000000010a', ws, 'e0000001-0000-0000-0000-00000000000a', NULL,
      'Jules: regional anesthesia and pain clinic experience. California license current. Target rate $260/hr. Prefers Los Angeles over Denver for this block.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-00000000010b', ws, 'e0000001-0000-0000-0000-00000000000a', NULL,
      'Jules confirmed rate at $255/hr and schedule starting ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || '. Strong preference for pain clinic work over OR cases.',
      now() - interval '1 day'),
    -- Kai Yamamoto — NY cardiac
    ('f0000001-0000-0000-0000-00000000010c', ws, 'e0000001-0000-0000-0000-00000000000d', NULL,
      'Kai is local to Manhattan, cardiothoracic background. Rate $305/hr for CT anesthesia. Not IMLC eligible — New York only coverage.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-00000000010d', ws, 'e0000001-0000-0000-0000-00000000000d', NULL,
      'Credential follow-up: Kai''s New York license + CSR active. ACLS current. Available for 6-week block starting ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || '.',
      now() - interval '8 hours'),
    -- Uma Ibrahim — NY general
    ('f0000001-0000-0000-0000-00000000010e', ws, 'e0000001-0000-0000-0000-00000000000e', NULL,
      'Uma available immediately in Manhattan. Rate $230/hr. Open to general anesthesia work through next quarter.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-00000000010f', ws, 'e0000001-0000-0000-0000-00000000000e', NULL,
      'Uma preference update: she wants to avoid OB cases on this block. General anesthesia only. Would consider Texas placements later.',
      now() - interval '1 day'),
    -- Luna Zabala — Miami OB journey
    ('f0000001-0000-0000-0000-000000000110', ws, 'e0000001-0000-0000-0000-000000000020', NULL,
      'Luna: OB specialist, Miami-based. Rate $235/hr. Prefers L&D-heavy assignments. Available in Florida starting next month.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000111', ws, 'e0000001-0000-0000-0000-000000000020', NULL,
      'Luna confirmed start ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || ' at $240/hr. Credentials all current. Scheduling block out through year-end.',
      now() - interval '6 hours'),
    -- Niko Brennan — Chicago pain
    ('f0000001-0000-0000-0000-000000000112', ws, 'e0000001-0000-0000-0000-000000000022', NULL,
      'Niko: IMLC covers IL, OH, MI. Pain management + regional blocks. Rate $275/hr for Chicago pain clinic work. Available ' || to_char(CURRENT_DATE + 15, 'YYYY-MM-DD') || '.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-000000000113', ws, 'e0000001-0000-0000-0000-000000000022', NULL,
      'Michigan CSR not on file — will request. Niko OK waiting but prefers Illinois blocks first. Rate $270/hr for 8-week block.',
      now() - interval '1 day'),
    -- Omar Choi — Phoenix general
    ('f0000001-0000-0000-0000-000000000114', ws, 'e0000001-0000-0000-0000-000000000025', NULL,
      'Omar: IMLC compact (AZ, CO, IL). Open to Phoenix general anesthesia work. Rate $230/hr. Available immediately once contract signed.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000115', ws, 'e0000001-0000-0000-0000-000000000025', NULL,
      'Omar rate update: floated $240 per hour, will accept $235. Scheduling 6-week block in Arizona starting ' || to_char(CURRENT_DATE + 22, 'YYYY-MM-DD') || '.',
      now() - interval '12 hours'),
    -- Mira Abbas — Boston pediatric
    ('f0000001-0000-0000-0000-000000000116', ws, 'e0000001-0000-0000-0000-000000000027', NULL,
      'Mira: pediatric anesthesia background, Massachusetts-based. Target rate $270/hr. Available in Boston starting ' || to_char(CURRENT_DATE + 30, 'YYYY-MM-DD') || '.',
      now() - interval '4 days'),
    ('f0000001-0000-0000-0000-000000000117', ws, 'e0000001-0000-0000-0000-000000000027', NULL,
      'Mira preference: strong interest in children''s hospital work. Rate closed at $265/hr. Scheduled for 12-week block.',
      now() - interval '1 day'),
    -- Priya Delgado — Atlanta cardiac
    ('f0000001-0000-0000-0000-000000000118', ws, 'e0000001-0000-0000-0000-000000000029', NULL,
      'Priya: CT anesthesia fellowship, IMLC-eligible (GA, TN). Rate $290/hr for Atlanta heart cases. Immunizations renewal in flight — expect clear in 2 weeks.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-000000000119', ws, 'e0000001-0000-0000-0000-000000000029', NULL,
      'Priya accepted $285/hr. Scheduling open to Nashville as well since she''s Georgia + Tennessee licensed. Available ' || to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || '.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-00000000011a', ws, 'e0000001-0000-0000-0000-000000000029', NULL,
      'Immunization follow-up: Priya''s titers drawn, results pending. Renewal paperwork submitted to Atlanta facility. No change to start date.',
      now() - interval '6 hours'),
    -- Quinn Erikson — Cleveland OB
    ('f0000001-0000-0000-0000-00000000011b', ws, 'e0000001-0000-0000-0000-00000000002b', NULL,
      'Quinn: OB specialist, Ohio-based. Prefers L&D-heavy assignments. Rate $245/hr. Not available weekends per prior conversation.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-00000000011c', ws, 'e0000001-0000-0000-0000-00000000002b', NULL,
      'Quinn confirmed Cleveland start ' || to_char(CURRENT_DATE + 18, 'YYYY-MM-DD') || ' at $240 per hour. Monday-Friday only. 8-week block.',
      now() - interval '1 day'),
    -- Tariq Hart — Detroit cardiac
    ('f0000001-0000-0000-0000-00000000011d', ws, 'e0000001-0000-0000-0000-00000000002f', NULL,
      'Tariq: cardiac + heart transplant anesthesia background. IMLC-eligible. Rate $300/hr for complex CT cases. Michigan CSR active.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-00000000011e', ws, 'e0000001-0000-0000-0000-00000000002f', NULL,
      'Rate conversation: Tariq accepted $295 per hour. Scheduling confirmation in process. Available ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || '.',
      now() - interval '1 day'),
    -- Sage Guzman — Philadelphia pain
    ('f0000001-0000-0000-0000-00000000011f', ws, 'e0000001-0000-0000-0000-000000000031', NULL,
      'Sage currently booked until ' || to_char(CURRENT_DATE + 7, 'YYYY-MM-DD') || '. After that available for Philadelphia pain clinic. Rate $250/hr.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000120', ws, 'e0000001-0000-0000-0000-000000000031', NULL,
      'Sage preference: Pennsylvania over New York for this block. Rate confirmed $250 per hour. 10-week commitment.',
      now() - interval '4 hours'),
    -- Diverse pay-band examples (low + high end)
    ('f0000001-0000-0000-0000-000000000121', ws, 'e0000001-0000-0000-0000-000000000003', NULL,
      'Blair Nguyen: OB anesthesia, Texas + Washington licenses. Board cert in renewal, ACLS current. Rate floor $200/hr. Available once board cert clears.',
      now() - interval '2 days'),
    ('f0000001-0000-0000-0000-000000000122', ws, 'e0000001-0000-0000-0000-00000000000b', NULL,
      'Farah Taylor: California-only cardiac. Rate $325/hr for LA CT cases given scarcity. Immediate availability.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000123', ws, 'e0000001-0000-0000-0000-000000000030', NULL,
      'Niko Brennan Detroit pain coverage: IMLC covers Michigan. Rate band $650/hr given trauma case acuity. Available for 4-week trauma block.',
      now() - interval '1 day'),
    ('f0000001-0000-0000-0000-000000000124', ws, 'e0000001-0000-0000-0000-00000000000f', NULL,
      'Sage: comfortable NY timeline, no urgency. Rate band $235-$255 per hour. Prefers Manhattan.',
      now() - interval '3 days'),
    ('f0000001-0000-0000-0000-000000000125', ws, 'e0000001-0000-0000-0000-000000000026', NULL,
      'Yael Monroe: pain, Phoenix opportunity. Rate $215/hr floor. Colorado and Washington alternatives if Phoenix falls through.',
      now() - interval '2 days'),
    -- Newly-added providers: light footprint
    ('f0000001-0000-0000-0000-000000000126', ws, 'e0000001-0000-0000-0000-000000000001', NULL,
      'Intake note on NEW provider Zoe Alvarado (TX cardiac). Minimal credential set — background check pending. Rate target $230/hr pending full onboarding.',
      now() - interval '4 days'),
    ('f0000001-0000-0000-0000-000000000127', ws, 'e0000001-0000-0000-0000-000000000021', NULL,
      'Intake note on NEW provider Ari Bello (FL ob). Still being onboarded, missing ACLS + immunizations. Tentative rate $225 per hour once cleared.',
      now() - interval '6 days'),
    ('f0000001-0000-0000-0000-000000000128', ws, 'e0000001-0000-0000-0000-000000000027', NULL,
      'Intake note on NEW provider Bodhi Cho (MA pediatric). Background check + immunizations pending. Target rate $250/hr. Expected clear in 3 weeks.',
      now() - interval '8 days')
  ON CONFLICT (id) DO NOTHING;

  -- ─── outreach_threads + outreach_messages ──────────────────────
  -- One thread per active case (recipient_kind='provider'), with
  -- 3-5 messages per thread spanning the full outreach flow:
  -- initial send → follow-up → response-synthesis. Covers the
  -- WS C conversations reader (reads outbound email history). The
  -- thread's recipient_email matches the provider's email so
  -- entity resolution lands on the seeded signal_providers row.
  INSERT INTO outreach_threads (id, workspace_id, case_id, recipient_kind, recipient_name, recipient_email, recipient_phone, status, created_at)
  VALUES
    ('aa000001-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', 'provider', 'Alex Morgan',    'alex.morgan@signal-seed.test',    '512-555-0101', 'active',    now() - interval '10 days'),
    ('aa000001-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000002', 'provider', 'Grey Umoren',    'grey.umoren@signal-seed.test',    '512-555-0107', 'active',    now() - interval '14 days'),
    ('aa000001-0000-0000-0000-000000000006', ws, 'e0000001-0000-0000-0000-000000000006', 'provider', 'Devin Rivera',   'devin.rivera@signal-seed.test',   '206-555-0104', 'active',    now() - interval '18 days'),
    ('aa000001-0000-0000-0000-000000000008', ws, 'e0000001-0000-0000-0000-000000000008', 'provider', 'Alex Morgan',    'alex.morgan@signal-seed.test',    '512-555-0101', 'active',    now() - interval '2 days'),
    ('aa000001-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', 'provider', 'Jules Xavier',   'jules.xavier@signal-seed.test',   '206-555-0110', 'active',    now() - interval '5 days'),
    ('aa000001-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-00000000000d', 'provider', 'Kai Yamamoto',   'kai.yamamoto@signal-seed.test',   '212-555-0111', 'active',    now() - interval '3 days'),
    ('aa000001-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-00000000000e', 'provider', 'Uma Ibrahim',    'uma.ibrahim@signal-seed.test',    '212-555-0121', 'active',    now() - interval '8 days'),
    ('aa000001-0000-0000-0000-000000000020', ws, 'e0000001-0000-0000-0000-000000000020', 'provider', 'Luna Zabala',    'luna.zabala@signal-seed.test',    '305-555-0112', 'active',    now() - interval '4 days'),
    ('aa000001-0000-0000-0000-000000000022', ws, 'e0000001-0000-0000-0000-000000000022', 'provider', 'Niko Brennan',   'niko.brennan@signal-seed.test',   '312-555-0114', 'active',    now() - interval '6 days'),
    ('aa000001-0000-0000-0000-000000000025', ws, 'e0000001-0000-0000-0000-000000000025', 'provider', 'Omar Choi',      'omar.choi@signal-seed.test',      '602-555-0115', 'active',    now() - interval '3 days'),
    ('aa000001-0000-0000-0000-000000000027', ws, 'e0000001-0000-0000-0000-000000000027', 'provider', 'Mira Abbas',     'mira.abbas@signal-seed.test',     '617-555-0113', 'active',    now() - interval '7 days'),
    ('aa000001-0000-0000-0000-000000000029', ws, 'e0000001-0000-0000-0000-000000000029', 'provider', 'Priya Delgado',  'priya.delgado@signal-seed.test',  '404-555-0116', 'active',    now() - interval '5 days'),
    ('aa000001-0000-0000-0000-00000000002b', ws, 'e0000001-0000-0000-0000-00000000002b', 'provider', 'Quinn Erikson',  'quinn.erikson@signal-seed.test',  '216-555-0117', 'active',    now() - interval '4 days'),
    ('aa000001-0000-0000-0000-00000000002f', ws, 'e0000001-0000-0000-0000-00000000002f', 'provider', 'Tariq Hart',     'tariq.hart@signal-seed.test',     '313-555-0120', 'active',    now() - interval '6 days'),
    ('aa000001-0000-0000-0000-000000000031', ws, 'e0000001-0000-0000-0000-000000000031', 'provider', 'Sage Guzman',    'sage.guzman@signal-seed.test',    '215-555-0119', 'active',    now() - interval '3 days')
  ON CONFLICT (id) DO NOTHING;

  -- Outreach messages — 3-5 per thread, mix of email + SMS to show
  -- multi-channel. Rich bodies with REGION / TIMING / RATE /
  -- SUBSPECIALTY / AVAILABILITY tokens so the WS E extractor fires.
  INSERT INTO outreach_messages (id, thread_id, workspace_id, channel, direction, template, body, sent_at, created_at)
  VALUES
    -- Alex Morgan (Austin cardiac) thread
    ('ab000001-0000-0000-0000-000000000001', 'aa000001-0000-0000-0000-000000000001', ws, 'email', 'out', 'coverage_offer',
      E'Hi Alex,\n\nI have a cardiac anesthesia opening at Austin Medical Center starting the week of ' || to_char(CURRENT_DATE + 21, 'Mon DD, YYYY') ||
      E'. 7-on/7-off schedule, $240/hr. Is this a fit? Texas CSR must be current.\n\nThanks,\nRevanth',
      now() - interval '9 days', now() - interval '9 days'),
    ('ab000001-0000-0000-0000-000000000002', 'aa000001-0000-0000-0000-000000000001', ws, 'email', 'out', 'follow_up',
      E'Hi Alex — following up on the Austin cardiac opening. Rate can move to $245/hr. Available starting ' || to_char(CURRENT_DATE + 21, 'YYYY-MM-DD') || E'.',
      now() - interval '6 days', now() - interval '6 days'),
    ('ab000001-0000-0000-0000-000000000003', 'aa000001-0000-0000-0000-000000000001', ws, 'email', 'out', 'rate_update',
      E'Alex, CMO approved $255 per hour given the cardiothoracic case mix. Need confirmation this week to lock the start date.',
      now() - interval '2 days', now() - interval '2 days'),
    ('ab000001-0000-0000-0000-000000000004', 'aa000001-0000-0000-0000-000000000001', ws, 'sms', 'out', 'reminder',
      E'Quick ping on the Austin cardiac offer — rate at $255/hr, start 3 weeks out. Let me know if we''re a go.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Grey Umoren (Austin general) thread
    ('ab000001-0000-0000-0000-000000000005', 'aa000001-0000-0000-0000-000000000002', ws, 'email', 'out', 'coverage_offer',
      E'Hi Grey — Austin general anesthesia coverage opportunity. IMLC-friendly, Texas-based block. Rate $220/hr. Can you start in the next 30 days?',
      now() - interval '13 days', now() - interval '13 days'),
    ('ab000001-0000-0000-0000-000000000006', 'aa000001-0000-0000-0000-000000000002', ws, 'email', 'out', 'follow_up',
      E'Grey, follow-up on the Texas general anesthesia role. Rate band $210-$230 per hour depending on case mix. Available immediately preferred.',
      now() - interval '9 days', now() - interval '9 days'),
    ('ab000001-0000-0000-0000-000000000007', 'aa000001-0000-0000-0000-000000000002', ws, 'email', 'out', 'response_synthesis',
      E'Grey confirmed: Texas and Colorado coverage through Q1. Rate $220/hr. Available January through March. Needs TX CSR filed first.',
      now() - interval '3 days', now() - interval '3 days'),
    -- Devin Rivera (Seattle pain) thread
    ('ab000001-0000-0000-0000-00000000000a', 'aa000001-0000-0000-0000-000000000006', ws, 'email', 'out', 'coverage_offer',
      E'Devin — Seattle pain clinic coverage, Washington licensed. Rate $280/hr. Start ' || to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || E'. 10-day blocks, no weekends per your prior note.',
      now() - interval '17 days', now() - interval '17 days'),
    ('ab000001-0000-0000-0000-00000000000b', 'aa000001-0000-0000-0000-000000000006', ws, 'email', 'out', 'follow_up',
      E'Devin — confirming Seattle pain opportunity. Rate holds at $285 per hour. California license noted. Available weekdays only.',
      now() - interval '12 days', now() - interval '12 days'),
    ('ab000001-0000-0000-0000-00000000000c', 'aa000001-0000-0000-0000-000000000006', ws, 'email', 'out', 'response_synthesis',
      E'Devin confirmed: Seattle start ' || to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || E', chronic pain cases only, $285/hr. 10-day block through end of quarter.',
      now() - interval '3 days', now() - interval '3 days'),
    -- Alex Morgan (Nashville cardiac) — same provider, second thread
    ('ab000001-0000-0000-0000-00000000000d', 'aa000001-0000-0000-0000-000000000008', ws, 'email', 'out', 'coverage_offer',
      E'Alex — Nashville cardiac institute has a CT anesthesia opening. Tennessee covered via IMLC. Rate $265/hr. Start ' || to_char(CURRENT_DATE + 18, 'YYYY-MM-DD') || E'. Interested?',
      now() - interval '1 day', now() - interval '1 day'),
    -- Jules Xavier (LA pain) thread
    ('ab000001-0000-0000-0000-00000000000e', 'aa000001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'coverage_offer',
      E'Jules — LA pain management opening. California active, rate $260/hr. Start ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || E'. Regional anesthesia preferred over OR.',
      now() - interval '4 days', now() - interval '4 days'),
    ('ab000001-0000-0000-0000-00000000000f', 'aa000001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'rate_negotiation',
      E'Jules, revised rate at $255/hr. Pain clinic work preferred — confirmed with facility. Looking at a 12-week block.',
      now() - interval '2 days', now() - interval '2 days'),
    ('ab000001-0000-0000-0000-000000000010', 'aa000001-0000-0000-0000-00000000000a', ws, 'sms', 'out', 'reminder',
      E'Hi Jules — Los Angeles pain opportunity, start in 3 weeks. Need your yes to send paperwork.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Kai Yamamoto (NY cardiac) thread
    ('ab000001-0000-0000-0000-000000000011', 'aa000001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'coverage_offer',
      E'Kai — Manhattan CT anesthesia opportunity. Rate $305/hr for cardiothoracic case mix. Start ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || E'.',
      now() - interval '2 days', now() - interval '2 days'),
    ('ab000001-0000-0000-0000-000000000012', 'aa000001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'follow_up',
      E'Kai follow-up: NY CSR confirmed active, ACLS current. Lock rate at $300 per hour? 6-week block.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Uma Ibrahim (NY general) thread
    ('ab000001-0000-0000-0000-000000000013', 'aa000001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'coverage_offer',
      E'Uma — Manhattan general anesthesia. New York license. Rate $230/hr. Available immediately noted. Not OB per your preference.',
      now() - interval '7 days', now() - interval '7 days'),
    ('ab000001-0000-0000-0000-000000000014', 'aa000001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'follow_up',
      E'Uma, confirming rate at $225 per hour, general anesthesia only. Would you consider a Texas block later?',
      now() - interval '4 days', now() - interval '4 days'),
    ('ab000001-0000-0000-0000-000000000015', 'aa000001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'response_synthesis',
      E'Uma confirmed: Manhattan work through next quarter, $225/hr, general only. Open to Texas Q2 next year.',
      now() - interval '2 days', now() - interval '2 days'),
    -- Luna Zabala (Miami OB) thread
    ('ab000001-0000-0000-0000-000000000016', 'aa000001-0000-0000-0000-000000000020', ws, 'email', 'out', 'coverage_offer',
      E'Luna — Miami L&D coverage. Florida licensed. Rate $235/hr. Start ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || E'.',
      now() - interval '3 days', now() - interval '3 days'),
    ('ab000001-0000-0000-0000-000000000017', 'aa000001-0000-0000-0000-000000000020', ws, 'email', 'out', 'follow_up',
      E'Luna — confirmed start, rate moving to $240 per hour. Georgia block available if Miami falls through.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Niko Brennan (Chicago pain) thread
    ('ab000001-0000-0000-0000-000000000018', 'aa000001-0000-0000-0000-000000000022', ws, 'email', 'out', 'coverage_offer',
      E'Niko — Chicago pain clinic coverage. IMLC compact covers IL. Rate $275/hr. 8-week block starting ' || to_char(CURRENT_DATE + 15, 'YYYY-MM-DD') || E'.',
      now() - interval '5 days', now() - interval '5 days'),
    ('ab000001-0000-0000-0000-000000000019', 'aa000001-0000-0000-0000-000000000022', ws, 'email', 'out', 'follow_up',
      E'Niko follow-up: Illinois first, Michigan if we file state CSR. Rate $270 per hour acceptable?',
      now() - interval '2 days', now() - interval '2 days'),
    -- Omar Choi (Phoenix general) thread
    ('ab000001-0000-0000-0000-00000000001a', 'aa000001-0000-0000-0000-000000000025', ws, 'email', 'out', 'coverage_offer',
      E'Omar — Phoenix general anesthesia block. Arizona IMLC active. Rate $230/hr. Start ' || to_char(CURRENT_DATE + 22, 'YYYY-MM-DD') || E'.',
      now() - interval '2 days', now() - interval '2 days'),
    ('ab000001-0000-0000-0000-00000000001b', 'aa000001-0000-0000-0000-000000000025', ws, 'email', 'out', 'rate_update',
      E'Omar — bumped rate to $235 per hour. 6-week commitment for the Phoenix block.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Mira Abbas (Boston pediatric) thread
    ('ab000001-0000-0000-0000-00000000001c', 'aa000001-0000-0000-0000-000000000027', ws, 'email', 'out', 'coverage_offer',
      E'Mira — Boston Metro children''s hospital anesthesia coverage. Massachusetts license. Rate $270/hr. Start ' || to_char(CURRENT_DATE + 30, 'YYYY-MM-DD') || E'. 12-week block.',
      now() - interval '6 days', now() - interval '6 days'),
    ('ab000001-0000-0000-0000-00000000001d', 'aa000001-0000-0000-0000-000000000027', ws, 'email', 'out', 'follow_up',
      E'Mira — pediatric anesthesia + children''s hospital background is the perfect fit. Rate holding at $265 per hour.',
      now() - interval '3 days', now() - interval '3 days'),
    ('ab000001-0000-0000-0000-00000000001e', 'aa000001-0000-0000-0000-000000000027', ws, 'sms', 'out', 'reminder',
      E'Hi Mira — Boston pediatric opening still open. Can we finalize this week?',
      now() - interval '1 day', now() - interval '1 day'),
    -- Priya Delgado (Atlanta cardiac) thread
    ('ab000001-0000-0000-0000-00000000001f', 'aa000001-0000-0000-0000-000000000029', ws, 'email', 'out', 'coverage_offer',
      E'Priya — Atlanta cardiac heart center opportunity. IMLC covers Georgia + Tennessee. Rate $290/hr. Start ' || to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || E'.',
      now() - interval '4 days', now() - interval '4 days'),
    ('ab000001-0000-0000-0000-000000000020', 'aa000001-0000-0000-0000-000000000029', ws, 'email', 'out', 'rate_negotiation',
      E'Priya — settled $285 per hour. Immunization renewal in flight, clear in 2 weeks. No schedule impact.',
      now() - interval '2 days', now() - interval '2 days'),
    ('ab000001-0000-0000-0000-000000000021', 'aa000001-0000-0000-0000-000000000029', ws, 'email', 'out', 'response_synthesis',
      E'Priya confirmed: Atlanta cardiac + Nashville overflow. $285/hr. Available ' || to_char(CURRENT_DATE + 14, 'YYYY-MM-DD') || E'.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Quinn Erikson (Cleveland OB) thread
    ('ab000001-0000-0000-0000-000000000022', 'aa000001-0000-0000-0000-00000000002b', ws, 'email', 'out', 'coverage_offer',
      E'Quinn — Cleveland obstetric anesthesia, Ohio-based. Rate $245/hr. Start ' || to_char(CURRENT_DATE + 18, 'YYYY-MM-DD') || E'. Weekdays only per your note.',
      now() - interval '3 days', now() - interval '3 days'),
    ('ab000001-0000-0000-0000-000000000023', 'aa000001-0000-0000-0000-00000000002b', ws, 'email', 'out', 'follow_up',
      E'Quinn — settled at $240 per hour. Monday-Friday L&D for 8 weeks. Pennsylvania backup if needed.',
      now() - interval '1 day', now() - interval '1 day'),
    -- Tariq Hart (Detroit cardiac) thread
    ('ab000001-0000-0000-0000-000000000024', 'aa000001-0000-0000-0000-00000000002f', ws, 'email', 'out', 'coverage_offer',
      E'Tariq — Detroit cardiac + heart transplant anesthesia opening. Michigan licensed, IMLC-eligible. Rate $300/hr for complex CT cases. Start ' || to_char(CURRENT_DATE + 20, 'YYYY-MM-DD') || E'.',
      now() - interval '5 days', now() - interval '5 days'),
    ('ab000001-0000-0000-0000-000000000025', 'aa000001-0000-0000-0000-00000000002f', ws, 'email', 'out', 'rate_update',
      E'Tariq — accepted $295 per hour for 8-week block. Scheduling confirmation in progress.',
      now() - interval '2 days', now() - interval '2 days'),
    -- Sage Guzman (Philadelphia pain) thread
    ('ab000001-0000-0000-0000-000000000026', 'aa000001-0000-0000-0000-000000000031', ws, 'email', 'out', 'coverage_offer',
      E'Sage — Philadelphia pain clinic coverage, Pennsylvania licensed. Rate $250/hr. Booked until ' || to_char(CURRENT_DATE + 7, 'YYYY-MM-DD') || E', then 10-week block.',
      now() - interval '2 days', now() - interval '2 days'),
    ('ab000001-0000-0000-0000-000000000027', 'aa000001-0000-0000-0000-000000000031', ws, 'sms', 'out', 'reminder',
      E'Sage — confirming Philly pain start week of ' || to_char(CURRENT_DATE + 7, 'YYYY-MM-DD') || E'. Rate holds at $250 per hour.',
      now() - interval '4 hours', now() - interval '4 hours')
  ON CONFLICT (id) DO NOTHING;

  -- ─── worked case journeys: lifecycle transitions ───────────────
  -- Flip a mix of cases to progressed statuses so the recruiter UI
  -- has real "I''ve been here before" context. Use UPDATE to move
  -- status + stamp submittedAt / completedAt / assignedSpecialistId
  -- without destroying the original opened_at. case_status_events
  -- below records the transitions.
  UPDATE cases SET
    status      = 'submitted',
    submitted_at = now() - interval '2 days'
    WHERE id = 'e0000001-0000-0000-0000-000000000001'; -- Austin cardiac (Alex Morgan)
  UPDATE cases SET
    status       = 'completed',
    submitted_at = now() - interval '45 days',
    completed_at = now() - interval '30 days'
    WHERE id = 'e0000001-0000-0000-0000-000000000006'; -- Seattle pain (Devin Rivera) — wrapped assignment
  UPDATE cases SET
    status       = 'ready_for_review',
    submitted_at = now() - interval '1 day'
    WHERE id = 'e0000001-0000-0000-0000-000000000029'; -- Atlanta cardiac (Priya Delgado)
  UPDATE cases SET
    status       = 'awaiting_provider'
    WHERE id = 'e0000001-0000-0000-0000-00000000002b'; -- Cleveland OB (Quinn Erikson)
  UPDATE cases SET
    status       = 'in_progress'
    WHERE id = 'e0000001-0000-0000-0000-00000000000a'; -- LA pain (Jules Xavier)

  INSERT INTO case_status_events (id, workspace_id, case_id, from_status, to_status, actor_user_id, actor_type, reason, created_at)
  VALUES
    -- Alex Morgan Austin: intake → in_progress → ready_for_review → submitted
    ('ba000001-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-000000000001', 'intake',           'in_progress',      NULL, 'system', 'provider accepted offer at $255/hr',          now() - interval '10 days'),
    ('ba000001-0000-0000-0000-000000000012', ws, 'e0000001-0000-0000-0000-000000000001', 'in_progress',      'ready_for_review', NULL, 'system', 'packet assembled — awaiting specialist review', now() - interval '4 days'),
    ('ba000001-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-000000000001', 'ready_for_review', 'submitted',        NULL, 'system', 'packet submitted to Austin Medical Center',   now() - interval '2 days'),
    -- Devin Rivera Seattle: completed journey
    ('ba000001-0000-0000-0000-000000000061', ws, 'e0000001-0000-0000-0000-000000000006', 'intake',           'in_progress',      NULL, 'system', 'provider accepted — chronic pain focus',       now() - interval '70 days'),
    ('ba000001-0000-0000-0000-000000000062', ws, 'e0000001-0000-0000-0000-000000000006', 'in_progress',      'ready_for_review', NULL, 'system', 'packet assembled',                             now() - interval '55 days'),
    ('ba000001-0000-0000-0000-000000000063', ws, 'e0000001-0000-0000-0000-000000000006', 'ready_for_review', 'submitted',        NULL, 'system', 'submitted to Seattle Children',              now() - interval '45 days'),
    ('ba000001-0000-0000-0000-000000000064', ws, 'e0000001-0000-0000-0000-000000000006', 'submitted',        'completed',        NULL, 'system', 'assignment wrapped — provider rolled off',    now() - interval '30 days'),
    -- Priya Delgado Atlanta: intake → in_progress → ready_for_review
    ('ba000001-0000-0000-0000-00000000029a', ws, 'e0000001-0000-0000-0000-000000000029', 'intake',           'in_progress',      NULL, 'system', 'offer accepted at $285/hr',                   now() - interval '3 days'),
    ('ba000001-0000-0000-0000-00000000029b', ws, 'e0000001-0000-0000-0000-000000000029', 'in_progress',      'ready_for_review', NULL, 'system', 'immunization renewal in flight',              now() - interval '1 day'),
    -- Quinn Erikson Cleveland: intake → awaiting_provider
    ('ba000001-0000-0000-0000-00000000002b', ws, 'e0000001-0000-0000-0000-00000000002b', 'intake',           'awaiting_provider', NULL, 'system', 'awaiting provider signature on schedule',    now() - interval '1 day'),
    -- Jules Xavier LA: intake → in_progress
    ('ba000001-0000-0000-0000-0000000000aa', ws, 'e0000001-0000-0000-0000-00000000000a', 'intake',           'in_progress',      NULL, 'system', 'offer accepted — LA pain block',              now() - interval '2 days')
  ON CONFLICT (id) DO NOTHING;

END $$;

COMMIT;

-- ─── POST-INGEST: backfill signal_jobs.state from facility address ──
-- The WS C jobs reader leaves `signal_jobs.state` NULL (cases does
-- not carry state). We derive it from the facility address trailer
-- `City, STATE ZIP`. This runs AFTER the ingest so ranking has a
-- real state to project against.
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

-- ─── POST-INGEST: backfill signal_jobs.pay with varied bands ────────
-- cases.pay doesn't exist, so ingest leaves pay NULL. We map each
-- seeded case's external_id → signal_jobs.id via signal_source_lineage
-- and set a spread of hourly rates ($200/hr … $650/hr) so the ranker's
-- RATE_WITHIN_BAND facet lights up against varied job pay. Idempotent.
WITH seed_pay(ext_id, pay) AS (
  VALUES
    ('e0000001-0000-0000-0000-000000000001'::text, 255.00),  -- Austin cardiac
    ('e0000001-0000-0000-0000-000000000002'::text, 220.00),  -- Austin general
    ('e0000001-0000-0000-0000-000000000003'::text, 215.00),  -- Austin OB
    ('e0000001-0000-0000-0000-000000000004'::text, 265.00),  -- Denver pediatric
    ('e0000001-0000-0000-0000-000000000005'::text, 240.00),  -- Denver OB
    ('e0000001-0000-0000-0000-000000000006'::text, 285.00),  -- Seattle pain
    ('e0000001-0000-0000-0000-000000000007'::text, 270.00),  -- Seattle pediatric
    ('e0000001-0000-0000-0000-000000000008'::text, 265.00),  -- Nashville cardiac
    ('e0000001-0000-0000-0000-000000000009'::text, 225.00),  -- Nashville general
    ('e0000001-0000-0000-0000-00000000000a'::text, 255.00),  -- LA pain
    ('e0000001-0000-0000-0000-00000000000b'::text, 325.00),  -- LA cardiac (scarcity premium)
    ('e0000001-0000-0000-0000-00000000000c'::text, 260.00),  -- LA pain
    ('e0000001-0000-0000-0000-00000000000d'::text, 305.00),  -- NY cardiac
    ('e0000001-0000-0000-0000-00000000000e'::text, 230.00),  -- NY general
    ('e0000001-0000-0000-0000-00000000000f'::text, 245.00),  -- NY pain
    ('e0000001-0000-0000-0000-000000000020'::text, 240.00),  -- Miami OB
    ('e0000001-0000-0000-0000-000000000021'::text, 225.00),  -- Miami OB 2
    ('e0000001-0000-0000-0000-000000000022'::text, 275.00),  -- Chicago pain
    ('e0000001-0000-0000-0000-000000000023'::text, 205.00),  -- Chicago general (low end)
    ('e0000001-0000-0000-0000-000000000024'::text, 260.00),  -- Chicago pediatric
    ('e0000001-0000-0000-0000-000000000025'::text, 235.00),  -- Phoenix general
    ('e0000001-0000-0000-0000-000000000026'::text, 215.00),  -- Phoenix pain
    ('e0000001-0000-0000-0000-000000000027'::text, 270.00),  -- Boston pediatric
    ('e0000001-0000-0000-0000-000000000028'::text, 200.00),  -- Boston general (floor)
    ('e0000001-0000-0000-0000-000000000029'::text, 285.00),  -- Atlanta cardiac
    ('e0000001-0000-0000-0000-00000000002a'::text, 220.00),  -- Atlanta general
    ('e0000001-0000-0000-0000-00000000002b'::text, 240.00),  -- Cleveland OB
    ('e0000001-0000-0000-0000-00000000002c'::text, 265.00),  -- Cleveland pain
    ('e0000001-0000-0000-0000-00000000002d'::text, 210.00),  -- Charlotte general
    ('e0000001-0000-0000-0000-00000000002e'::text, 300.00),  -- Charlotte cardiac
    ('e0000001-0000-0000-0000-00000000002f'::text, 295.00),  -- Detroit cardiac
    ('e0000001-0000-0000-0000-000000000030'::text, 650.00),  -- Detroit pain (trauma premium top end)
    ('e0000001-0000-0000-0000-000000000031'::text, 250.00),  -- Philadelphia pain
    ('e0000001-0000-0000-0000-000000000032'::text, 235.00),  -- Philadelphia OB
    ('e0000001-0000-0000-0000-000000000033'::text, 280.00),  -- extra Chicago pain
    ('e0000001-0000-0000-0000-000000000034'::text, 260.00),  -- extra NY pediatric
    ('e0000001-0000-0000-0000-000000000035'::text, 230.00)   -- extra Miami OB
)
UPDATE signal_jobs sj
SET pay = sub.pay
FROM seed_pay sub
JOIN signal_source_lineage sl
  ON sl.canonical_table = 'signal_jobs'
 AND sl.external_system = 'roster-internal'
 AND sl.external_id     = sub.ext_id
WHERE sj.id = sl.canonical_id
  AND (sj.pay IS NULL OR sj.pay::numeric <> sub.pay);
-- ─── v4 expansion: varied conversations spread across 12 months ────
-- Engagement tier classification (reflected in conversation density/timing):
--   WARMING  (5): Alex Morgan, Mira Abbas, Omar Choi, Priya Delgado, Sage Guzman
--   ACTIVE   (8): Devin Rivera, Grey Umoren, Jules Xavier, Kai Yamamoto, Luna Zabala, Niko Brennan, Quinn Erikson, Tariq Hart
--   COOLING  (5): Blair Nguyen, Casey Patel, Hayden Vasquez, Will Khan, Yael Monroe
--   DORMANT  (4): Eli Sato, Farah Taylor, Uma Ibrahim, Vera Juarez
--   LIGHT    (6): Indra Wyatt, Ravi Fonseca, Xian Lopez, Zoe Alvarado, Ari Bello, Bodhi Cho
-- Generated deterministically from seed=42 with mixed intents + channels.
-- case_notes: ~40%, outreach email: ~40%, outreach sms: ~20%.

BEGIN;

DO $$
DECLARE
  ws uuid;
BEGIN
  SELECT id INTO ws FROM workspaces WHERE slug = 'roster-hc-beta';

  -- ─── additional outreach_threads (one or two per provider) ────────
  INSERT INTO outreach_threads (id, workspace_id, case_id, recipient_kind, recipient_name, recipient_email, recipient_phone, status, created_at) VALUES
    ('aa100001-0000-0000-0000-000000000005', ws, 'e0000001-0000-0000-0000-000000000009', 'provider', 'Eli Sato', 'eli.sato@signal-seed.test', '615-555-0105', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000006', ws, 'e0000001-0000-0000-0000-00000000000b', 'provider', 'Farah Taylor', 'farah.taylor@signal-seed.test', '213-555-0106', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000015', ws, 'e0000001-0000-0000-0000-00000000000e', 'provider', 'Uma Ibrahim', 'uma.ibrahim@signal-seed.test', '212-555-0121', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000016', ws, 'e0000001-0000-0000-0000-000000000021', 'provider', 'Vera Juarez', 'vera.juarez@signal-seed.test', '305-555-0122', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000016', ws, 'e0000001-0000-0000-0000-000000000035', 'provider', 'Vera Juarez', 'vera.juarez@signal-seed.test', '305-555-0122', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000003', 'provider', 'Blair Nguyen', 'blair.nguyen@signal-seed.test', '512-555-0102', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000004', 'provider', 'Casey Patel', 'casey.patel@signal-seed.test', '720-555-0103', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000008', ws, 'e0000001-0000-0000-0000-000000000005', 'provider', 'Hayden Vasquez', 'hayden.vasquez@signal-seed.test', '720-555-0108', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000017', ws, 'e0000001-0000-0000-0000-000000000028', 'provider', 'Will Khan', 'will.khan@signal-seed.test', '617-555-0123', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000019', ws, 'e0000001-0000-0000-0000-000000000026', 'provider', 'Yael Monroe', 'yael.monroe@signal-seed.test', '720-555-0125', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000004', ws, 'e0000001-0000-0000-0000-000000000006', 'provider', 'Devin Rivera', 'devin.rivera@signal-seed.test', '206-555-0104', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000004', ws, 'e0000001-0000-0000-0000-00000000000c', 'provider', 'Devin Rivera', 'devin.rivera@signal-seed.test', '206-555-0104', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', 'provider', 'Grey Umoren', 'grey.umoren@signal-seed.test', '512-555-0107', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', 'provider', 'Jules Xavier', 'jules.xavier@signal-seed.test', '206-555-0110', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000000b', ws, 'e0000001-0000-0000-0000-00000000000d', 'provider', 'Kai Yamamoto', 'kai.yamamoto@signal-seed.test', '212-555-0111', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', 'provider', 'Luna Zabala', 'luna.zabala@signal-seed.test', '305-555-0112', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-000000000022', 'provider', 'Niko Brennan', 'niko.brennan@signal-seed.test', '312-555-0114', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-00000000002c', 'provider', 'Niko Brennan', 'niko.brennan@signal-seed.test', '312-555-0114', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-00000000002b', 'provider', 'Quinn Erikson', 'quinn.erikson@signal-seed.test', '216-555-0117', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-000000000032', 'provider', 'Quinn Erikson', 'quinn.erikson@signal-seed.test', '216-555-0117', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000014', ws, 'e0000001-0000-0000-0000-00000000002f', 'provider', 'Tariq Hart', 'tariq.hart@signal-seed.test', '313-555-0120', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', 'provider', 'Alex Morgan', 'alex.morgan@signal-seed.test', '512-555-0101', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000008', 'provider', 'Alex Morgan', 'alex.morgan@signal-seed.test', '512-555-0101', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000027', 'provider', 'Mira Abbas', 'mira.abbas@signal-seed.test', '617-555-0113', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', 'provider', 'Mira Abbas', 'mira.abbas@signal-seed.test', '617-555-0113', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000000f', ws, 'e0000001-0000-0000-0000-000000000023', 'provider', 'Omar Choi', 'omar.choi@signal-seed.test', '602-555-0115', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-00000000000f', ws, 'e0000001-0000-0000-0000-000000000025', 'provider', 'Omar Choi', 'omar.choi@signal-seed.test', '602-555-0115', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-000000000029', 'provider', 'Priya Delgado', 'priya.delgado@signal-seed.test', '404-555-0116', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-00000000002e', 'provider', 'Priya Delgado', 'priya.delgado@signal-seed.test', '404-555-0116', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-00000000000f', 'provider', 'Sage Guzman', 'sage.guzman@signal-seed.test', '215-555-0119', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-000000000031', 'provider', 'Sage Guzman', 'sage.guzman@signal-seed.test', '215-555-0119', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000009', ws, 'e0000001-0000-0000-0000-000000000007', 'provider', 'Indra Wyatt', 'indra.wyatt@signal-seed.test', '615-555-0109', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000012', ws, 'e0000001-0000-0000-0000-00000000002a', 'provider', 'Ravi Fonseca', 'ravi.fonseca@signal-seed.test', '704-555-0118', 'active', now() - interval '365 days'),
    ('aa200001-0000-0000-0000-000000000012', ws, 'e0000001-0000-0000-0000-00000000002d', 'provider', 'Ravi Fonseca', 'ravi.fonseca@signal-seed.test', '704-555-0118', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-000000000018', ws, 'e0000001-0000-0000-0000-000000000024', 'provider', 'Xian Lopez', 'xian.lopez@signal-seed.test', '512-555-0124', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000001a', ws, 'e0000001-0000-0000-0000-000000000001', 'provider', 'Zoe Alvarado', 'zoe.alvarado@signal-seed.test', '512-555-0126', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000001b', ws, 'e0000001-0000-0000-0000-000000000021', 'provider', 'Ari Bello', 'ari.bello@signal-seed.test', '305-555-0127', 'active', now() - interval '365 days'),
    ('aa100001-0000-0000-0000-00000000001c', ws, 'e0000001-0000-0000-0000-000000000027', 'provider', 'Bodhi Cho', 'bodhi.cho@signal-seed.test', '617-555-0128', 'active', now() - interval '365 days')
  ON CONFLICT (id) DO NOTHING;

  -- ─── case_notes across 12 months, mixed intents ──────────────────
  INSERT INTO case_notes (id, workspace_id, case_id, author_user_id, body, created_at) VALUES
    ('f2000001-0000-0000-0000-000000000005', ws, 'e0000001-0000-0000-0000-000000000009', NULL, 'First contact with Eli Sato — brief intro, sent credential form. general experience, TN-licensed.', now() - interval '186 days' - interval '7 hours'),
    ('f2000002-0000-0000-0000-000000000006', ws, 'e0000001-0000-0000-0000-00000000000b', NULL, 'Farah Taylor credential status update: state_csr renewal in flight for CA. Expected clear within 30 days.', now() - interval '267 days' - interval '22 hours'),
    ('f2000003-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000003', NULL, 'Blair Nguyen passed. Rate $210 per hour was below their floor. Will keep in roster for premium cases.', now() - interval '54 days' - interval '19 hours'),
    ('f2000004-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000003', NULL, 'Blair Nguyen said no to the WA assignment — too far from home. Prefers West Coast work for the rest of the year.', now() - interval '55 days' - interval '20 hours'),
    ('f2000005-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000003', NULL, 'Availability check-in with Blair Nguyen: booked until in 8 weeks, then open for 6-10 weeks. ob preferred.', now() - interval '123 days' - interval '20 hours'),
    ('f2000006-0000-0000-0000-000000000002', ws, 'e0000001-0000-0000-0000-000000000003', NULL, 'Opening presented to Blair Nguyen: ob coverage in Seattle, WA. Rate $213/hr. Start window in 6 weeks. Blair Nguyen said they''d review.', now() - interval '175 days' - interval '19 hours'),
    ('f2000007-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000004', NULL, 'Initial note to Casey Patel: introduced Roster, pitched CO pediatric work. Awaiting reply.', now() - interval '32 days' - interval '5 hours'),
    ('f2000008-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000004', NULL, 'Pitched Casey Patel on the Denver pediatric assignment. 8-week block, $249 per hour. Casey Patel is CO-licensed and open to the role.', now() - interval '136 days' - interval '18 hours'),
    ('f2000009-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000004', NULL, 'Credential check with Casey Patel: board cert current. Target CO placement. Immunizations on file.', now() - interval '139 days' - interval '16 hours'),
    ('f200000a-0000-0000-0000-000000000003', ws, 'e0000001-0000-0000-0000-000000000004', NULL, 'Opening presented to Casey Patel: pediatric coverage in Memphis, TN. Rate $271/hr. Start window in 8 weeks. Casey Patel said they''d review.', now() - interval '151 days' - interval '13 hours'),
    ('f200000b-0000-0000-0000-000000000008', ws, 'e0000001-0000-0000-0000-000000000005', NULL, 'Opening presented to Hayden Vasquez: ob coverage in Denver, CO. Rate $242/hr. Start window in 8 weeks. Hayden Vasquez said they''d review.', now() - interval '123 days' - interval '23 hours'),
    ('f200000c-0000-0000-0000-000000000008', ws, 'e0000001-0000-0000-0000-000000000005', NULL, 'Initial note to Hayden Vasquez: introduced Roster, pitched CO ob work. Awaiting reply.', now() - interval '129 days' - interval '19 hours'),
    ('f200000d-0000-0000-0000-000000000017', ws, 'e0000001-0000-0000-0000-000000000028', NULL, 'Updated rate band: $200-$235/hr for Will Khan. Will Khan comfortable with $206/hr if we can lock general cases only.', now() - interval '33 days' - interval '7 hours'),
    ('f200000e-0000-0000-0000-000000000017', ws, 'e0000001-0000-0000-0000-000000000028', NULL, 'Will Khan passed on the Philadelphia general opening. Not a fit for their case mix right now. Keep warm.', now() - interval '180 days' - interval '13 hours'),
    ('f200000f-0000-0000-0000-000000000019', ws, 'e0000001-0000-0000-0000-000000000026', NULL, 'Cold outreach to Yael Monroe: first touch, briefly covered the Tucson pain opening. Yael Monroe said they''d review.', now() - interval '60 days' - interval '0 hours'),
    ('f2000010-0000-0000-0000-000000000004', ws, 'e0000001-0000-0000-0000-00000000000c', NULL, 'Devin Rivera intro call: pitched the Tacoma pain block. Facility interested. Target rate band $240-$285 per hour. Available in WA.', now() - interval '53 days' - interval '7 hours'),
    ('f2000011-0000-0000-0000-000000000004', ws, 'e0000001-0000-0000-0000-00000000000c', NULL, 'Devin Rivera scheduling: prefers 7-on/7-off block. Available in 4 weeks. CA license current. Would start a 10-week commitment.', now() - interval '54 days' - interval '1 hours'),
    ('f2000012-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Updated rate band: $200-$235/hr for Grey Umoren. Grey Umoren comfortable with $220/hr if we can lock general cases only.', now() - interval '4 days' - interval '14 hours'),
    ('f2000013-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Grey Umoren intro call: pitched the Spokane general block. Facility interested. Target rate band $200-$235 per hour. Available in WA.', now() - interval '11 days' - interval '13 hours'),
    ('f2000014-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Grey Umoren intro call: pitched the Austin general block. Facility interested. Target rate band $200-$235 per hour. Available in TX.', now() - interval '17 days' - interval '20 hours'),
    ('f2000015-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Offer declined: Grey Umoren is booked through December. Will revisit next quarter.', now() - interval '52 days' - interval '13 hours'),
    ('f2000016-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Credential check with Grey Umoren: board cert current. Target CO placement. Immunizations on file.', now() - interval '60 days' - interval '10 hours'),
    ('f2000017-0000-0000-0000-000000000007', ws, 'e0000001-0000-0000-0000-000000000002', NULL, 'Grey Umoren responded to the admin question about general experience: 8+ years in general cases, fellowship-trained. Strong fit.', now() - interval '69 days' - interval '17 hours'),
    ('f2000018-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', NULL, 'Jules Xavier said yes to the Tacoma pain block. Rate $268/hr acceptable. Credential packet next.', now() - interval '48 days' - interval '5 hours'),
    ('f2000019-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', NULL, 'Jules Xavier accepted $254/hr for pain block in WA. Scheduling in motion.', now() - interval '55 days' - interval '7 hours'),
    ('f200001a-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', NULL, 'Jules Xavier floated $244 per hour given the pain case acuity. Facility ceiling is $240. Narrowing the gap.', now() - interval '59 days' - interval '13 hours'),
    ('f200001b-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', NULL, 'Jules Xavier said available immediately. Rate $274/hr, CA work.', now() - interval '61 days' - interval '14 hours'),
    ('f200001c-0000-0000-0000-00000000000a', ws, 'e0000001-0000-0000-0000-00000000000a', NULL, 'Jules Xavier said available immediately. Rate $268/hr, CO work.', now() - interval '71 days' - interval '18 hours'),
    ('f200001d-0000-0000-0000-00000000000b', ws, 'e0000001-0000-0000-0000-00000000000d', NULL, 'Kai Yamamoto confirmed interest in the Newark assignment. cardiac case mix is a strong fit. Ready to proceed.', now() - interval '37 days' - interval '22 hours'),
    ('f200001e-0000-0000-0000-00000000000b', ws, 'e0000001-0000-0000-0000-00000000000d', NULL, 'Kai Yamamoto confirmed interest in the Manhattan assignment. cardiac case mix is a strong fit. Ready to proceed.', now() - interval '43 days' - interval '12 hours'),
    ('f200001f-0000-0000-0000-00000000000b', ws, 'e0000001-0000-0000-0000-00000000000d', NULL, 'Kai Yamamoto accepted $294/hr for cardiac block in NY. Scheduling in motion.', now() - interval '45 days' - interval '0 hours'),
    ('f2000020-0000-0000-0000-00000000000b', ws, 'e0000001-0000-0000-0000-00000000000d', NULL, 'Kai Yamamoto responded to the admin question about cardiac experience: 8+ years in cardiac cases, fellowship-trained. Strong fit.', now() - interval '64 days' - interval '14 hours'),
    ('f2000021-0000-0000-0000-00000000000b', ws, 'e0000001-0000-0000-0000-00000000000d', NULL, 'Kai Yamamoto is excited about the cardiac opportunity in NY. Available in 2 weeks. Moving to intake.', now() - interval '72 days' - interval '19 hours'),
    ('f2000022-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Reached out to Luna Zabala on licensure: GA active, DEA current, ACLS good through next year. All clear for ob work.', now() - interval '22 days' - interval '8 hours'),
    ('f2000023-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Luna Zabala floated $212 per hour given the ob case acuity. Facility ceiling is $210. Narrowing the gap.', now() - interval '32 days' - interval '20 hours'),
    ('f2000024-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Opening presented to Luna Zabala: ob coverage in Savannah, GA. Rate $221/hr. Start window in 3 weeks. Luna Zabala said they''d review.', now() - interval '38 days' - interval '18 hours'),
    ('f2000025-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Luna Zabala clarified call schedule tolerance: happy to take call for the first 4 weeks, prefers no call after.', now() - interval '42 days' - interval '2 hours'),
    ('f2000026-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Luna Zabala shared block calendar — available for the next 60 days in GA. Prefers ob cases.', now() - interval '46 days' - interval '14 hours'),
    ('f2000027-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Opening presented to Luna Zabala: ob coverage in Savannah, GA. Rate $217/hr. Start window in 2 weeks. Luna Zabala said they''d review.', now() - interval '48 days' - interval '19 hours'),
    ('f2000028-0000-0000-0000-00000000000c', ws, 'e0000001-0000-0000-0000-000000000020', NULL, 'Luna Zabala floated $233 per hour given the ob case acuity. Facility ceiling is $210. Narrowing the gap.', now() - interval '56 days' - interval '15 hours'),
    ('f2000029-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-000000000022', NULL, 'Niko Brennan answered on CRNA supervision preference: open to either model, prefers 1:2 ratio.', now() - interval '5 days' - interval '21 hours'),
    ('f200002a-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-00000000002c', NULL, 'Niko Brennan availability window: in 8 weeks through October. IL primary, open to adjacent states.', now() - interval '13 days' - interval '21 hours'),
    ('f200002b-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-000000000022', NULL, 'Pitched Niko Brennan on the Cleveland pain assignment. 8-week block, $244 per hour. Niko Brennan is OH-licensed and open to the role.', now() - interval '36 days' - interval '0 hours'),
    ('f200002c-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-000000000022', NULL, 'Niko Brennan shared block calendar — available for the next 60 days in OH. Prefers pain cases.', now() - interval '53 days' - interval '4 hours'),
    ('f200002d-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-000000000033', NULL, 'Availability check-in with Niko Brennan: booked until in 4 weeks, then open for 6-10 weeks. pain preferred.', now() - interval '57 days' - interval '22 hours'),
    ('f200002e-0000-0000-0000-00000000000e', ws, 'e0000001-0000-0000-0000-000000000022', NULL, 'Confirmed with Niko Brennan: start date in 4 weeks, 12-week block, no overnights. Rate $258/hr.', now() - interval '75 days' - interval '21 hours'),
    ('f200002f-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-00000000002b', NULL, 'Requested Quinn Erikson''s most recent CV and privileging packet for the Cleveland ob role. Pending receipt.', now() - interval '15 days' - interval '11 hours'),
    ('f2000030-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-00000000002b', NULL, 'Confirmed with Quinn Erikson: start date in 3 weeks, 12-week block, no overnights. Rate $236/hr.', now() - interval '28 days' - interval '21 hours'),
    ('f2000031-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-000000000032', NULL, 'Quinn Erikson floated $230 per hour given the ob case acuity. Facility ceiling is $210. Narrowing the gap.', now() - interval '36 days' - interval '6 hours'),
    ('f2000032-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-000000000032', NULL, 'Quinn Erikson said yes to the Philadelphia ob block. Rate $235/hr acceptable. Credential packet next.', now() - interval '45 days' - interval '5 hours'),
    ('f2000033-0000-0000-0000-000000000011', ws, 'e0000001-0000-0000-0000-00000000002b', NULL, 'Quinn Erikson credential status update: state_csr renewal in flight for OH. Expected clear within 30 days.', now() - interval '62 days' - interval '16 hours'),
    ('f2000034-0000-0000-0000-000000000014', ws, 'e0000001-0000-0000-0000-00000000002f', NULL, 'Tariq Hart accepted $310/hr for cardiac block in OH. Scheduling in motion.', now() - interval '37 days' - interval '11 hours'),
    ('f2000035-0000-0000-0000-000000000014', ws, 'e0000001-0000-0000-0000-00000000002f', NULL, 'Tariq Hart shared block calendar — available for the next 60 days in OH. Prefers cardiac cases.', now() - interval '40 days' - interval '10 hours'),
    ('f2000036-0000-0000-0000-000000000014', ws, 'e0000001-0000-0000-0000-00000000002f', NULL, 'Tariq Hart said available immediately. Rate $279/hr, MI work.', now() - interval '46 days' - interval '11 hours'),
    ('f2000037-0000-0000-0000-000000000014', ws, 'e0000001-0000-0000-0000-00000000002f', NULL, 'Availability check-in with Tariq Hart: booked until in 8 weeks, then open for 6-10 weeks. cardiac preferred.', now() - interval '60 days' - interval '21 hours'),
    ('f2000038-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000008', NULL, 'Alex Morgan clarified call schedule tolerance: happy to take call for the first 4 weeks, prefers no call after.', now() - interval '1 days' - interval '13 hours'),
    ('f2000039-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Alex Morgan intro call: pitched the Houston cardiac block. Facility interested. Target rate band $260-$310 per hour. Available in TX.', now() - interval '2 days' - interval '7 hours'),
    ('f200003a-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000008', NULL, 'Credential check with Alex Morgan: board cert current. Target CO placement. Immunizations on file.', now() - interval '3 days' - interval '1 hours'),
    ('f200003b-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Alex Morgan scheduling update: blackout dates added for November. Available before and after. TX work only.', now() - interval '6 days' - interval '22 hours'),
    ('f200003c-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000008', NULL, 'Alex Morgan credential status update: state_csr renewal in flight for TX. Expected clear within 30 days.', now() - interval '8 days' - interval '23 hours'),
    ('f200003d-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Alex Morgan confirmed interest in the Dallas assignment. cardiac case mix is a strong fit. Ready to proceed.', now() - interval '9 days' - interval '4 hours'),
    ('f200003e-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000008', NULL, 'Requested Alex Morgan''s most recent CV and privileging packet for the Denver cardiac role. Pending receipt.', now() - interval '11 days' - interval '16 hours'),
    ('f200003f-0000-0000-0000-000000000001', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Opening presented to Alex Morgan: cardiac coverage in Aurora, CO. Rate $288/hr. Start window in 7 weeks. Alex Morgan said they''d review.', now() - interval '14 days' - interval '17 hours'),
    ('f2000040-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', NULL, 'Mira Abbas confirmed interest in the Boston assignment. pediatric case mix is a strong fit. Ready to proceed.', now() - interval '4 days' - interval '20 hours'),
    ('f2000041-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000027', NULL, 'Reached out to Mira Abbas on licensure: MA active, DEA current, ACLS good through next year. All clear for pediatric work.', now() - interval '5 days' - interval '18 hours'),
    ('f2000042-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', NULL, 'Schedule call with Mira Abbas — not available weekends, needs weekdays only. Target start in 8 weeks. 8-week block in Boston.', now() - interval '8 days' - interval '14 hours'),
    ('f2000043-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', NULL, 'Mira Abbas scheduling: prefers 7-on/7-off block. Available in 3 weeks. NY license current. Would start a 10-week commitment.', now() - interval '13 days' - interval '23 hours'),
    ('f2000044-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', NULL, 'Mira Abbas scheduling update: blackout dates added for June. Available before and after. MA work only.', now() - interval '14 days' - interval '2 hours'),
    ('f2000045-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', NULL, 'Mira Abbas confirmed interest in the Boston assignment. pediatric case mix is a strong fit. Ready to proceed.', now() - interval '15 days' - interval '4 hours'),
    ('f2000046-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000027', NULL, 'Requested Mira Abbas''s most recent CV and privileging packet for the Brooklyn pediatric role. Pending receipt.', now() - interval '16 days' - interval '18 hours'),
    ('f2000047-0000-0000-0000-00000000000d', ws, 'e0000001-0000-0000-0000-000000000034', NULL, 'Mira Abbas floated $258 per hour given the pediatric case acuity. Facility ceiling is $245. Narrowing the gap.', now() - interval '18 days' - interval '6 hours'),
    ('f2000048-0000-0000-0000-00000000000f', ws, 'e0000001-0000-0000-0000-000000000023', NULL, 'Opening presented to Omar Choi: general coverage in Springfield, IL. Rate $206/hr. Start window in 2 weeks. Omar Choi said they''d review.', now() - interval '2 days' - interval '20 hours'),
    ('f2000049-0000-0000-0000-00000000000f', ws, 'e0000001-0000-0000-0000-000000000023', NULL, 'Omar Choi scheduling update: blackout dates added for May. Available before and after. IL work only.', now() - interval '7 days' - interval '10 hours'),
    ('f200004a-0000-0000-0000-00000000000f', ws, 'e0000001-0000-0000-0000-000000000023', NULL, 'Omar Choi shared block calendar — available for the next 60 days in IL. Prefers general cases.', now() - interval '11 days' - interval '9 hours'),
    ('f200004b-0000-0000-0000-00000000000f', ws, 'e0000001-0000-0000-0000-000000000025', NULL, 'Omar Choi scheduling: prefers 7-on/7-off block. Available in 2 weeks. IL license current. Would start a 10-week commitment.', now() - interval '17 days' - interval '18 hours'),
    ('f200004c-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-00000000002e', NULL, 'Priya Delgado clarified rate expectations: $291/hr for cardiac, flexible on TN vs adjacent states.', now() - interval '4 days' - interval '8 hours'),
    ('f200004d-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-000000000029', NULL, 'Schedule call with Priya Delgado — not available weekends, needs weekdays only. Target start in 5 weeks. 8-week block in Memphis.', now() - interval '5 days' - interval '16 hours'),
    ('f200004e-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-000000000029', NULL, 'Rate conversation with Priya Delgado: pushed back on initial offer, countered at $265/hr. CMO reviewing. Target close this week.', now() - interval '7 days' - interval '7 hours'),
    ('f200004f-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-000000000029', NULL, 'Priya Delgado said yes to the Atlanta cardiac block. Rate $308/hr acceptable. Credential packet next.', now() - interval '8 days' - interval '8 hours'),
    ('f2000050-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-000000000029', NULL, 'Priya Delgado answered on CRNA supervision preference: open to either model, prefers 1:2 ratio.', now() - interval '9 days' - interval '15 hours'),
    ('f2000051-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-000000000029', NULL, 'Priya Delgado is excited about the cardiac opportunity in TN. Available in 8 weeks. Moving to intake.', now() - interval '11 days' - interval '9 hours'),
    ('f2000052-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-00000000002e', NULL, 'Priya Delgado intro call: pitched the Atlanta cardiac block. Facility interested. Target rate band $260-$310 per hour. Available in GA.', now() - interval '12 days' - interval '11 hours'),
    ('f2000053-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-00000000002e', NULL, 'Priya Delgado accepted $295/hr for cardiac block in GA. Scheduling in motion.', now() - interval '13 days' - interval '9 hours'),
    ('f2000054-0000-0000-0000-000000000010', ws, 'e0000001-0000-0000-0000-00000000002e', NULL, 'Priya Delgado availability window: in 5 weeks through September. GA primary, open to adjacent states.', now() - interval '20 days' - interval '22 hours'),
    ('f2000055-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-00000000000f', NULL, 'Sage Guzman clarified call schedule tolerance: happy to take call for the first 4 weeks, prefers no call after.', now() - interval '5 days' - interval '7 hours'),
    ('f2000056-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-000000000031', NULL, 'Schedule call with Sage Guzman — not available weekends, needs weekdays only. Target start in 2 weeks. 8-week block in Brooklyn.', now() - interval '6 days' - interval '2 hours'),
    ('f2000057-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-000000000031', NULL, 'Sage Guzman floated $267 per hour given the pain case acuity. Facility ceiling is $240. Narrowing the gap.', now() - interval '7 days' - interval '14 hours'),
    ('f2000058-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-00000000000f', NULL, 'Sage Guzman scheduling: prefers 7-on/7-off block. Available in 5 weeks. NY license current. Would start a 10-week commitment.', now() - interval '8 days' - interval '3 hours'),
    ('f2000059-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-00000000000f', NULL, 'Updated rate band: $240-$285/hr for Sage Guzman. Sage Guzman comfortable with $270/hr if we can lock pain cases only.', now() - interval '10 days' - interval '15 hours'),
    ('f200005a-0000-0000-0000-000000000013', ws, 'e0000001-0000-0000-0000-000000000031', NULL, 'Requested Sage Guzman''s most recent CV and privileging packet for the Brooklyn pain role. Pending receipt.', now() - interval '13 days' - interval '19 hours'),
    ('f200005b-0000-0000-0000-000000000009', ws, 'e0000001-0000-0000-0000-000000000007', NULL, 'Pitched Indra Wyatt on the Memphis pediatric assignment. 8-week block, $268 per hour. Indra Wyatt is TN-licensed and open to the role.', now() - interval '22 days' - interval '3 hours'),
    ('f200005c-0000-0000-0000-000000000012', ws, 'e0000001-0000-0000-0000-00000000002a', NULL, 'Pitched Ravi Fonseca on the Memphis general assignment. 8-week block, $220 per hour. Ravi Fonseca is TN-licensed and open to the role.', now() - interval '14 days' - interval '15 hours'),
    ('f200005d-0000-0000-0000-000000000018', ws, 'e0000001-0000-0000-0000-000000000024', NULL, 'Opening presented to Xian Lopez: pediatric coverage in Chicago, IL. Rate $281/hr. Start window in 8 weeks. Xian Lopez said they''d review.', now() - interval '30 days' - interval '12 hours'),
    ('f200005e-0000-0000-0000-00000000001a', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Requested Zoe Alvarado''s most recent CV and privileging packet for the Dallas cardiac role. Pending receipt.', now() - interval '13 days' - interval '14 hours'),
    ('f200005f-0000-0000-0000-00000000001a', ws, 'e0000001-0000-0000-0000-000000000001', NULL, 'Availability check-in with Zoe Alvarado: booked until in 7 weeks, then open for 6-10 weeks. cardiac preferred.', now() - interval '21 days' - interval '11 hours'),
    ('f2000060-0000-0000-0000-00000000001b', ws, 'e0000001-0000-0000-0000-000000000021', NULL, 'Ari Bello said yes to the Orlando ob block. Rate $218/hr acceptable. Credential packet next.', now() - interval '16 days' - interval '9 hours'),
    ('f2000061-0000-0000-0000-00000000001c', ws, 'e0000001-0000-0000-0000-000000000027', NULL, 'Bodhi Cho said no to the MA assignment — too far from home. Prefers West Coast work for the rest of the year.', now() - interval '12 days' - interval '17 hours'),
    ('f2000062-0000-0000-0000-00000000001c', ws, 'e0000001-0000-0000-0000-000000000027', NULL, 'First contact with Bodhi Cho — brief intro, sent credential form. pediatric experience, MA-licensed.', now() - interval '35 days' - interval '15 hours')
  ON CONFLICT (id) DO NOTHING;

  -- ─── outreach_messages across 12 months, email + sms ─────────────
  INSERT INTO outreach_messages (id, thread_id, workspace_id, channel, direction, template, body, sent_at, created_at) VALUES
    ('ab000001-0000-0000-0000-000000000005', 'aa100001-0000-0000-0000-000000000005', ws, 'email', 'out', 'coverage_offer', 'Hi Eli,\n\nQuick intro — I have a general anesthesia opening at Nashville Cardiac Institute in Nashville, TN. Rate $228/hr, start in 4 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '250 days' - interval '7 hours', now() - interval '250 days' - interval '7 hours'),
    ('ab000002-1000-0000-0000-000000000006', 'aa100001-0000-0000-0000-000000000006', ws, 'sms', 'out', 'declined', 'Quick ping on the Los Angeles cardiac offer — rate $282/hr, in 6 weeks start. Yes/no?', now() - interval '219 days' - interval '6 hours', now() - interval '219 days' - interval '6 hours'),
    ('ab000003-0000-0000-0000-000000000006', 'aa100001-0000-0000-0000-000000000006', ws, 'email', 'out', 'coverage_offer', 'Hey Farah,\n\nSan Diego Medical in San Diego is looking for cardiac anesthesia coverage. Rate band $260-$310 per hour. in 6 weeks start.\n\nLet me know.\nRevanth', now() - interval '251 days' - interval '23 hours', now() - interval '251 days' - interval '23 hours'),
    ('ab000004-0000-0000-0000-000000000015', 'aa100001-0000-0000-0000-000000000015', ws, 'email', 'out', 'cold_outreach', 'Hi Uma,\n\nI''m Revanth from Roster. Based on your anesthesia background, wanted to introduce a general opening in Buffalo, NY. Rate $215/hr.\n\nOpen to a quick chat?\n\nRevanth', now() - interval '270 days' - interval '6 hours', now() - interval '270 days' - interval '6 hours'),
    ('ab000005-0000-0000-0000-000000000015', 'aa100001-0000-0000-0000-000000000015', ws, 'email', 'out', 'declined', 'Hey Uma,\n\nManhattan Surgical Center in Manhattan is looking for general anesthesia coverage. Rate band $200-$235 per hour. in 5 weeks start.\n\nLet me know.\nRevanth', now() - interval '274 days' - interval '20 hours', now() - interval '274 days' - interval '20 hours'),
    ('ab000006-0000-0000-0000-000000000016', 'aa200001-0000-0000-0000-000000000016', ws, 'email', 'out', 'declined', 'Hi Vera — new ob coverage in CA. Los Angeles Pain Center, Los Angeles. 10-week block at $226/hr. Can you take this one?', now() - interval '260 days' - interval '6 hours', now() - interval '260 days' - interval '6 hours'),
    ('ab000007-0000-0000-0000-000000000016', 'aa100001-0000-0000-0000-000000000016', ws, 'email', 'out', 'cold_outreach', 'Hi Vera,\n\nI''m Revanth from Roster. Based on your anesthesia background, wanted to introduce a ob opening in Los Angeles, CA. Rate $218/hr.\n\nOpen to a quick chat?\n\nRevanth', now() - interval '325 days' - interval '23 hours', now() - interval '325 days' - interval '23 hours'),
    ('ab000008-1000-0000-0000-000000000003', 'aa100001-0000-0000-0000-000000000003', ws, 'sms', 'out', 'interest', 'Thanks Casey — forwarding paperwork now for the Denver block.', now() - interval '47 days' - interval '14 hours', now() - interval '47 days' - interval '14 hours'),
    ('ab000009-0000-0000-0000-000000000003', 'aa100001-0000-0000-0000-000000000003', ws, 'email', 'out', 'credential_ask', 'Casey, can you send your latest CV + privileging packet? TN license number + DEA too. Thanks.', now() - interval '155 days' - interval '21 hours', now() - interval '155 days' - interval '21 hours'),
    ('ab00000a-1000-0000-0000-000000000008', 'aa100001-0000-0000-0000-000000000008', ws, 'sms', 'out', 'coverage_offer', 'Hayden — urgent ob opening in Boulder at $244/hr. Can you take it?', now() - interval '50 days' - interval '7 hours', now() - interval '50 days' - interval '7 hours'),
    ('ab00000b-0000-0000-0000-000000000008', 'aa100001-0000-0000-0000-000000000008', ws, 'email', 'out', 'rate_negotiation', 'Hayden, we can offer $234/hr for ob. Below that we''d need to swap to a lower-acuity case mix.', now() - interval '61 days' - interval '13 hours', now() - interval '61 days' - interval '13 hours'),
    ('ab00000c-0000-0000-0000-000000000008', 'aa100001-0000-0000-0000-000000000008', ws, 'email', 'out', 'cold_outreach', 'Hi Hayden,\n\nI''m Revanth from Roster. Based on your anesthesia background, wanted to introduce a ob opening in Denver, CO. Rate $228/hr.\n\nOpen to a quick chat?\n\nRevanth', now() - interval '86 days' - interval '9 hours', now() - interval '86 days' - interval '9 hours'),
    ('ab00000d-0000-0000-0000-000000000008', 'aa100001-0000-0000-0000-000000000008', ws, 'email', 'out', 'availability', 'Hey Hayden,\n\nDenver General Hospital in Denver is looking for ob anesthesia coverage. Rate band $210-$245 per hour. in 4 weeks start.\n\nLet me know.\nRevanth', now() - interval '133 days' - interval '13 hours', now() - interval '133 days' - interval '13 hours'),
    ('ab00000e-0000-0000-0000-000000000017', 'aa100001-0000-0000-0000-000000000017', ws, 'email', 'out', 'availability', 'Hi Will,\n\nQuick intro — I have a general anesthesia opening at Boston Metro Hospital in Boston, MA. Rate $232/hr, start in 3 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '17 days' - interval '14 hours', now() - interval '17 days' - interval '14 hours'),
    ('ab00000f-0000-0000-0000-000000000017', 'aa100001-0000-0000-0000-000000000017', ws, 'email', 'out', 'scheduling', 'Will — confirming your schedule for the Philadelphia block. Start in 5 weeks, 7-on/7-off, no weekends. Rate $216/hr. Good?', now() - interval '91 days' - interval '23 hours', now() - interval '91 days' - interval '23 hours'),
    ('ab000010-0000-0000-0000-000000000017', 'aa100001-0000-0000-0000-000000000017', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Will. Noted general preference, MA only, weekdays. I''ll draft the schedule.', now() - interval '95 days' - interval '2 hours', now() - interval '95 days' - interval '2 hours'),
    ('ab000011-0000-0000-0000-000000000017', 'aa100001-0000-0000-0000-000000000017', ws, 'email', 'out', 'availability', 'Hi Will,\n\nQuick intro — I have a general anesthesia opening at Boston Metro Hospital in Boston, MA. Rate $234/hr, start in 8 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '132 days' - interval '17 hours', now() - interval '132 days' - interval '17 hours'),
    ('ab000012-0000-0000-0000-000000000019', 'aa100001-0000-0000-0000-000000000019', ws, 'email', 'out', 'declined', 'Hey Yael,\n\nPhoenix Desert Medical in Phoenix is looking for pain anesthesia coverage. Rate band $240-$285 per hour. in 8 weeks start.\n\nLet me know.\nRevanth', now() - interval '21 days' - interval '5 hours', now() - interval '21 days' - interval '5 hours'),
    ('ab000013-1000-0000-0000-000000000019', 'aa100001-0000-0000-0000-000000000019', ws, 'sms', 'out', 'cold_outreach', 'Hi Yael — CO pain opening still open. Need your yes to send paperwork.', now() - interval '54 days' - interval '12 hours', now() - interval '54 days' - interval '12 hours'),
    ('ab000014-0000-0000-0000-000000000019', 'aa100001-0000-0000-0000-000000000019', ws, 'email', 'out', 'declined', 'Hey Yael,\n\nAurora Regional in Aurora is looking for pain anesthesia coverage. Rate band $240-$285 per hour. in 6 weeks start.\n\nLet me know.\nRevanth', now() - interval '56 days' - interval '0 hours', now() - interval '56 days' - interval '0 hours'),
    ('ab000015-0000-0000-0000-000000000019', 'aa100001-0000-0000-0000-000000000019', ws, 'email', 'out', 'interest', 'Hi Yael — new pain coverage in CO. Aurora Regional, Aurora. 10-week block at $276/hr. Can you take this one?', now() - interval '75 days' - interval '23 hours', now() - interval '75 days' - interval '23 hours'),
    ('ab000016-0000-0000-0000-000000000019', 'aa100001-0000-0000-0000-000000000019', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Yael. Noted pain preference, WA only, weekdays. I''ll draft the schedule.', now() - interval '120 days' - interval '0 hours', now() - interval '120 days' - interval '0 hours'),
    ('ab000017-0000-0000-0000-000000000004', 'aa200001-0000-0000-0000-000000000004', ws, 'email', 'out', 'scheduling', 'Devin — confirming your schedule for the San Francisco block. Start in 8 weeks, 7-on/7-off, no weekends. Rate $253/hr. Good?', now() - interval '17 days' - interval '19 hours', now() - interval '17 days' - interval '19 hours'),
    ('ab000018-0000-0000-0000-000000000004', 'aa200001-0000-0000-0000-000000000004', ws, 'email', 'out', 'availability', 'Hi Devin — new pain coverage in CA. San Diego Medical, San Diego. 10-week block at $250/hr. Can you take this one?', now() - interval '23 days' - interval '14 hours', now() - interval '23 days' - interval '14 hours'),
    ('ab000019-1000-0000-0000-000000000004', 'aa200001-0000-0000-0000-000000000004', ws, 'sms', 'out', 'availability', 'Devin, following up on Seattle Children''s Hospital. Can we talk today?', now() - interval '25 days' - interval '2 hours', now() - interval '25 days' - interval '2 hours'),
    ('ab00001a-1000-0000-0000-000000000004', 'aa100001-0000-0000-0000-000000000004', ws, 'sms', 'out', 'coverage_offer', 'Hi Devin, last-min WA pain coverage. $284/hr, start in 5 weeks. Reply.', now() - interval '38 days' - interval '19 hours', now() - interval '38 days' - interval '19 hours'),
    ('ab00001b-0000-0000-0000-000000000004', 'aa100001-0000-0000-0000-000000000004', ws, 'email', 'out', 'coverage_offer', 'Hi Devin,\n\nQuick intro — I have a pain anesthesia opening at Los Angeles Pain Center in Los Angeles, CA. Rate $251/hr, start in 5 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '40 days' - interval '4 hours', now() - interval '40 days' - interval '4 hours'),
    ('ab00001c-0000-0000-0000-000000000004', 'aa200001-0000-0000-0000-000000000004', ws, 'email', 'out', 'credential_ask', 'Hi Devin — need your board cert copy + most recent ACLS card for the San Diego role. Rush please.', now() - interval '42 days' - interval '3 hours', now() - interval '42 days' - interval '3 hours'),
    ('ab00001d-0000-0000-0000-000000000004', 'aa100001-0000-0000-0000-000000000004', ws, 'email', 'out', 'declined', 'Hey Devin,\n\nSpokane Regional in Spokane is looking for pain anesthesia coverage. Rate band $240-$285 per hour. in 5 weeks start.\n\nLet me know.\nRevanth', now() - interval '49 days' - interval '5 hours', now() - interval '49 days' - interval '5 hours'),
    ('ab00001e-0000-0000-0000-000000000004', 'aa100001-0000-0000-0000-000000000004', ws, 'email', 'out', 'availability', 'Hi Devin,\n\nQuick intro — I have a pain anesthesia opening at SF General in San Francisco, CA. Rate $260/hr, start in 2 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '52 days' - interval '8 hours', now() - interval '52 days' - interval '8 hours'),
    ('ab00001f-0000-0000-0000-000000000004', 'aa100001-0000-0000-0000-000000000004', ws, 'email', 'out', 'interest', 'Hi Devin — new pain coverage in WA. Tacoma Memorial, Tacoma. 10-week block at $254/hr. Can you take this one?', now() - interval '65 days' - interval '17 hours', now() - interval '65 days' - interval '17 hours'),
    ('ab000020-1000-0000-0000-000000000007', 'aa100001-0000-0000-0000-000000000007', ws, 'sms', 'out', 'scheduling', 'Reminder: your Denver General Hospital block starts in 4 weeks. Any schedule concerns?', now() - interval '18 days' - interval '18 hours', now() - interval '18 days' - interval '18 hours'),
    ('ab000021-0000-0000-0000-000000000007', 'aa100001-0000-0000-0000-000000000007', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Grey. Noted general preference, CO only, weekdays. I''ll draft the schedule.', now() - interval '22 days' - interval '9 hours', now() - interval '22 days' - interval '9 hours'),
    ('ab000022-0000-0000-0000-000000000007', 'aa100001-0000-0000-0000-000000000007', ws, 'email', 'out', 'rate_negotiation', 'Hi Grey, understood on $222 per hour. Will take it to the facility and come back.', now() - interval '44 days' - interval '3 hours', now() - interval '44 days' - interval '3 hours'),
    ('ab000023-0000-0000-0000-000000000007', 'aa100001-0000-0000-0000-000000000007', ws, 'email', 'out', 'scheduling', 'Hi Grey, locking in your start: in 7 weeks. 8-week block in CO. Please confirm.', now() - interval '51 days' - interval '2 hours', now() - interval '51 days' - interval '2 hours'),
    ('ab000024-1000-0000-0000-000000000007', 'aa100001-0000-0000-0000-000000000007', ws, 'sms', 'out', 'credential_ask', 'Quick ping on the Aurora general offer — rate $215/hr, in 6 weeks start. Yes/no?', now() - interval '55 days' - interval '10 hours', now() - interval '55 days' - interval '10 hours'),
    ('ab000025-0000-0000-0000-000000000007', 'aa100001-0000-0000-0000-000000000007', ws, 'email', 'out', 'scheduling', 'Grey — confirming your schedule for the Houston block. Start in 7 weeks, 7-on/7-off, no weekends. Rate $214/hr. Good?', now() - interval '70 days' - interval '20 hours', now() - interval '70 days' - interval '20 hours'),
    ('ab000026-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'rate_negotiation', 'Hi Jules, understood on $270 per hour. Will take it to the facility and come back.', now() - interval '15 days' - interval '3 hours', now() - interval '15 days' - interval '3 hours'),
    ('ab000027-1000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'sms', 'out', 'rate_negotiation', 'Jules, following up on Tacoma Memorial. Can we talk today?', now() - interval '33 days' - interval '3 hours', now() - interval '33 days' - interval '3 hours'),
    ('ab000028-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'availability', 'Hi Jules,\n\nQuick intro — I have a pain anesthesia opening at Aurora Regional in Aurora, CO. Rate $246/hr, start in 6 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '35 days' - interval '1 hours', now() - interval '35 days' - interval '1 hours'),
    ('ab000029-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'rate_negotiation', 'Hi Jules, understood on $247 per hour. Will take it to the facility and come back.', now() - interval '40 days' - interval '15 hours', now() - interval '40 days' - interval '15 hours'),
    ('ab00002a-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'coverage_offer', 'Hi Jules,\n\nQuick intro — I have a pain anesthesia opening at Aurora Regional in Aurora, CO. Rate $245/hr, start in 2 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '43 days' - interval '18 hours', now() - interval '43 days' - interval '18 hours'),
    ('ab00002b-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'interest', 'Hi Jules — new pain coverage in CA. SF General, San Francisco. 10-week block at $268/hr. Can you take this one?', now() - interval '45 days' - interval '19 hours', now() - interval '45 days' - interval '19 hours'),
    ('ab00002c-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'coverage_offer', 'Hi Jules — new pain coverage in WA. Seattle Children''s Hospital, Seattle. 10-week block at $280/hr. Can you take this one?', now() - interval '46 days' - interval '9 hours', now() - interval '46 days' - interval '9 hours'),
    ('ab00002d-0000-0000-0000-00000000000a', 'aa100001-0000-0000-0000-00000000000a', ws, 'email', 'out', 'interest', 'Hi Jules,\n\nQuick intro — I have a pain anesthesia opening at Seattle Children''s Hospital in Seattle, WA. Rate $283/hr, start in 6 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '68 days' - interval '13 hours', now() - interval '68 days' - interval '13 hours'),
    ('ab00002e-1000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'sms', 'out', 'credential_ask', 'Quick ping on the Newark cardiac offer — rate $280/hr, in 4 weeks start. Yes/no?', now() - interval '12 days' - interval '21 hours', now() - interval '12 days' - interval '21 hours'),
    ('ab00002f-1000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'sms', 'out', 'coverage_offer', 'Hi Kai, last-min NJ cardiac coverage. $272/hr, start in 4 weeks. Reply.', now() - interval '14 days' - interval '16 hours', now() - interval '14 days' - interval '16 hours'),
    ('ab000030-0000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'email', 'out', 'coverage_offer', 'Hey Kai,\n\nBrooklyn General in Brooklyn is looking for cardiac anesthesia coverage. Rate band $260-$310 per hour. in 2 weeks start.\n\nLet me know.\nRevanth', now() - interval '21 days' - interval '20 hours', now() - interval '21 days' - interval '20 hours'),
    ('ab000031-1000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'sms', 'out', 'rate_negotiation', 'Kai, following up on Jersey City Medical. Can we talk today?', now() - interval '42 days' - interval '15 hours', now() - interval '42 days' - interval '15 hours'),
    ('ab000032-1000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'sms', 'out', 'credential_ask', 'Hi Kai — NJ cardiac opening still open. Need your yes to send paperwork.', now() - interval '53 days' - interval '14 hours', now() - interval '53 days' - interval '14 hours'),
    ('ab000033-1000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'sms', 'out', 'scheduling', 'Kai, confirming your Newark start on in 6 weeks. Reply YES to lock.', now() - interval '61 days' - interval '22 hours', now() - interval '61 days' - interval '22 hours'),
    ('ab000034-0000-0000-0000-00000000000b', 'aa100001-0000-0000-0000-00000000000b', ws, 'email', 'out', 'scheduling', 'Kai — confirming your schedule for the Jersey City block. Start in 7 weeks, 7-on/7-off, no weekends. Rate $280/hr. Good?', now() - interval '71 days' - interval '10 hours', now() - interval '71 days' - interval '10 hours'),
    ('ab000035-0000-0000-0000-00000000000c', 'aa100001-0000-0000-0000-00000000000c', ws, 'email', 'out', 'availability', 'Hi Luna,\n\nQuick intro — I have a ob anesthesia opening at Miami Women''s Hospital in Miami, FL. Rate $215/hr, start in 8 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '4 days' - interval '16 hours', now() - interval '4 days' - interval '16 hours'),
    ('ab000036-1000-0000-0000-00000000000c', 'aa100001-0000-0000-0000-00000000000c', ws, 'sms', 'out', 'coverage_offer', 'Hi Luna, last-min GA ob coverage. $226/hr, start in 8 weeks. Reply.', now() - interval '6 days' - interval '15 hours', now() - interval '6 days' - interval '15 hours'),
    ('ab000037-0000-0000-0000-00000000000c', 'aa100001-0000-0000-0000-00000000000c', ws, 'email', 'out', 'coverage_offer', 'Hey Luna,\n\nSavannah General in Savannah is looking for ob anesthesia coverage. Rate band $210-$245 per hour. in 8 weeks start.\n\nLet me know.\nRevanth', now() - interval '8 days' - interval '21 hours', now() - interval '8 days' - interval '21 hours'),
    ('ab000038-1000-0000-0000-00000000000c', 'aa100001-0000-0000-0000-00000000000c', ws, 'sms', 'out', 'coverage_offer', 'Hi Luna, last-min GA ob coverage. $228/hr, start in 8 weeks. Reply.', now() - interval '19 days' - interval '12 hours', now() - interval '19 days' - interval '12 hours'),
    ('ab000039-0000-0000-0000-00000000000c', 'aa100001-0000-0000-0000-00000000000c', ws, 'email', 'out', 'rate_negotiation', 'Hi Luna, understood on $228 per hour. Will take it to the facility and come back.', now() - interval '39 days' - interval '16 hours', now() - interval '39 days' - interval '16 hours'),
    ('ab00003a-1000-0000-0000-00000000000e', 'aa100001-0000-0000-0000-00000000000e', ws, 'sms', 'out', 'interest', 'Thanks Niko — forwarding paperwork now for the Springfield block.', now() - interval '28 days' - interval '2 hours', now() - interval '28 days' - interval '2 hours'),
    ('ab00003b-0000-0000-0000-00000000000e', 'aa200001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'credential_ask', 'Niko, can you send your latest CV + privileging packet? MI license number + DEA too. Thanks.', now() - interval '31 days' - interval '4 hours', now() - interval '31 days' - interval '4 hours'),
    ('ab00003c-0000-0000-0000-00000000000e', 'aa200001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Niko. Noted pain preference, MI only, weekdays. I''ll draft the schedule.', now() - interval '47 days' - interval '14 hours', now() - interval '47 days' - interval '14 hours'),
    ('ab00003d-0000-0000-0000-00000000000e', 'aa100001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'coverage_offer', 'Hi Niko — new pain coverage in OH. Cleveland Memorial Hospital, Cleveland. 10-week block at $245/hr. Can you take this one?', now() - interval '48 days' - interval '12 hours', now() - interval '48 days' - interval '12 hours'),
    ('ab00003e-0000-0000-0000-00000000000e', 'aa100001-0000-0000-0000-00000000000e', ws, 'email', 'out', 'rate_negotiation', 'Niko, we can offer $263/hr for pain. Below that we''d need to swap to a lower-acuity case mix.', now() - interval '63 days' - interval '13 hours', now() - interval '63 days' - interval '13 hours'),
    ('ab00003f-1000-0000-0000-00000000000e', 'aa200001-0000-0000-0000-00000000000e', ws, 'sms', 'out', 'coverage_offer', 'Niko — urgent pain opening in Grand Rapids at $248/hr. Can you take it?', now() - interval '68 days' - interval '2 hours', now() - interval '68 days' - interval '2 hours'),
    ('ab000040-1000-0000-0000-000000000011', 'aa200001-0000-0000-0000-000000000011', ws, 'sms', 'out', 'credential_ask', 'Quick ping on the Philadelphia ob offer — rate $221/hr, in 7 weeks start. Yes/no?', now() - interval '14 days' - interval '17 hours', now() - interval '14 days' - interval '17 hours'),
    ('ab000041-0000-0000-0000-000000000011', 'aa100001-0000-0000-0000-000000000011', ws, 'email', 'out', 'scheduling', 'Hi Quinn, locking in your start: in 3 weeks. 8-week block in PA. Please confirm.', now() - interval '20 days' - interval '12 hours', now() - interval '20 days' - interval '12 hours'),
    ('ab000042-0000-0000-0000-000000000011', 'aa100001-0000-0000-0000-000000000011', ws, 'email', 'out', 'rate_negotiation', 'Quinn, we can offer $224/hr for ob. Below that we''d need to swap to a lower-acuity case mix.', now() - interval '29 days' - interval '11 hours', now() - interval '29 days' - interval '11 hours'),
    ('ab000043-1000-0000-0000-000000000011', 'aa100001-0000-0000-0000-000000000011', ws, 'sms', 'out', 'interest', 'Thanks Quinn — forwarding paperwork now for the Pittsburgh block.', now() - interval '48 days' - interval '2 hours', now() - interval '48 days' - interval '2 hours'),
    ('ab000044-0000-0000-0000-000000000011', 'aa200001-0000-0000-0000-000000000011', ws, 'email', 'out', 'availability', 'Hey Quinn,\n\nColumbus Regional in Columbus is looking for ob anesthesia coverage. Rate band $210-$245 per hour. in 5 weeks start.\n\nLet me know.\nRevanth', now() - interval '55 days' - interval '19 hours', now() - interval '55 days' - interval '19 hours'),
    ('ab000045-0000-0000-0000-000000000011', 'aa100001-0000-0000-0000-000000000011', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Quinn. Noted ob preference, PA only, weekdays. I''ll draft the schedule.', now() - interval '64 days' - interval '16 hours', now() - interval '64 days' - interval '16 hours'),
    ('ab000046-0000-0000-0000-000000000011', 'aa200001-0000-0000-0000-000000000011', ws, 'email', 'out', 'availability', 'Hi Quinn — new ob coverage in OH. Cleveland Memorial Hospital, Cleveland. 10-week block at $241/hr. Can you take this one?', now() - interval '65 days' - interval '5 hours', now() - interval '65 days' - interval '5 hours'),
    ('ab000047-1000-0000-0000-000000000011', 'aa200001-0000-0000-0000-000000000011', ws, 'sms', 'out', 'interest', 'Thanks Quinn — forwarding paperwork now for the Philadelphia block.', now() - interval '71 days' - interval '21 hours', now() - interval '71 days' - interval '21 hours'),
    ('ab000048-0000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Tariq. Noted cardiac preference, OH only, weekdays. I''ll draft the schedule.', now() - interval '5 days' - interval '2 hours', now() - interval '5 days' - interval '2 hours'),
    ('ab000049-1000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'sms', 'out', 'interest', 'Thanks Tariq — forwarding paperwork now for the Columbus block.', now() - interval '8 days' - interval '14 hours', now() - interval '8 days' - interval '14 hours'),
    ('ab00004a-1000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'sms', 'out', 'coverage_offer', 'Tariq — urgent cardiac opening in Detroit at $305/hr. Can you take it?', now() - interval '10 days' - interval '10 hours', now() - interval '10 days' - interval '10 hours'),
    ('ab00004b-0000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'email', 'out', 'credential_ask', 'Tariq, can you send your latest CV + privileging packet? OH license number + DEA too. Thanks.', now() - interval '48 days' - interval '4 hours', now() - interval '48 days' - interval '4 hours'),
    ('ab00004c-1000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'sms', 'out', 'declined', 'Hi Tariq — MI cardiac opening still open. Need your yes to send paperwork.', now() - interval '58 days' - interval '10 hours', now() - interval '58 days' - interval '10 hours'),
    ('ab00004d-0000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'email', 'out', 'scheduling', 'Tariq — confirming your schedule for the Columbus block. Start in 3 weeks, 7-on/7-off, no weekends. Rate $308/hr. Good?', now() - interval '65 days' - interval '23 hours', now() - interval '65 days' - interval '23 hours'),
    ('ab00004e-1000-0000-0000-000000000014', 'aa100001-0000-0000-0000-000000000014', ws, 'sms', 'out', 'availability', 'Hi Tariq — OH cardiac opening still open. Need your yes to send paperwork.', now() - interval '75 days' - interval '9 hours', now() - interval '75 days' - interval '9 hours'),
    ('ab00004f-1000-0000-0000-000000000001', 'aa100001-0000-0000-0000-000000000001', ws, 'sms', 'out', 'interest', 'Thanks Alex — forwarding paperwork now for the Houston block.', now() - interval '4 days' - interval '6 hours', now() - interval '4 days' - interval '6 hours'),
    ('ab000050-0000-0000-0000-000000000001', 'aa100001-0000-0000-0000-000000000001', ws, 'email', 'out', 'interest', 'Hi Alex,\n\nQuick intro — I have a cardiac anesthesia opening at Houston General Hospital in Houston, TX. Rate $298/hr, start in 2 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '5 days' - interval '13 hours', now() - interval '5 days' - interval '13 hours'),
    ('ab000051-1000-0000-0000-000000000001', 'aa200001-0000-0000-0000-000000000001', ws, 'sms', 'out', 'coverage_offer', 'Alex — urgent cardiac opening in Aurora at $262/hr. Can you take it?', now() - interval '7 days' - interval '16 hours', now() - interval '7 days' - interval '16 hours'),
    ('ab000052-0000-0000-0000-000000000001', 'aa200001-0000-0000-0000-000000000001', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Alex. Noted cardiac preference, CO only, weekdays. I''ll draft the schedule.', now() - interval '10 days' - interval '2 hours', now() - interval '10 days' - interval '2 hours'),
    ('ab000053-1000-0000-0000-000000000001', 'aa100001-0000-0000-0000-000000000001', ws, 'sms', 'out', 'rate_negotiation', 'Quick ping on the Aurora cardiac offer — rate $285/hr, in 5 weeks start. Yes/no?', now() - interval '12 days' - interval '1 hours', now() - interval '12 days' - interval '1 hours'),
    ('ab000054-0000-0000-0000-000000000001', 'aa100001-0000-0000-0000-000000000001', ws, 'email', 'out', 'scheduling', 'Hi Alex, locking in your start: in 5 weeks. 8-week block in TX. Please confirm.', now() - interval '13 days' - interval '15 hours', now() - interval '13 days' - interval '15 hours'),
    ('ab000055-0000-0000-0000-000000000001', 'aa200001-0000-0000-0000-000000000001', ws, 'email', 'out', 'scheduling', 'Hi Alex, locking in your start: in 2 weeks. 8-week block in CO. Please confirm.', now() - interval '16 days' - interval '22 hours', now() - interval '16 days' - interval '22 hours'),
    ('ab000056-0000-0000-0000-000000000001', 'aa100001-0000-0000-0000-000000000001', ws, 'email', 'out', 'availability', 'Hi Alex,\n\nQuick intro — I have a cardiac anesthesia opening at Austin Medical Center in Austin, TX. Rate $298/hr, start in 2 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '17 days' - interval '11 hours', now() - interval '17 days' - interval '11 hours'),
    ('ab000057-0000-0000-0000-000000000001', 'aa200001-0000-0000-0000-000000000001', ws, 'email', 'out', 'scheduling', 'Hi Alex, locking in your start: in 4 weeks. 8-week block in TX. Please confirm.', now() - interval '18 days' - interval '7 hours', now() - interval '18 days' - interval '7 hours'),
    ('ab000058-0000-0000-0000-000000000001', 'aa100001-0000-0000-0000-000000000001', ws, 'email', 'out', 'interest', 'Hey Alex,\n\nBoulder Medical in Boulder is looking for cardiac anesthesia coverage. Rate band $260-$310 per hour. in 2 weeks start.\n\nLet me know.\nRevanth', now() - interval '19 days' - interval '2 hours', now() - interval '19 days' - interval '2 hours'),
    ('ab000059-0000-0000-0000-000000000001', 'aa200001-0000-0000-0000-000000000001', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Alex. Noted cardiac preference, CO only, weekdays. I''ll draft the schedule.', now() - interval '20 days' - interval '15 hours', now() - interval '20 days' - interval '15 hours'),
    ('ab00005a-1000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'coverage_offer', 'Hi Mira, last-min MA pediatric coverage. $274/hr, start in 4 weeks. Reply.', now() - interval '1 days' - interval '13 hours', now() - interval '1 days' - interval '13 hours'),
    ('ab00005b-0000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'question_answered', 'Thanks for confirming, Mira. Noted pediatric preference, MA only, weekdays. I''ll draft the schedule.', now() - interval '3 days' - interval '4 hours', now() - interval '3 days' - interval '4 hours'),
    ('ab00005c-1000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'interest', 'Thanks Mira — forwarding paperwork now for the Cambridge block.', now() - interval '3 days' - interval '11 hours', now() - interval '3 days' - interval '11 hours'),
    ('ab00005d-1000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'interest', 'Thanks Mira — forwarding paperwork now for the Manhattan block.', now() - interval '5 days' - interval '15 hours', now() - interval '5 days' - interval '15 hours'),
    ('ab00005e-0000-0000-0000-00000000000d', 'aa200001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'scheduling', 'Mira — confirming your schedule for the Buffalo block. Start in 8 weeks, 7-on/7-off, no weekends. Rate $254/hr. Good?', now() - interval '7 days' - interval '5 hours', now() - interval '7 days' - interval '5 hours'),
    ('ab00005f-1000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'scheduling', 'Reminder: your Cambridge Medical block starts in 2 weeks. Any schedule concerns?', now() - interval '8 days' - interval '23 hours', now() - interval '8 days' - interval '23 hours'),
    ('ab000060-1000-0000-0000-00000000000d', 'aa200001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'question_answered', 'Mira, following up on Manhattan Surgical Center. Can we talk today?', now() - interval '10 days' - interval '7 hours', now() - interval '10 days' - interval '7 hours'),
    ('ab000061-0000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'coverage_offer', 'Hey Mira,\n\nManhattan Surgical Center in Manhattan is looking for pediatric anesthesia coverage. Rate band $245-$285 per hour. in 4 weeks start.\n\nLet me know.\nRevanth', now() - interval '12 days' - interval '9 hours', now() - interval '12 days' - interval '9 hours'),
    ('ab000062-0000-0000-0000-00000000000d', 'aa200001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'credential_ask', 'Hi Mira — need your board cert copy + most recent ACLS card for the Buffalo role. Rush please.', now() - interval '12 days' - interval '9 hours', now() - interval '12 days' - interval '9 hours'),
    ('ab000063-0000-0000-0000-00000000000d', 'aa200001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'interest', 'Hi Mira — new pediatric coverage in MA. Cambridge Medical, Cambridge. 10-week block at $284/hr. Can you take this one?', now() - interval '16 days' - interval '16 hours', now() - interval '16 days' - interval '16 hours'),
    ('ab000064-0000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'credential_ask', 'Mira, can you send your latest CV + privileging packet? NY license number + DEA too. Thanks.', now() - interval '17 days' - interval '13 hours', now() - interval '17 days' - interval '13 hours'),
    ('ab000065-0000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'interest', 'Hi Mira — new pediatric coverage in NY. Manhattan Surgical Center, Manhattan. 10-week block at $260/hr. Can you take this one?', now() - interval '17 days' - interval '18 hours', now() - interval '17 days' - interval '18 hours'),
    ('ab000066-0000-0000-0000-00000000000d', 'aa100001-0000-0000-0000-00000000000d', ws, 'email', 'out', 'availability', 'Hi Mira — new pediatric coverage in MA. Cambridge Medical, Cambridge. 10-week block at $275/hr. Can you take this one?', now() - interval '18 days' - interval '23 hours', now() - interval '18 days' - interval '23 hours'),
    ('ab000067-1000-0000-0000-00000000000d', 'aa200001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'scheduling', 'Reminder: your Buffalo Medical block starts in 3 weeks. Any schedule concerns?', now() - interval '19 days' - interval '14 hours', now() - interval '19 days' - interval '14 hours'),
    ('ab000068-1000-0000-0000-00000000000d', 'aa200001-0000-0000-0000-00000000000d', ws, 'sms', 'out', 'question_answered', 'Mira, following up on Cambridge Medical. Can we talk today?', now() - interval '20 days' - interval '7 hours', now() - interval '20 days' - interval '7 hours'),
    ('ab000069-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'coverage_offer', 'Hi Omar — new general coverage in IL. Chicago West Hospital, Chicago. 10-week block at $215/hr. Can you take this one?', now() - interval '1 days' - interval '17 hours', now() - interval '1 days' - interval '17 hours'),
    ('ab00006a-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'credential_ask', 'Hi Omar — need your board cert copy + most recent ACLS card for the Boulder role. Rush please.', now() - interval '3 days' - interval '13 hours', now() - interval '3 days' - interval '13 hours'),
    ('ab00006b-0000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'rate_negotiation', 'Hi Omar, understood on $211 per hour. Will take it to the facility and come back.', now() - interval '4 days' - interval '2 hours', now() - interval '4 days' - interval '2 hours'),
    ('ab00006c-1000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'sms', 'out', 'question_answered', 'Omar, following up on Phoenix Desert Medical. Can we talk today?', now() - interval '5 days' - interval '5 hours', now() - interval '5 days' - interval '5 hours'),
    ('ab00006d-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'interest', 'Hi Omar — new general coverage in CO. Denver General Hospital, Denver. 10-week block at $232/hr. Can you take this one?', now() - interval '6 days' - interval '9 hours', now() - interval '6 days' - interval '9 hours'),
    ('ab00006e-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'interest', 'Hey Omar,\n\nBoulder Medical in Boulder is looking for general anesthesia coverage. Rate band $200-$235 per hour. in 5 weeks start.\n\nLet me know.\nRevanth', now() - interval '8 days' - interval '5 hours', now() - interval '8 days' - interval '5 hours'),
    ('ab00006f-1000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'sms', 'out', 'scheduling', 'Omar, confirming your Tucson start on in 5 weeks. Reply YES to lock.', now() - interval '9 days' - interval '5 hours', now() - interval '9 days' - interval '5 hours'),
    ('ab000070-0000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'interest', 'Hey Omar,\n\nSpringfield General in Springfield is looking for general anesthesia coverage. Rate band $200-$235 per hour. in 7 weeks start.\n\nLet me know.\nRevanth', now() - interval '10 days' - interval '9 hours', now() - interval '10 days' - interval '9 hours'),
    ('ab000071-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'scheduling', 'Hi Omar, locking in your start: in 8 weeks. 8-week block in CO. Please confirm.', now() - interval '12 days' - interval '4 hours', now() - interval '12 days' - interval '4 hours'),
    ('ab000072-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'interest', 'Hi Omar,\n\nQuick intro — I have a general anesthesia opening at Springfield General in Springfield, IL. Rate $233/hr, start in 2 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '13 days' - interval '7 hours', now() - interval '13 days' - interval '7 hours'),
    ('ab000073-1000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'sms', 'out', 'question_answered', 'Hi Omar — IL general opening still open. Need your yes to send paperwork.', now() - interval '14 days' - interval '1 hours', now() - interval '14 days' - interval '1 hours'),
    ('ab000074-0000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'availability', 'Hey Omar,\n\nTucson Regional in Tucson is looking for general anesthesia coverage. Rate band $200-$235 per hour. in 3 weeks start.\n\nLet me know.\nRevanth', now() - interval '15 days' - interval '3 hours', now() - interval '15 days' - interval '3 hours'),
    ('ab000075-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'interest', 'Hi Omar — new general coverage in CO. Boulder Medical, Boulder. 10-week block at $201/hr. Can you take this one?', now() - interval '16 days' - interval '14 hours', now() - interval '16 days' - interval '14 hours'),
    ('ab000076-0000-0000-0000-00000000000f', 'aa200001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'availability', 'Hi Omar — new general coverage in IL. Springfield General, Springfield. 10-week block at $223/hr. Can you take this one?', now() - interval '18 days' - interval '5 hours', now() - interval '18 days' - interval '5 hours'),
    ('ab000077-0000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'email', 'out', 'interest', 'Hi Omar — new general coverage in AZ. Tucson Regional, Tucson. 10-week block at $207/hr. Can you take this one?', now() - interval '19 days' - interval '2 hours', now() - interval '19 days' - interval '2 hours'),
    ('ab000078-1000-0000-0000-00000000000f', 'aa100001-0000-0000-0000-00000000000f', ws, 'sms', 'out', 'credential_ask', 'Quick ping on the Aurora general offer — rate $234/hr, in 6 weeks start. Yes/no?', now() - interval '20 days' - interval '23 hours', now() - interval '20 days' - interval '23 hours'),
    ('ab000079-0000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'email', 'out', 'scheduling', 'Priya — confirming your schedule for the Atlanta block. Start in 4 weeks, 7-on/7-off, no weekends. Rate $268/hr. Good?', now() - interval '1 days' - interval '7 hours', now() - interval '1 days' - interval '7 hours'),
    ('ab00007a-0000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'email', 'out', 'availability', 'Hey Priya,\n\nSavannah General in Savannah is looking for cardiac anesthesia coverage. Rate band $260-$310 per hour. in 3 weeks start.\n\nLet me know.\nRevanth', now() - interval '2 days' - interval '18 hours', now() - interval '2 days' - interval '18 hours'),
    ('ab00007b-1000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'sms', 'out', 'coverage_offer', 'Hi Priya, last-min GA cardiac coverage. $286/hr, start in 6 weeks. Reply.', now() - interval '6 days' - interval '9 hours', now() - interval '6 days' - interval '9 hours'),
    ('ab00007c-0000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'email', 'out', 'rate_negotiation', 'Hi Priya, understood on $284 per hour. Will take it to the facility and come back.', now() - interval '10 days' - interval '22 hours', now() - interval '10 days' - interval '22 hours'),
    ('ab00007d-1000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'sms', 'out', 'interest', 'Thanks Priya — forwarding paperwork now for the Nashville block.', now() - interval '14 days' - interval '15 hours', now() - interval '14 days' - interval '15 hours'),
    ('ab00007e-1000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'sms', 'out', 'interest', 'Thanks Priya — forwarding paperwork now for the Atlanta block.', now() - interval '15 days' - interval '5 hours', now() - interval '15 days' - interval '5 hours'),
    ('ab00007f-1000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'sms', 'out', 'rate_negotiation', 'Hi Priya — GA cardiac opening still open. Need your yes to send paperwork.', now() - interval '16 days' - interval '4 hours', now() - interval '16 days' - interval '4 hours'),
    ('ab000080-0000-0000-0000-000000000010', 'aa200001-0000-0000-0000-000000000010', ws, 'email', 'out', 'coverage_offer', 'Hi Priya — new cardiac coverage in TN. Nashville Cardiac Institute, Nashville. 10-week block at $261/hr. Can you take this one?', now() - interval '17 days' - interval '21 hours', now() - interval '17 days' - interval '21 hours'),
    ('ab000081-0000-0000-0000-000000000010', 'aa100001-0000-0000-0000-000000000010', ws, 'email', 'out', 'availability', 'Hey Priya,\n\nAtlanta Heart Center in Atlanta is looking for cardiac anesthesia coverage. Rate band $260-$310 per hour. in 3 weeks start.\n\nLet me know.\nRevanth', now() - interval '18 days' - interval '0 hours', now() - interval '18 days' - interval '0 hours'),
    ('ab000082-0000-0000-0000-000000000010', 'aa100001-0000-0000-0000-000000000010', ws, 'email', 'out', 'credential_ask', 'Hi Priya — need your board cert copy + most recent ACLS card for the Nashville role. Rush please.', now() - interval '19 days' - interval '19 hours', now() - interval '19 days' - interval '19 hours'),
    ('ab000083-1000-0000-0000-000000000013', 'aa100001-0000-0000-0000-000000000013', ws, 'sms', 'out', 'availability', 'Sage, following up on Philadelphia Children''s East. Can we talk today?', now() - interval '1 days' - interval '1 hours', now() - interval '1 days' - interval '1 hours'),
    ('ab000084-1000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'sms', 'out', 'question_answered', 'Sage, following up on Philadelphia Children''s East. Can we talk today?', now() - interval '2 days' - interval '22 hours', now() - interval '2 days' - interval '22 hours'),
    ('ab000085-0000-0000-0000-000000000013', 'aa100001-0000-0000-0000-000000000013', ws, 'email', 'out', 'coverage_offer', 'Hi Sage — new pain coverage in PA. Pittsburgh Memorial, Pittsburgh. 10-week block at $243/hr. Can you take this one?', now() - interval '3 days' - interval '12 hours', now() - interval '3 days' - interval '12 hours'),
    ('ab000086-0000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'email', 'out', 'interest', 'Hi Sage — new pain coverage in NY. Brooklyn General, Brooklyn. 10-week block at $241/hr. Can you take this one?', now() - interval '4 days' - interval '10 hours', now() - interval '4 days' - interval '10 hours'),
    ('ab000087-1000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'sms', 'out', 'question_answered', 'Hi Sage — PA pain opening still open. Need your yes to send paperwork.', now() - interval '9 days' - interval '23 hours', now() - interval '9 days' - interval '23 hours'),
    ('ab000088-0000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'email', 'out', 'interest', 'Hi Sage,\n\nQuick intro — I have a pain anesthesia opening at Manhattan Surgical Center in Manhattan, NY. Rate $248/hr, start in 2 weeks. Interested?\n\nThanks,\nRevanth', now() - interval '11 days' - interval '23 hours', now() - interval '11 days' - interval '23 hours'),
    ('ab000089-1000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'sms', 'out', 'rate_negotiation', 'Sage, following up on Pittsburgh Memorial. Can we talk today?', now() - interval '14 days' - interval '19 hours', now() - interval '14 days' - interval '19 hours'),
    ('ab00008a-0000-0000-0000-000000000013', 'aa100001-0000-0000-0000-000000000013', ws, 'email', 'out', 'rate_negotiation', 'Sage, we can offer $247/hr for pain. Below that we''d need to swap to a lower-acuity case mix.', now() - interval '15 days' - interval '18 hours', now() - interval '15 days' - interval '18 hours'),
    ('ab00008b-0000-0000-0000-000000000013', 'aa100001-0000-0000-0000-000000000013', ws, 'email', 'out', 'coverage_offer', 'Hi Sage — new pain coverage in NY. Buffalo Medical, Buffalo. 10-week block at $253/hr. Can you take this one?', now() - interval '16 days' - interval '21 hours', now() - interval '16 days' - interval '21 hours'),
    ('ab00008c-0000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'email', 'out', 'coverage_offer', 'Hey Sage,\n\nPittsburgh Memorial in Pittsburgh is looking for pain anesthesia coverage. Rate band $240-$285 per hour. in 7 weeks start.\n\nLet me know.\nRevanth', now() - interval '17 days' - interval '13 hours', now() - interval '17 days' - interval '13 hours'),
    ('ab00008d-0000-0000-0000-000000000013', 'aa200001-0000-0000-0000-000000000013', ws, 'email', 'out', 'interest', 'Hi Sage — new pain coverage in NY. Buffalo Medical, Buffalo. 10-week block at $272/hr. Can you take this one?', now() - interval '19 days' - interval '2 hours', now() - interval '19 days' - interval '2 hours'),
    ('ab00008e-1000-0000-0000-000000000013', 'aa100001-0000-0000-0000-000000000013', ws, 'sms', 'out', 'interest', 'Thanks Sage — forwarding paperwork now for the Philadelphia block.', now() - interval '20 days' - interval '22 hours', now() - interval '20 days' - interval '22 hours'),
    ('ab00008f-1000-0000-0000-000000000009', 'aa100001-0000-0000-0000-000000000009', ws, 'sms', 'out', 'availability', 'Indra, following up on Austin Medical Center. Can we talk today?', now() - interval '28 days' - interval '11 hours', now() - interval '28 days' - interval '11 hours'),
    ('ab000090-1000-0000-0000-000000000012', 'aa200001-0000-0000-0000-000000000012', ws, 'sms', 'out', 'credential_ask', 'Hi Ravi — TN general opening still open. Need your yes to send paperwork.', now() - interval '34 days' - interval '0 hours', now() - interval '34 days' - interval '0 hours'),
    ('ab000091-0000-0000-0000-000000000018', 'aa100001-0000-0000-0000-000000000018', ws, 'email', 'out', 'coverage_offer', 'Hi Xian — new pediatric coverage in GA. Savannah General, Savannah. 10-week block at $246/hr. Can you take this one?', now() - interval '15 days' - interval '12 hours', now() - interval '15 days' - interval '12 hours')
  ON CONFLICT (id) DO NOTHING;

  -- ─── enforce engagement-tier timing on pre-existing base rows ────
  -- The base seed's case_notes / outreach_messages are all dated
  -- "now() - interval 'N days'" with N < 14, which pulls the dormant
  -- and cooling providers' most-recent timestamps into the current
  -- month. Shift the base rows for those providers deterministically
  -- so the tier labels hold (idempotent — repeated runs end at the
  -- same offsets because we pivot off the row id's hash).
  --
  -- Target providers are identified by their case's `cases.provider_id`
  -- matching the dormant/cooling set.

  -- Dormant providers → shift any created_at within the last 120d back
  -- so most recent is 6-12 months ago.
  WITH dormant_pids(provider_id) AS (
    SELECT id FROM providers WHERE email IN (
      'eli.sato@signal-seed.test',
      'farah.taylor@signal-seed.test',
      'uma.ibrahim@signal-seed.test',
      'vera.juarez@signal-seed.test'
    )
  ),
  dormant_cases AS (SELECT id FROM cases WHERE provider_id IN (SELECT provider_id FROM dormant_pids))
  UPDATE case_notes cn
  SET created_at = now()
                    - interval '180 days'
                    - (interval '1 day' * (abs(hashtext(cn.id::text)) % 180))
  WHERE cn.case_id IN (SELECT id FROM dormant_cases)
    AND cn.created_at > now() - interval '120 days';

  WITH dormant_pids(provider_id) AS (
    SELECT id FROM providers WHERE email IN (
      'eli.sato@signal-seed.test',
      'farah.taylor@signal-seed.test',
      'uma.ibrahim@signal-seed.test',
      'vera.juarez@signal-seed.test'
    )
  ),
  dormant_threads AS (
    SELECT ot.id FROM outreach_threads ot
    JOIN cases c ON c.id = ot.case_id
    WHERE c.provider_id IN (SELECT provider_id FROM dormant_pids)
  )
  UPDATE outreach_messages om
  SET sent_at    = now() - interval '180 days' - (interval '1 day' * (abs(hashtext(om.id::text)) % 180)),
      created_at = now() - interval '180 days' - (interval '1 day' * (abs(hashtext(om.id::text)) % 180))
  WHERE om.thread_id IN (SELECT id FROM dormant_threads)
    AND om.sent_at > now() - interval '120 days';

  -- Cooling providers → shift any created_at within the last 14d back
  -- so most recent is 15-60 days ago (keeps the historical trail older).
  WITH cooling_pids(provider_id) AS (
    SELECT id FROM providers WHERE email IN (
      'blair.nguyen@signal-seed.test',
      'casey.patel@signal-seed.test',
      'hayden.vasquez@signal-seed.test',
      'will.khan@signal-seed.test',
      'yael.monroe@signal-seed.test'
    )
  ),
  cooling_cases AS (SELECT id FROM cases WHERE provider_id IN (SELECT provider_id FROM cooling_pids))
  UPDATE case_notes cn
  SET created_at = now()
                    - interval '20 days'
                    - (interval '1 day' * (abs(hashtext(cn.id::text)) % 40))
  WHERE cn.case_id IN (SELECT id FROM cooling_cases)
    AND cn.created_at > now() - interval '14 days';

  WITH cooling_pids(provider_id) AS (
    SELECT id FROM providers WHERE email IN (
      'blair.nguyen@signal-seed.test',
      'casey.patel@signal-seed.test',
      'hayden.vasquez@signal-seed.test',
      'will.khan@signal-seed.test',
      'yael.monroe@signal-seed.test'
    )
  ),
  cooling_threads AS (
    SELECT ot.id FROM outreach_threads ot
    JOIN cases c ON c.id = ot.case_id
    WHERE c.provider_id IN (SELECT provider_id FROM cooling_pids)
  )
  UPDATE outreach_messages om
  SET sent_at    = now() - interval '20 days' - (interval '1 day' * (abs(hashtext(om.id::text)) % 40)),
      created_at = now() - interval '20 days' - (interval '1 day' * (abs(hashtext(om.id::text)) % 40))
  WHERE om.thread_id IN (SELECT id FROM cooling_threads)
    AND om.sent_at > now() - interval '14 days';

END $$;

COMMIT;

