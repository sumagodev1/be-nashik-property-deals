-- ============================================================
-- 085 — Hotel MD-driven masters seed
-- ============================================================
-- Seeds every vocabulary referenced by the Hotel Registration Form,
-- sourced from `reference of forms/hotel.md`. Hotel replaces its previous
-- (never-shipped) master set with a spec-aligned collection: one expandable
-- vocabulary (`hotel_type`) plus 27 fixed Available / Not Available
-- masters covering Utilities, Technology Setup, Essential Licenses, and
-- the Buyer Checklist.
--
-- Naming: master keys are `hotel_*`, hierarchical labels start with
-- `Hotel / ` so they group in the Admin → Masters sidebar next to the
-- other property-family masters.
--
-- Per spec:
--   • `hotel_type` is expandable (Veg / Non-Veg / Fast Food / Café /
--     Fine Dining / Cloud Kitchen). Admins can add new types via the
--     "Other → Save" flow on the Hotel form.
--   • Every other Hotel master is a fixed 2-option Available / Not
--     Available pair. The Do-NOT-add-Other-to-fixed-value-fields rule
--     is enforced on the FE via FIXED_VALUE_MASTERS in
--     DynamicPropertyForm.jsx.
--
-- INSERT IGNORE keeps the migration idempotent. Related:
--   - server/services/masters/management.js LOOKUP_KEYS / MASTER_LABELS
--   - src/admin/pages/Inventory/dynamic/hotelMastersConfig.js on the FE
--   - src/admin/pages/Inventory/dynamic/hotelFormsConfig.js on the FE
-- ============================================================

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- ── hotel_type (expandable) ─────────────────────────────────
  ('hotel_type', 'veg',           'Veg',           10, 1),
  ('hotel_type', 'non_veg',       'Non-Veg',       20, 1),
  ('hotel_type', 'fast_food',     'Fast Food',     30, 1),
  ('hotel_type', 'cafe',          'Café',          40, 1),
  ('hotel_type', 'fine_dining',   'Fine Dining',   50, 1),
  ('hotel_type', 'cloud_kitchen', 'Cloud Kitchen', 60, 1),

  -- ── Utilities (6 × Available / Not Available) ──────────────
  ('hotel_generator_power_backup', 'available',     'Available',     10, 1),
  ('hotel_generator_power_backup', 'not_available', 'Not Available', 20, 1),

  ('hotel_inverter_ups_support',   'available',     'Available',     10, 1),
  ('hotel_inverter_ups_support',   'not_available', 'Not Available', 20, 1),

  ('hotel_water_tanks',            'available',     'Available',     10, 1),
  ('hotel_water_tanks',            'not_available', 'Not Available', 20, 1),

  ('hotel_water_pumps',            'available',     'Available',     10, 1),
  ('hotel_water_pumps',            'not_available', 'Not Available', 20, 1),

  ('hotel_lift_facility',          'available',     'Available',     10, 1),
  ('hotel_lift_facility',          'not_available', 'Not Available', 20, 1),

  ('hotel_parking_facility',       'available',     'Available',     10, 1),
  ('hotel_parking_facility',       'not_available', 'Not Available', 20, 1),

  -- ── Technology Setup (9 × Available / Not Available) ────────
  ('hotel_billing_computer',        'available',     'Available',     10, 1),
  ('hotel_billing_computer',        'not_available', 'Not Available', 20, 1),

  ('hotel_pos_software',            'available',     'Available',     10, 1),
  ('hotel_pos_software',            'not_available', 'Not Available', 20, 1),

  ('hotel_online_ordering_system',  'available',     'Available',     10, 1),
  ('hotel_online_ordering_system',  'not_available', 'Not Available', 20, 1),

  ('hotel_receipt_printer',         'available',     'Available',     10, 1),
  ('hotel_receipt_printer',         'not_available', 'Not Available', 20, 1),

  ('hotel_qr_menu',                 'available',     'Available',     10, 1),
  ('hotel_qr_menu',                 'not_available', 'Not Available', 20, 1),

  ('hotel_barcode_scanner',         'available',     'Available',     10, 1),
  ('hotel_barcode_scanner',         'not_available', 'Not Available', 20, 1),

  ('hotel_card_payment_machine',    'available',     'Available',     10, 1),
  ('hotel_card_payment_machine',    'not_available', 'Not Available', 20, 1),

  ('hotel_inventory_mgmt_software', 'available',     'Available',     10, 1),
  ('hotel_inventory_mgmt_software', 'not_available', 'Not Available', 20, 1),

  ('hotel_cctv_monitoring',         'available',     'Available',     10, 1),
  ('hotel_cctv_monitoring',         'not_available', 'Not Available', 20, 1),

  -- ── Essential Licenses (7 × Available / Not Available) ──────
  ('hotel_fssai_license',           'available',     'Available',     10, 1),
  ('hotel_fssai_license',           'not_available', 'Not Available', 20, 1),

  ('hotel_gst_registration',        'available',     'Available',     10, 1),
  ('hotel_gst_registration',        'not_available', 'Not Available', 20, 1),

  ('hotel_shop_establishment_reg',  'available',     'Available',     10, 1),
  ('hotel_shop_establishment_reg',  'not_available', 'Not Available', 20, 1),

  ('hotel_trade_license',           'available',     'Available',     10, 1),
  ('hotel_trade_license',           'not_available', 'Not Available', 20, 1),

  ('hotel_fire_noc',                'available',     'Available',     10, 1),
  ('hotel_fire_noc',                'not_available', 'Not Available', 20, 1),

  ('hotel_pollution_approvals',     'available',     'Available',     10, 1),
  ('hotel_pollution_approvals',     'not_available', 'Not Available', 20, 1),

  ('hotel_music_playing_license',   'available',     'Available',     10, 1),
  ('hotel_music_playing_license',   'not_available', 'Not Available', 20, 1),

  -- ── Checklist Before Buying (5 × Available / Not Available) ─
  ('hotel_commercial_use_permission', 'available',     'Available',     10, 1),
  ('hotel_commercial_use_permission', 'not_available', 'Not Available', 20, 1),

  ('hotel_adequate_water_supply',     'available',     'Available',     10, 1),
  ('hotel_adequate_water_supply',     'not_available', 'Not Available', 20, 1),

  ('hotel_3phase_electricity',        'available',     'Available',     10, 1),
  ('hotel_3phase_electricity',        'not_available', 'Not Available', 20, 1),

  ('hotel_kitchen_exhaust_route',     'available',     'Available',     10, 1),
  ('hotel_kitchen_exhaust_route',     'not_available', 'Not Available', 20, 1),

  ('hotel_high_footfall_location',    'available',     'Available',     10, 1),
  ('hotel_high_footfall_location',    'not_available', 'Not Available', 20, 1);
