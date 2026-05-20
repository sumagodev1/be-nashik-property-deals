-- Migration 013: details JSON on website_properties.
--
-- Mirrors the column added to inventory_properties in migration 011 so both
-- property tables can carry the same open-ended extras (map coordinates,
-- amenities, etc.). On website_properties this primarily holds lat/lng for
-- the public detail page's map, but any category-specific fields the admin
-- captures during review can also live here.

ALTER TABLE website_properties
  ADD COLUMN details JSON NULL AFTER rejection_reason;
