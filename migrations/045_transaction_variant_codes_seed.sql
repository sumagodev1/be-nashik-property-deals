-- ===========================================================
-- 045 — Seed transaction-variant codes into master_transaction_types
-- ===========================================================
-- The inventory MD-form configs (bunglow / commercial / flat / shop /
-- hospital / industrial-plot / etc.) encode a *variant* alongside the
-- broad transaction type:
--
--   transactionType    = 'lease_in'
--   transactionVariant = 'new_lease_in'         ← this row
--
-- Backend inventory validation runs `assertActiveCode('transaction_type', ...)`
-- against BOTH fields. Without these variant rows in the masters table
-- the submit fails with:
--   INVALID_MASTER_CODE — Unknown or inactive transaction type: "new_lease_in"
--
-- Variants live under the same master because they share the same table
-- shape and we don't want a second admin surface just for these hidden
-- codes. sort_order pushed to 100+ so the primary picker (Sale / Rent
-- In / Lease Out / etc.) stays first-class in the admin UI.
-- ===========================================================

INSERT INTO master_transaction_types (code, label, sort_order, is_active)
VALUES
  ('resale',         'Resale',           100, 1),
  ('new_sale',       'New Sale',         101, 1),
  ('new_purchase',   'New Purchase',     102, 1),
  ('new_rent_in',    'New Rent In',      103, 1),
  ('new_rent_out',   'New Rent Out',     104, 1),
  ('new_lease_in',   'New Lease In',     105, 1),
  ('new_lease_out',  'New Lease Out',    106, 1)
ON DUPLICATE KEY UPDATE
  label      = VALUES(label),
  sort_order = VALUES(sort_order),
  is_active  = 1;
