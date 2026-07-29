-- ===========================================================
-- 075 — Enquiry Property Status master (split from status_type)
-- ===========================================================
-- T-2026-080: Split the shared "Property Status" master into
-- two independent vocabularies so Inventory and Enquiry can
-- carry different workflow states.
--
--   * status_type    (existing, master_status_types table)
--       Rename display label to "Inventory / Property Status".
--       Rows: available / sold / rented / inactive
--       + any custom rows the admin has added. UNCHANGED here —
--       label rename lives on the FE/BE registration side, not
--       the DB row itself.
--
--   * enquiry_status (NEW, master_lookups table)
--       Label "Enquiry / Property Status".
--       Seeds 4 defaults (new_enquiry / enquiry_in_discussion /
--       enquiry_converted / enquiry_lost) each with a Description.
--       Legacy codes (available / sold / rented / inactive)
--       are ALSO seeded but flagged INACTIVE so:
--         (a) existing enquiry_properties rows whose status is
--             still one of those legacy codes continue to
--             resolve to a human label on read paths, and
--         (b) the new-enquiry dropdown only offers the 4 new
--             active codes.
--       Admin can hard-delete the legacy inactive rows later
--       once every historical enquiry row has been migrated.
--
-- Guardrails:
--   * Additive only. No column dropped or renamed.
--   * Idempotent. Second run is a no-op (INSERT IGNORE +
--     information_schema-guarded ADD COLUMN).
--   * `master_lookups.description` is added as a nullable
--     column so every existing lookup row stays legal without
--     backfill and every future lookup key can carry a
--     Description/Meaning without another schema bump.
-- ===========================================================

-- Step 1: master_lookups.description
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'master_lookups'
    AND column_name = 'description'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE master_lookups ADD COLUMN description VARCHAR(255) NULL AFTER label',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Step 2: seed the 4 default active enquiry statuses
--
-- Uses INSERT ... ON DUPLICATE KEY UPDATE so a re-run refreshes the
-- description text without disturbing sort_order / is_active. If an
-- admin has already tweaked one of these rows the label + description
-- get restored to the seeded canonical values (matches the enum-style
-- guarantee for seeded defaults elsewhere in the codebase).
INSERT INTO master_lookups (master_key, code, label, description, sort_order, is_active)
VALUES
  ('enquiry_status', 'new_enquiry',          'New Enquiry',           'Newly received enquiry awaiting processing.',                       10, 1),
  ('enquiry_status', 'enquiry_in_discussion','Enquiry In Discussion', 'Discussion or follow-up is currently in progress.',                 20, 1),
  ('enquiry_status', 'enquiry_converted',    'Enquiry Converted',     'Enquiry has successfully converted into a confirmed deal.',         30, 1),
  ('enquiry_status', 'enquiry_lost',         'Enquiry Lost',          'Enquiry closed without conversion.',                                40, 1)
ON DUPLICATE KEY UPDATE
  label       = VALUES(label),
  description = VALUES(description),
  sort_order  = VALUES(sort_order);

-- Step 3: seed the 4 legacy codes as INACTIVE
--
-- Kept as inactive rows so existing enquiry_properties.status values
-- (which historically shared the inventory status codes) still resolve
-- to a human label on read paths. Not offered in new-enquiry dropdowns.
-- Descriptions are borrowed from the same wording the Inventory master
-- carries so admins reading the row understand the legacy meaning.
INSERT INTO master_lookups (master_key, code, label, description, sort_order, is_active)
VALUES
  ('enquiry_status', 'available', 'Available (legacy)', 'Legacy code inherited from the shared Property Status master. Kept for backward compatibility with older enquiry records.', 90, 0),
  ('enquiry_status', 'sold',      'Sold (legacy)',      'Legacy code inherited from the shared Property Status master. Prefer "Enquiry Converted" for new records.',                91, 0),
  ('enquiry_status', 'rented',    'Rented (legacy)',    'Legacy code inherited from the shared Property Status master. Prefer "Enquiry Converted" for new records.',                92, 0),
  ('enquiry_status', 'inactive',  'Inactive (legacy)',  'Legacy code inherited from the shared Property Status master. Prefer "Enquiry Lost" for new records.',                     93, 0)
ON DUPLICATE KEY UPDATE
  label       = VALUES(label),
  description = VALUES(description),
  sort_order  = VALUES(sort_order);

-- Step 4: migrate existing enquiry_properties rows from legacy inventory
-- codes to the new enquiry-specific codes. Runs after the seeds above so
-- both source and target codes exist in the master. Idempotent — the WHERE
-- clause filters to only the four legacy codes so a re-run after the
-- migration has already promoted every row is a no-op.
--
-- Mapping rationale:
--   available → new_enquiry
--       Enquiry rows default to 'available' on create (schema default from
--       migration 056) which historically meant "just received, awaiting
--       processing". That matches New Enquiry semantics 1:1.
--   sold      → enquiry_converted
--       On the enquiry side a "sold" record represented a converted lead
--       (the deal closed).
--   rented    → enquiry_converted
--       Same rationale as sold — the enquiry converted into a rental deal.
--   inactive  → enquiry_lost
--       An enquiry marked inactive was one closed without conversion.
--
-- Post-migration the four legacy rows above stay in the master as
-- INACTIVE reference rows so any label lookup fired during audit trail
-- rendering still resolves to their (legacy) label.
UPDATE enquiry_properties SET status = 'new_enquiry'       WHERE status = 'available' AND deleted_at IS NULL;
UPDATE enquiry_properties SET status = 'enquiry_converted' WHERE status = 'sold'      AND deleted_at IS NULL;
UPDATE enquiry_properties SET status = 'enquiry_converted' WHERE status = 'rented'    AND deleted_at IS NULL;
UPDATE enquiry_properties SET status = 'enquiry_lost'      WHERE status = 'inactive'  AND deleted_at IS NULL;

-- Step 5: retarget the enquiry_properties.status column default to the new
-- canonical starting state so a fresh INSERT that omits `status` lands as
-- 'new_enquiry' instead of the now-inactive 'available' code.
ALTER TABLE enquiry_properties MODIFY COLUMN status VARCHAR(64) NOT NULL DEFAULT 'new_enquiry';
