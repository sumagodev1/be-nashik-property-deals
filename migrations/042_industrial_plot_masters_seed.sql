-- ============================================================
-- 042 — Industrial Plot MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 1 Industrial Plot
-- Registration Form in `reference of forms/Industrial Plot Registration
-- Form.md`.
--
-- Naming: master keys `industrial_*`, display labels "Industrial Plot / X".
--
-- 2-option fields (Available/Not Available, Yes/No, Single Phase/Three
-- Phase Connection, Paid/Not Paid, Pending/Not Pending, Green/Orange,
-- Visible/Not Visible, Present/Absent, Clear/Not Clear, Functional/Non
-- Functional, Possible/Not Possible, Legal/Illegal, Paid/Unpaid) render
-- as inline radios — not seeded.
--
-- Reused: `road_width` (shared, not seeded here).
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/industrialPlotMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── industrial_plot_status ───────────────────────────────────
  ('industrial_plot_status', 'freehold',                'Freehold',                 10, 1),
  ('industrial_plot_status', 'leasehold',               'Leasehold',                20, 1),
  ('industrial_plot_status', 'midc_allotted',           'MIDC Allotted',            30, 1),
  ('industrial_plot_status', 'private_industrial_park', 'Private Industrial Park',  40, 1),

  -- ── industrial_permitted_industry ────────────────────────────
  ('industrial_permitted_industry', 'chemical',   'Chemical',   10, 1),
  ('industrial_permitted_industry', 'food',       'Food',       20, 1),
  ('industrial_permitted_industry', 'pharma',     'Pharma',     30, 1),
  ('industrial_permitted_industry', 'mechanical', 'Mechanical', 40, 1),

  -- ── industrial_previous_transfer_order ───────────────────────
  ('industrial_previous_transfer_order', '1st', '1st', 10, 1),
  ('industrial_previous_transfer_order', '2nd', '2nd', 20, 1),
  ('industrial_previous_transfer_order', '3rd', '3rd', 30, 1),
  ('industrial_previous_transfer_order', '4th', '4th', 40, 1),
  ('industrial_previous_transfer_order', '5th', '5th', 50, 1),

  -- ── industrial_bank_statement_period ─────────────────────────
  ('industrial_bank_statement_period', '6_months', '6 months', 10, 1),
  ('industrial_bank_statement_period', '1_year',   '1 Year',   20, 1),
  ('industrial_bank_statement_period', '3_years',  '3 Years',  30, 1);
