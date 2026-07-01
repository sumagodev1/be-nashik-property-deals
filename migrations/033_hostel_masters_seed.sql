-- ============================================================
-- 033 — Hostel MD-driven masters seed
-- ============================================================
-- Seeds every >2-option vocabulary referenced by the 2 Hostel Registration
-- Forms in `reference of forms/Hostel Registration Form.md`. All rows go
-- into the generic `master_lookups` table.
--
-- Naming: master keys `hostel_*`, display labels "Hostel / X".
--
-- 2-option fields (Required/Not Required, Available/Not Available,
-- Independent/Common, Old/New, Yes/No, Specific/Any, A.C./Non A.C.,
-- A.C. Required/A.C. Not Required) render as inline radio buttons and
-- are NOT seeded.
--
-- `hostel_residence` is an existing key — INSERT IGNORE tops up the MD
-- values without disturbing any prior seed.
--
-- INSERT IGNORE is idempotent.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/hostelMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── hostel_category ──────────────────────────────────────────
  ('hostel_category', 'private',         'Private',         10, 1),
  ('hostel_category', 'semi_government', 'Semi-Government', 20, 1),
  ('hostel_category', 'government',      'Government',      30, 1),

  -- ── hostel_rooms_count ───────────────────────────────────────
  ('hostel_rooms_count', '1_room',  '1 Room',  10, 1),
  ('hostel_rooms_count', '2_rooms', '2 Rooms', 20, 1),
  ('hostel_rooms_count', '3_rooms', '3 Rooms', 30, 1),
  ('hostel_rooms_count', '4_rooms', '4 Rooms', 40, 1),
  ('hostel_rooms_count', '5_rooms', '5 Rooms', 50, 1),

  -- ── hostel_residence (top-up — key already declared) ─────────
  ('hostel_residence', 'independent', 'Independent', 10, 1),
  ('hostel_residence', '1_partner',   '1 Partner',   20, 1),
  ('hostel_residence', '2_partners',  '2 Partners',  30, 1),
  ('hostel_residence', '3_partners',  '3 Partners',  40, 1),
  ('hostel_residence', '4_partners',  '4 Partners',  50, 1),
  ('hostel_residence', '5_partners',  '5 Partners',  60, 1),

  -- ── hostel_facing ────────────────────────────────────────────
  ('hostel_facing', 'east',  'East',  10, 1),
  ('hostel_facing', 'west',  'West',  20, 1),
  ('hostel_facing', 'north', 'North', 30, 1),
  ('hostel_facing', 'south', 'South', 40, 1),

  -- ── hostel_condition ─────────────────────────────────────────
  ('hostel_condition', 'unfurnished',     'Unfurnished',     10, 1),
  ('hostel_condition', 'semi_furnished',  'Semi-Furnished',  20, 1),
  ('hostel_condition', 'fully_furnished', 'Fully Furnished', 30, 1),

  -- ── hostel_status ────────────────────────────────────────────
  ('hostel_status', 'available',     'Available',     10, 1),
  ('hostel_status', 'pipeline',      'Pipeline',      20, 1),
  ('hostel_status', 'not_available', 'Not Available', 30, 1),

  -- ── hostel_amount_budget (12 buckets — used for Hostel Fees Monthly + Yearly + Deposit) ──
  ('hostel_amount_budget', 'below_5000',   'Below Rs. 5000',         10, 1),
  ('hostel_amount_budget', '5000_10000',   'Rs.5000 to Rs.10000',    20, 1),
  ('hostel_amount_budget', '10000_20000',  'Rs.10000 to Rs.20000',   30, 1),
  ('hostel_amount_budget', '20000_30000',  'Rs.20000 to Rs.30000',   40, 1),
  ('hostel_amount_budget', '30000_40000',  'Rs.30000 to Rs.40000',   50, 1),
  ('hostel_amount_budget', '40000_50000',  'Rs.40000 to Rs.50000',   60, 1),
  ('hostel_amount_budget', '50000_60000',  'Rs.50000 to Rs.60000',   70, 1),
  ('hostel_amount_budget', '60000_70000',  'Rs.60000 to Rs.70000',   80, 1),
  ('hostel_amount_budget', '70000_80000',  'Rs.70000 to Rs.80000',   90, 1),
  ('hostel_amount_budget', '80000_90000',  'Rs.80000 to Rs.90000',  100, 1),
  ('hostel_amount_budget', '90000_100000', 'Rs.90000 to Rs.100000', 110, 1),
  ('hostel_amount_budget', 'above_100000', 'Rs.100000 & Above',     120, 1);
