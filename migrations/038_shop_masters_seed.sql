-- ============================================================
-- 038 — Shop MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 12 Shop Registration
-- Forms in `reference of forms/Shop Registration Forms.md`.
--
-- Naming: master keys `shop_*`, display labels "Shop / X".
--
-- 2-option fields (Single Height/Double Height, Available/Not Available,
-- Essential/Not Essential, Allotted/Common, Attached/Not Attached, Yes/No,
-- Under Construction/Ready Possession, Meters/Kms) are NOT seeded — they
-- render as inline radios.
--
-- `shop_expected_tenant` is a legacy LOOKUP_KEY. INSERT IGNORE tops it up
-- with the MD's 12 values; pre-existing rows survive untouched.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/shopMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── shop_facing_specific ─────────────────────────────────────
  ('shop_facing_specific', 'east',               'East',                10, 1),
  ('shop_facing_specific', 'west',               'West',                20, 1),
  ('shop_facing_specific', 'north',              'North',               30, 1),
  ('shop_facing_specific', 'south',              'South',               40, 1),
  ('shop_facing_specific', 'south_not_required', 'South Not Required',  50, 1),

  -- ── shop_facing_any ──────────────────────────────────────────
  ('shop_facing_any', 'east',  'East',  10, 1),
  ('shop_facing_any', 'west',  'West',  20, 1),
  ('shop_facing_any', 'north', 'North', 30, 1),
  ('shop_facing_any', 'south', 'South', 40, 1),

  -- ── shop_age_specific ────────────────────────────────────────
  ('shop_age_specific', 'below_20_yrs', 'Below 20 Yrs', 10, 1),
  ('shop_age_specific', 'below_15_yrs', 'Below 15 Yrs', 20, 1),
  ('shop_age_specific', 'below_10_yrs', 'Below 10 Yrs', 30, 1),
  ('shop_age_specific', 'below_5_yrs',  'Below 5 Yrs',  40, 1),

  -- ── shop_condition ───────────────────────────────────────────
  ('shop_condition', 'unfurnished',     'Unfurnished',     10, 1),
  ('shop_condition', 'semi_furnished',  'Semi-Furnished',  20, 1),
  ('shop_condition', 'fully_furnished', 'Fully Furnished', 30, 1),

  -- ── shop_status ──────────────────────────────────────────────
  ('shop_status', 'available',     'Available',     10, 1),
  ('shop_status', 'pipeline',      'Pipeline',      20, 1),
  ('shop_status', 'not_available', 'Not Available', 30, 1),

  -- ── shop_defect_built ────────────────────────────────────────
  ('shop_defect_built', 'cracks',    'Cracks',    10, 1),
  ('shop_defect_built', 'leakages',  'Leakages',  20, 1),
  ('shop_defect_built', 'slum_area', 'Slum Area', 30, 1),

  -- ── shop_defect_community (sensitive — inactive by default) ──
  ('shop_defect_community', 'slum_area',         'Slum Area',         10, 0),
  ('shop_defect_community', 'muslim_community',  'Muslim Community',  20, 0),
  ('shop_defect_community', 'buddist_community', 'Buddist Community', 30, 0),

  -- ── shop_lease_monthly_budget (12 buckets) ───────────────────
  ('shop_lease_monthly_budget', 'below_5000',   'Below Rs. 5000',        10, 1),
  ('shop_lease_monthly_budget', '5000_10000',   'Rs.5000 to Rs.10000',   20, 1),
  ('shop_lease_monthly_budget', '10000_20000',  'Rs.10000 to Rs.20000',  30, 1),
  ('shop_lease_monthly_budget', '20000_30000',  'Rs.20000 to Rs.30000',  40, 1),
  ('shop_lease_monthly_budget', '30000_40000',  'Rs.30000 to Rs.40000',  50, 1),
  ('shop_lease_monthly_budget', '40000_50000',  'Rs.40000 to Rs.50000',  60, 1),
  ('shop_lease_monthly_budget', '50000_60000',  'Rs.50000 to Rs.60000',  70, 1),
  ('shop_lease_monthly_budget', '60000_70000',  'Rs.60000 to Rs.70000',  80, 1),
  ('shop_lease_monthly_budget', '70000_80000',  'Rs.70000 to Rs.80000',  90, 1),
  ('shop_lease_monthly_budget', '80000_90000',  'Rs.80000 to Rs.90000', 100, 1),
  ('shop_lease_monthly_budget', '90000_100000', 'Rs.90000 to Rs.100000',110, 1),
  ('shop_lease_monthly_budget', 'above_100000', 'Rs.100000 & Above',    120, 1),

  -- ── shop_lease_yearly_budget (20 buckets) ────────────────────
  ('shop_lease_yearly_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('shop_lease_yearly_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('shop_lease_yearly_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('shop_lease_yearly_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('shop_lease_yearly_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('shop_lease_yearly_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('shop_lease_yearly_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('shop_lease_yearly_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('shop_lease_yearly_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('shop_lease_yearly_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('shop_lease_yearly_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('shop_lease_yearly_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('shop_lease_yearly_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('shop_lease_yearly_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('shop_lease_yearly_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('shop_lease_yearly_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('shop_lease_yearly_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('shop_lease_yearly_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('shop_lease_yearly_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('shop_lease_yearly_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1),

  -- ── shop_deposit_budget (20 buckets) ─────────────────────────
  ('shop_deposit_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('shop_deposit_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('shop_deposit_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('shop_deposit_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('shop_deposit_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('shop_deposit_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('shop_deposit_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('shop_deposit_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('shop_deposit_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('shop_deposit_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('shop_deposit_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('shop_deposit_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('shop_deposit_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('shop_deposit_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('shop_deposit_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('shop_deposit_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('shop_deposit_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('shop_deposit_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('shop_deposit_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('shop_deposit_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1),

  -- ── shop_booking_amount_fixed ────────────────────────────────
  ('shop_booking_amount_fixed', '1_lac',  '1 Lac',   10, 1),
  ('shop_booking_amount_fixed', '2_lacs', '2 Lacs',  20, 1),
  ('shop_booking_amount_fixed', '5_lacs', '5 Lacs',  30, 1),
  ('shop_booking_amount_fixed', '10_lacs','10 Lacs', 40, 1),

  -- ── shop_expected_tenant (top-up legacy key with MD values) ──
  ('shop_expected_tenant', 'private_bank',       'Private Bank',       10, 1),
  ('shop_expected_tenant', 'atm_machine',        'ATM Machine',        20, 1),
  ('shop_expected_tenant', 'hotel',              'Hotel',              30, 1),
  ('shop_expected_tenant', 'medical_shop',       'Medical Shop',       40, 1),
  ('shop_expected_tenant', 'hardware',           'Hardware',           50, 1),
  ('shop_expected_tenant', 'saloon',             'Saloon',             60, 1),
  ('shop_expected_tenant', 'kirana_shop',        'Kirana Shop',        70, 1),
  ('shop_expected_tenant', 'ice_cream_parlour',  'Ice Cream Parlour',  80, 1),
  ('shop_expected_tenant', 'beauty_parlour',     'Beauty Parlour',     90, 1),
  ('shop_expected_tenant', 'dr_clinic',          'Dr. Clinic',        100, 1),
  ('shop_expected_tenant', 'office_use',         'Office Use',        110, 1),
  ('shop_expected_tenant', 'godown_purpose',     'Godown Purpose',    120, 1);
