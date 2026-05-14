-- Migration 004: close remaining PRD gaps.
-- 1. inventory_properties.is_draft — supports the Draft Save flow.
-- 2. sellers.area — supports area-wise seller registration chart on the
--    admin dashboard. Backfills as NULL; UI surfaces it as an optional field.
-- All other gaps reuse existing tables (property_files, seller_documents)
-- without schema changes.

ALTER TABLE inventory_properties
  ADD COLUMN is_draft TINYINT(1) NOT NULL DEFAULT 0 AFTER status;

ALTER TABLE inventory_properties
  ADD INDEX ix_inventory_is_draft (is_draft);

ALTER TABLE sellers
  ADD COLUMN area VARCHAR(255) NULL AFTER business_address;

ALTER TABLE sellers
  ADD INDEX ix_sellers_area (area);
