-- ============================================================
-- 040 — Bank Auction MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 1 Bank Auction
-- Registration Form in `reference of forms/Bank Auction Registration
-- Form.md`.
--
-- Naming: master keys `bank_auction_*`, display labels "Bank Auction / X".
--
-- 2-option fields (Available/Not Available, Symbolic/Physical, Registered/
-- Not Registered, Refundable/Non-Refundable, Yes/No) render as inline
-- radios — not seeded.
--
-- `bank_auction_pending_dues` is a legacy key (already declared in
-- LOOKUP_KEYS via migration 029). INSERT IGNORE tops it up; pre-existing
-- rows survive untouched.
--
-- Reused shared masters (not seeded here): `taluka`, `district`, `shivar`.
-- "Bank Name" in the MD is a free-text input — no master needed.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/bankAuctionMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── bank_auction_project_type ────────────────────────────────
  ('bank_auction_project_type', 'flat',         'Flat',         10, 1),
  ('bank_auction_project_type', 'shop',         'Shop',         20, 1),
  ('bank_auction_project_type', 'office_space', 'Office Space', 30, 1),
  ('bank_auction_project_type', 'bunglow',      'Bunglow',      40, 1),
  ('bank_auction_project_type', 'row_house',    'Row House',    50, 1),
  ('bank_auction_project_type', 'plot',         'Plot',         60, 1),
  ('bank_auction_project_type', 'land',         'Land',         70, 1),

  -- ── bank_auction_pending_dues (top-up legacy key — 8 MD values) ──
  ('bank_auction_pending_dues', 'society',             'Society',              10, 1),
  ('bank_auction_pending_dues', 'nmc',                 'NMC',                  20, 1),
  ('bank_auction_pending_dues', 'midc',                'MIDC',                 30, 1),
  ('bank_auction_pending_dues', 'electricity',         'Electricity',          40, 1),
  ('bank_auction_pending_dues', 'legal_expenses',      'Legal Expenses',       50, 1),
  ('bank_auction_pending_dues', 'house_tax',           'House Tax',            60, 1),
  ('bank_auction_pending_dues', 'property_tax',        'Property Tax',         70, 1),
  ('bank_auction_pending_dues', 'maintenance_charges', 'Maintenance Charges',  80, 1);
