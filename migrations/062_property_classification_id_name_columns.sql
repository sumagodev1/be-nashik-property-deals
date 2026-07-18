-- ===========================================================
-- 062 - Property classification {id, name} pair columns
--   (Property Type / Transaction Type / Property Variety)
-- ===========================================================
-- T-2026-055: Extends the classification storage layer so each
-- inventory / enquiry row carries BOTH the canonical master
-- code (already stored in property_type / transaction_type /
-- transaction_variant since T-2026-051) AND the master row
-- primary-key id + display name (label) captured verbatim from
-- the pre-form chooser at creation time.
--
-- Guardrails:
--   - Additive only. No column dropped or renamed.
--   - The existing canonical code columns (property_type,
--     transaction_type, transaction_variant) are LEFT UNTOUCHED
--     so every read path currently keying off them keeps
--     working. The new columns SUPPLEMENT the codes with the
--     master identity captured at write time.
--   - New columns nullable so pre-existing rows are legal
--     without the backfill running.
--   - Backfill only touches rows where the new columns are
--     still NULL AND a matching master row exists (INNER JOIN
--     resolves via the canonical code).
--   - Idempotent. Second run is a no-op.
--   - No trigger, no view, no procedure. Straight DDL + DML.
--
-- Applies to BOTH inventory_properties AND enquiry_properties.
-- ===========================================================

-- Step 1: ADD COLUMNS (guarded on information_schema so a re-run
-- does not error on ER_DUP_FIELDNAME).

-- inventory_properties.property_type_id
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'inventory_properties'
    AND column_name = 'property_type_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE inventory_properties ADD COLUMN property_type_id BIGINT UNSIGNED NULL AFTER property_type',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- inventory_properties.property_type_name
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'inventory_properties'
    AND column_name = 'property_type_name'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE inventory_properties ADD COLUMN property_type_name VARCHAR(255) NULL AFTER property_type_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- inventory_properties.transaction_type_id
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'inventory_properties'
    AND column_name = 'transaction_type_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE inventory_properties ADD COLUMN transaction_type_id BIGINT UNSIGNED NULL AFTER transaction_type',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- inventory_properties.transaction_type_name
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'inventory_properties'
    AND column_name = 'transaction_type_name'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE inventory_properties ADD COLUMN transaction_type_name VARCHAR(255) NULL AFTER transaction_type_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- inventory_properties.property_variety_id
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'inventory_properties'
    AND column_name = 'property_variety_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE inventory_properties ADD COLUMN property_variety_id BIGINT UNSIGNED NULL AFTER transaction_variant',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- inventory_properties.property_variety_name
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'inventory_properties'
    AND column_name = 'property_variety_name'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE inventory_properties ADD COLUMN property_variety_name VARCHAR(255) NULL AFTER property_variety_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.property_type_id
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'property_type_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE enquiry_properties ADD COLUMN property_type_id BIGINT UNSIGNED NULL AFTER property_type',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.property_type_name
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'property_type_name'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE enquiry_properties ADD COLUMN property_type_name VARCHAR(255) NULL AFTER property_type_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.transaction_type_id
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'transaction_type_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE enquiry_properties ADD COLUMN transaction_type_id BIGINT UNSIGNED NULL AFTER transaction_type',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.transaction_type_name
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'transaction_type_name'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE enquiry_properties ADD COLUMN transaction_type_name VARCHAR(255) NULL AFTER transaction_type_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.property_variety_id
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'property_variety_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE enquiry_properties ADD COLUMN property_variety_id BIGINT UNSIGNED NULL AFTER transaction_variant',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- enquiry_properties.property_variety_name
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'enquiry_properties'
    AND column_name = 'property_variety_name'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE enquiry_properties ADD COLUMN property_variety_name VARCHAR(255) NULL AFTER property_variety_id',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Step 2: DRY-RUN REPORT

SELECT
  'inventory_properties' AS source_table,
  SUM(CASE WHEN property_type_id     IS NULL AND property_type       IS NOT NULL AND property_type       <> '' THEN 1 ELSE 0 END) AS pending_property_type_backfill,
  SUM(CASE WHEN transaction_type_id  IS NULL AND transaction_type    IS NOT NULL AND transaction_type    <> '' THEN 1 ELSE 0 END) AS pending_transaction_type_backfill,
  SUM(CASE WHEN property_variety_id  IS NULL AND transaction_variant IS NOT NULL AND transaction_variant <> '' THEN 1 ELSE 0 END) AS pending_variety_backfill,
  COUNT(*) AS total_rows
FROM inventory_properties
WHERE deleted_at IS NULL;

SELECT
  'enquiry_properties' AS source_table,
  SUM(CASE WHEN property_type_id     IS NULL AND property_type       IS NOT NULL AND property_type       <> '' THEN 1 ELSE 0 END) AS pending_property_type_backfill,
  SUM(CASE WHEN transaction_type_id  IS NULL AND transaction_type    IS NOT NULL AND transaction_type    <> '' THEN 1 ELSE 0 END) AS pending_transaction_type_backfill,
  SUM(CASE WHEN property_variety_id  IS NULL AND transaction_variant IS NOT NULL AND transaction_variant <> '' THEN 1 ELSE 0 END) AS pending_variety_backfill,
  COUNT(*) AS total_rows
FROM enquiry_properties
WHERE deleted_at IS NULL;

-- Step 3: BACKFILL

-- inventory_properties: backfill property_type_id + property_type_name from master_property_types
UPDATE inventory_properties ip
JOIN master_property_types mpt
  ON mpt.code       = ip.property_type
 AND mpt.deleted_at IS NULL
SET ip.property_type_id   = mpt.id,
    ip.property_type_name = mpt.label
WHERE ip.deleted_at IS NULL
  AND ip.property_type_id IS NULL
  AND ip.property_type IS NOT NULL
  AND ip.property_type <> '';

-- inventory_properties: backfill transaction_type_id + transaction_type_name from master_transaction_types
UPDATE inventory_properties ip
JOIN master_transaction_types mtt
  ON mtt.code       = ip.transaction_type
 AND mtt.deleted_at IS NULL
SET ip.transaction_type_id   = mtt.id,
    ip.transaction_type_name = mtt.label
WHERE ip.deleted_at IS NULL
  AND ip.transaction_type_id IS NULL
  AND ip.transaction_type IS NOT NULL
  AND ip.transaction_type <> '';

-- inventory_properties: backfill property_variety_id + property_variety_name from master_lookups
UPDATE inventory_properties ip
JOIN master_lookups ml
  ON ml.master_key = 'property_variety'
 AND ml.code       = ip.transaction_variant
 AND ml.deleted_at IS NULL
SET ip.property_variety_id   = ml.id,
    ip.property_variety_name = ml.label
WHERE ip.deleted_at IS NULL
  AND ip.property_variety_id IS NULL
  AND ip.transaction_variant IS NOT NULL
  AND ip.transaction_variant <> '';

-- enquiry_properties: backfill property_type_id + property_type_name from master_property_types
UPDATE enquiry_properties ep
JOIN master_property_types mpt
  ON mpt.code       = ep.property_type
 AND mpt.deleted_at IS NULL
SET ep.property_type_id   = mpt.id,
    ep.property_type_name = mpt.label
WHERE ep.deleted_at IS NULL
  AND ep.property_type_id IS NULL
  AND ep.property_type IS NOT NULL
  AND ep.property_type <> '';

-- enquiry_properties: backfill transaction_type_id + transaction_type_name from master_transaction_types
UPDATE enquiry_properties ep
JOIN master_transaction_types mtt
  ON mtt.code       = ep.transaction_type
 AND mtt.deleted_at IS NULL
SET ep.transaction_type_id   = mtt.id,
    ep.transaction_type_name = mtt.label
WHERE ep.deleted_at IS NULL
  AND ep.transaction_type_id IS NULL
  AND ep.transaction_type IS NOT NULL
  AND ep.transaction_type <> '';

-- enquiry_properties: backfill property_variety_id + property_variety_name from master_lookups
UPDATE enquiry_properties ep
JOIN master_lookups ml
  ON ml.master_key = 'property_variety'
 AND ml.code       = ep.transaction_variant
 AND ml.deleted_at IS NULL
SET ep.property_variety_id   = ml.id,
    ep.property_variety_name = ml.label
WHERE ep.deleted_at IS NULL
  AND ep.property_variety_id IS NULL
  AND ep.transaction_variant IS NOT NULL
  AND ep.transaction_variant <> '';

-- Step 4: POST-CHECK

SELECT
  'inventory_properties' AS source_table,
  SUM(CASE WHEN property_type_id     IS NULL AND property_type       IS NOT NULL AND property_type       <> '' THEN 1 ELSE 0 END) AS remaining_property_type_unbackfilled,
  SUM(CASE WHEN transaction_type_id  IS NULL AND transaction_type    IS NOT NULL AND transaction_type    <> '' THEN 1 ELSE 0 END) AS remaining_transaction_type_unbackfilled,
  SUM(CASE WHEN property_variety_id  IS NULL AND transaction_variant IS NOT NULL AND transaction_variant <> '' THEN 1 ELSE 0 END) AS remaining_variety_unbackfilled
FROM inventory_properties
WHERE deleted_at IS NULL;

SELECT
  'enquiry_properties' AS source_table,
  SUM(CASE WHEN property_type_id     IS NULL AND property_type       IS NOT NULL AND property_type       <> '' THEN 1 ELSE 0 END) AS remaining_property_type_unbackfilled,
  SUM(CASE WHEN transaction_type_id  IS NULL AND transaction_type    IS NOT NULL AND transaction_type    <> '' THEN 1 ELSE 0 END) AS remaining_transaction_type_unbackfilled,
  SUM(CASE WHEN property_variety_id  IS NULL AND transaction_variant IS NOT NULL AND transaction_variant <> '' THEN 1 ELSE 0 END) AS remaining_variety_unbackfilled
FROM enquiry_properties
WHERE deleted_at IS NULL;
