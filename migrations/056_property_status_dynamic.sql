-- ===========================================================
-- 056 — Property Status: dynamic master (drop ENUM lock)
-- ===========================================================
-- The `status_type` master + `master_status_types` table already exist
-- (created + seeded in migration 008 with Available / Sold / Rented /
-- Inactive). Two changes are needed to make Property Status a fully
-- admin-editable Global master:
--
-- 1. Widen the status columns from ENUM(...) to VARCHAR(64) on the
--    property tables. The current ENUM is a hard database-level lock
--    that rejects any new master value (e.g. "Reserved") before the
--    row hits the app-layer validator. VARCHAR + master validation is
--    the same shape every other lookup uses (property_type,
--    transaction_type, district, etc.). Existing rows keep their
--    current string values — ENUM → VARCHAR is a lossless conversion
--    in MySQL, no backfill needed.
--
-- 2. Un-fixing the master + renaming the label happens in
--    server/services/masters/management.js (removes 'status_type' from
--    FIXED_MASTERS + updates MASTER_LABELS). No table-level change
--    there.
--
-- Historical rows continue to render correctly: their existing status
-- codes ('available' / 'sold' / 'rented' / 'inactive') match seeded
-- master rows, so the frontend label lookup resolves as before.
-- ===========================================================

ALTER TABLE inventory_properties
  MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT 'available';

ALTER TABLE enquiry_properties
  MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT 'available';
