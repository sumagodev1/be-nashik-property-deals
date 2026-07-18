-- T-2026-048: add formatted_address column for reverse-geocoded human-readable
-- address string paired with (latitude, longitude). Nullable — legacy rows and
-- rows without a pinned map location leave it NULL. Existing lat/lng columns
-- are left untouched.

ALTER TABLE inventory_properties
  ADD COLUMN formatted_address VARCHAR(300) NULL AFTER longitude;

ALTER TABLE enquiry_properties
  ADD COLUMN formatted_address VARCHAR(300) NULL AFTER longitude;
