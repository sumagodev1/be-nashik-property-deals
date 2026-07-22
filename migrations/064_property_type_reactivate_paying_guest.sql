-- ===========================================================
-- 064 - Global / Property Type: reactivate `paying_guest`
-- ===========================================================
-- Migration 058 reseeded master_property_types to 16 authoritative values
-- and soft-deleted every other row. `paying_guest` (originally seeded by
-- migration 012) was among the soft-deleted set.
--
-- The frontend, however, still treats `paying_guest` as a canonical
-- Property Type -- see
-- src/admin/pages/Inventory/dynamic/formCodeCanonicalMap.js:44
--   ['paying-guest-', 'paying_guest']
-- and the four Paying Guest registration forms in
-- src/admin/pages/Inventory/dynamic/payingGuestFormsConfig.js which each
-- ship `propertyType: 'paying_guest'` in the payload. The backend
-- constants map (server/constants/formCodeCatalog.js:PROPERTY_TYPE_TO_PREFIX)
-- also lists `paying_guest`.
--
-- After the ID-first centralised validator went live (services/masters/
-- propertyMasters.js), the previously-silent `propertyType` check became
-- strict, exposing the drift: PG saves failed with
--   "Unknown or inactive global / property type: 'paying_guest'"
--
-- This migration revives the row in place (preserves id + audit history)
-- so PG forms save cleanly. It does NOT touch transaction_type or
-- property_variety masters; `paying_guest` already exists as an active
-- transaction_type (migration 046).
-- ===========================================================

-- Revive an existing soft-deleted row if present.
UPDATE master_property_types
   SET label       = 'Paying Guest',
       sort_order  = 105,
       is_active   = 1,
       deleted_at  = NULL
 WHERE code = 'paying_guest';

-- Or insert fresh if this DB never had the row (idempotent guard).
INSERT IGNORE INTO master_property_types (code, label, sort_order, is_active)
VALUES ('paying_guest', 'Paying Guest', 105, 1);
