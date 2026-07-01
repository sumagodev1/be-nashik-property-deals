-- ============================================================
-- 037 — SEZ MD-driven masters seed
-- ============================================================
-- The 4 SEZ Registration Forms in `reference of forms/SEZ Registration
-- Form.md` reference three >2-option masters:
--   1. `sez_type` (legacy key from migration 029) — topped up here with
--       the MD's 4 canonical values.
--   2. `sez_infrastructural_facilities` (NEW) — multi-select for the
--       "Infrastructural Facilities" field, MD lists 5 values.
--   3. `sez_fiscal_incentives` (NEW) — multi-select for the "Fiscal
--       Incentives" field, MD lists 3 values.
--
-- All other fields in the SEZ forms are text / textarea / number, or reuse
-- the existing shared `district` / `taluka` / `shivar` hierarchical masters.
--
-- INSERT IGNORE is idempotent — pre-existing rows survive untouched.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/sezFormsConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── sez_type (top-up legacy key) ─────────────────────────────
  ('sez_type', 'textile',         'Textile',         10, 1),
  ('sez_type', 'chemical',        'Chemical',        20, 1),
  ('sez_type', 'food_processing', 'Food Processing', 30, 1),
  ('sez_type', 'multi_product',   'Multi Product',   40, 1),

  -- ── sez_infrastructural_facilities (multi-select) ────────────
  ('sez_infrastructural_facilities', 'developed_land',           'Developed land',                    10, 1),
  ('sez_infrastructural_facilities', 'standard_factory_buildings','Standard design factory buildings', 20, 1),
  ('sez_infrastructural_facilities', 'built_up_sheds',           'Built-up sheds',                    30, 1),
  ('sez_infrastructural_facilities', 'roads',                    'Roads',                             40, 1),
  ('sez_infrastructural_facilities', 'power_supply_drainage',    'Power supply and drainage',         50, 1),

  -- ── sez_fiscal_incentives (multi-select) ─────────────────────
  ('sez_fiscal_incentives', 'customs_exemption',     'Customs Exemption',     10, 1),
  ('sez_fiscal_incentives', 'excise_exemption',      'Excise Exemption',      20, 1),
  ('sez_fiscal_incentives', 'income_tax_exemption',  'Income Tax Exemption',  30, 1);
