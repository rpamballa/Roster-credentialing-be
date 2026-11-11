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
    ('c0000001-0000-0000-0000-000000000019', '1700000025', 'Yael',     'Monroe',     'yael.monroe@signal-seed.test',     '720-555-0125', ARRAY['anesthesiology','pain'],       ARRAY['CO','WA','AZ'])
  ON CONFLICT (id) DO UPDATE SET
    first_name      = EXCLUDED.first_name,
    last_name       = EXCLUDED.last_name,
    email           = EXCLUDED.email,
    phone           = EXCLUDED.phone,
    specialties     = EXCLUDED.specialties,
    states_licensed = EXCLUDED.states_licensed;

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
    ('d0000001-0000-0000-0000-000000000199', ws, 'c0000001-0000-0000-0000-000000000019', 'state_csr',        'manual', 'AZ', 'CSR-AZ-025',  'active',   now())
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
    -- Atlanta GA — cardiac + general (compact)
    ('e0000001-0000-0000-0000-000000000029', ws, 'c0000001-0000-0000-0000-000000000010', 'b0000001-0000-0000-0000-00000000000b', '1', 'cardiac',   'initial_appointment', 'intake',      now() - interval '4 days',  CURRENT_DATE + 14, '[]'::jsonb),
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
      now() - interval '1 day')
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
