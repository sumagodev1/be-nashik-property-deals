-- ============================================================
-- 035 — Paying Guest MD-driven masters seed
-- ============================================================
-- Seeds the >2-option vocabularies referenced by the 2 Paying Guest
-- Registration Forms in `reference of forms/Paying Guest Registration
-- Forms.md`. Both forms (Bunglow PG, Flat PG) share one category — their
-- masters are all `paying_guest_*` and group under "Paying Guest / X" in
-- the Admin sidebar, NOT under Bunglow or Flat.
--
-- 2-option fields (New/Resale, Independent/Attached, Available/Not Available,
-- Yes/No, Apartment/Society) render as inline radio buttons — not seeded.
--
-- INSERT IGNORE is idempotent.
--
-- See also:
--   - Frontend/src/admin/pages/Inventory/dynamic/payingGuestMastersConfig.js

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── paying_guest_size (11 values — union of Bunglow PG + Flat PG sizes) ──
  ('paying_guest_size', '1_room',  '1 Room', 10,  1),
  ('paying_guest_size', '2_rooms', '2 Rooms',20,  1),
  ('paying_guest_size', '1bk',     '1BK',    30,  1),
  ('paying_guest_size', '1bhk',    '1BHK',   40,  1),
  ('paying_guest_size', '2bhk',    '2BHK',   50,  1),
  ('paying_guest_size', '3bhk',    '3BHK',   60,  1),
  ('paying_guest_size', '4bhk',    '4BHK',   70,  1),
  ('paying_guest_size', '5bhk',    '5BHK',   80,  1),
  ('paying_guest_size', '6bhk',    '6BHK',   90,  1),
  ('paying_guest_size', '7bhk',    '7BHK',  100,  1),
  ('paying_guest_size', '8bhk',    '8BHK',  110,  1),

  -- ── paying_guest_floor (Ground..12th) ────────────────────────
  ('paying_guest_floor', 'ground', 'Ground', 10,  1),
  ('paying_guest_floor', '1st',    '1st',    20,  1),
  ('paying_guest_floor', '2nd',    '2nd',    30,  1),
  ('paying_guest_floor', '3rd',    '3rd',    40,  1),
  ('paying_guest_floor', '4th',    '4th',    50,  1),
  ('paying_guest_floor', '5th',    '5th',    60,  1),
  ('paying_guest_floor', '6th',    '6th',    70,  1),
  ('paying_guest_floor', '7th',    '7th',    80,  1),
  ('paying_guest_floor', '8th',    '8th',    90,  1),
  ('paying_guest_floor', '9th',    '9th',   100,  1),
  ('paying_guest_floor', '10th',   '10th',  110,  1),
  ('paying_guest_floor', '11th',   '11th',  120,  1),
  ('paying_guest_floor', '12th',   '12th',  130,  1),

  -- ── paying_guest_facing ──────────────────────────────────────
  ('paying_guest_facing', 'east',  'East',  10, 1),
  ('paying_guest_facing', 'west',  'West',  20, 1),
  ('paying_guest_facing', 'north', 'North', 30, 1),
  ('paying_guest_facing', 'south', 'South', 40, 1),

  -- ── paying_guest_condition ───────────────────────────────────
  ('paying_guest_condition', 'unfurnished',     'Unfurnished',     10, 1),
  ('paying_guest_condition', 'semi_furnished',  'Semi-Furnished',  20, 1),
  ('paying_guest_condition', 'fully_furnished', 'Fully Furnished', 30, 1),

  -- ── paying_guest_status ──────────────────────────────────────
  ('paying_guest_status', 'available',     'Available',     10, 1),
  ('paying_guest_status', 'pipeline',      'Pipeline',      20, 1),
  ('paying_guest_status', 'not_available', 'Not Available', 30, 1),

  -- ── paying_guest_defect_built ────────────────────────────────
  ('paying_guest_defect_built', 'cracks',    'Cracks',    10, 1),
  ('paying_guest_defect_built', 'leakages',  'Leakages',  20, 1),
  ('paying_guest_defect_built', 'slum_area', 'Slum Area', 30, 1);
