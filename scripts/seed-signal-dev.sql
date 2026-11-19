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
