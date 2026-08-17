-- ============================================================
-- 100 — Builder Status Master (dynamic Builder Property unit status)
-- ============================================================
-- T-2026-146: The Builder Property feature shipped in T-2026-136..T-2026-145
-- persists per-unit lifecycle status on `inventory_property_units.status` as a
-- fixed ENUM('available','in_discussion','booked','sold','hold','hidden').
-- Client requirement: replace the static list with a Master so admins can
-- Add / Edit / Delete / Activate / Deactivate status codes at runtime and
-- new statuses appear on the Builder unit Status pills WITHOUT any FE code
-- change.
--
-- REUSING THE EXISTING MASTERS FRAMEWORK (do NOT invent a parallel table):
--   This repo's masters framework already provides everything the spec
--   asks for. Every `master_lookups` vocabulary registered in
--   server/services/masters/management.js#LOOKUP_KEYS automatically gets:
--     * Admin CRUD via /api/admin/masters/:key (list/create/update/delete)
--     * Toggle-active via the update path (isActive boolean)
--     * Delete-safety via USAGE_REFS (refuses removal when in use, with a
--       friendly "Cannot delete — this status is being used in Builder
--       Property Units" 409 error; admin should Deactivate instead)
--     * Admin sidebar entry (auto-populated from GET /api/admin/masters)
--     * MasterListPage + MasterEntryModal UI (fully generic)
--     * Public read-only dropdown at /api/public/masters/:key?isActive=true
--   Same pattern as `enquiry_status` (migration 075), `enquiry_relation`
--   (migration 087), `gst` (migration 094), and 100+ other keys.
--
-- Design decisions locked with the orchestrator:
--   1. NO new table. `master_lookups` handles it via `master_key='builder_status'`.
--   2. NO new FK column. The existing masters idiom stores the CODE string
--      (VARCHAR) directly on the target column — same as `status_type` and
--      `inventory_properties.status` (see USAGE_REFS in masters/management.js).
--      This preserves the whole framework's uniform delete-safety machinery,
--      dropdown API, admin UI, and cache-invalidation surface.
--   3. Column type change: ENUM('available',...) -> VARCHAR(64). Byte-safe
--      coercion — every existing enum value is a valid VARCHAR(64) so no
--      row data changes. New admin-added codes (validated to /^[a-z0-9_]{2,64}$/
--      by the master's create path) fit trivially.
--   4. Seed the 6 shipped codes into master_lookups. `available`,
--      `in_discussion`, `booked`, `sold`, `hold`, `hidden` with sort_order
--      10..60. Labels match the shipped FE UNIT_STATUS_LABELS. is_active=1.
--      Idempotent via INSERT IGNORE against the (master_key, code) unique key.
--   5. Backward-compat: every pre-existing unit row's status VARCHAR already
--      equals one of the 6 seeded codes, so every existing row continues to
--      render byte-identically after the migration applies.
--
-- Historical safety (spec requirement):
--   "Existing units using an old status must continue to display correctly
--    even if that status is later deactivated."
--   Because the code lives directly on `inventory_property_units.status`
--   and the master row is only SOFT-deleted (deleted_at set + is_active=0),
--   old units keep displaying via the seeded code even after admin
--   deactivation. Hard-delete is refused when in-use (USAGE_REFS guard).
--
-- Scope (spec explicit):
--   Apply ONLY to Builder Property -> Flat Sale New -> Unit Status.
--   The 'status_type' master (Inventory) and 'enquiry_status' master
--   (Enquiry) are UNCHANGED. Only the Builder unit column is affected.
--
-- Related files (modified in the T-2026-146 slice — this migration alone):
--   * server/services/masters/management.js  (register the key + label + USAGE_REFS)
--   * server/routes/admin/inventory-property-units.js  (replace hardcoded
--     UNIT_STATUSES with runtime assertActiveCode('builder_status', ...) )
--   * src/shared/api/masters.js  (register the key + label for the FE sidebar)
--   * src/shared/api/inventoryPropertyUnits.js  (remove hardcoded consts +
--     add useBuilderStatuses hook)
--   * src/admin/pages/Inventory/dynamic/BuilderUnitBlock.jsx  (fetch dynamic)
--   * src/admin/pages/Inventory/units/UnitInventoryDashboard.jsx  (fetch dynamic)
--   * src/admin/pages/Inventory/units/UnitForm.jsx  (fetch dynamic)
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- 1) Coerce inventory_property_units.status from ENUM to VARCHAR(64)
-- ------------------------------------------------------------------
-- Byte-safe: existing enum values are all valid VARCHAR strings; the DB
-- does NOT rewrite row data on this ALTER (metadata-only for MariaDB
-- 10.4+ when the new type is a superset of the old). Column keeps its
-- NOT NULL + DEFAULT 'available' semantics.
--
-- Guarded via information_schema so re-running the migration is a no-op
-- (matches the idiom used in migrations 096 / 098 / 099).
SET @cur_type := (
  SELECT COLUMN_TYPE
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'inventory_property_units'
     AND COLUMN_NAME = 'status'
);
SET @sql := IF(
  @cur_type IS NOT NULL AND @cur_type LIKE 'enum(%',
  'ALTER TABLE inventory_property_units MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT ''available'' COMMENT ''T-2026-146: Master-driven code (master_lookups.master_key=builder_status). Was ENUM in migration 099.''',
  'SELECT 1'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ------------------------------------------------------------------
-- 2) Seed the 6 shipped statuses under master_key='builder_status'
-- ------------------------------------------------------------------
-- INSERT IGNORE against the (master_key, code) unique key -> idempotent.
-- Existing rows (from a prior partial re-run) are preserved. Labels match
-- the pre-T-146 FE UNIT_STATUS_LABELS exactly so post-migration display
-- is byte-identical to pre-migration display.
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('builder_status', 'available',     'Available',     10, 1),
  ('builder_status', 'in_discussion', 'In Discussion', 20, 1),
  ('builder_status', 'booked',        'Booked',        30, 1),
  ('builder_status', 'sold',          'Sold',          40, 1),
  ('builder_status', 'hold',          'Hold',          50, 1),
  ('builder_status', 'hidden',        'Hidden',        60, 1);
