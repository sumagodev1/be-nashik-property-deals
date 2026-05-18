-- Migration 008: configurable masters
--
-- Until now the four lookup vocabularies (property type, transaction type,
-- flat / BHK config, inventory status) lived only in code constants. Moving
-- them into MySQL tables lets the admin manage them from the panel without a
-- deploy. Every master table has the same shape so the application layer can
-- share one generic CRUD service.
--
-- Each row carries:
--   - code      machine-stable key referenced by inventory_properties /
--               website_properties (e.g. 'flat', 'sale', '2bhk', 'available')
--   - label     display string shown in the UI
--   - sort_order ascending sort hint for dropdowns
--   - is_active toggles visibility in the dropdowns without losing history
--   - deleted_at soft-delete (history kept; ux defaults to non-deleted)

CREATE TABLE IF NOT EXISTS master_property_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_master_property_types_code (code),
  KEY ix_master_property_types_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_transaction_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_master_transaction_types_code (code),
  KEY ix_master_transaction_types_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_flat_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_master_flat_types_code (code),
  KEY ix_master_flat_types_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS master_status_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  label VARCHAR(255) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_master_status_types_code (code),
  KEY ix_master_status_types_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed defaults so existing inventory / website rows keep working immediately.
INSERT IGNORE INTO master_property_types (code, label, sort_order) VALUES
  ('flat',         'Flat / Apartment', 10),
  ('house',        'House',            20),
  ('villa',        'Villa',            30),
  ('plot',         'Plot',             40),
  ('commercial',   'Commercial',       50),
  ('agricultural', 'Agricultural',     60),
  ('other',        'Other',            70);

INSERT IGNORE INTO master_transaction_types (code, label, sort_order) VALUES
  ('sale',  'Sale',  10),
  ('rent',  'Rent',  20),
  ('lease', 'Lease', 30);

INSERT IGNORE INTO master_flat_types (code, label, sort_order) VALUES
  ('studio', 'Studio', 10),
  ('1rk',    '1 RK',   20),
  ('1bhk',   '1 BHK',  30),
  ('2bhk',   '2 BHK',  40),
  ('3bhk',   '3 BHK',  50),
  ('4bhk',   '4 BHK',  60),
  ('5bhk',   '5 BHK',  70),
  ('duplex', 'Duplex', 80),
  ('penthouse', 'Penthouse', 90);

INSERT IGNORE INTO master_status_types (code, label, sort_order) VALUES
  ('available', 'Available', 10),
  ('sold',      'Sold',      20),
  ('rented',    'Rented',    30),
  ('inactive',  'Inactive',  40);
