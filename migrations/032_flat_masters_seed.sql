-- ============================================================
-- 032 — Flat MD-driven masters seed
-- ============================================================
-- Seeds every >2-option vocabulary referenced by the Flat Registration
-- Forms in `reference of forms/Flat Registration Forms.md`. All rows go
-- into the generic `master_lookups` table.
--
-- Naming: master keys `flat_*`, display labels "Flat / X".
--
-- 2-option fields (Yes/No, Available/Not Available, Essential/Not Essential,
-- Allotted/Common, Project/Standlone Apartment, Part/Full Completion,
-- Apartment/Society where applicable, Under Construction/Ready Possession)
-- are NOT seeded — they render as inline radio buttons.
--
-- INSERT IGNORE is idempotent. Existing seeded rows are preserved.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/flatMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── flat_type ────────────────────────────────────────────────
  ('flat_type', 'regular',    'Regular',    10, 1),
  ('flat_type', 'duplex',     'Duplex',     20, 1),
  ('flat_type', 'pent_house', 'Pent House', 30, 1),

  -- ── flat_size ────────────────────────────────────────────────
  ('flat_size', '1hk',  '1HK',  10, 1),
  ('flat_size', '1bhk', '1BHK', 20, 1),
  ('flat_size', '2bhk', '2BHK', 30, 1),
  ('flat_size', '3bhk', '3BHK', 40, 1),
  ('flat_size', '4bhk', '4BHK', 50, 1),
  ('flat_size', '5bhk', '5BHK', 60, 1),
  ('flat_size', '6bhk', '6BHK', 70, 1),
  ('flat_size', '7bhk', '7BHK', 80, 1),

  -- ── flat_facing_specific ─────────────────────────────────────
  ('flat_facing_specific', 'east',               'East',                10, 1),
  ('flat_facing_specific', 'west',               'West',                20, 1),
  ('flat_facing_specific', 'north',              'North',               30, 1),
  ('flat_facing_specific', 'south',              'South',               40, 1),
  ('flat_facing_specific', 'south_not_required', 'South Not Required',  50, 1),

  -- ── flat_facing_any ──────────────────────────────────────────
  ('flat_facing_any', 'east',  'East',  10, 1),
  ('flat_facing_any', 'west',  'West',  20, 1),
  ('flat_facing_any', 'north', 'North', 30, 1),
  ('flat_facing_any', 'south', 'South', 40, 1),

  -- ── flat_age_specific ────────────────────────────────────────
  ('flat_age_specific', 'below_20_yrs', 'Below 20 Yrs', 10, 1),
  ('flat_age_specific', 'below_15_yrs', 'Below 15 Yrs', 20, 1),
  ('flat_age_specific', 'below_10_yrs', 'Below 10 Yrs', 30, 1),
  ('flat_age_specific', 'below_5_yrs',  'Below 5 Yrs',  40, 1),

  -- ── flat_condition ───────────────────────────────────────────
  ('flat_condition', 'unfurnished',     'Unfurnished',     10, 1),
  ('flat_condition', 'semi_furnished',  'Semi-Furnished',  20, 1),
  ('flat_condition', 'fully_furnished', 'Fully Furnished', 30, 1),

  -- ── flat_status ──────────────────────────────────────────────
  ('flat_status', 'available',     'Available',     10, 1),
  ('flat_status', 'pipeline',      'Pipeline',      20, 1),
  ('flat_status', 'not_available', 'Not Available', 30, 1),

  -- ── flat_nature ──────────────────────────────────────────────
  ('flat_nature', 'apartment', 'Apartment', 10, 1),
  ('flat_nature', 'society',   'Society',   20, 1),
  ('flat_nature', 'any_other', 'Any Other', 30, 1),

  -- ── flat_parking_type ────────────────────────────────────────
  ('flat_parking_type', 'allotted', 'Allotted', 10, 1),
  ('flat_parking_type', 'common',   'Common',   20, 1),
  ('flat_parking_type', 'any',      'Any',      30, 1),

  -- ── flat_no_of_car_parking ───────────────────────────────────
  ('flat_no_of_car_parking', '1', '1', 10, 1),
  ('flat_no_of_car_parking', '2', '2', 20, 1),
  ('flat_no_of_car_parking', '3', '3', 30, 1),
  ('flat_no_of_car_parking', '4', '4', 40, 1),

  -- ── flat_defect_built ────────────────────────────────────────
  ('flat_defect_built', 'cracks',    'Cracks',    10, 1),
  ('flat_defect_built', 'leakages',  'Leakages',  20, 1),
  ('flat_defect_built', 'slum_area', 'Slum Area', 30, 1),

  -- ── flat_defect_community (sensitive — inactive by default) ──
  ('flat_defect_community', 'slum_area',         'Slum Area',         10, 0),
  ('flat_defect_community', 'muslim_community',  'Muslim Community',  20, 0),
  ('flat_defect_community', 'buddist_community', 'Buddist Community', 30, 0),

  -- ── flat_lease_monthly_budget (12 buckets) ───────────────────
  ('flat_lease_monthly_budget', 'below_5000',    'Below Rs. 5000',         10, 1),
  ('flat_lease_monthly_budget', '5000_10000',    'Rs.5000 to Rs.10000',    20, 1),
  ('flat_lease_monthly_budget', '10000_20000',   'Rs.10000 to Rs.20000',   30, 1),
  ('flat_lease_monthly_budget', '20000_30000',   'Rs.20000 to Rs.30000',   40, 1),
  ('flat_lease_monthly_budget', '30000_40000',   'Rs.30000 to Rs.40000',   50, 1),
  ('flat_lease_monthly_budget', '40000_50000',   'Rs.40000 to Rs.50000',   60, 1),
  ('flat_lease_monthly_budget', '50000_60000',   'Rs.50000 to Rs.60000',   70, 1),
  ('flat_lease_monthly_budget', '60000_70000',   'Rs.60000 to Rs.70000',   80, 1),
  ('flat_lease_monthly_budget', '70000_80000',   'Rs.70000 to Rs.80000',   90, 1),
  ('flat_lease_monthly_budget', '80000_90000',   'Rs.80000 to Rs.90000',  100, 1),
  ('flat_lease_monthly_budget', '90000_100000',  'Rs.90000 to Rs.100000', 110, 1),
  ('flat_lease_monthly_budget', 'above_100000',  'Rs.100000 & Above',     120, 1),

  -- ── flat_lease_yearly_budget (20 buckets) ────────────────────
  ('flat_lease_yearly_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('flat_lease_yearly_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('flat_lease_yearly_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('flat_lease_yearly_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('flat_lease_yearly_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('flat_lease_yearly_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('flat_lease_yearly_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('flat_lease_yearly_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('flat_lease_yearly_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('flat_lease_yearly_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('flat_lease_yearly_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('flat_lease_yearly_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('flat_lease_yearly_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('flat_lease_yearly_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('flat_lease_yearly_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('flat_lease_yearly_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('flat_lease_yearly_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('flat_lease_yearly_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('flat_lease_yearly_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('flat_lease_yearly_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1),

  -- ── flat_deposit_budget (20 buckets) ─────────────────────────
  ('flat_deposit_budget', 'below_50000', 'Below Rs. 50000',          10, 1),
  ('flat_deposit_budget', '50k_1l',      'Rs.50000 to Rs.100000',    20, 1),
  ('flat_deposit_budget', '1l_2l',       'Rs.100000 to Rs.200000',   30, 1),
  ('flat_deposit_budget', '2l_3l',       'Rs.200000 to Rs.300000',   40, 1),
  ('flat_deposit_budget', '3l_4l',       'Rs.300000 to Rs.400000',   50, 1),
  ('flat_deposit_budget', '4l_5l',       'Rs.400000 to Rs.500000',   60, 1),
  ('flat_deposit_budget', '5l_6l',       'Rs.500000 to Rs.600000',   70, 1),
  ('flat_deposit_budget', '6l_7l',       'Rs.600000 to Rs.700000',   80, 1),
  ('flat_deposit_budget', '7l_8l',       'Rs.700000 to Rs.800000',   90, 1),
  ('flat_deposit_budget', '8l_9l',       'Rs.800000 to Rs.900000',  100, 1),
  ('flat_deposit_budget', '9l_10l',      'Rs.900000 to Rs.1000000', 110, 1),
  ('flat_deposit_budget', '10l_15l',     'Rs.1000000 to Rs.1500000',120, 1),
  ('flat_deposit_budget', '15l_20l',     'Rs.1500000 to Rs.2000000',130, 1),
  ('flat_deposit_budget', '20l_25l',     'Rs.2000000 to Rs.2500000',140, 1),
  ('flat_deposit_budget', '25l_30l',     'Rs.2500000 to Rs.3000000',150, 1),
  ('flat_deposit_budget', '30l_35l',     'Rs.3000000 to Rs.3500000',160, 1),
  ('flat_deposit_budget', '35l_40l',     'Rs.3500000 to Rs.4000000',170, 1),
  ('flat_deposit_budget', '40l_45l',     'Rs.4000000 to Rs.4500000',180, 1),
  ('flat_deposit_budget', '45l_50l',     'Rs.4500000 to Rs.5000000',190, 1),
  ('flat_deposit_budget', 'above_50l',   'Rs.5000000 & Above',      200, 1),

  -- ── flat_development_ratio ───────────────────────────────────
  ('flat_development_ratio', '40_60', '40:60 %', 10, 1),
  ('flat_development_ratio', '45_55', '45:55 %', 20, 1),
  ('flat_development_ratio', '50_50', '50:50 %', 30, 1),

  -- ── flat_tdr_purchase ────────────────────────────────────────
  ('flat_tdr_purchase', 'owner',     'Owner',     10, 1),
  ('flat_tdr_purchase', 'developer', 'Developer', 20, 1),
  ('flat_tdr_purchase', '50_50',     '50:50',     30, 1),

  -- ── flat_booking_amount_fixed ────────────────────────────────
  ('flat_booking_amount_fixed', '1_lac',  '1 Lac',   10, 1),
  ('flat_booking_amount_fixed', '2_lacs', '2 Lacs',  20, 1),
  ('flat_booking_amount_fixed', '5_lacs', '5 Lacs',  30, 1),
  ('flat_booking_amount_fixed', '10_lacs','10 Lacs', 40, 1),

  -- ── flat_possession_after ────────────────────────────────────
  ('flat_possession_after', 'after_1_year',  'After 1 Year',  10, 1),
  ('flat_possession_after', 'after_2_years', 'After 2 Years', 20, 1),
  ('flat_possession_after', 'after_3_years', 'After 3 Years', 30, 1),
  ('flat_possession_after', 'after_4_years', 'After 4 Years', 40, 1),
  ('flat_possession_after', 'after_5_years', 'After 5 Years', 50, 1),
  ('flat_possession_after', 'after_6_years', 'After 6 Years', 60, 1),
  ('flat_possession_after', 'after_7_years', 'After 7 Years', 70, 1),
  ('flat_possession_after', 'after_8_years', 'After 8 Years', 80, 1),

  -- ── flat_indoor_amenities (14 items) ─────────────────────────
  ('flat_indoor_amenities', 'bathroom',         'Bathroom',         10, 1),
  ('flat_indoor_amenities', 'balconies',        'Balconies',        20, 1),
  ('flat_indoor_amenities', 'lights',           'Lights',           30, 1),
  ('flat_indoor_amenities', 'fridge',           'Fridge',           40, 1),
  ('flat_indoor_amenities', 'geyser',           'Geyser',           50, 1),
  ('flat_indoor_amenities', 'kitchen_trolley',  'Kitchen Trolley',  60, 1),
  ('flat_indoor_amenities', 'beds',             'Beds',             70, 1),
  ('flat_indoor_amenities', 'fans',             'Fans',             80, 1),
  ('flat_indoor_amenities', 'curtains',         'Curtains',         90, 1),
  ('flat_indoor_amenities', 'ac',               'A.C.',            100, 1),
  ('flat_indoor_amenities', 'washing_machine',  'Washing Machine', 110, 1),
  ('flat_indoor_amenities', 'water_filter',     'Water Filter',    120, 1),
  ('flat_indoor_amenities', 'dining_table',     'Dining Table',    130, 1),
  ('flat_indoor_amenities', 'sofa_set',         'Sofa Set',        140, 1),

  -- ── flat_outdoor_amenities (22 items) ────────────────────────
  ('flat_outdoor_amenities', 'garden',              'Garden',              10, 1),
  ('flat_outdoor_amenities', 'club_house',          'Club House',          20, 1),
  ('flat_outdoor_amenities', 'gym',                 'Gym',                 30, 1),
  ('flat_outdoor_amenities', 'jogging_track',       'Jogging Track',       40, 1),
  ('flat_outdoor_amenities', 'swimming_pool',       'Swimming Pool',       50, 1),
  ('flat_outdoor_amenities', 'childrens_play_area', 'Childrens Play Area', 60, 1),
  ('flat_outdoor_amenities', 'accupressure_park',   'Accupressure Park',   70, 1),
  ('flat_outdoor_amenities', 'meditation_hall',     'Meditation Hall',     80, 1),
  ('flat_outdoor_amenities', 'cctv_cameras',        'CCTV Cameras',        90, 1),
  ('flat_outdoor_amenities', 'video_door_phone',    'Video Door Phone',   100, 1),
  ('flat_outdoor_amenities', 'wifi_connection',     'Wifi Connection',    110, 1),
  ('flat_outdoor_amenities', 'skating_rink',        'Skating Rink',       120, 1),
  ('flat_outdoor_amenities', 'cafeteria',           'Cafeteria',          130, 1),
  ('flat_outdoor_amenities', 'amphi_theatre',       'Amphi Theatre',      140, 1),
  ('flat_outdoor_amenities', 'community_hall',      'Community Hall',     150, 1),
  ('flat_outdoor_amenities', 'pergola',             'Pergola',            160, 1),
  ('flat_outdoor_amenities', 'indoor_games',        'Indoor Games',       170, 1),
  ('flat_outdoor_amenities', 'jacuzzi',             'Jacuzzi',            180, 1),
  ('flat_outdoor_amenities', 'gazebo',              'Gazebo',             190, 1),
  ('flat_outdoor_amenities', 'sauna',               'Sauna',              200, 1),
  ('flat_outdoor_amenities', 'barbaque',            'Barbaque',           210, 1),
  ('flat_outdoor_amenities', 'security',            'Security',           220, 1);
