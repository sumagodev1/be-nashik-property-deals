-- Migration 081: Rename `registration_date` -> `posting_date` on the
-- inventory and enquiry property tables. This aligns the DB with the
-- new UI/DTO label "Posting Date" (was "Date" / "Registration date").
--
-- Scope:
--   * inventory_properties.registration_date -> posting_date
--   * enquiry_properties.registration_date  -> posting_date
--
-- Website (self-registration) is explicitly OUT of scope:
--   * website_properties.registration_date is intentionally UNCHANGED.
--     The shared shareProperty service maps column names per module,
--     so website continues to resolve to `registration_date`.
--
-- MySQL `CHANGE COLUMN` preserves existing row data (values and NULLs),
-- so no backfill is required. `created_at` (server timestamp, powers
-- the new "Created On Date" field) and `available_from_date` (added in
-- migration 080) are unaffected.

ALTER TABLE inventory_properties
  CHANGE COLUMN registration_date posting_date DATE NULL DEFAULT NULL
    COMMENT 'Posting Date (admin-supplied). Renamed from registration_date in migration 081.';

ALTER TABLE enquiry_properties
  CHANGE COLUMN registration_date posting_date DATE NULL DEFAULT NULL
    COMMENT 'Posting Date (admin-supplied). Renamed from registration_date in migration 081.';
