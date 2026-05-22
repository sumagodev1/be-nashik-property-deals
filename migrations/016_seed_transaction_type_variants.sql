-- Migration 016: seed the full set of transaction-type tabs the admin
-- inventory form expects.
--
-- The reference Flat / Bunglow / Plot / Shop / Land / Commercial / Hostel
-- registration forms split the workflow into seven flavours:
--   sale  — Re-sale of an existing unit
--   purchase — Buyer-side (admin recording a buyer wish-list)
--   rent_in  — Tenant-side (admin recording a renter wish-list)
--   rent_out — Owner letting a unit on rent
--   lease_in — Tenant-side lease (long term)
--   lease_out — Owner leasing a unit out
--   joint_venture — Flat-specific owner/developer arrangement
--
-- We keep the legacy `rent` and `lease` rows around (older listings still
-- reference them) but mark them `is_active = 0` so they no longer surface as
-- tabs in the new form. Existing rows pointing at those codes keep working.

INSERT INTO master_transaction_types (code, label, sort_order, is_active)
VALUES
  ('purchase',       'Purchase',       15, 1),
  ('rent_in',        'Rent In',        21, 1),
  ('rent_out',       'Rent Out',       22, 1),
  ('lease_in',       'Lease In',       31, 1),
  ('lease_out',      'Lease Out',      32, 1),
  ('joint_venture',  'Joint Venture',  40, 1)
ON DUPLICATE KEY UPDATE
  label = VALUES(label),
  sort_order = VALUES(sort_order),
  is_active = 1;

-- Retire the legacy generic codes so they stop showing as duplicate tabs.
-- Listings already saved with these codes keep working — only the picker UI
-- changes. Re-enable manually from /admin/masters/transaction_type if needed.
UPDATE master_transaction_types SET is_active = 0 WHERE code IN ('rent', 'lease');
