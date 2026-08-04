-- ===========================================================
-- 093 — Merge Phone Book into Business Associates
-- ===========================================================
-- Companion to migration 092 (schema) — this migration MOVES data.
--
-- After this runs, every non-deleted Phone Book row exists in
-- `business_associates` with general_category='phone_book'. The
-- Phone Book table itself is LEFT INTACT as a permanent archive so
-- rollback is possible; nothing writes to it going forward (the
-- frontend + backend route wiring stop pointing at it).
--
-- Three independent write-blocks below:
--   1. INSERT phone_book rows → business_associates.
--   2. UPSERT phone_book_designation master values into
--      business_associate_designation (dedupe on `code`).
--   3. GRANT BUSINESS_ASSOCIATE_MANAGEMENT to every sub-admin who
--      currently holds PHONE_BOOK_MANAGEMENT so their access is
--      preserved after the frontend removes the PB nav item.
--
-- All three blocks use IGNORE / ON DUPLICATE KEY UPDATE so the
-- migration is safe to re-run.
-- ===========================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- 1. Data migration: phone_book → business_associates.
-- ------------------------------------------------------------
-- New IDs are auto-assigned. Original phone_book.id is not preserved
-- because no other table has an FK referencing it (audited). Every
-- other column maps one-for-one; business_category / area_wise /
-- property_wise are set NULL because PB never captured them.
INSERT INTO business_associates (
  general_category,
  salutation, first_name, middle_name, surname,
  company_name, business_category, designation,
  area_wise, property_wise,
  address_line1, address_line2,
  city_code, taluka_code, district_code,
  phone1, phone2,
  mobile1, mobile2, mobile3,
  whatsapp,
  email1, email2,
  website1, website2,
  date_of_birth,
  notes,
  created_by_admin_id,
  created_at, updated_at
)
SELECT
  'phone_book',
  -- phone_book.salutation is nullable; business_associates.salutation
  -- is NOT NULL. Coalesce to 'mr' as a safe neutral default so the
  -- migration cannot fail on a legacy row with a missing salutation.
  COALESCE(pb.salutation, 'mr'),
  pb.first_name, pb.middle_name, pb.surname,
  pb.company_name, NULL, pb.designation,
  NULL, NULL,
  pb.address_line1, pb.address_line2,
  pb.city_code, pb.taluka_code, pb.district_code,
  pb.phone1, pb.phone2,
  pb.mobile1, pb.mobile2, pb.mobile3,
  pb.whatsapp,
  pb.email1, pb.email2,
  pb.website1, pb.website2,
  pb.date_of_birth,
  pb.notes,
  pb.created_by_admin_id,
  pb.created_at, pb.updated_at
FROM phone_book pb
WHERE pb.deleted_at IS NULL
  -- Idempotency guard: don't re-import a PB row whose contact set is
  -- already represented in business_associates as a phone_book entry.
  -- Match on mobile1 (the primary handle) if present, else email1.
  AND NOT EXISTS (
    SELECT 1 FROM business_associates ba
    WHERE ba.general_category = 'phone_book'
      AND ba.deleted_at IS NULL
      AND (
        (pb.mobile1 IS NOT NULL AND pb.mobile1 <> '' AND ba.mobile1 = pb.mobile1)
        OR
        (pb.email1  IS NOT NULL AND pb.email1  <> '' AND ba.email1  = pb.email1)
      )
  );

-- ------------------------------------------------------------
-- 2. Designation master merge.
-- ------------------------------------------------------------
-- Copy every phone_book_designation entry into the
-- business_associate_designation vocabulary, deduping on `code`.
-- master_lookups has a UNIQUE (master_key, code) constraint (see
-- migration 001), so INSERT IGNORE cleanly skips collisions.
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active)
SELECT
  'business_associate_designation',
  code,
  label,
  -- Shift PB sort_orders to sit AFTER the BA range so they cluster
  -- at the end of the unified dropdown instead of interleaving.
  1000 + COALESCE(sort_order, 0),
  is_active
FROM master_lookups
WHERE master_key = 'phone_book_designation';

-- ------------------------------------------------------------
-- 3. Permission migration.
-- ------------------------------------------------------------
-- Any sub-admin currently authorised for the (soon-to-be-retired)
-- PHONE_BOOK_MANAGEMENT module needs BUSINESS_ASSOCIATE_MANAGEMENT
-- so they keep seeing the unified module in the sidebar.
-- We keep the PB grant in place too — the constant still exists as
-- a permission key and removing it here would be a destructive
-- action outside the scope of this migration.
INSERT IGNORE INTO sub_admin_modules (sub_admin_id, module_key)
SELECT DISTINCT sub_admin_id, 'business_associate_management'
FROM sub_admin_modules
WHERE module_key = 'phone_book_management';
