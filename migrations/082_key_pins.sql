-- ===========================================================
-- 082 — Key PIN Master (Security PIN Verification)
-- ===========================================================
-- Stores hashed 6-digit numeric PINs used to gate access to
-- confidential owner / key-person details and sensitive
-- property mutations (create / edit / delete).
--
-- PINs are NEVER stored in plaintext. bcrypt is used for
-- hashing at the service layer. The application enforces
-- max 5 ACTIVE PINs and 6-digit-numeric-only input; the
-- table itself just persists the hash + status.
--
-- Soft-delete via deleted_at so audit trails are preserved
-- even after a PIN is removed.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS key_pins (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  hashed_pin VARCHAR(255) NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  created_by_admin_id BIGINT UNSIGNED NULL,
  updated_by_admin_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_key_pins_status (status, deleted_at),
  KEY ix_key_pins_created (created_at),
  CONSTRAINT fk_key_pins_created_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL,
  CONSTRAINT fk_key_pins_updated_admin
    FOREIGN KEY (updated_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
