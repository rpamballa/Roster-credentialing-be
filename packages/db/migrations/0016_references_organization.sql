-- 0016_references_organization.sql
--
-- Promote references.response_fields->>'organization' to a first-class
-- column. It's captured on the reference form (POST /v1/cases/:id/references)
-- but was buried in the JSONB response_fields, forcing the caseDetail
-- resolver to reach into the blob. That's fine for a rare field, but
-- organization renders on every reference row in the cockpit review
-- table, so a plain column is cleaner (indexable, typed, obvious).
--
-- Backfill: copy existing values from response_fields->>'organization'.
-- New rows write to both column and JSONB during the transition to
-- keep the old resolver fallback working; a follow-up PR can drop the
-- JSONB duplicate once every writer is migrated.

BEGIN;

ALTER TABLE "references"
  ADD COLUMN IF NOT EXISTS organization text;

UPDATE "references"
   SET organization = (response_fields->>'organization')
 WHERE organization IS NULL
   AND response_fields ? 'organization';

COMMIT;
