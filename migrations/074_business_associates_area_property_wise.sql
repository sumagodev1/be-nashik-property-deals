-- ===========================================================
-- 074 — Business Associates: area_wise + property_wise columns
-- ===========================================================
-- T-2026-079: Enhancement request — after the Designation is
-- selected on the Business Associate form, two dependent
-- dropdowns appear below it:
--
--   • area_wise      → Global `location` master (searchable
--                       with the shared "Other → Save → refresh"
--                       flow). Stores the master LABEL for
--                       backward compat with the same rule the
--                       enquiry `location` field follows (see
--                       T-2026-075) — that way a curated Nashik
--                       locality name like "College Road" reads
--                       cleanly on List / View surfaces without
--                       an extra join.
--
--   • property_wise  → Global `property_type` master. Stores
--                       the master CODE (e.g. 'flat', 'plot',
--                       'bungalow') to match how every other
--                       property_type reference on the backend
--                       persists — resolved to a label at read
--                       time via the master lookup on the FE.
--
-- Guardrails:
--   * Additive only. No column dropped or renamed.
--   * Both nullable so pre-existing rows are legal without
--     any backfill.
--   * Idempotent. Second run is a no-op (guarded on
--     information_schema).
--   * No trigger, no view, no procedure. Straight DDL.
-- ===========================================================

-- business_associates.area_wise
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'business_associates'
    AND column_name = 'area_wise'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE business_associates ADD COLUMN area_wise VARCHAR(255) NULL AFTER designation',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- business_associates.property_wise
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'business_associates'
    AND column_name = 'property_wise'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE business_associates ADD COLUMN property_wise VARCHAR(64) NULL AFTER area_wise',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
