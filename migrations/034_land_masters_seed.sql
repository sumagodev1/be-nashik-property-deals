-- ============================================================
-- 034 — Land MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 6 Land Registration
-- Forms in `reference of forms/Land Registration Forms.md`. All rows go
-- into the generic `master_lookups` table.
--
-- Naming: master keys `land_*`, display labels "Land / X".
--
-- 2-option fields (Yes/No, Meters/Kms) render as inline radio buttons and
-- are NOT seeded.
--
-- `land_type` is a legacy key (already in LOOKUP_KEYS via migration 026/029).
-- INSERT IGNORE leaves any prior seed alone and tops up the MD values only.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/landMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── land_type (top-up — key already declared) ────────────────
  ('land_type', 'agriculture', 'Agriculture', 10, 1),
  ('land_type', 'residential', 'Residential', 20, 1),
  ('land_type', 'commercial',  'Commercial',  30, 1),
  ('land_type', 'industrial',  'Industrial',  40, 1),

  -- ── land_sub_type (combined 14-value vocabulary) ─────────────
  ('land_sub_type', 'bagayati',         'Bagayati',                       10, 1),
  ('land_sub_type', 'jirayati',         'Jirayati',                       20, 1),
  ('land_sub_type', 'malran',           'Malran',                         30, 1),
  ('land_sub_type', 'pure_yellow',      'Pure Yellow',                    40, 1),
  ('land_sub_type', 'gaothan_yellow',   'Gaothan Yellow',                 50, 1),
  ('land_sub_type', 'proposed_yellow',  'Proposed Yellow',                60, 1),
  ('land_sub_type', 'special_yellow',   'Special Yellow',                 70, 1),
  ('land_sub_type', 'c1_local',         'Local Commercial (C-1)',         80, 1),
  ('land_sub_type', 'c2_district',      'District Commercial (C-2)',      90, 1),
  ('land_sub_type', 'sc',               'Shopping Centre (SC)',          100, 1),
  ('land_sub_type', 'i1_service',       'Service Industries (I-1)',      110, 1),
  ('land_sub_type', 'i2_general',       'General Industries (I-2)',      120, 1),
  ('land_sub_type', 'i3_special',       'Special Industries (I-3)',      130, 1),
  ('land_sub_type', 'ie',               'Industrial Estate (IE)',        140, 1),

  -- ── land_category_residential ────────────────────────────────
  ('land_category_residential', 'retention', 'Retention', 10, 1),
  ('land_category_residential', 'excess',    'Excess',    20, 1),
  ('land_category_residential', 'tds',       'TDS',       30, 1),

  -- ── land_category_commercial ─────────────────────────────────
  ('land_category_commercial', 'c1', 'C-1', 10, 1),
  ('land_category_commercial', 'c2', 'C-2', 20, 1),
  ('land_category_commercial', 'sc', 'SC',  30, 1),

  -- ── land_category_industrial ─────────────────────────────────
  ('land_category_industrial', 'i1', 'I-1', 10, 1),
  ('land_category_industrial', 'i2', 'I-2', 20, 1),
  ('land_category_industrial', 'i3', 'I-3', 30, 1),
  ('land_category_industrial', 'ie', 'IE',  40, 1),

  -- ── land_facing ──────────────────────────────────────────────
  ('land_facing', 'east',  'East',  10, 1),
  ('land_facing', 'west',  'West',  20, 1),
  ('land_facing', 'north', 'North', 30, 1),
  ('land_facing', 'south', 'South', 40, 1),

  -- ── land_status ──────────────────────────────────────────────
  ('land_status', 'available',     'Available',     10, 1),
  ('land_status', 'pipeline',      'Pipeline',      20, 1),
  ('land_status', 'not_available', 'Not Available', 30, 1),

  -- ── land_area_unit ───────────────────────────────────────────
  ('land_area_unit', 'guntha',  'Guntha',  10, 1),
  ('land_area_unit', 'acre',    'Acre',    20, 1),
  ('land_area_unit', 'hectare', 'Hectare', 30, 1),

  -- ── land_lease_monthly_budget (12 buckets) ───────────────────
  ('land_lease_monthly_budget', 'below_5000',   'Below Rs. 5000',         10, 1),
  ('land_lease_monthly_budget', '5000_10000',   'Rs.5000 to Rs.10000',    20, 1),
  ('land_lease_monthly_budget', '10000_20000',  'Rs.10000 to Rs.20000',   30, 1),
  ('land_lease_monthly_budget', '20000_30000',  'Rs.20000 to Rs.30000',   40, 1),
  ('land_lease_monthly_budget', '30000_40000',  'Rs.30000 to Rs.40000',   50, 1),
  ('land_lease_monthly_budget', '40000_50000',  'Rs.40000 to Rs.50000',   60, 1),
  ('land_lease_monthly_budget', '50000_60000',  'Rs.50000 to Rs.60000',   70, 1),
  ('land_lease_monthly_budget', '60000_70000',  'Rs.60000 to Rs.70000',   80, 1),
  ('land_lease_monthly_budget', '70000_80000',  'Rs.70000 to Rs.80000',   90, 1),
  ('land_lease_monthly_budget', '80000_90000',  'Rs.80000 to Rs.90000',  100, 1),
  ('land_lease_monthly_budget', '90000_100000', 'Rs.90000 to Rs.100000', 110, 1),
  ('land_lease_monthly_budget', 'above_100000', 'Rs.100000 & Above',     120, 1),

  -- ── land_lease_yearly_budget (20 buckets) ────────────────────
  ('land_lease_yearly_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('land_lease_yearly_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('land_lease_yearly_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('land_lease_yearly_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('land_lease_yearly_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('land_lease_yearly_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('land_lease_yearly_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('land_lease_yearly_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('land_lease_yearly_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('land_lease_yearly_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('land_lease_yearly_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('land_lease_yearly_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('land_lease_yearly_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('land_lease_yearly_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('land_lease_yearly_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('land_lease_yearly_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('land_lease_yearly_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('land_lease_yearly_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('land_lease_yearly_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('land_lease_yearly_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1),

  -- ── land_deposit_budget (20 buckets) ─────────────────────────
  ('land_deposit_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('land_deposit_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('land_deposit_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('land_deposit_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('land_deposit_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('land_deposit_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('land_deposit_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('land_deposit_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('land_deposit_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('land_deposit_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('land_deposit_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('land_deposit_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('land_deposit_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('land_deposit_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('land_deposit_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('land_deposit_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('land_deposit_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('land_deposit_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('land_deposit_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('land_deposit_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1);
