-- Migration 071: drop the unused enquiry_properties.property_varieties column.
--
-- The multi-select Property Variety feature (former migration
-- 070_enquiry_property_varieties_multi.sql) was reverted at the product
-- owner's request. Its additive JSON column is now unreferenced by any
-- code path, so this removes it.
--
-- Guardrails:
--   - Idempotent + guarded via information_schema, so it is safe to re-run
--     and on installs where 070 was never applied (column already absent).
--   - Only touches enquiry_properties; inventory / website tables untouched.

-- enquiry_properties.property_varieties — drop if present
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'property_varieties'
);
SET @sql := IF(@col_exists = 1,
  'ALTER TABLE enquiry_properties DROP COLUMN property_varieties',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Remove the stale history row for the reverted 070 migration so
-- schema_migrations matches the files on disk (070 file was deleted).
DELETE FROM schema_migrations
 WHERE filename = '070_enquiry_property_varieties_multi.sql';
