-- Migration 012: seed the property-category codes the new tabbed inventory
-- form uses. The form's outer tabs match the registration-form folders the
-- client supplied:
--   Flat, Bunglow, Plot, Shop, Land, Commercial, Hostel, Paying Guest.
--
-- Codes are inserted with INSERT IGNORE so this is safe to re-run and won't
-- clobber any label/sort_order tweaks the admin has already made via the
-- Masters UI.

INSERT IGNORE INTO master_property_types (code, label, sort_order, is_active) VALUES
  ('flat',          'Flat',          10, 1),
  ('bunglow',       'Bunglow',       20, 1),
  ('plot',          'Plot',          30, 1),
  ('shop',          'Shop',          40, 1),
  ('land',          'Land',          50, 1),
  ('commercial',    'Commercial',    60, 1),
  ('hostel',        'Hostel',        70, 1),
  ('paying_guest',  'Paying Guest',  80, 1);
