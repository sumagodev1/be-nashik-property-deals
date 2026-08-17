-- ============================================================
-- 099 — Builder Property / Multi-Unit Inventory (Admin-only)
-- ============================================================
-- T-2026-136: Introduces the "Builder Property" flow. An admin can flag
-- a Flat Sale New inventory row as a MASTER PROPERTY that represents a
-- multi-unit building/project. Each such master carries N independent
-- UNIT rows (one per flat/apartment inside the building) with their own
-- unit-level details, pricing calc, and status.
--
-- Design (spec section 6 / 7 / 9 / 11):
--
--   inventory_properties (existing table — additive only):
--     + is_builder_master   TINYINT(1) NOT NULL DEFAULT 0
--         1 = this row is a Builder-Property MASTER (holds project-level
--         data — location, common amenities, owner, etc.). Its per-flat
--         units live in inventory_property_units keyed by master_property_id.
--         0 = ordinary single-record inventory (pre-T-136 behaviour;
--         must remain byte-identical).
--     + total_units_planned INT NULL
--         Admin-entered target unit count (informational — no rows are
--         auto-created; the admin adds units on demand from the Unit
--         Inventory dashboard).
--
--   inventory_property_units (NEW table):
--     One row per flat/apartment/unit inside a builder-master project.
--     Keyed by FK to inventory_properties(id) so cascade-delete of the
--     master removes all its units atomically. `unit_no` is unique per
--     master so admin cannot accidentally duplicate a flat number.
--     `details` JSON carries the full unit-level dynamicData subset
--     (spec section 9) — same shape as
--     inventory_properties.details.dynamicData but limited to unit-level
--     fields (no location, no owner, no master amenities).
--
-- PUBLIC-EXCLUSION CONTRACT (spec sections 12 / 26 / T13-T14):
--   Builder masters + their units must NEVER appear on public APIs.
--   Enforced at the QUERY layer in later T-2026-141 slice via
--   `WHERE is_builder_master = 0 OR is_builder_master IS NULL` on
--   every public read of inventory_properties. inventory_property_units
--   is NEVER read by public queries (public code MUST NOT JOIN it).
--   This migration lays the flag; the guards are added in slice 6.
--
-- BACKWARD-COMPATIBILITY (spec sections 10 / T1 / T15):
--   • is_builder_master defaults to 0 — every pre-T-136 row lands
--     with the correct "normal property" value automatically.
--   • total_units_planned is NULL for all pre-existing rows.
--   • No column removal, no data rewrite, no default backfill needed
--     beyond the DEFAULT clause on the new columns.
--   • The two new columns are additive; existing SELECT * queries and
--     the inventory service's mapping layer continue to work unchanged
--     (a column they don't know about is silently ignored).
--   • The new table is empty on migration apply; no existing feature
--     reads it.
--
-- IDEMPOTENCY / SAFETY (per repo convention — see 096 / 098):
--   • ADD COLUMN IF NOT EXISTS ...  (MariaDB 10.0+; safe re-run).
--   • CREATE TABLE IF NOT EXISTS ...  (safe re-run).
--   • ADD INDEX / ADD CONSTRAINT guarded by information_schema checks
--     via the prepared-statement idiom used in 096, so no
--     "duplicate key name" error on re-apply.
--   • Zero DELETE, zero DROP, zero UPDATE. Migration is byte-safe.
--
-- FK typing:
--   inventory_properties.id is BIGINT UNSIGNED NOT NULL AUTO_INCREMENT
--   (see migration 001, line 85). master_property_id therefore matches
--   as BIGINT UNSIGNED NOT NULL. FK carries ON DELETE CASCADE so a
--   master delete removes its units in a single DB round-trip.
--
-- Scope for this iteration (spec section 29):
--   Flat Sale New only. Other property types (Rowhouse / Bungalow /
--   Land / Plot / Commercial / Shop) are architecturally supported by
--   this schema (property_type on the master is unchanged; a builder
--   master keeps property_type='flat' for now, and later iterations
--   can enable the flag on additional types with zero migration change).
--
-- Related files (created/modified in later T-2026-137..141 slices):
--   • server/routes/admin/inventory-properties-units.js  (new)
--   • server/services/inventory/units.js                 (new)
--   • server/db/queries/inventory_property_units.js      (new)
--   • server/db/queries/public_properties.js             (WHERE guard)
--   • server/services/public/properties.js               (WHERE guard)
--   • server/services/public/general_enquiries.js        (WHERE guard)
--   • src/admin/pages/Inventory/dynamic/flatFormsConfig.js
--   • src/admin/pages/Inventory/InventoryForm.jsx
--   • src/admin/pages/Inventory/units/* (new route family)
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- 1) inventory_properties: two additive nullable-safe columns
-- ------------------------------------------------------------------
ALTER TABLE inventory_properties
  ADD COLUMN IF NOT EXISTS is_builder_master TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'T-2026-136: 1 = Builder Property MASTER row (multi-unit); 0 = normal single record',
  ADD COLUMN IF NOT EXISTS total_units_planned INT NULL
    COMMENT 'T-2026-136: Admin-entered target unit count for Builder Property (informational; no auto-create)';

-- Filter index for admin-side "Builder only" list queries and for the
-- public-exclusion guard's index-friendly WHERE clause. Guarded via the
-- 096-pattern so re-apply is a no-op.
SET @exist := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventory_properties'
    AND INDEX_NAME = 'ix_inv_is_builder_master'
);
SET @sql := IF(@exist = 0,
  'ALTER TABLE inventory_properties ADD INDEX ix_inv_is_builder_master (is_builder_master)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------------
-- 2) inventory_property_units: new child table
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_property_units (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  master_property_id BIGINT UNSIGNED NOT NULL
    COMMENT 'FK inventory_properties.id (must be a row with is_builder_master=1)',
  unit_no            VARCHAR(64) NOT NULL
    COMMENT 'Flat No. / Unit identifier — unique per master',
  status             ENUM('available','in_discussion','booked','sold','hold','hidden')
                     NOT NULL DEFAULT 'available'
    COMMENT 'Per-unit lifecycle status (spec section 11)',
  details            JSON NOT NULL
    COMMENT 'Unit-level dynamicData subset (spec section 9)',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_master_unit (master_property_id, unit_no),
  KEY idx_master (master_property_id),
  KEY idx_status (status),
  CONSTRAINT fk_inv_unit_master
    FOREIGN KEY (master_property_id) REFERENCES inventory_properties (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Belt-and-braces: if the table already existed from a previous run of
-- this migration, the CREATE TABLE IF NOT EXISTS above is a no-op and
-- the indexes/constraints inside will not be re-declared. That is the
-- correct semantic — the initial CREATE always ships with the full
-- key set, so no follow-up guarded ADDs are needed here.
