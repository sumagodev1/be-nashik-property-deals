-- ===========================================================
-- 046 — Seed hostel_let_in / hostel_let_out / paying_guest into
--       master_transaction_types
-- ===========================================================
-- The hostel and paying-guest MD form configs encode a non-standard
-- transactionType that lives OUTSIDE the {sale, rent_in, lease_in, ...}
-- set the primary tabs allow:
--
--   Hostel Let In        → transactionType: 'hostel_let_in'
--   Hostel Let Out       → transactionType: 'hostel_let_out'
--   Paying Guest         → transactionType: 'paying_guest'
--
-- Backend inventory validation runs `assertActiveCode('transaction_type', ...)`
-- against payload.transactionType. Without these rows the save fails with:
--   INVALID_MASTER_CODE — Unknown or inactive transaction type: "hostel_let_out"
--
-- sort_order pushed to 200+ so the primary tab picker (Sale / Rent In /
-- Lease Out / etc.) stays first-class in the admin UI. Same pattern as
-- migration 045 for the variant codes.
-- ===========================================================

INSERT INTO master_transaction_types (code, label, sort_order, is_active)
VALUES
  ('hostel_let_in',   'Hostel Let In',   200, 1),
  ('hostel_let_out',  'Hostel Let Out',  201, 1),
  ('paying_guest',    'Paying Guest',    202, 1)
ON DUPLICATE KEY UPDATE
  label      = VALUES(label),
  sort_order = VALUES(sort_order),
  is_active  = 1;
