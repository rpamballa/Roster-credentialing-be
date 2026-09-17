-- Persist per-field review marks on facility profiles. The cockpit's
-- review screen lets an admin tap "Mark reviewed" on each row; those
-- marks used to live in React state and vanished on navigate-away.
--
-- The column holds the keys of already-reviewed fields (e.g. "doc_medical_license_0",
-- "ver_state_license_0", "att_provider_2"). Absent from this array
-- means "still needs review". Full-list replacement semantics; the
-- PATCH endpoint sends every currently-reviewed key on each write.

ALTER TABLE facility_profiles
  ADD COLUMN IF NOT EXISTS reviewed_field_keys text[] NOT NULL DEFAULT '{}';
