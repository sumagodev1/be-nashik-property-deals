-- ============================================================
-- 041 — Hospital MD-driven masters seed
-- ============================================================
-- Seeds the only >2-option vocabulary referenced by the 1 Hospital
-- Registration Form in `reference of forms/Hospital Registration Form.md`:
-- the legacy `hospital_type` master key (already in LOOKUP_KEYS via
-- migration 029).
--
-- The MD lists 4 values, with "Surgical" appearing twice — mirrored as-is
-- (admin can dedup via Admin → Masters if intended as a typo for "General").
-- INSERT IGNORE collapses the duplicate at the unique-key (master_key,
-- code) level; the second "Surgical" row is silently skipped.
--
-- All other Hospital form fields are text / number — no masters needed.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/hospitalFormsConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('hospital_type', 'surgical',         'Surgical',         10, 1),
  ('hospital_type', 'multi_speciality', 'Multi-Speciality', 20, 1),
  ('hospital_type', 'maternity',        'Maternity',        30, 1),
  -- MD also lists "Surgical" a second time — INSERT IGNORE will skip this
  -- duplicate due to the unique key (master_key, code). Left in place so
  -- the seed mirrors the MD source verbatim for audit trail.
  ('hospital_type', 'surgical',         'Surgical',         40, 1);
