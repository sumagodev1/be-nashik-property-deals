-- Migration 080: Add `available_from_date` column to all three property
-- surfaces (inventory, enquiry, website). Nullable — availability is
-- optional metadata that the property owner may or may not disclose.
--
-- No backfill needed:
--   • Legacy rows keep NULL until an admin edits them.
--   • `registration_date` (renamed to "Posting Date" in the UI/DTO) and
--     `created_at` continue to exist unchanged — no data migration
--     required beyond adding this one column.

ALTER TABLE inventory_properties
  ADD COLUMN available_from_date DATE NULL DEFAULT NULL
    COMMENT 'Date the property becomes available for occupancy'
  AFTER registration_date;

ALTER TABLE enquiry_properties
  ADD COLUMN available_from_date DATE NULL DEFAULT NULL
    COMMENT 'Date the property becomes available for occupancy'
  AFTER registration_date;

ALTER TABLE website_properties
  ADD COLUMN available_from_date DATE NULL DEFAULT NULL
    COMMENT 'Date the property becomes available for occupancy'
  AFTER title;
