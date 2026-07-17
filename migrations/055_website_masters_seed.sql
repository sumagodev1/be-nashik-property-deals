-- ===========================================================
-- 055 — Website-scoped masters (independent from Global masters)
-- ===========================================================
-- The public website's Seller Registration + Add-Property flow now uses its
-- OWN independent masters instead of reusing the Admin-side Global masters.
-- Rationale from the 2026-07-16 manager brief:
--   "Admin may later add Lease / Lease Out / Auction / Exchange / Joint
--    Venture to Global Transaction Type. These changes must NOT affect the
--    Website Seller Property Listing."
-- Full independence = each surface can evolve its vocabulary without
-- coordinating with the other.
--
-- All three masters live in the shared `master_lookups` table (created by
-- migration 026), scoped by the new master_key values:
--   'website_property_type', 'website_transaction_type', 'website_property_variety'
-- Every CRUD / validator / public-dropdown surface auto-picks them up once
-- the keys are registered in server/services/masters/management.js.
--
-- transaction_type codes ('sale', 'rent') intentionally match the existing
-- ENUM on website_properties.transaction_type. That keeps this master a
-- pure ADD (no ALTER TABLE, per user constraint) — new website master rows
-- must use one of the three ENUM codes until the schema is widened.
-- ===========================================================

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active)
VALUES
  -- ── Website / Property Type ──────────────────────────────
  ('website_property_type', 'flat_apartment',   'Flat / Apartment',   10, 1),
  ('website_property_type', 'bungalow',         'Bungalow',           20, 1),
  ('website_property_type', 'villa',            'Villa',              30, 1),
  ('website_property_type', 'row_house',        'Row House',          40, 1),
  ('website_property_type', 'plot',             'Plot',               50, 1),
  ('website_property_type', 'land',             'Land',               60, 1),
  ('website_property_type', 'agricultural_land','Agricultural Land',  70, 1),
  ('website_property_type', 'na_plot',          'NA Plot',            80, 1),
  ('website_property_type', 'commercial_space', 'Commercial Space',   90, 1),
  ('website_property_type', 'office',           'Office',            100, 1),
  ('website_property_type', 'shop',             'Shop',              110, 1),
  ('website_property_type', 'showroom',         'Showroom',          120, 1),
  ('website_property_type', 'warehouse',        'Warehouse',         130, 1),
  ('website_property_type', 'factory',          'Factory',           140, 1),
  ('website_property_type', 'industrial_shed',  'Industrial Shed',   150, 1),
  ('website_property_type', 'hotel',            'Hotel',             160, 1),
  ('website_property_type', 'hostel',           'Hostel',            170, 1),
  ('website_property_type', 'hospital',         'Hospital',          180, 1),
  ('website_property_type', 'pg',               'PG (Paying Guest)', 190, 1),
  ('website_property_type', 'tdr',              'TDR',               200, 1),
  ('website_property_type', 'farm_house',       'Farm House',        210, 1),
  ('website_property_type', 'resort',           'Resort',            220, 1),
  ('website_property_type', 'building',         'Building',          230, 1),
  ('website_property_type', 'society',          'Society',           240, 1),
  ('website_property_type', 'parking',          'Parking',           250, 1),
  ('website_property_type', 'other',            'Other',             260, 1),

  -- ── Website / Transaction Type ───────────────────────────
  -- Codes align with website_properties.transaction_type ENUM so no schema
  -- change is required. Labels ('Sell', 'Rent Out') follow the manager brief.
  ('website_transaction_type', 'sale', 'Sell',     10, 1),
  ('website_transaction_type', 'rent', 'Rent Out', 20, 1),

  -- ── Website / Property Variety ───────────────────────────
  ('website_property_variety', 'new',    'New',    10, 1),
  ('website_property_variety', 'resale', 'Resale', 20, 1);
