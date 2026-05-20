-- Migration 011: tabbed inventory registration form.
--
-- The new admin inventory form captures dozens of category-specific fields
-- (flat-only floor/lift; plot-only zoning/frontage; hostel-only room count;
-- land-only zone/variety; etc.). Adding ~120 nullable columns would be
-- painful to evolve and most rows would be empty for any given category.
--
-- Instead we keep the small set of common, queryable fields as columns
-- (code, title, type, txn, status, location, bhk, area, price, owner, agent)
-- and stash the long tail in a single JSON column. Querying inside `details`
-- is rare; when it's needed MySQL's JSON functions handle it.
--
-- Going JSON also means future field additions don't need a migration — only
-- a frontend change and an updated Joi schema.

ALTER TABLE inventory_properties
  ADD COLUMN details JSON NULL AFTER agent_contact;
