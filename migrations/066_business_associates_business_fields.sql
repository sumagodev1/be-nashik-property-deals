-- ===========================================================
-- 066 — Business Associates: company_name / business_category
-- ===========================================================
-- Promotes two previously-packed values out of address_line2 into
-- their own columns so the manual Add/Edit form + Bulk Upload can
-- read/write them directly (and the View page can surface them as
-- discrete rows):
--
--   company_name       -- was: bulk-upload "Company Name" packed into
--                        address_line2 as "Co: ...". Rename display
--                        label to "Company Name / Business".
--   business_category  -- NEW column in the enhancement request.
--
-- Both columns are nullable so existing rows stay valid without
-- backfill. Nothing else in the row shape changes.
--
-- NOTE: An earlier revision of this migration also added a `business`
-- column, which was subsequently deemed unnecessary and removed. If a
-- prior apply left that column on your DB, drop it with:
--   ALTER TABLE business_associates DROP COLUMN business;
-- ===========================================================

SET NAMES utf8mb4;

ALTER TABLE business_associates
  ADD COLUMN company_name      VARCHAR(255) NULL AFTER surname,
  ADD COLUMN business_category VARCHAR(255) NULL AFTER company_name;
