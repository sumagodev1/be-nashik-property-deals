-- ===========================================================
-- 049 — Location cascade: state_code / state_name / pincode
--        columns + hierarchy indexes for master_lookups
-- ===========================================================
-- The district → taluka → shivar (village) cascade already lives in
-- `master_lookups` (see migration 026): each row's `parent_code` points
-- at its parent's `code`. Everything the Maharashtra 7/12 portal-style
-- cascade needs is already there — code + label + parent_code — except
-- three government-master fields we want to carry alongside imported
-- data so admins can see and search on them:
--
--   - `state_code`  numeric state code (only meaningful on `district` rows)
--   - `state_name`  english state name (mirror of state_code, for display)
--   - `pincode`     6-digit Indian pincode (only meaningful on `shivar` rows)
--
-- All three are NULL for pre-existing lookup vocabularies. The CSV import
-- script (`scripts/import-locations.js`) is the only writer that populates
-- them today; the admin master CRUD leaves them alone and admins can still
-- Add/Edit/Delete districts/talukas/villages through the existing UI (they
-- just won't set state / pincode when adding manually — which is fine, both
-- fields are nullable).
--
-- Indexes: the existing `ix_master_lookups_parent (master_key, parent_code)`
-- is already ideal for the cascade query pattern (SELECT ... WHERE
-- master_key='taluka' AND parent_code='<districtCode>'). We just add
-- `(master_key, is_active, label)` — the paginated + searchable village
-- lookup does WHERE master_key='shivar' AND is_active=1 AND label LIKE ?
-- ORDER BY label, and 45k rows without this index would be a full scan.

SET NAMES utf8mb4;

ALTER TABLE master_lookups
  ADD COLUMN state_code  VARCHAR(10)  NULL AFTER parent_code,
  ADD COLUMN state_name  VARCHAR(120) NULL AFTER state_code,
  ADD COLUMN pincode     VARCHAR(10)  NULL AFTER state_name;

-- Composite index for the village-search query pattern (label prefix filter
-- + alphabetical order under a specific master_key + active state). Also
-- accelerates the districts alphabetical listing.
ALTER TABLE master_lookups
  ADD KEY ix_master_lookups_key_active_label (master_key, is_active, label);

-- Composite index for the parent-cascade + label filter (talukas/villages
-- filtered by parent AND searched by label).
ALTER TABLE master_lookups
  ADD KEY ix_master_lookups_key_parent_label (master_key, parent_code, label);

-- Pincode lookups (used by the "villages inside a pincode" reverse search
-- if we ever expose it — cheap to add now).
ALTER TABLE master_lookups
  ADD KEY ix_master_lookups_pincode (pincode);
