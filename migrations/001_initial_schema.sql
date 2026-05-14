-- Nasik Property Deals — initial schema
-- Run: mysql -u <user> -p <db_name> < 001_initial_schema.sql
-- Idempotent: every CREATE uses IF NOT EXISTS.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ===========================================================
-- Admin users (full access)
-- ===========================================================
CREATE TABLE IF NOT EXISTS admins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_admins_email (email),
  KEY ix_admins_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Sub admins (staff) with module-level access
-- ===========================================================
CREATE TABLE IF NOT EXISTS sub_admins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sub_admins_email (email),
  KEY ix_sub_admins_is_active (is_active),
  CONSTRAINT fk_sub_admins_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Module access toggles per sub admin (one row per granted module).
CREATE TABLE IF NOT EXISTS sub_admin_modules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sub_admin_id BIGINT UNSIGNED NOT NULL,
  module_key VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sub_admin_module (sub_admin_id, module_key),
  CONSTRAINT fk_sub_admin_modules_sub_admin FOREIGN KEY (sub_admin_id) REFERENCES sub_admins (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Sellers (Owner / Agent)
-- ===========================================================
CREATE TABLE IF NOT EXISTS sellers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_type ENUM('owner', 'agent') NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  mobile_number VARCHAR(20) NOT NULL,
  email VARCHAR(255) NOT NULL,
  alternate_contact VARCHAR(20) NULL,
  agency_name VARCHAR(255) NULL,
  business_address TEXT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sellers_mobile (mobile_number),
  KEY ix_sellers_email (email),
  KEY ix_sellers_user_type (user_type),
  KEY ix_sellers_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Inventory properties (admin-managed, internal only)
-- ===========================================================
CREATE TABLE IF NOT EXISTS inventory_properties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_code VARCHAR(32) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  property_type VARCHAR(64) NOT NULL,
  transaction_type ENUM('sale', 'rent', 'lease') NOT NULL,
  location VARCHAR(255) NOT NULL,
  area_value DECIMAL(12,2) NULL,
  area_unit VARCHAR(16) NULL,
  bhk VARCHAR(16) NULL,
  price DECIMAL(14,2) NOT NULL,
  status ENUM('available', 'sold', 'rented', 'inactive') NOT NULL DEFAULT 'available',
  owner_name VARCHAR(255) NULL,
  owner_contact VARCHAR(20) NULL,
  agent_name VARCHAR(255) NULL,
  agent_contact VARCHAR(20) NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_inventory_property_code (property_code),
  KEY ix_inventory_location (location),
  KEY ix_inventory_property_type (property_type),
  KEY ix_inventory_transaction_type (transaction_type),
  KEY ix_inventory_status (status),
  KEY ix_inventory_created_at (created_at),
  CONSTRAINT fk_inventory_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Website properties (seller-submitted, public after approval)
-- ===========================================================
CREATE TABLE IF NOT EXISTS website_properties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_code VARCHAR(32) NOT NULL,
  seller_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  property_type VARCHAR(64) NOT NULL,
  transaction_type ENUM('sale', 'rent', 'lease') NOT NULL,
  location VARCHAR(255) NOT NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  area_value DECIMAL(12,2) NULL,
  area_unit VARCHAR(16) NULL,
  bhk VARCHAR(16) NULL,
  price DECIMAL(14,2) NOT NULL,
  approval_status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_featured TINYINT(1) NOT NULL DEFAULT 0,
  approved_by_admin_id BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  rejection_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_website_property_code (property_code),
  KEY ix_website_seller (seller_id),
  KEY ix_website_location (location),
  KEY ix_website_property_type (property_type),
  KEY ix_website_transaction_type (transaction_type),
  KEY ix_website_approval (approval_status),
  KEY ix_website_active_featured (is_active, is_featured),
  KEY ix_website_created_at (created_at),
  CONSTRAINT fk_website_seller FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE CASCADE,
  CONSTRAINT fk_website_approver FOREIGN KEY (approved_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Property files (images for both kinds; documents for agents)
-- ===========================================================
CREATE TABLE IF NOT EXISTS property_files (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_kind ENUM('inventory', 'website') NOT NULL,
  property_id BIGINT UNSIGNED NOT NULL,
  file_kind ENUM('image', 'document') NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(127) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_property_files_lookup (property_kind, property_id, file_kind),
  KEY ix_property_files_stored_name (stored_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seller agent business documents (separate from property files)
CREATE TABLE IF NOT EXISTS seller_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  seller_id BIGINT UNSIGNED NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(127) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_seller_documents_seller (seller_id),
  CONSTRAINT fk_seller_documents_seller FOREIGN KEY (seller_id) REFERENCES sellers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Leads (generated by Buyer clicks on Contact Seller / View Location)
-- ===========================================================
CREATE TABLE IF NOT EXISTS leads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  website_property_id BIGINT UNSIGNED NOT NULL,
  action_type ENUM('contact_seller', 'view_location') NOT NULL,
  buyer_name VARCHAR(255) NOT NULL,
  buyer_mobile VARCHAR(20) NOT NULL,
  buyer_email VARCHAR(255) NOT NULL,
  message TEXT NULL,
  status ENUM('new', 'contacted') NOT NULL DEFAULT 'new',
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_leads_property (website_property_id),
  KEY ix_leads_status (status),
  KEY ix_leads_created_at (created_at),
  CONSTRAINT fk_leads_property FOREIGN KEY (website_property_id) REFERENCES website_properties (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- OTPs (email-based for Buyer + Seller flows)
-- ===========================================================
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  purpose ENUM('seller_register', 'buyer_lead') NOT NULL,
  email VARCHAR(255) NOT NULL,
  mobile_number VARCHAR(20) NULL,
  code_hash VARCHAR(255) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed_at DATETIME NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_otp_purpose_email (purpose, email),
  KEY ix_otp_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Refresh tokens (for JWT rotation)
-- ===========================================================
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_kind ENUM('admin', 'sub_admin') NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  replaced_by_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_refresh_token_hash (token_hash),
  KEY ix_refresh_subject (subject_kind, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Notifications (in-app, visible to admin + authorized sub admin)
-- ===========================================================
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NULL,
  related_kind VARCHAR(64) NULL,
  related_id BIGINT UNSIGNED NULL,
  module_key VARCHAR(64) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_notifications_module (module_key),
  KEY ix_notifications_created_at (created_at),
  KEY ix_notifications_is_read (is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Email outbox (retry queue for failed sends)
-- ===========================================================
CREATE TABLE IF NOT EXISTS email_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  to_address VARCHAR(255) NOT NULL,
  subject VARCHAR(512) NOT NULL,
  body_text MEDIUMTEXT NULL,
  body_html MEDIUMTEXT NULL,
  status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT NULL,
  next_attempt_at DATETIME NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_email_outbox_status (status, next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- CMS (hero banners, contact info, social links)
-- ===========================================================
CREATE TABLE IF NOT EXISTS cms_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  setting_key VARCHAR(128) NOT NULL,
  setting_value MEDIUMTEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_cms_setting_key (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cms_banners (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  image_file_id BIGINT UNSIGNED NULL,
  image_url VARCHAR(512) NULL,
  alt_text VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_cms_banners_active_sort (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===========================================================
-- Storage usage tracker (for the 500 MB total quota)
-- ===========================================================
CREATE TABLE IF NOT EXISTS storage_usage (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_storage_usage_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO storage_usage (id, used_bytes) VALUES (1, 0);
