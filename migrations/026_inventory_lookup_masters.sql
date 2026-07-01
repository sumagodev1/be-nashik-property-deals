-- ===========================================================
-- 026 — Generic master_lookups table + Phase-1 seed
-- ===========================================================
-- The existing four master_* tables (property_types, transaction_types,
-- flat_types, status_types) hold lookups that are tightly coupled to
-- inventory_properties columns. The reference registration forms (Flat,
-- Bunglow, Plot, Land, Shop, Commercial, Hostel, PG, Hospital, Industrial,
-- SEZ, TDR, Pre-Leased, Bank Auction) reference 30+ additional vocabularies
-- (Floor, Facing, Plot Type, Lease Period, Bank Name, Phase, Wing, Possession
-- Month / Year, Tenant Preference, Hospital Type, …) — all simple key/label
-- lookups that don't justify a table each.
--
-- One generic table with a `master_key` discriminator keeps the cost of a
-- new vocabulary down to "insert seed rows", lets the admin manage every
-- one through the existing generic /admin/masters/:key UI, and avoids 30
-- near-identical CREATE TABLE blocks. The optional `parent_code` column
-- supports hierarchical masters (district → taluka → shivar) without a
-- second table.
--
-- The existing four master_* tables are NOT migrated — they stay because
-- inventory_properties.{property_type, transaction_type, bhk, status}
-- already references them via the masters service. New vocabularies go
-- here; existing ones stay where they are.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS master_lookups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  master_key  VARCHAR(64)  NOT NULL,
  code        VARCHAR(64)  NOT NULL,
  label       VARCHAR(255) NOT NULL,
  parent_code VARCHAR(64)  NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at  DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_master_lookups_key_code (master_key, code),
  KEY ix_master_lookups_key_active (master_key, is_active, sort_order),
  KEY ix_master_lookups_parent (master_key, parent_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------
-- A. Property-spec vocabularies
-- -----------------------------------------------------------

-- floor_level: shared across Flat, Bunglow, Shop, Commercial, Hostel, PG, TDR
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('floor_level', 'basement', 'Basement',  10),
  ('floor_level', 'ground',   'Ground',    20),
  ('floor_level', '1st',  '1st',  30),
  ('floor_level', '2nd',  '2nd',  40),
  ('floor_level', '3rd',  '3rd',  50),
  ('floor_level', '4th',  '4th',  60),
  ('floor_level', '5th',  '5th',  70),
  ('floor_level', '6th',  '6th',  80),
  ('floor_level', '7th',  '7th',  90),
  ('floor_level', '8th',  '8th',  100),
  ('floor_level', '9th',  '9th',  110),
  ('floor_level', '10th', '10th', 120),
  ('floor_level', '11th', '11th', 130),
  ('floor_level', '12th', '12th', 140),
  ('floor_level', '13th-plus', '13th+', 150);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('facing', 'east',  'East',  10),
  ('facing', 'west',  'West',  20),
  ('facing', 'north', 'North', 30),
  ('facing', 'south', 'South', 40),
  ('facing', 'north-east', 'North-East', 50),
  ('facing', 'north-west', 'North-West', 60),
  ('facing', 'south-east', 'South-East', 70),
  ('facing', 'south-west', 'South-West', 80);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('lease_period', '1-year',     '1 Year',      10),
  ('lease_period', '2-years',    '2 Years',     20),
  ('lease_period', '3-5-years',  '3-5 Years',   30),
  ('lease_period', '5-10-years', '5-10 Years',  40),
  ('lease_period', '10-15-years','10-15 Years', 50),
  ('lease_period', '15-20-years','15-20 Years', 60),
  ('lease_period', '20-25-years','20-25 Years', 70),
  ('lease_period', '25-30-years','25-30 Years', 80),
  ('lease_period', '30-50-years','30-50 Years', 90),
  ('lease_period', '50-100-years','50-100 Years',100);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('plot_type', 'residential', 'Residential', 10),
  ('plot_type', 'commercial',  'Commercial',  20),
  ('plot_type', 'industrial',  'Industrial',  30),
  ('plot_type', 'amenity',     'Amenity',     40),
  ('plot_type', 'gunthe-wari', 'Gunthe-wari', 50),
  ('plot_type', 'farm-house',  'Farm House',  60),
  ('plot_type', 'resort',      'Resort',      70);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('plot_sub_industrial', 'i-1', 'I-1', 10),
  ('plot_sub_industrial', 'i-2', 'I-2', 20),
  ('plot_sub_industrial', 'i-3', 'I-3', 30),
  ('plot_sub_industrial', 'ie',  'IE',  40);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('plot_shape', 'square',      'Square',      10),
  ('plot_shape', 'rectangle',   'Rectangle',   20),
  ('plot_shape', 'gomukhi',     'Gomukhi',     30),
  ('plot_shape', 'vyagramukhi', 'Vyagramukhi', 40);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('road_width', '6m',   '6m',   10),
  ('road_width', '7-5m', '7.5m', 20),
  ('road_width', '9m',   '9m',   30),
  ('road_width', '12m',  '12m',  40),
  ('road_width', '15m',  '15m',  50),
  ('road_width', '18m',  '18m',  60),
  ('road_width', '20m',  '20m',  70),
  ('road_width', '24m',  '24m',  80),
  ('road_width', '30m',  '30m',  90);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('road_front_type', 'village-road',        'Village Road',          10),
  ('road_front_type', 'zp-road',             'Z.P. Road',             20),
  ('road_front_type', 'shiv-road',           'Shiv Road',             30),
  ('road_front_type', 'dp-road',             'D.P. Road',             40),
  ('road_front_type', 'major-district-road', 'Major District Road',   50),
  ('road_front_type', 'state-highway',       'State Highway',         60),
  ('road_front_type', 'national-highway',    'National Highway',      70);

-- -----------------------------------------------------------
-- B. Land masters
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('land_type', 'agriculture', 'Agriculture', 10),
  ('land_type', 'residential', 'Residential', 20),
  ('land_type', 'commercial',  'Commercial',  30),
  ('land_type', 'industrial',  'Industrial',  40);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('land_zone', 'agriculture-green',         'Agriculture (Green)',           10),
  ('land_zone', 'residential-yellow',        'Residential (Yellow)',          20),
  ('land_zone', 'commercial-blue',           'Commercial (Blue)',             30),
  ('land_zone', 'industrial-pink',           'Industrial (Pink)',             40),
  ('land_zone', 'public-semi-public',        'Public-Semi Public (Light Pink)',50),
  ('land_zone', 'public-utility-orange',     'Public Utility (Orange)',       60),
  ('land_zone', 'transportation-grey',       'Transportation (Grey)',         70),
  ('land_zone', 'non-development',           'Non-Development (Bottle Green)',80),
  ('land_zone', 'water-body',                'Water Body (Sky Blue)',         90),
  ('land_zone', 'recreational',              'Recreational (Educational)',    100),
  ('land_zone', 'forest-zone',               'Forest Zone',                   110),
  ('land_zone', 'military-zone',             'Military Zone',                 120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('land_variety', 'general',        'General',         10),
  ('land_variety', 'adivasi',        'Adivasi',         20),
  ('land_variety', 'nazrana',        'Nazrana',         30),
  ('land_variety', '43-permission',  '43 Permission',   40);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('defect_land', 'dead-end',         'Dead End',         10),
  ('defect_land', 'nala',             'Nala',             20),
  ('defect_land', 'slum-area',        'Slum Area',        30),
  ('defect_land', 'high-tension-line','High Tension Line',40),
  ('defect_land', 'conservation',     'Conservation',     50),
  ('defect_land', 'less-frontage',    'Less Frontage',    60),
  ('defect_land', 'common-wall',      'Common Wall',      70);

-- -----------------------------------------------------------
-- C. Financial / Sale terms
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('bank_name', 'hdfc',           'HDFC',            10),
  ('bank_name', 'icici',          'ICICI',           20),
  ('bank_name', 'sbi',            'SBI',             30),
  ('bank_name', 'idbi',           'IDBI',            40),
  ('bank_name', 'axis',           'Axis',            50),
  ('bank_name', 'kotak',          'Kotak',           60),
  ('bank_name', 'pnb',            'PNB',             70),
  ('bank_name', 'bank-of-baroda', 'Bank of Baroda',  80),
  ('bank_name', 'boi',            'BOI',             90),
  ('bank_name', 'dena-bank',      'Dena Bank',       100),
  ('bank_name', 'bom',            'BOM',             110),
  ('bank_name', 'other',          'Other',           120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('payment_mode', 'cash',   'Cash',   10),
  ('payment_mode', 'cheque', 'Cheque', 20),
  ('payment_mode', 'dd',     'DD',     30),
  ('payment_mode', 'neft',   'NEFT',   40),
  ('payment_mode', 'rtgs',   'RTGS',   50);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('payment_period', '15-days',  '15 Days',   10),
  ('payment_period', '1-month',  '1 Month',   20),
  ('payment_period', '2-months', '2 Months',  30),
  ('payment_period', '3-months', '3 Months',  40),
  ('payment_period', '4-months', '4 Months',  50),
  ('payment_period', '6-months', '6 Months',  60),
  ('payment_period', '8-months', '8 Months',  70),
  ('payment_period', '10-months','10 Months', 80),
  ('payment_period', '1-year',   '1 Year',    90);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('payment_white_percent', '20-pct', '20%', 10),
  ('payment_white_percent', '25-pct', '25%', 20),
  ('payment_white_percent', '50-pct', '50%', 30),
  ('payment_white_percent', '60-pct', '60%', 40),
  ('payment_white_percent', '75-pct', '75%', 50),
  ('payment_white_percent', '80-pct', '80%', 60),
  ('payment_white_percent', '100-pct','100%',70);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('token_amount', '50000',   'Rs. 50,000',    10),
  ('token_amount', '100000',  'Rs. 1,00,000',  20),
  ('token_amount', '200000',  'Rs. 2,00,000',  30),
  ('token_amount', '500000',  'Rs. 5,00,000',  40),
  ('token_amount', '1000000', 'Rs. 10,00,000', 50);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('booking_amount_percent', '2-pct',  '2% of Basic Cost',  10),
  ('booking_amount_percent', '5-pct',  '5% of Basic Cost',  20),
  ('booking_amount_percent', '10-pct', '10% of Basic Cost', 30),
  ('booking_amount_percent', '20-pct', '20% of Basic Cost', 40),
  ('booking_amount_percent', '30-pct', '30% of Basic Cost', 50);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('yearly_hike_percent', '5-pct',   '5%',   10),
  ('yearly_hike_percent', '10-pct',  '10%',  20),
  ('yearly_hike_percent', '15-pct',  '15%',  30),
  ('yearly_hike_percent', '20-pct',  '20%',  40),
  ('yearly_hike_percent', '25-pct',  '25%',  50),
  ('yearly_hike_percent', '30-pct',  '30%',  60),
  ('yearly_hike_percent', '35-pct',  '35%',  70),
  ('yearly_hike_percent', '40-pct',  '40%',  80),
  ('yearly_hike_percent', '50-pct',  '50%',  90),
  ('yearly_hike_percent', '60-pct',  '60%',  100),
  ('yearly_hike_percent', '70-pct',  '70%',  110),
  ('yearly_hike_percent', '80-pct',  '80%',  120),
  ('yearly_hike_percent', '90-pct',  '90%',  130),
  ('yearly_hike_percent', '100-pct', '100%', 140);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('bunglow_age_range', 'below-5-yrs',   'Below 5 Yrs',    10),
  ('bunglow_age_range', '5-to-10-yrs',   '5-10 Yrs',       20),
  ('bunglow_age_range', '10-to-15-yrs',  '10-15 Yrs',      30),
  ('bunglow_age_range', '15-to-20-yrs',  '15-20 Yrs',      40),
  ('bunglow_age_range', '20-to-25-yrs',  '20-25 Yrs',      50),
  ('bunglow_age_range', '25-to-30-yrs',  '25-30 Yrs',      60),
  ('bunglow_age_range', '30-to-40-yrs',  '30-40 Yrs',      70),
  ('bunglow_age_range', '40-to-50-yrs',  '40-50 Yrs',      80),
  ('bunglow_age_range', '50-to-60-yrs',  '50-60 Yrs',      90),
  ('bunglow_age_range', '60-to-70-yrs',  '60-70 Yrs',      100),
  ('bunglow_age_range', '70-to-80-yrs',  '70-80 Yrs',      110),
  ('bunglow_age_range', '80-to-100-yrs', '80-100 Yrs',     120),
  ('bunglow_age_range', 'above-100-yrs', 'Above 100 Yrs',  130);

-- -----------------------------------------------------------
-- D. Construction / Project
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('phase', 'i',   'I',   10),
  ('phase', 'ii',  'II',  20),
  ('phase', 'iii', 'III', 30),
  ('phase', 'iv',  'IV',  40),
  ('phase', 'v',   'V',   50),
  ('phase', 'vi',  'VI',  60);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('wing', 'a', 'A', 10),
  ('wing', 'b', 'B', 20),
  ('wing', 'c', 'C', 30),
  ('wing', 'd', 'D', 40),
  ('wing', 'e', 'E', 50),
  ('wing', 'f', 'F', 60);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('possession_month', 'jan', 'Jan', 10),
  ('possession_month', 'feb', 'Feb', 20),
  ('possession_month', 'mar', 'Mar', 30),
  ('possession_month', 'apr', 'Apr', 40),
  ('possession_month', 'may', 'May', 50),
  ('possession_month', 'jun', 'Jun', 60),
  ('possession_month', 'jul', 'Jul', 70),
  ('possession_month', 'aug', 'Aug', 80),
  ('possession_month', 'sep', 'Sep', 90),
  ('possession_month', 'oct', 'Oct', 100),
  ('possession_month', 'nov', 'Nov', 110),
  ('possession_month', 'dec', 'Dec', 120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('possession_year', '2024', '2024', 10),
  ('possession_year', '2025', '2025', 20),
  ('possession_year', '2026', '2026', 30),
  ('possession_year', '2027', '2027', 40),
  ('possession_year', '2028', '2028', 50),
  ('possession_year', '2029', '2029', 60),
  ('possession_year', '2030', '2030', 70),
  ('possession_year', '2031', '2031', 80),
  ('possession_year', '2032', '2032', 90),
  ('possession_year', '2033', '2033', 100),
  ('possession_year', '2034', '2034', 110),
  ('possession_year', '2035', '2035', 120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('tdr_floor', 'ground','Ground', 10),
  ('tdr_floor', '1st',   '1st',    20),
  ('tdr_floor', '2nd',   '2nd',    30),
  ('tdr_floor', '3rd',   '3rd',    40),
  ('tdr_floor', '4th',   '4th',    50),
  ('tdr_floor', '5th',   '5th',    60),
  ('tdr_floor', '6th',   '6th',    70),
  ('tdr_floor', '7th',   '7th',    80),
  ('tdr_floor', '8th',   '8th',    90),
  ('tdr_floor', '9th',   '9th',    100),
  ('tdr_floor', '10th',  '10th',   110),
  ('tdr_floor', '11th',  '11th',   120),
  ('tdr_floor', '12th',  '12th',   130);

-- -----------------------------------------------------------
-- E. Amenities (multi-select)
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('amenities_residential', 'garden',             'Garden',                 10),
  ('amenities_residential', 'swimming-pool',      'Swimming Pool',          20),
  ('amenities_residential', 'gym',                'Gym',                    30),
  ('amenities_residential', 'club-house',         'Club House',             40),
  ('amenities_residential', 'jogging-track',      'Jogging Track',          50),
  ('amenities_residential', 'temple',             'Temple',                 60),
  ('amenities_residential', 'tennis-court',       'Tennis Court',           70),
  ('amenities_residential', 'play-area',          'Play Area',              80),
  ('amenities_residential', 'security',           'Security',               90),
  ('amenities_residential', 'wi-fi',              'Wi-Fi',                 100),
  ('amenities_residential', 'terrace-parking',    'Terrace Parking',       110),
  ('amenities_residential', 'terrace-garden',     'Terrace Garden',        120),
  ('amenities_residential', 'amphitheatre',       'Amphitheatre',          130),
  ('amenities_residential', 'school',             'School',                140),
  ('amenities_residential', 'shopping-mall',      'Shopping Mall',         150),
  ('amenities_residential', 'meditation-center',  'Meditation Center',     160),
  ('amenities_residential', 'cctv-cameras',       'CCTV Cameras',          170),
  ('amenities_residential', 'video-door-phone',   'Video Door Phone',      180),
  ('amenities_residential', 'community-hall',     'Community Hall',        190),
  ('amenities_residential', 'steam-bath',         'Steam Bath',            200),
  ('amenities_residential', 'indoor-games-area',  'Indoor Games Area',     210),
  ('amenities_residential', 'podium-parking',     'Podium Parking',        220),
  ('amenities_residential', 'generator-backup',   'Generator / Battery Backup', 230),
  ('amenities_residential', 'lift',               'Lift',                  240),
  ('amenities_residential', 'badminton-court',    'Badminton Court',       250),
  ('amenities_residential', 'inverter-point',     'Inverter Point',        260);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('amenities_bunglow_furniture', 'tv',              'TV',              10),
  ('amenities_bunglow_furniture', 'sofa',            'Sofa',            20),
  ('amenities_bunglow_furniture', 'fridge',          'Fridge',          30),
  ('amenities_bunglow_furniture', 'washing-machine', 'Washing Machine', 40),
  ('amenities_bunglow_furniture', 'ac',              'A.C.',            50),
  ('amenities_bunglow_furniture', 'gas-facility',    'Gas Facility',    60),
  ('amenities_bunglow_furniture', 'wardrobe',        'Wardrobe',        70),
  ('amenities_bunglow_furniture', 'bed',             'Bed',             80),
  ('amenities_bunglow_furniture', 'dining-table',    'Dining Table',    90);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('amenities_plot', 'wbm-road',              'WBM Road',              10),
  ('amenities_plot', 'fencing',               'Fencing',               20),
  ('amenities_plot', 'tree-plantation',       'Tree Plantation',       30),
  ('amenities_plot', 'street-light',          'Street Light',          40),
  ('amenities_plot', 'plot-demarcation',      'Plot Demarcation',      50),
  ('amenities_plot', 'water-connection',      'Water Connection',      60),
  ('amenities_plot', 'electricity-connection','Electricity Connection',70),
  ('amenities_plot', 'drainage',              'Drainage',              80);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('amenities_commercial', 'lift',           'Lift',             10),
  ('amenities_commercial', 'ac',             'Central AC',       20),
  ('amenities_commercial', 'parking',        'Parking',          30),
  ('amenities_commercial', 'cctv-cameras',   'CCTV Cameras',     40),
  ('amenities_commercial', 'reception',      'Reception',        50),
  ('amenities_commercial', 'conference-room','Conference Room',  60),
  ('amenities_commercial', 'pantry',         'Pantry',           70),
  ('amenities_commercial', 'security',       'Security',         80),
  ('amenities_commercial', 'fire-safety',    'Fire Safety',      90),
  ('amenities_commercial', 'power-backup',   'Power Backup',     100),
  ('amenities_commercial', 'water-storage',  'Water Storage',    110),
  ('amenities_commercial', 'visitor-parking','Visitor Parking',  120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('amenities_hostel', 'wi-fi',           'Wi-Fi',          10),
  ('amenities_hostel', 'tv-room',         'TV Room',        20),
  ('amenities_hostel', 'library',         'Library',        30),
  ('amenities_hostel', 'gym',             'Gym',            40),
  ('amenities_hostel', 'mess-facility',   'Mess Facility',  50),
  ('amenities_hostel', 'hot-water',       'Hot Water',      60),
  ('amenities_hostel', 'laundry',         'Laundry',        70),
  ('amenities_hostel', 'cctv-cameras',    'CCTV Cameras',   80),
  ('amenities_hostel', 'parking',         'Parking',        90),
  ('amenities_hostel', 'security',        'Security',       100);

-- -----------------------------------------------------------
-- F. Tenant / Hostel
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('tenant_preference', 'family',           'Family',           10),
  ('tenant_preference', 'bachelor',         'Bachelor',         20),
  ('tenant_preference', 'boys-student',     'Boys Student',     30),
  ('tenant_preference', 'girl-student',     'Girl Student',     40),
  ('tenant_preference', 'company-employee', 'Company Employee', 50),
  ('tenant_preference', 'bank-employee',    'Bank Employee',    60),
  ('tenant_preference', 'paying-guest',     'Paying Guest',     70),
  ('tenant_preference', 'senior-citizen',   'Senior Citizen',   80),
  ('tenant_preference', 'any',              'Any',              90);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('shop_expected_tenant', 'private-bank',       'Private Bank',        10),
  ('shop_expected_tenant', 'atm',                'ATM',                 20),
  ('shop_expected_tenant', 'hotel',              'Hotel',               30),
  ('shop_expected_tenant', 'medical-shop',       'Medical Shop',        40),
  ('shop_expected_tenant', 'hardware',           'Hardware',            50),
  ('shop_expected_tenant', 'saloon',             'Saloon',              60),
  ('shop_expected_tenant', 'kirana-shop',        'Kirana Shop',         70),
  ('shop_expected_tenant', 'ice-cream-parlour',  'Ice Cream Parlour',   80),
  ('shop_expected_tenant', 'beauty-parlour',     'Beauty Parlour',      90),
  ('shop_expected_tenant', 'dr-clinic',          'Doctor Clinic',       100),
  ('shop_expected_tenant', 'office-use',         'Office Use',          110),
  ('shop_expected_tenant', 'godown-purpose',     'Godown Purpose',      120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('commercial_expected_tenant', 'private-bank',       'Private Bank',        10),
  ('commercial_expected_tenant', 'atm-machine',        'ATM Machine',         20),
  ('commercial_expected_tenant', 'hotel',              'Hotel',               30),
  ('commercial_expected_tenant', 'medical-shop',       'Medical Shop',        40),
  ('commercial_expected_tenant', 'hardware',           'Hardware',            50),
  ('commercial_expected_tenant', 'saloon',             'Saloon',              60),
  ('commercial_expected_tenant', 'kirana-shop',        'Kirana Shop',         70),
  ('commercial_expected_tenant', 'ice-cream-parlour',  'Ice Cream Parlour',   80),
  ('commercial_expected_tenant', 'beauty-parlour',     'Beauty Parlour',      90),
  ('commercial_expected_tenant', 'dr-clinic',          'Doctor Clinic',       100),
  ('commercial_expected_tenant', 'office-use',         'Office Use',          110),
  ('commercial_expected_tenant', 'godown-purpose',     'Godown Purpose',      120);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('hostel_residence', 'independent',  'Independent',  10),
  ('hostel_residence', '1-partner',    '1 Partner',    20),
  ('hostel_residence', '2-partners',   '2 Partners',   30),
  ('hostel_residence', '3-partners',   '3 Partners',   40),
  ('hostel_residence', '4-partners',   '4 Partners',   50),
  ('hostel_residence', '5-partners',   '5 Partners',   60);

-- -----------------------------------------------------------
-- G. New property-type vocabularies
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('hospital_type', 'surgical',         'Surgical',          10),
  ('hospital_type', 'multi-speciality', 'Multi-Speciality',  20),
  ('hospital_type', 'maternity',        'Maternity',         30),
  ('hospital_type', 'general',          'General',           40),
  ('hospital_type', 'trauma',           'Trauma',            50);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('industrial_shed_type', 'open',     'Open',     10),
  ('industrial_shed_type', 'closed',   'Closed',   20),
  ('industrial_shed_type', 'hangar',   'Hangar',   30),
  ('industrial_shed_type', 'rcc',      'RCC',      40),
  ('industrial_shed_type', 'steel',    'Steel',    50);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('allotted_area_to_owner', 'flats',   'Flats',   10),
  ('allotted_area_to_owner', 'shops',   'Shops',   20),
  ('allotted_area_to_owner', 'offices', 'Offices', 30),
  ('allotted_area_to_owner', 'both',    'Both',    40);

-- -----------------------------------------------------------
-- H. Contacts
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('contact_relation', 'self',      'Self',      10),
  ('contact_relation', 'father',    'Father',    20),
  ('contact_relation', 'mother',    'Mother',    30),
  ('contact_relation', 'brother',   'Brother',   40),
  ('contact_relation', 'sister',    'Sister',    50),
  ('contact_relation', 'husband',   'Husband',   60),
  ('contact_relation', 'wife',      'Wife',      70),
  ('contact_relation', 'son',       'Son',       80),
  ('contact_relation', 'daughter',  'Daughter',  90),
  ('contact_relation', 'uncle',     'Uncle',     100),
  ('contact_relation', 'aunt',      'Aunt',      110),
  ('contact_relation', 'friend',    'Friend',    120),
  ('contact_relation', 'other',     'Other',     130);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('contact_type', 'owner',         'Owner',          10),
  ('contact_type', 'co-owner',      'Co-owner',       20),
  ('contact_type', 'agent',         'Agent',          30),
  ('contact_type', 'builder',       'Builder',        40),
  ('contact_type', 'reference',     'Reference',      50),
  ('contact_type', 'key-holder',    'Key Holder',     60),
  ('contact_type', 'caretaker',     'Caretaker',      70),
  ('contact_type', 'tenant',        'Tenant',         80),
  ('contact_type', 'legal-contact', 'Legal Contact',  90);

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  ('lead_source', 'walk-in',         'Walk-In',          10),
  ('lead_source', 'reference',       'Reference',        20),
  ('lead_source', 'newspaper',       'Newspaper',        30),
  ('lead_source', 'website',         'Website',          40),
  ('lead_source', 'social-media',    'Social Media',     50),
  ('lead_source', 'hoarding',        'Hoarding',         60),
  ('lead_source', 'cold-call',       'Cold Call',        70),
  ('lead_source', 'broker',          'Broker',           80),
  ('lead_source', 'existing-client', 'Existing Client',  90);

-- -----------------------------------------------------------
-- I. Hierarchical location: district → taluka → shivar
--    parent_code references the parent row's `code` within the same lookup
--    domain (so taluka.parent_code = district.code, shivar.parent_code =
--    taluka.code). Hierarchical-aware UI joins on (master_key, parent_code).
-- -----------------------------------------------------------

INSERT IGNORE INTO master_lookups (master_key, code, label, parent_code, sort_order) VALUES
  ('district', 'nashik', 'Nashik', NULL, 10),
  ('district', 'pune',   'Pune',   NULL, 20),
  ('district', 'mumbai', 'Mumbai', NULL, 30);

INSERT IGNORE INTO master_lookups (master_key, code, label, parent_code, sort_order) VALUES
  ('taluka', 'nashik-city', 'Nashik City', 'nashik', 10),
  ('taluka', 'niphad',      'Niphad',      'nashik', 20),
  ('taluka', 'igatpuri',    'Igatpuri',    'nashik', 30),
  ('taluka', 'trimbak',     'Trimbak',     'nashik', 40),
  ('taluka', 'sinnar',      'Sinnar',      'nashik', 50),
  ('taluka', 'malegaon',    'Malegaon',    'nashik', 60),
  ('taluka', 'baglan',      'Baglan',      'nashik', 70),
  ('taluka', 'chandwad',    'Chandwad',    'nashik', 80),
  ('taluka', 'dindori',     'Dindori',     'nashik', 90),
  ('taluka', 'kalwan',      'Kalwan',      'nashik', 100),
  ('taluka', 'nandgaon',    'Nandgaon',    'nashik', 110),
  ('taluka', 'peint',       'Peint',       'nashik', 120),
  ('taluka', 'satana',      'Satana',      'nashik', 130),
  ('taluka', 'surgana',     'Surgana',     'nashik', 140),
  ('taluka', 'yeola',       'Yeola',       'nashik', 150);

INSERT IGNORE INTO master_lookups (master_key, code, label, parent_code, sort_order) VALUES
  ('shivar', 'chandsi',   'Chandsi',   'nashik-city', 10),
  ('shivar', 'ozar',      'Ozar',      'nashik-city', 20),
  ('shivar', 'pathardi',  'Pathardi',  'nashik-city', 30),
  ('shivar', 'adgaon',    'Adgaon',    'nashik-city', 40),
  ('shivar', 'panchavati','Panchavati','nashik-city', 50);
