-- ============================================================
-- 044 — Project MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 1 Project Registration
-- Form in `reference of forms/Project Registration Form.md`.
--
-- Naming: master keys `project_*`, display labels "Project / X".
--
-- 2-option fields (Yes/No, Available/Not Available, Attached/Not Attached,
-- Allotted/Common, On-Going Project/New Project) render as inline radios —
-- not seeded.
--
-- Floor reuses the shared `floor_level` master (not seeded here).
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/projectMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── project_facing ───────────────────────────────────────────
  ('project_facing', 'east',  'East',  10, 1),
  ('project_facing', 'west',  'West',  20, 1),
  ('project_facing', 'north', 'North', 30, 1),
  ('project_facing', 'south', 'South', 40, 1),

  -- ── project_condition ────────────────────────────────────────
  ('project_condition', 'unfurnished',     'Unfurnished',     10, 1),
  ('project_condition', 'semi_furnished',  'Semi-Furnished',  20, 1),
  ('project_condition', 'fully_furnished', 'Fully Furnished', 30, 1),

  -- ── project_defect_built ─────────────────────────────────────
  ('project_defect_built', 'cracks',    'Cracks',    10, 1),
  ('project_defect_built', 'leakages',  'Leakages',  20, 1),
  ('project_defect_built', 'slum_area', 'Slum Area', 30, 1),

  -- ── project_sale_status ──────────────────────────────────────
  ('project_sale_status', 'available',     'Available',     10, 1),
  ('project_sale_status', 'pipeline',      'Pipeline',      20, 1),
  ('project_sale_status', 'not_available', 'Not Available', 30, 1);
