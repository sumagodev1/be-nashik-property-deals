-- ============================================================
-- 084 — Rowhouse MD-driven masters seed
-- ============================================================
-- Seeds every vocabulary referenced by the Rowhouse Registration Forms.
-- Rowhouse is a NEW property type parallel to Bungalow (migration 083);
-- these masters are Rowhouse-specific and MUST NOT reuse bungalow_*
-- vocabularies (per product spec: separate masters for every dimension).
--
-- Naming: master keys are `rowhouse_*`, hierarchical labels start with
-- `Rowhouse / ` so they group in the Admin → Masters sidebar next to the
-- Bungalow set.
--
-- 2-option fields (Yes/No, Available/Not Available, Essential/Not Essential,
-- Under Construction/Ready Possession) stay inline as radios per project
-- spec. INSERT IGNORE keeps the migration idempotent.
--
-- Not included: 'rowhouse_status' — the per-property Status master was
-- retired globally in T-2026-081 in favour of the shared `status_type` /
-- `enquiry_status` masters. Rowhouse uses those global masters directly.
--
-- Related: server/services/masters/management.js LOOKUP_KEYS / MASTER_LABELS,
-- src/admin/pages/Inventory/dynamic/rowhouseMastersConfig.js on the FE.
-- ============================================================

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── rowhouse_property_position ──────────────────────────────
  -- NEW field on Rowhouse (replaces "Bunglow Type"): Left Corner /
  -- Middle / Right Corner. Rendered as a select in every Rowhouse form.
  ('rowhouse_property_position', 'left_corner',  'Left Corner',  10, 1),
  ('rowhouse_property_position', 'middle',       'Middle',       20, 1),
  ('rowhouse_property_position', 'right_corner', 'Right Corner', 30, 1),

  -- ── rowhouse_size ───────────────────────────────────────────
  ('rowhouse_size', '1bhk', '1BHK', 10, 1),
  ('rowhouse_size', '2bhk', '2BHK', 20, 1),
  ('rowhouse_size', '3bhk', '3BHK', 30, 1),
  ('rowhouse_size', '4bhk', '4BHK', 40, 1),
  ('rowhouse_size', '5bhk', '5BHK', 50, 1),
  ('rowhouse_size', '6bhk', '6BHK', 60, 1),
  ('rowhouse_size', '7bhk', '7BHK', 70, 1),
  ('rowhouse_size', '8bhk', '8BHK', 80, 1),

  -- ── rowhouse_facing_specific ────────────────────────────────
  ('rowhouse_facing_specific', 'east',               'East',                10, 1),
  ('rowhouse_facing_specific', 'west',               'West',                20, 1),
  ('rowhouse_facing_specific', 'north',              'North',               30, 1),
  ('rowhouse_facing_specific', 'south',              'South',               40, 1),
  ('rowhouse_facing_specific', 'south_not_required', 'South Not Required',  50, 1),

  -- ── rowhouse_facing_any ─────────────────────────────────────
  ('rowhouse_facing_any', 'east',  'East',  10, 1),
  ('rowhouse_facing_any', 'west',  'West',  20, 1),
  ('rowhouse_facing_any', 'north', 'North', 30, 1),
  ('rowhouse_facing_any', 'south', 'South', 40, 1),

  -- ── rowhouse_age_specific ───────────────────────────────────
  ('rowhouse_age_specific', 'below_20_yrs', 'Below 20 Yrs', 10, 1),
  ('rowhouse_age_specific', 'below_15_yrs', 'Below 15 Yrs', 20, 1),
  ('rowhouse_age_specific', 'below_10_yrs', 'Below 10 Yrs', 30, 1),
  ('rowhouse_age_specific', 'below_5_yrs',  'Below 5 Yrs',  40, 1),

  -- ── rowhouse_age_range (parallel to bunglow_age_range) ──────
  ('rowhouse_age_range', 'below-5-yrs',   'Below 5 Yrs',   10, 1),
  ('rowhouse_age_range', '5-to-10-yrs',   '5-10 Yrs',      20, 1),
  ('rowhouse_age_range', '10-to-15-yrs',  '10-15 Yrs',     30, 1),
  ('rowhouse_age_range', '15-to-20-yrs',  '15-20 Yrs',     40, 1),
  ('rowhouse_age_range', '20-to-25-yrs',  '20-25 Yrs',     50, 1),
  ('rowhouse_age_range', '25-to-30-yrs',  '25-30 Yrs',     60, 1),
  ('rowhouse_age_range', '30-to-40-yrs',  '30-40 Yrs',     70, 1),
  ('rowhouse_age_range', '40-to-50-yrs',  '40-50 Yrs',     80, 1),
  ('rowhouse_age_range', '50-to-60-yrs',  '50-60 Yrs',     90, 1),
  ('rowhouse_age_range', '60-to-70-yrs',  '60-70 Yrs',    100, 1),
  ('rowhouse_age_range', '70-to-80-yrs',  '70-80 Yrs',    110, 1),
  ('rowhouse_age_range', '80-to-100-yrs', '80-100 Yrs',   120, 1),
  ('rowhouse_age_range', 'above-100-yrs', 'Above 100 Yrs',130, 1),

  -- ── rowhouse_condition ──────────────────────────────────────
  ('rowhouse_condition', 'unfurnished',     'Unfurnished',     10, 1),
  ('rowhouse_condition', 'semi_furnished',  'Semi-Furnished',  20, 1),
  ('rowhouse_condition', 'fully_furnished', 'Fully Furnished', 30, 1),

  -- ── rowhouse_defect_built ───────────────────────────────────
  ('rowhouse_defect_built', 'cracks',    'Cracks',    10, 1),
  ('rowhouse_defect_built', 'leakages',  'Leakages',  20, 1),
  ('rowhouse_defect_built', 'slum_area', 'Slum Area', 30, 1),

  -- ── rowhouse_defect_community (socially sensitive; default OFF)
  ('rowhouse_defect_community', 'slum_area',         'Slum Area',         10, 0),
  ('rowhouse_defect_community', 'muslim_community',  'Muslim Community',  20, 0),
  ('rowhouse_defect_community', 'buddist_community', 'Buddist Community', 30, 0),

  -- ── rowhouse_lease_monthly_budget (12 buckets) ──────────────
  ('rowhouse_lease_monthly_budget', 'below_5000',   'Below Rs. 5000',            10, 1),
  ('rowhouse_lease_monthly_budget', '5000_10000',   'Rs.5000 to Rs.10000',       20, 1),
  ('rowhouse_lease_monthly_budget', '10000_20000',  'Rs.10000 to Rs.20000',      30, 1),
  ('rowhouse_lease_monthly_budget', '20000_30000',  'Rs.20000 to Rs.30000',      40, 1),
  ('rowhouse_lease_monthly_budget', '30000_40000',  'Rs.30000 to Rs.40000',      50, 1),
  ('rowhouse_lease_monthly_budget', '40000_50000',  'Rs.40000 to Rs.50000',      60, 1),
  ('rowhouse_lease_monthly_budget', '50000_60000',  'Rs.50000 to Rs.60000',      70, 1),
  ('rowhouse_lease_monthly_budget', '60000_70000',  'Rs.60000 to Rs.70000',      80, 1),
  ('rowhouse_lease_monthly_budget', '70000_80000',  'Rs.70000 to Rs.80000',      90, 1),
  ('rowhouse_lease_monthly_budget', '80000_90000',  'Rs.80000 to Rs.90000',     100, 1),
  ('rowhouse_lease_monthly_budget', '90000_100000', 'Rs.90000 to Rs.100000',    110, 1),
  ('rowhouse_lease_monthly_budget', 'above_100000', 'Rs.100000 & Above',        120, 1),

  -- ── rowhouse_lease_yearly_budget (20 buckets) ───────────────
  ('rowhouse_lease_yearly_budget', 'below_50000', 'Below Rs. 50000',            10, 1),
  ('rowhouse_lease_yearly_budget', '50k_1l',      'Rs.50000 to Rs.100000',      20, 1),
  ('rowhouse_lease_yearly_budget', '1l_2l',       'Rs.100000 to Rs.200000',     30, 1),
  ('rowhouse_lease_yearly_budget', '2l_3l',       'Rs.200000 to Rs.300000',     40, 1),
  ('rowhouse_lease_yearly_budget', '3l_4l',       'Rs.300000 to Rs.400000',     50, 1),
  ('rowhouse_lease_yearly_budget', '4l_5l',       'Rs.400000 to Rs.500000',     60, 1),
  ('rowhouse_lease_yearly_budget', '5l_6l',       'Rs.500000 to Rs.600000',     70, 1),
  ('rowhouse_lease_yearly_budget', '6l_7l',       'Rs.600000 to Rs.700000',     80, 1),
  ('rowhouse_lease_yearly_budget', '7l_8l',       'Rs.700000 to Rs.800000',     90, 1),
  ('rowhouse_lease_yearly_budget', '8l_9l',       'Rs.800000 to Rs.900000',    100, 1),
  ('rowhouse_lease_yearly_budget', '9l_10l',      'Rs.900000 to Rs.1000000',   110, 1),
  ('rowhouse_lease_yearly_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',  120, 1),
  ('rowhouse_lease_yearly_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',  130, 1),
  ('rowhouse_lease_yearly_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',  140, 1),
  ('rowhouse_lease_yearly_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',  150, 1),
  ('rowhouse_lease_yearly_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',  160, 1),
  ('rowhouse_lease_yearly_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',  170, 1),
  ('rowhouse_lease_yearly_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',  180, 1),
  ('rowhouse_lease_yearly_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',  190, 1),
  ('rowhouse_lease_yearly_budget', 'above_50l',   'Rs.5000000 & Above',        200, 1),

  -- ── rowhouse_deposit_budget (same 20 buckets) ───────────────
  ('rowhouse_deposit_budget', 'below_50000', 'Below Rs. 50000',            10, 1),
  ('rowhouse_deposit_budget', '50k_1l',      'Rs.50000 to Rs.100000',      20, 1),
  ('rowhouse_deposit_budget', '1l_2l',       'Rs.100000 to Rs.200000',     30, 1),
  ('rowhouse_deposit_budget', '2l_3l',       'Rs.200000 to Rs.300000',     40, 1),
  ('rowhouse_deposit_budget', '3l_4l',       'Rs.300000 to Rs.400000',     50, 1),
  ('rowhouse_deposit_budget', '4l_5l',       'Rs.400000 to Rs.500000',     60, 1),
  ('rowhouse_deposit_budget', '5l_6l',       'Rs.500000 to Rs.600000',     70, 1),
  ('rowhouse_deposit_budget', '6l_7l',       'Rs.600000 to Rs.700000',     80, 1),
  ('rowhouse_deposit_budget', '7l_8l',       'Rs.700000 to Rs.800000',     90, 1),
  ('rowhouse_deposit_budget', '8l_9l',       'Rs.800000 to Rs.900000',    100, 1),
  ('rowhouse_deposit_budget', '9l_10l',      'Rs.900000 to Rs.1000000',   110, 1),
  ('rowhouse_deposit_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',  120, 1),
  ('rowhouse_deposit_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',  130, 1),
  ('rowhouse_deposit_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',  140, 1),
  ('rowhouse_deposit_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',  150, 1),
  ('rowhouse_deposit_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',  160, 1),
  ('rowhouse_deposit_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',  170, 1),
  ('rowhouse_deposit_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',  180, 1),
  ('rowhouse_deposit_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',  190, 1),
  ('rowhouse_deposit_budget', 'above_50l',   'Rs.5000000 & Above',        200, 1),

  -- ── rowhouse_rent_monthly_budget (21 buckets) ───────────────
  ('rowhouse_rent_monthly_budget', 'below_5000',    'Below Rs.5000/-',            10, 1),
  ('rowhouse_rent_monthly_budget', '5000_10000',    'Rs.5000/- to Rs.10000/-',    20, 1),
  ('rowhouse_rent_monthly_budget', '10000_15000',   'Rs.10000/- to Rs.15000/-',   30, 1),
  ('rowhouse_rent_monthly_budget', '15000_20000',   'Rs.15000/- to Rs.20000/-',   40, 1),
  ('rowhouse_rent_monthly_budget', '20000_25000',   'Rs.20000/- to Rs.25000/-',   50, 1),
  ('rowhouse_rent_monthly_budget', '25000_30000',   'Rs.25000/- to Rs.30000/-',   60, 1),
  ('rowhouse_rent_monthly_budget', '30000_35000',   'Rs.30000/- to Rs.35000/-',   70, 1),
  ('rowhouse_rent_monthly_budget', '35000_40000',   'Rs.35000/- to Rs.40000/-',   80, 1),
  ('rowhouse_rent_monthly_budget', '40000_45000',   'Rs.40000/- to Rs.45000/-',   90, 1),
  ('rowhouse_rent_monthly_budget', '45000_50000',   'Rs.45000/- to Rs.50000/-',  100, 1),
  ('rowhouse_rent_monthly_budget', '50000_55000',   'Rs.50000/- to Rs.55000/-',  110, 1),
  ('rowhouse_rent_monthly_budget', '55000_60000',   'Rs.55000/- to Rs.60000/-',  120, 1),
  ('rowhouse_rent_monthly_budget', '60000_65000',   'Rs.60000/- to Rs.65000/-',  130, 1),
  ('rowhouse_rent_monthly_budget', '65000_70000',   'Rs.65000/- to Rs.70000/-',  140, 1),
  ('rowhouse_rent_monthly_budget', '70000_75000',   'Rs.70000/- to Rs.75000/-',  150, 1),
  ('rowhouse_rent_monthly_budget', '75000_80000',   'Rs.75000/- to Rs.80000/-',  160, 1),
  ('rowhouse_rent_monthly_budget', '80000_85000',   'Rs.80000/- to Rs.85000/-',  170, 1),
  ('rowhouse_rent_monthly_budget', '85000_90000',   'Rs.85000/- to Rs.90000/-',  180, 1),
  ('rowhouse_rent_monthly_budget', '90000_95000',   'Rs.90000/- to Rs.95000/-',  190, 1),
  ('rowhouse_rent_monthly_budget', '95000_100000',  'Rs.95000/- to Rs.100000/-', 200, 1),
  ('rowhouse_rent_monthly_budget', 'above_100000',  'Above Rs.100000/-',         210, 1),

  -- ── rowhouse_rent_deposit_budget (19 buckets) ───────────────
  ('rowhouse_rent_deposit_budget', 'below_10000',    'Below Rs.10000/-',           10, 1),
  ('rowhouse_rent_deposit_budget', '10000_20000',    'Rs.10000/- to Rs.20000/-',   20, 1),
  ('rowhouse_rent_deposit_budget', '20000_30000',    'Rs.20000/- to Rs.30000/-',   30, 1),
  ('rowhouse_rent_deposit_budget', '30000_40000',    'Rs.30000/- to Rs.40000/-',   40, 1),
  ('rowhouse_rent_deposit_budget', '40000_50000',    'Rs.40000/- to Rs.50000/-',   50, 1),
  ('rowhouse_rent_deposit_budget', '50000_60000',    'Rs.50000/- to Rs.60000/-',   60, 1),
  ('rowhouse_rent_deposit_budget', '60000_70000',    'Rs.60000/- to Rs.70000/-',   70, 1),
  ('rowhouse_rent_deposit_budget', '70000_80000',    'Rs.70000/- to Rs.80000/-',   80, 1),
  ('rowhouse_rent_deposit_budget', '80000_90000',    'Rs.80000/- to Rs.90000/-',   90, 1),
  ('rowhouse_rent_deposit_budget', '90000_100000',   'Rs.90000/- to Rs.100000/-', 100, 1),
  ('rowhouse_rent_deposit_budget', '100000_150000',  'Rs.100000/- to Rs.150000/-',110, 1),
  ('rowhouse_rent_deposit_budget', '150000_200000',  'Rs.150000/- to Rs.200000/-',120, 1),
  ('rowhouse_rent_deposit_budget', '200000_250000',  'Rs.200000/- to Rs.250000/-',130, 1),
  ('rowhouse_rent_deposit_budget', '250000_300000',  'Rs.250000/- to Rs.300000/-',140, 1),
  ('rowhouse_rent_deposit_budget', '300000_350000',  'Rs.300000/- to Rs.350000/-',150, 1),
  ('rowhouse_rent_deposit_budget', '350000_400000',  'Rs.350000/- to Rs.400000/-',160, 1),
  ('rowhouse_rent_deposit_budget', '400000_450000',  'Rs.400000/- to Rs.450000/-',170, 1),
  ('rowhouse_rent_deposit_budget', '450000_500000',  'Rs.450000/- to Rs.500000/-',180, 1),
  ('rowhouse_rent_deposit_budget', 'above_500000',   'Above 500000/-',            190, 1),

  -- ── rowhouse_tenant_preference (12 entries) ─────────────────
  ('rowhouse_tenant_preference', 'company_employee',     'Company Employee',      10, 1),
  ('rowhouse_tenant_preference', 'bank_employee',        'Bank Employee',         20, 1),
  ('rowhouse_tenant_preference', 'bachalor',             'Bachalor',              30, 1),
  ('rowhouse_tenant_preference', 'family',               'Family',                40, 1),
  ('rowhouse_tenant_preference', 'boys_student',         'Boys Student',          50, 1),
  ('rowhouse_tenant_preference', 'girl_student',         'Girl Student',          60, 1),
  ('rowhouse_tenant_preference', 'paying_guest',         'Paying Guest',          70, 1),
  ('rowhouse_tenant_preference', 'senior_citizen',       'Senior Citizen',        80, 1),
  ('rowhouse_tenant_preference', 'muslim_family',        'Muslim Family',         90, 1),
  ('rowhouse_tenant_preference', 'buddist_family',       'Buddist Family',       100, 1),
  ('rowhouse_tenant_preference', 'maharashtrian_family', 'Maharashtrian Family', 110, 1),
  ('rowhouse_tenant_preference', 'other_state_person',   'Other State Person',   120, 1),

  -- ── rowhouse_booking_amount_fixed ───────────────────────────
  ('rowhouse_booking_amount_fixed', '1_lac',   '1 Lac',   10, 1),
  ('rowhouse_booking_amount_fixed', '2_lacs',  '2 Lacs',  20, 1),
  ('rowhouse_booking_amount_fixed', '5_lacs',  '5 Lacs',  30, 1),
  ('rowhouse_booking_amount_fixed', '10_lacs', '10 Lacs', 40, 1),

  -- ── rowhouse_possession_after ───────────────────────────────
  ('rowhouse_possession_after', 'after_1_year',  'After 1 Year',   10, 1),
  ('rowhouse_possession_after', 'after_2_years', 'After 2 Years',  20, 1),
  ('rowhouse_possession_after', 'after_3_years', 'After 3 Years',  30, 1),
  ('rowhouse_possession_after', 'after_4_years', 'After 4 Years',  40, 1),
  ('rowhouse_possession_after', 'after_5_years', 'After 5 Years',  50, 1),
  ('rowhouse_possession_after', 'after_6_years', 'After 6 Years',  60, 1),
  ('rowhouse_possession_after', 'after_7_years', 'After 7 Years',  70, 1),
  ('rowhouse_possession_after', 'after_8_years', 'After 8 Years',  80, 1),

  -- ── amenities_rowhouse_furniture ────────────────────────────
  ('amenities_rowhouse_furniture', 'tv',              'TV',              10, 1),
  ('amenities_rowhouse_furniture', 'sofa',            'Sofa',            20, 1),
  ('amenities_rowhouse_furniture', 'fridge',          'Fridge',          30, 1),
  ('amenities_rowhouse_furniture', 'washing-machine', 'Washing Machine', 40, 1),
  ('amenities_rowhouse_furniture', 'ac',              'A.C.',            50, 1),
  ('amenities_rowhouse_furniture', 'gas-facility',    'Gas Facility',    60, 1),
  ('amenities_rowhouse_furniture', 'wardrobe',        'Wardrobe',        70, 1),
  ('amenities_rowhouse_furniture', 'bed',             'Bed',             80, 1),
  ('amenities_rowhouse_furniture', 'dining-table',    'Dining Table',    90, 1);
