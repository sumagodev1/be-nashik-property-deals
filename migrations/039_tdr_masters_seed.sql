-- ============================================================
-- 039 — TDR MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 1 TDR Registration
-- Form in `reference of forms/TDR Registration Form.md`.
--
-- Naming: master keys `tdr_*`, display labels "TDR / X".
--
-- `tdr_zone` and `tdr_floor` are legacy keys (already declared in
-- LOOKUP_KEYS via migration 029). INSERT IGNORE tops them up; pre-existing
-- rows survive untouched.
--
-- Reused shared masters (not seeded here): `road_width`,
-- `allotted_area_to_owner`.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/tdrMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── tdr_zone (top-up legacy key) ─────────────────────────────
  ('tdr_zone', 'a_zone', 'A Zone', 10, 1),
  ('tdr_zone', 'b_zone', 'B Zone', 20, 1),
  ('tdr_zone', 'c_zone', 'C Zone', 30, 1),
  ('tdr_zone', 'd_zone', 'D Zone', 40, 1),

  -- ── tdr_floor (top-up legacy key with 13 floor values) ───────
  ('tdr_floor', 'ground',    'Ground',    10, 1),
  ('tdr_floor', '1st_floor', '1st floor', 20, 1),
  ('tdr_floor', '2nd',       '2nd',       30, 1),
  ('tdr_floor', '3rd',       '3rd',       40, 1),
  ('tdr_floor', '4th',       '4th',       50, 1),
  ('tdr_floor', '5th',       '5th',       60, 1),
  ('tdr_floor', '6th',       '6th',       70, 1),
  ('tdr_floor', '7th',       '7th',       80, 1),
  ('tdr_floor', '8th',       '8th',       90, 1),
  ('tdr_floor', '9th',       '9th',      100, 1),
  ('tdr_floor', '10th',      '10th',     110, 1),
  ('tdr_floor', '11th',      '11th',     120, 1),
  ('tdr_floor', '12th',      '12th',     130, 1),

  -- ── tdr_plot_facing ──────────────────────────────────────────
  ('tdr_plot_facing', 'east',  'East',  10, 1),
  ('tdr_plot_facing', 'west',  'West',  20, 1),
  ('tdr_plot_facing', 'north', 'North', 30, 1),
  ('tdr_plot_facing', 'south', 'South', 40, 1),

  -- ── tdr_development_ratio ────────────────────────────────────
  ('tdr_development_ratio', '40_60', '40:60 %', 10, 1),
  ('tdr_development_ratio', '45_55', '45:55 %', 20, 1),
  ('tdr_development_ratio', '50_50', '50:50 %', 30, 1),

  -- ── tdr_purchase ─────────────────────────────────────────────
  ('tdr_purchase', 'owner',     'Owner',     10, 1),
  ('tdr_purchase', 'developer', 'Developer', 20, 1),
  ('tdr_purchase', '50_50',     '50:50',     30, 1),

  -- ── tdr_status ───────────────────────────────────────────────
  ('tdr_status', 'available',     'Available',     10, 1),
  ('tdr_status', 'pipeline',      'Pipeline',      20, 1),
  ('tdr_status', 'not_available', 'Not Available', 30, 1);
