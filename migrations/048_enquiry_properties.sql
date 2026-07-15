-- ============================================================
-- 048 — Enquiry properties (parallel to inventory_properties)
-- ============================================================
-- The 79 registration forms split into two admin-facing surfaces:
--
--   Inventory Forms  (22 forms — Out / Lease-Out / Rent-Out / Joint Venture)
--   Enquiry Forms    (57 forms — In / Purchase / Sale / Rent-In / Lease-In /
--                                Rate Finder / TDR / Bank Auction / etc.)
--
-- Requirement: both surfaces are fully independent modules — separate tables,
-- separate APIs, no cross-navigation. This migration adds the storage side.
--
-- `enquiry_properties` is a structural mirror of `inventory_properties` after
-- migrations 004 / 011 / 014 / 027 (all the ALTERs applied). Same columns,
-- same indexes, same FK to admins.
--
-- Data migration (moving Enquiry-category rows out of inventory_properties)
-- ships as a separate one-shot script (scripts/migrate-inventory-to-enquiry.js)
-- so it can be dry-run first and rolled back per admin ask.
-- ============================================================

SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- Enquiry properties table (mirror of inventory_properties)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enquiry_properties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_code VARCHAR(32) NOT NULL,
  registration_date DATE NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  property_type VARCHAR(64) NOT NULL,
  transaction_type ENUM('sale', 'rent', 'lease') NOT NULL,
  transaction_variant VARCHAR(64) NULL,
  location VARCHAR(255) NOT NULL,
  district VARCHAR(64) NULL,
  taluka VARCHAR(64) NULL,
  shivar VARCHAR(64) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  pincode VARCHAR(10) NULL,
  area_value DECIMAL(12,2) NULL,
  area_unit VARCHAR(16) NULL,
  bhk VARCHAR(16) NULL,
  price DECIMAL(14,2) NOT NULL,
  status ENUM('available', 'sold', 'rented', 'inactive') NOT NULL DEFAULT 'available',
  status_note TEXT NULL,
  status_changed_at DATETIME NULL,
  status_changed_by BIGINT UNSIGNED NULL,
  is_draft TINYINT(1) NOT NULL DEFAULT 0,
  owner_name VARCHAR(255) NULL,
  owner_contact VARCHAR(20) NULL,
  agent_name VARCHAR(255) NULL,
  agent_contact VARCHAR(20) NULL,
  details JSON NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_enquiry_property_code (property_code),
  KEY ix_enquiry_location (location),
  KEY ix_enquiry_property_type (property_type),
  KEY ix_enquiry_transaction_type (transaction_type),
  KEY ix_enquiry_transaction_variant (transaction_variant),
  KEY ix_enquiry_status (status),
  KEY ix_enquiry_is_draft (is_draft),
  KEY ix_enquiry_district_taluka (district, taluka),
  KEY ix_enquiry_pincode (pincode),
  KEY ix_enquiry_created_at (created_at),
  CONSTRAINT fk_enquiry_admin FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- Extend property_files.property_kind to include 'enquiry'.
-- Property images + private documents for enquiry rows go through the same
-- shared property_files table (identical policy: public images, private docs,
-- storage-usage tracking). The service layer already parametrises on
-- propertyKind — only the ENUM needs widening.
--
-- Idempotent guard: MODIFY COLUMN with the same set of values is a no-op if
-- 'enquiry' is already listed, so re-running this migration is safe.
-- ------------------------------------------------------------
ALTER TABLE property_files
  MODIFY COLUMN property_kind ENUM('inventory', 'website', 'enquiry') NOT NULL;
