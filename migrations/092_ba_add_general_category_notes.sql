-- ===========================================================
-- 092 — Business Associates: add general_category + notes
-- ===========================================================
-- The Business Associates module is being unified with the Phone Book
-- module into a single "Business Associates Database" (see spec).
--
-- To support that:
--   1. `general_category` classifies each row as a Business Associate
--      or a Phone Book entry (the two originating buckets). Default is
--      'business_associate' so every existing row remains a BA — Phone
--      Book rows are migrated in migration 093 with the other value.
--   2. `notes` mirrors the Phone Book column so migrated PB rows can
--      preserve their existing notes text. Kept nullable because
--      historical BA rows have no notes.
--
-- No existing columns are touched. No indexes are removed. Existing
-- routes / queries / DTOs continue to work unchanged; the new columns
-- become visible only after the service is extended in a follow-up.
-- ===========================================================

SET NAMES utf8mb4;

ALTER TABLE business_associates
  ADD COLUMN general_category ENUM('business_associate', 'phone_book')
      NOT NULL DEFAULT 'business_associate'
      AFTER id,
  ADD COLUMN notes VARCHAR(500) NULL
      AFTER date_of_birth,
  ADD KEY ix_biz_assoc_general_category (general_category, deleted_at);
