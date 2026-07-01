-- ============================================================
-- 036 — Plot MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 6 Plot Registration
-- Forms in `reference of forms/Plot Registration Form.md`. All rows go
-- into the generic `master_lookups` table.
--
-- Naming: master keys `plot_*`, display labels "Plot / X".
--
-- 2-option fields (Yes/No, Available/Not Available, Independent/Attached,
-- Meters/Kms) render as inline radio buttons — not seeded.
--
-- `plot_type` and `plot_sub_industrial` are legacy LOOKUP_KEYS. INSERT
-- IGNORE leaves any prior seed alone and tops up the MD values only.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/plotMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── plot_type (top-up — 7 values per MD) ─────────────────────
  ('plot_type', 'residential',  'Residential', 10, 1),
  ('plot_type', 'commercial',   'Commercial',  20, 1),
  ('plot_type', 'industrial',   'Industrial',  30, 1),
  ('plot_type', 'amenity',      'Amenity',     40, 1),
  ('plot_type', 'gunthe_wari',  'Gunthe-wari', 50, 1),
  ('plot_type', 'farm_house',   'Farm House',  60, 1),
  ('plot_type', 'resort',       'Resort',      70, 1),

  -- ── plot_sub_residential ─────────────────────────────────────
  ('plot_sub_residential', 'retention', 'Retention', 10, 1),
  ('plot_sub_residential', 'excess',    'Excess',    20, 1),
  ('plot_sub_residential', 'tds',       'TDS',       30, 1),

  -- ── plot_sub_commercial ──────────────────────────────────────
  ('plot_sub_commercial', 'c1', 'C-1', 10, 1),
  ('plot_sub_commercial', 'c2', 'C-2', 20, 1),
  ('plot_sub_commercial', 'sc', 'SC',  30, 1),

  -- ── plot_sub_industrial (top-up legacy key) ──────────────────
  ('plot_sub_industrial', 'i1', 'I-1', 10, 1),
  ('plot_sub_industrial', 'i2', 'I-2', 20, 1),
  ('plot_sub_industrial', 'i3', 'I-3', 30, 1),
  ('plot_sub_industrial', 'ie', 'IE',  40, 1),

  -- ── plot_facing ──────────────────────────────────────────────
  ('plot_facing', 'east',  'East',  10, 1),
  ('plot_facing', 'west',  'West',  20, 1),
  ('plot_facing', 'north', 'North', 30, 1),
  ('plot_facing', 'south', 'South', 40, 1),

  -- ── plot_corner ──────────────────────────────────────────────
  ('plot_corner', '2_road', '2 Road', 10, 1),
  ('plot_corner', '3_road', '3 Road', 20, 1),
  ('plot_corner', '4_road', '4 Road', 30, 1),

  -- ── plot_layout_status ───────────────────────────────────────
  ('plot_layout_status', 'tentative',        'Tentative',         10, 1),
  ('plot_layout_status', 'tentative_and_na', 'Tentative & N.A',   20, 1),
  ('plot_layout_status', 'final',            'Final',             30, 1),

  -- ── plot_status ──────────────────────────────────────────────
  ('plot_status', 'available',     'Available',     10, 1),
  ('plot_status', 'pipeline',      'Pipeline',      20, 1),
  ('plot_status', 'not_available', 'Not Available', 30, 1),

  -- ── plot_area_unit ───────────────────────────────────────────
  ('plot_area_unit', 'sq_yard', 'Sq. Yard', 10, 1),
  ('plot_area_unit', 'sq_mt',   'Sq. Mt.',  20, 1),
  ('plot_area_unit', 'sq_ft',   'Sq. Ft.',  30, 1),

  -- ── plot_rate_unit ───────────────────────────────────────────
  ('plot_rate_unit', 'war',    'War',     10, 1),
  ('plot_rate_unit', 'sq_mt',  'Sq. Mt',  20, 1),
  ('plot_rate_unit', 'sq_ft',  'Sq. Ft.', 30, 1),
  ('plot_rate_unit', 'guntha', 'Guntha',  40, 1),

  -- ── plot_amenities ───────────────────────────────────────────
  ('plot_amenities', 'wbm_road',         'WBM Road',                  10, 1),
  ('plot_amenities', 'fencing',          'Fencing to whole layout',   20, 1),
  ('plot_amenities', 'tree_plantation',  'Tree Plantation',           30, 1),
  ('plot_amenities', 'street_light',     'Street Light',              40, 1),
  ('plot_amenities', 'plot_demarcation', 'Plot Demarcation',          50, 1),

  -- ── plot_emi_count (14 values) ───────────────────────────────
  ('plot_emi_count', '3',  '3',   10, 1),
  ('plot_emi_count', '6',  '6',   20, 1),
  ('plot_emi_count', '9',  '9',   30, 1),
  ('plot_emi_count', '12', '12',  40, 1),
  ('plot_emi_count', '15', '15',  50, 1),
  ('plot_emi_count', '18', '18',  60, 1),
  ('plot_emi_count', '21', '21',  70, 1),
  ('plot_emi_count', '24', '24',  80, 1),
  ('plot_emi_count', '27', '27',  90, 1),
  ('plot_emi_count', '30', '30', 100, 1),
  ('plot_emi_count', '33', '33', 110, 1),
  ('plot_emi_count', '36', '36', 120, 1),
  ('plot_emi_count', '48', '48', 130, 1),
  ('plot_emi_count', '60', '60', 140, 1),

  -- ── plot_emi_booking_percent (12 values) ─────────────────────
  ('plot_emi_booking_percent', '5',  '5 %',   10, 1),
  ('plot_emi_booking_percent', '10', '10 %',  20, 1),
  ('plot_emi_booking_percent', '15', '15 %',  30, 1),
  ('plot_emi_booking_percent', '20', '20 %',  40, 1),
  ('plot_emi_booking_percent', '25', '25 %',  50, 1),
  ('plot_emi_booking_percent', '30', '30 %',  60, 1),
  ('plot_emi_booking_percent', '35', '35 %',  70, 1),
  ('plot_emi_booking_percent', '40', '40 %',  80, 1),
  ('plot_emi_booking_percent', '45', '45 %',  90, 1),
  ('plot_emi_booking_percent', '50', '50 %', 100, 1),
  ('plot_emi_booking_percent', '55', '55 %', 110, 1),
  ('plot_emi_booking_percent', '60', '60 %', 120, 1),

  -- ── plot_lease_monthly_budget (12 buckets) ───────────────────
  ('plot_lease_monthly_budget', 'below_5000',   'Below Rs. 5000',         10, 1),
  ('plot_lease_monthly_budget', '5000_10000',   'Rs.5000 to Rs.10000',    20, 1),
  ('plot_lease_monthly_budget', '10000_20000',  'Rs.10000 to Rs.20000',   30, 1),
  ('plot_lease_monthly_budget', '20000_30000',  'Rs.20000 to Rs.30000',   40, 1),
  ('plot_lease_monthly_budget', '30000_40000',  'Rs.30000 to Rs.40000',   50, 1),
  ('plot_lease_monthly_budget', '40000_50000',  'Rs.40000 to Rs.50000',   60, 1),
  ('plot_lease_monthly_budget', '50000_60000',  'Rs.50000 to Rs.60000',   70, 1),
  ('plot_lease_monthly_budget', '60000_70000',  'Rs.60000 to Rs.70000',   80, 1),
  ('plot_lease_monthly_budget', '70000_80000',  'Rs.70000 to Rs.80000',   90, 1),
  ('plot_lease_monthly_budget', '80000_90000',  'Rs.80000 to Rs.90000',  100, 1),
  ('plot_lease_monthly_budget', '90000_100000', 'Rs.90000 to Rs.100000', 110, 1),
  ('plot_lease_monthly_budget', 'above_100000', 'Rs.100000 & Above',     120, 1),

  -- ── plot_lease_yearly_budget (20 buckets) ────────────────────
  ('plot_lease_yearly_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('plot_lease_yearly_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('plot_lease_yearly_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('plot_lease_yearly_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('plot_lease_yearly_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('plot_lease_yearly_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('plot_lease_yearly_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('plot_lease_yearly_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('plot_lease_yearly_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('plot_lease_yearly_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('plot_lease_yearly_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('plot_lease_yearly_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('plot_lease_yearly_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('plot_lease_yearly_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('plot_lease_yearly_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('plot_lease_yearly_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('plot_lease_yearly_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('plot_lease_yearly_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('plot_lease_yearly_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('plot_lease_yearly_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1),

  -- ── plot_deposit_budget (20 buckets) ─────────────────────────
  ('plot_deposit_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('plot_deposit_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('plot_deposit_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('plot_deposit_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('plot_deposit_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('plot_deposit_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('plot_deposit_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('plot_deposit_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('plot_deposit_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('plot_deposit_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('plot_deposit_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('plot_deposit_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('plot_deposit_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('plot_deposit_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('plot_deposit_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('plot_deposit_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('plot_deposit_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('plot_deposit_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('plot_deposit_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('plot_deposit_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1);
