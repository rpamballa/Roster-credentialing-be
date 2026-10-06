-- Allow a third kind of marketing lead: `trial`, used by the Provider
-- Simulation Trial landing page (/trial on the marketing site). Fields
-- reuse the existing columns:
--   - email, fullName, agency are populated the same way
--   - the applicant's primary specialty lands in the `role` column
--     (semantically it's "what they practice") so no new column is needed
--   - notes land in `free_text`
--
-- The constraint was unnamed in migration 0008 (inline table-level CHECK),
-- so Postgres auto-named it. We drop by that generated name, then re-add
-- an explicit named constraint covering the full enum.

ALTER TABLE marketing_leads
  DROP CONSTRAINT marketing_leads_kind_check;

ALTER TABLE marketing_leads
  ADD CONSTRAINT marketing_leads_kind_check
  CHECK (kind IN ('beta', 'demo', 'trial'));
