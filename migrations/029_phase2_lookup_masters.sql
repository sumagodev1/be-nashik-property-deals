-- ============================================================
-- 029 — Phase-2 lookup masters for the new property types
-- ============================================================
-- Adds the dropdown vocabularies that the new property-type forms need.
-- All live in the existing `master_lookups` table (one row per option,
-- scoped by `master_key`). Per the project rule, only vocabularies with
-- more than three options earn their own master — 2-3 value selects stay
-- as inline arrays in the form.
--
-- New keys (and their target form sections):
--   land_sub_type_res   — Land sub-type when Land Type = Residential
--   land_sub_type_ind   — Land sub-type when Land Type = Industrial
--   land_reservation    — Public-Semi-Public reservations on Land
--   sez_type            — Type of SEZ (Textile/Chemical/Food/Multi)
--   tdr_zone            — TDR zoning (A/B/C/D)
--   pre_leased_project_type — Project type for Pre-Leased records
--   bank_auction_pending_dues — Multi-select of dues categories
--
-- INSERT IGNORE keeps the migration idempotent.

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order) VALUES
  -- land_sub_type_res
  ('land_sub_type_res', 'pure_yellow',     'Pure Yellow',     10),
  ('land_sub_type_res', 'gaothan_yellow',  'Gaothan Yellow',  20),
  ('land_sub_type_res', 'proposed_yellow', 'Proposed Yellow', 30),
  ('land_sub_type_res', 'special_yellow',  'Special Yellow',  40),

  -- land_sub_type_ind
  ('land_sub_type_ind', 'i-1', 'Service Industries (I-1)', 10),
  ('land_sub_type_ind', 'i-2', 'General Industries (I-2)', 20),
  ('land_sub_type_ind', 'i-3', 'Special Industries (I-3)', 30),
  ('land_sub_type_ind', 'ie',  'Industrial Estate (IE)',   40),

  -- land_reservation
  ('land_reservation', 'public_semi_public',   'Public-Semi Public Utility', 10),
  ('land_reservation', 'transportation',       'Transportation',             20),
  ('land_reservation', 'non_dev_zone',         'Non-Development Zone',       30),
  ('land_reservation', 'water_body',           'Water Body',                 40),
  ('land_reservation', 'educational_school',   'Educational - School',       50),
  ('land_reservation', 'educational_college',  'Educational - College',      60),
  ('land_reservation', 'recreational_ground',  'Recreational Ground (RG)',   70),
  ('land_reservation', 'playground',           'Playground (PG)',            80),
  ('land_reservation', 'garden',               'Garden (G)',                 90),
  ('land_reservation', 'park',                 'Park (P)',                  100),
  ('land_reservation', 'forest_zone',          'Forest Zone',               110),
  ('land_reservation', 'military_zone',        'Military Zone',             120),

  -- sez_type
  ('sez_type', 'textile',         'Textile',         10),
  ('sez_type', 'chemical',        'Chemical',        20),
  ('sez_type', 'food_processing', 'Food Processing', 30),
  ('sez_type', 'multi_product',   'Multi Product',   40),

  -- tdr_zone
  ('tdr_zone', 'a', 'A Zone', 10),
  ('tdr_zone', 'b', 'B Zone', 20),
  ('tdr_zone', 'c', 'C Zone', 30),
  ('tdr_zone', 'd', 'D Zone', 40),

  -- pre_leased_project_type
  ('pre_leased_project_type', 'flat',         'Flat',         10),
  ('pre_leased_project_type', 'shop',         'Shop',         20),
  ('pre_leased_project_type', 'office_space', 'Office Space', 30),
  ('pre_leased_project_type', 'bunglow',      'Bunglow',      40),
  ('pre_leased_project_type', 'row_house',    'Row House',    50),
  ('pre_leased_project_type', 'plot',         'Plot',         60),
  ('pre_leased_project_type', 'land',         'Land',         70),

  -- bank_auction_pending_dues
  ('bank_auction_pending_dues', 'society',     'Society',           10),
  ('bank_auction_pending_dues', 'nmc',         'NMC',               20),
  ('bank_auction_pending_dues', 'midc',        'MIDC',              30),
  ('bank_auction_pending_dues', 'electricity', 'Electricity',       40),
  ('bank_auction_pending_dues', 'legal',       'Legal Expenses',    50),
  ('bank_auction_pending_dues', 'house_tax',   'House Tax',         60),
  ('bank_auction_pending_dues', 'property_tax','Property Tax',      70),
  ('bank_auction_pending_dues', 'maintenance', 'Maintenance',       80);
