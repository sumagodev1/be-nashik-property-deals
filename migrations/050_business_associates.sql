-- ===========================================================
-- 050 — Business Associates Database
-- ===========================================================
-- Directory of clients / business associates the office works with.
-- Powers the Admin → Business Associates CRUD and the public
-- homepage strip (`/api/public/business-associates`).
--
-- Location fields piggy-back on the existing global masters:
--   district_code → master_lookups.master_key = 'district'
--   taluka_code   → master_lookups.master_key = 'taluka'
--   city_code     → master_lookups.master_key = 'shivar' (smallest unit)
-- The frontend form uses the same LocationCascade component as the
-- Land Records surface; city == shivar here — the admin form just
-- relabels the last dropdown "City" for this use case.
--
-- No unique-key constraint on mobile / email — a single associate can
-- have multiple contacts, and multiple entries may legitimately share
-- an email (e.g. two people at the same firm). Duplicate detection is
-- a UX concern, not a DB constraint.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS business_associates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  salutation    ENUM('mr','mrs','miss','smt') NOT NULL,
  first_name    VARCHAR(100) NOT NULL,
  middle_name   VARCHAR(100) NULL,
  surname       VARCHAR(100) NULL,
  designation   VARCHAR(200) NULL,
  address_line1 VARCHAR(255) NULL,
  address_line2 VARCHAR(255) NULL,
  city_code     VARCHAR(64)  NULL,
  taluka_code   VARCHAR(64)  NULL,
  district_code VARCHAR(64)  NULL,
  phone1        VARCHAR(20)  NULL,
  phone2        VARCHAR(20)  NULL,
  mobile1       VARCHAR(20)  NULL,
  mobile2       VARCHAR(20)  NULL,
  mobile3       VARCHAR(20)  NULL,
  whatsapp      VARCHAR(20)  NULL,
  email1        VARCHAR(255) NULL,
  email2        VARCHAR(255) NULL,
  website1      VARCHAR(255) NULL,
  website2      VARCHAR(255) NULL,
  date_of_birth DATE NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_biz_assoc_district (district_code),
  KEY ix_biz_assoc_taluka   (taluka_code),
  KEY ix_biz_assoc_city     (city_code),
  KEY ix_biz_assoc_created  (created_at),
  -- Contact-lookup helpers for the list-page search.
  KEY ix_biz_assoc_mobile1  (mobile1),
  KEY ix_biz_assoc_email1   (email1),
  CONSTRAINT fk_biz_assoc_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
