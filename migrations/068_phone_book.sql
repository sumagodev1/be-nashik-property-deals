-- ===========================================================
-- 068 — Phone Book Database
-- ===========================================================
-- Independent centralized directory for personal + business contacts.
-- Deliberately SEPARATE from `business_associates` — no shared table,
-- no shared APIs, no shared backend implementation. UI-only similarity
-- with the Business Associates page is intentional per product spec.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS phone_book (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  salutation    ENUM('mr','mrs','miss','smt') NULL,
  first_name    VARCHAR(100) NOT NULL,
  middle_name   VARCHAR(100) NULL,
  surname       VARCHAR(100) NULL,
  company_name  VARCHAR(255) NULL,
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
  notes         VARCHAR(500) NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_phone_book_district (district_code),
  KEY ix_phone_book_taluka   (taluka_code),
  KEY ix_phone_book_city     (city_code),
  KEY ix_phone_book_created  (created_at),
  KEY ix_phone_book_mobile1  (mobile1),
  KEY ix_phone_book_email1   (email1),
  CONSTRAINT fk_phone_book_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
