-- ============================================================
-- 028 — Phase-2 property types
-- ============================================================
-- Seeds the six reference-form property types that were absent from
-- migration 012's category list:
--
--   Hospital, Industrial Plot, SEZ, TDR, Pre-Leased Property, Bank Auction
--
-- Each ships as a single-vocabulary entry in master_property_types so the
-- admin Inventory form gets a new tab and the public API can filter by it.
-- Transaction-type variants for these (Re-Sale, Sale, Purchase, etc.) reuse
-- the existing master_transaction_types rows — no new transaction codes
-- needed.
--
-- Existing rows are untouched (IGNORE on conflict). Sort orders continue
-- after 80 (the Paying Guest tab) so new tabs render at the end.

INSERT IGNORE INTO master_property_types (code, label, sort_order, is_active) VALUES
  ('hospital',         'Hospital',              90,  1),
  ('industrial_plot',  'Industrial Plot',       100, 1),
  ('sez',              'SEZ',                   110, 1),
  ('tdr',              'TDR',                   120, 1),
  ('pre_leased',       'Pre-Leased Property',   130, 1),
  ('bank_auction',     'Bank Auction',          140, 1);
