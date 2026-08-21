-- ============================================================================
-- 120_inventory_area_column.sql
--
-- Promote the new inventory "Area" field to a top-level column so the
-- Inventory Dashboard can facet by it and the listing can render it.
--
-- WHY THIS EXISTS
-- ---------------
-- A new "Area" field was added to all 47 inventory form configs: a
-- master-driven dropdown backed by the existing `location` master (shown in
-- the Masters admin as "Global / Area"). Being a dynamic-form field, its value
-- lands inside the `details` JSON blob at details.dynamicData.area.
--
-- That is fine for a form field, but the client asked for two things the JSON
-- blob serves badly:
--
--   1. The Inventory Dashboard card "Top areas - Inventory" should be facetted
--      by Area. That is a GROUP BY over every inventory row. Against JSON it
--      means GROUP BY JSON_UNQUOTE(JSON_EXTRACT(details,'$.dynamicData.area')),
--      a full-table scan with no index, where the existing card does a plain
--      indexed GROUP BY location (see db/queries/dashboard.js).
--   2. Sorting and filtering by Area are impossible from JSON at all:
--      SORTABLE_COLUMNS in db/queries/inventory_properties.js is a hard
--      whitelist of REAL columns, which is exactly why the toolbar's existing
--      "Location (A-Z)" option works.
--
-- A real column makes all of that a normal indexed lookup, and mirrors how the
-- sibling `location` field is already stored - so this follows the existing
-- structure rather than inventing a second pattern.
--
-- SCHEMA CHANGE (additive, idempotent, non-destructive):
--   1. ADD COLUMN `area_name` VARCHAR(255) NULL AFTER `location`.
--
--      NAMED `area_name`, NOT `area`, deliberately. This table ALREADY carries
--      `area_value` DECIMAL(12,2) and `area_unit` VARCHAR(16), which hold the
--      property SIZE (sq ft / guntha). A bare `area` column sitting directly
--      beside those two would read as "size" to anyone opening the schema,
--      when it actually holds a locality name. The suffix keeps the two
--      concepts apart at a glance.
--
--      NULL-able on purpose. `location` is NOT NULL for historical reasons,
--      but Area is an OPTIONAL field (declared `optional: true` on the form and
--      deliberately NOT added to fieldPolicy's GLOBAL_MANDATORY_KEYS). Every
--      existing row predates the field, so they all get NULL - which the UI
--      renders as "NA", exactly as the client asked.
--
--   2. Index it, because its whole purpose is a dashboard GROUP BY.
--
-- DUAL-WRITE CONTRACT (read this before touching the write path):
--   The form will keep writing details.dynamicData.area for rendering, while
--   this column is written alongside it. That is the same shape the repo
--   already uses for agreementStartDate / isBuilderMaster (see the comment at
--   services/inventory/management.js). The rule is identical here:
--       * `area_name` (the COLUMN) is authoritative for cross-row queries -
--         dashboard facets, sorting, filtering.
--       * details.dynamicData.area is authoritative only for re-rendering the
--         form, and must never be used for aggregates.
--   Writing one without the other is what makes the two drift, so both write
--   paths go through the same promotion map.
--
-- NOT DONE HERE, deliberately:
--   * No back-fill. There is no honest source to back-fill FROM: the free-text
--     `location` column holds a geocoded address string ("Anandwali, Nashik,
--     Nashik Subdistrict, ..."), not a curated Area master value. Copying it
--     across would fabricate data and refill the new facet with precisely the
--     long addresses the client is trying to get away from. Existing rows show
--     NA until an operator picks an Area.
--   * NOT added to `enquiry_properties`. The Enquiry surface already collects
--     this vocabulary through its own dropdown, which persists to the EXISTING
--     `location` column there. A second column would split one concept in two.
--
-- ROLLBACK PLAN:
--   The column is additive and nullable, so reverting the application code
--   leaves it unread and harmless - it can stay in place indefinitely at zero
--   cost. If it must go:
--       ALTER TABLE inventory_properties DROP INDEX ix_inventory_properties_area_name
--       ALTER TABLE inventory_properties DROP COLUMN area_name
--   No data is lost that is not also still present in details.dynamicData.area,
--   which the form continues to write regardless.
-- ============================================================================

-- Guarded via the 096-pattern rather than ADD COLUMN IF NOT EXISTS: that form
-- is MariaDB-only and is a hard syntax error on MySQL 8, which the deploy
-- target runs. The guard makes re-apply a no-op on both engines.
SET @exist := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventory_properties'
    AND COLUMN_NAME = 'area_name'
);
SET @sql := IF(@exist = 0,
  'ALTER TABLE inventory_properties ADD COLUMN area_name VARCHAR(255) NULL COMMENT ''Curated Area (locality) picked from the `location` master, shown as "Global / Area". Optional, NULL renders as NA. NOT the property size - see area_value / area_unit for that. Mirrors details.dynamicData.area.'' AFTER location',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The dashboard facet groups on this column, so it needs an index. Plain
-- non-unique: many properties legitimately share one Area.
SET @exist := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventory_properties'
    AND INDEX_NAME = 'ix_inventory_properties_area_name'
);
SET @sql := IF(@exist = 0,
  'ALTER TABLE inventory_properties ADD INDEX ix_inventory_properties_area_name (area_name)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
