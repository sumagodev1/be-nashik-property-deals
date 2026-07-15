-- ===========================================================
-- 047 — Land Record Management (three record types)
-- ===========================================================
-- Adds three admin-only record surfaces sourced from
-- `reference of forms/LandRecordManagement.md`:
--
--   1. Gaothan Land Locator      — location + gut + road-approach details
--   2. Survey Number Locator     — survey number with directional landmarks
--   3. Paper Notice Record       — legal-notice publication tracking
--
-- Each is a standalone form with its own table — they share no columns
-- with inventory_properties or website_properties and follow a
-- different domain (parcel + notice bookkeeping, not sale/rent).
--
-- The Gaothan and Survey Number forms reuse the existing global
-- `district` / `taluka` / `shivar` masters (already seeded in
-- migration 026). The Paper Notice form seeds six NEW `master_lookups`
-- vocabularies:
--   - paper_notice_paper_name       (Paper name)
--   - paper_notice_area             (Area unit)
--   - paper_notice_pot_kharba       (Pot Kharaba unit)
--   - paper_notice_total_area       (Total Area unit)
--   - paper_notice_owners_area      (Owner's Area unit)
--   - paper_notice_saleable_area    (Saleable Area unit)
--
-- Salutation (Mr./Mrs./Smt./Miss) is intentionally NOT seeded — it's a
-- static frontend dropdown per the source doc, and only its selected
-- string is persisted on the record.
-- ===========================================================

SET NAMES utf8mb4;

-- ─────────────────────────────────────────────────────────────
-- 1. Gaothan Land Locator
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gaothan_land_locators (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  district_code       VARCHAR(64) NOT NULL,
  taluka_code         VARCHAR(64) NOT NULL,
  shivar_code         VARCHAR(64) NOT NULL,
  location            VARCHAR(255) NOT NULL,
  gut_or_survey_no    VARCHAR(255) NOT NULL,
  distance_from_gaothan VARCHAR(255) NULL,
  road_approach       TINYINT(1)   NOT NULL DEFAULT 0,
  road_approach_note  VARCHAR(500) NULL,
  road_1              VARCHAR(255) NULL,
  road_2              VARCHAR(255) NULL,
  area_guntha         DECIMAL(12,4) NULL,
  area_acre           DECIMAL(12,4) NULL,
  rate_per_guntha     DECIMAL(14,2) NULL,
  rate_per_acre       DECIMAL(14,2) NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_gaothan_district (district_code),
  KEY ix_gaothan_taluka   (taluka_code),
  KEY ix_gaothan_shivar   (shivar_code),
  KEY ix_gaothan_created  (created_at),
  CONSTRAINT fk_gaothan_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 2. Survey Number Locator
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS survey_number_locators (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  district_code       VARCHAR(64) NOT NULL,
  taluka_code         VARCHAR(64) NOT NULL,
  shivar_code         VARCHAR(64) NOT NULL,
  gut_or_survey_no    VARCHAR(255) NOT NULL,
  locality            VARCHAR(255) NOT NULL,
  road_touch          TINYINT(1)   NOT NULL DEFAULT 0,
  road_touch_note     VARCHAR(500) NULL,
  road                VARCHAR(255) NULL,
  off_road            VARCHAR(255) NULL,
  in_front_of         VARCHAR(255) NULL,
  near_by             VARCHAR(255) NULL,
  behind              VARCHAR(255) NULL,
  opposite            VARCHAR(255) NULL,
  next_to             VARCHAR(255) NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_survey_district (district_code),
  KEY ix_survey_taluka   (taluka_code),
  KEY ix_survey_shivar   (shivar_code),
  KEY ix_survey_created  (created_at),
  CONSTRAINT fk_survey_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- 3. Paper Notice Record
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_notice_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  paper_name_code     VARCHAR(64)  NOT NULL,
  page_no             VARCHAR(64)  NULL,
  paper_notice_no     VARCHAR(255) NULL,
  notice_date         DATE         NOT NULL,
  advocate_salutation ENUM('mr','mrs','smt','miss') NOT NULL,
  advocate_name       VARCHAR(255) NOT NULL,
  chamber_no          VARCHAR(64)  NULL,
  address             VARCHAR(500) NULL,
  contact_no          VARCHAR(20)  NULL,
  gut_or_survey_no    VARCHAR(255) NOT NULL,
  area_value          DECIMAL(14,4) NULL,
  area_unit_code      VARCHAR(64)  NULL,
  pot_kharba_value    DECIMAL(14,4) NULL,
  pot_kharba_unit_code VARCHAR(64) NULL,
  total_area_value    DECIMAL(14,4) NULL,
  total_area_unit_code VARCHAR(64) NULL,
  aakaar_paise        DECIMAL(14,2) NULL,
  owners_area_value   DECIMAL(14,4) NULL,
  owners_area_unit_code VARCHAR(64) NULL,
  owner_name          VARCHAR(255) NULL,
  saleable_area_value DECIMAL(14,4) NULL,
  saleable_area_unit_code VARCHAR(64) NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_paper_notice_date  (notice_date),
  KEY ix_paper_paper_name   (paper_name_code),
  KEY ix_paper_created      (created_at),
  CONSTRAINT fk_paper_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────
-- Master vocabularies for the Paper Notice form.
-- INSERT IGNORE keeps the migration idempotent.
-- The six area-unit masters share the same six values but are kept
-- as SEPARATE masters per the source doc's field-by-field naming
-- convention (paper_notice_area, paper_notice_pot_kharba, …).
-- ─────────────────────────────────────────────────────────────
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  -- paper_notice_paper_name
  ('paper_notice_paper_name', 'deshdoot',           'Deshdoot',           10, 1),
  ('paper_notice_paper_name', 'gavkari',            'Gavkari',            20, 1),
  ('paper_notice_paper_name', 'lokmat',             'Lokmat',             30, 1),
  ('paper_notice_paper_name', 'sakal',              'Sakal',              40, 1),
  ('paper_notice_paper_name', 'divya_marathi',      'Divya Marathi',      50, 1),
  ('paper_notice_paper_name', 'loksatta',           'Loksatta',           60, 1),
  ('paper_notice_paper_name', 'maharashtra_times',  'Maharashtra Times',  70, 1),
  ('paper_notice_paper_name', 'lokmat_times',       'Lokmat Times',       80, 1),
  ('paper_notice_paper_name', 'punya_nagari',       'Punya Nagari',       90, 1),
  ('paper_notice_paper_name', 'bhramer',            'Bhramer',           100, 1),
  ('paper_notice_paper_name', 'times_of_india',     'Times of India',    110, 1),
  ('paper_notice_paper_name', 'indian_express',     'Indian Express',    120, 1),
  ('paper_notice_paper_name', 'financial_express',  'Financial Express', 130, 1),
  ('paper_notice_paper_name', 'others',             'Others',            140, 1),

  -- paper_notice_area
  ('paper_notice_area', 'sq_ft',    'Sq. Ft.',    10, 1),
  ('paper_notice_area', 'sq_meter', 'Sq. Meter',  20, 1),
  ('paper_notice_area', 'sq_yard',  'Sq. Yard',   30, 1),
  ('paper_notice_area', 'guntha',   'Guntha',     40, 1),
  ('paper_notice_area', 'acre',     'Acre',       50, 1),
  ('paper_notice_area', 'hectare',  'Hectare',    60, 1),

  -- paper_notice_pot_kharba
  ('paper_notice_pot_kharba', 'sq_ft',    'Sq. Ft.',    10, 1),
  ('paper_notice_pot_kharba', 'sq_meter', 'Sq. Meter',  20, 1),
  ('paper_notice_pot_kharba', 'sq_yard',  'Sq. Yard',   30, 1),
  ('paper_notice_pot_kharba', 'guntha',   'Guntha',     40, 1),
  ('paper_notice_pot_kharba', 'acre',     'Acre',       50, 1),
  ('paper_notice_pot_kharba', 'hectare',  'Hectare',    60, 1),

  -- paper_notice_total_area
  ('paper_notice_total_area', 'sq_ft',    'Sq. Ft.',    10, 1),
  ('paper_notice_total_area', 'sq_meter', 'Sq. Meter',  20, 1),
  ('paper_notice_total_area', 'sq_yard',  'Sq. Yard',   30, 1),
  ('paper_notice_total_area', 'guntha',   'Guntha',     40, 1),
  ('paper_notice_total_area', 'acre',     'Acre',       50, 1),
  ('paper_notice_total_area', 'hectare',  'Hectare',    60, 1),

  -- paper_notice_owners_area
  ('paper_notice_owners_area', 'sq_ft',    'Sq. Ft.',    10, 1),
  ('paper_notice_owners_area', 'sq_meter', 'Sq. Meter',  20, 1),
  ('paper_notice_owners_area', 'sq_yard',  'Sq. Yard',   30, 1),
  ('paper_notice_owners_area', 'guntha',   'Guntha',     40, 1),
  ('paper_notice_owners_area', 'acre',     'Acre',       50, 1),
  ('paper_notice_owners_area', 'hectare',  'Hectare',    60, 1),

  -- paper_notice_saleable_area
  ('paper_notice_saleable_area', 'sq_ft',    'Sq. Ft.',    10, 1),
  ('paper_notice_saleable_area', 'sq_meter', 'Sq. Meter',  20, 1),
  ('paper_notice_saleable_area', 'sq_yard',  'Sq. Yard',   30, 1),
  ('paper_notice_saleable_area', 'guntha',   'Guntha',     40, 1),
  ('paper_notice_saleable_area', 'acre',     'Acre',       50, 1),
  ('paper_notice_saleable_area', 'hectare',  'Hectare',    60, 1);
