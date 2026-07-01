-- ============================================================
-- 043 — Pre-Leased Property MD-driven masters seed
-- ============================================================
-- Seeds the single >2-option vocabulary referenced by the 1 Pre-Leased
-- Property Registration Form in `reference of forms/Pre-Leased Property
-- Registration Form.md`:
--   - `pre_leased_project_type` (legacy key from migration 029)
--
-- 2-option fields (Available/Not Available, Owner/Buyer) render as inline
-- radios — not seeded.
--
-- Taluka / District / City reuse the existing shared hierarchical masters.
--
-- INSERT IGNORE leaves any prior seed alone.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/preLeasedFormsConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('pre_leased_project_type', 'flat',         'Flat',         10, 1),
  ('pre_leased_project_type', 'shop',         'Shop',         20, 1),
  ('pre_leased_project_type', 'office_space', 'Office Space', 30, 1),
  ('pre_leased_project_type', 'bunglow',      'Bunglow',      40, 1),
  ('pre_leased_project_type', 'row_house',    'Row House',    50, 1),
  ('pre_leased_project_type', 'plot',         'Plot',         60, 1),
  ('pre_leased_project_type', 'land',         'Land',         70, 1);
