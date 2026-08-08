-- ============================================================
-- 096 — Add Agreement Start / End Date columns
-- ============================================================
-- T-2026-112: Agreement Tracking & Reminder System. Adds two nullable
-- DATE columns to `inventory_properties` and `enquiry_properties` so
-- Rent Out and Lease Out records can carry the agreement window
-- expressly. Reminder list, dashboard summary, and topbar notification
-- badge query these columns directly (fast, indexable) rather than
-- walking every row's `details.dynamicData` JSON.
--
-- Additive-only, non-destructive:
--   • Nullable — existing rows land NULL and remain fully valid.
--   • IF NOT EXISTS guard on each ADD COLUMN so the migration is
--     idempotent (re-apply is a no-op both at the SQL level and at
--     the migration-runner level).
--   • No column removals, no data rewrites, no default backfills.
--   • Non-rent/lease rows keep both columns NULL forever — this is
--     the correct product behavior (Sale/Purchase/Rent In/Lease In
--     forms never surface the fields).
--   • The FE also mirrors the two values into `details.dynamicData`
--     for form rendering (dual-write), so old readers that only
--     inspect the JSON blob still see the values on any post-096
--     record. The top-level columns are the authoritative surface
--     for cross-row queries (reminder list, dashboard, badge count).
--
-- Indexes:
--   • Composite indexes on (transaction_variant, agreement_end_date)
--     accelerate the reminder-list scan which filters by variant
--     (`rent_out` / `lease_out`) and orders by end date.
--   • Migration is safe to re-run because each ADD INDEX is guarded
--     by an information_schema.STATISTICS existence check (the repo's
--     standard idempotent prepared-statement idiom — see 074 / 075).
--     This avoids the mysql-CLI-only `DELIMITER` directive, which the
--     mysql2-based migration runner (scripts/migrate.js) forwards
--     verbatim to MariaDB and cannot parse.
-- ============================================================

SET NAMES utf8mb4;

-- --- inventory_properties ------------------------------------------
ALTER TABLE inventory_properties
  ADD COLUMN IF NOT EXISTS agreement_start_date DATE NULL
    COMMENT 'Agreement Start Date — set only on Rent Out / Lease Out forms (T-2026-112)',
  ADD COLUMN IF NOT EXISTS agreement_end_date DATE NULL
    COMMENT 'Agreement End Date — set only on Rent Out / Lease Out forms (T-2026-112)';

-- --- enquiry_properties -------------------------------------------
ALTER TABLE enquiry_properties
  ADD COLUMN IF NOT EXISTS agreement_start_date DATE NULL
    COMMENT 'Agreement Start Date — set only on Rent Out / Lease Out forms (T-2026-112)',
  ADD COLUMN IF NOT EXISTS agreement_end_date DATE NULL
    COMMENT 'Agreement End Date — set only on Rent Out / Lease Out forms (T-2026-112)';

-- Composite indexes for the Agreement Reminder list scan. Guarded by an
-- information_schema.STATISTICS existence check so the migration stays
-- idempotent (MariaDB has no `CREATE INDEX IF NOT EXISTS` at DDL layer for
-- non-primary indexes). Top-level prepared-statement idiom — no DELIMITER,
-- no stored procedure — matching 074 / 075.

-- inventory_properties.ix_inv_agreement_end
SET @exist := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventory_properties'
    AND INDEX_NAME = 'ix_inv_agreement_end'
);
SET @sql := IF(@exist = 0,
  'ALTER TABLE inventory_properties ADD INDEX ix_inv_agreement_end (transaction_variant, agreement_end_date)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.ix_enq_agreement_end
SET @exist := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'enquiry_properties'
    AND INDEX_NAME = 'ix_enq_agreement_end'
);
SET @sql := IF(@exist = 0,
  'ALTER TABLE enquiry_properties ADD INDEX ix_enq_agreement_end (transaction_variant, agreement_end_date)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
