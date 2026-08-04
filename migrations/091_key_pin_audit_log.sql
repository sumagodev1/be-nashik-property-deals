-- ===========================================================
-- 091 — Key PIN audit log
-- ===========================================================
-- Immutable append-only log of every security-relevant action on
-- a key_pin: reset requested, reset verified (via OTP or link),
-- reset completed, inline change (Current + New), enable/disable
-- via the master listing. The PIN value is NEVER written here —
-- only metadata about who did what, from where, and when.
--
-- Kept in a dedicated table (rather than a generic audit_log)
-- so PIN-related retention/purge policies can be applied
-- independently.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS key_pin_audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_pin_id BIGINT UNSIGNED NULL,
  admin_id BIGINT UNSIGNED NULL,
  admin_role VARCHAR(20) NULL,
  actor_name VARCHAR(255) NULL,
  action VARCHAR(40) NOT NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_audit_key_pin_created (key_pin_id, created_at),
  KEY ix_audit_admin_created (admin_id, created_at),
  CONSTRAINT fk_audit_key_pin
    FOREIGN KEY (key_pin_id) REFERENCES key_pins (id) ON DELETE SET NULL,
  CONSTRAINT fk_audit_admin
    FOREIGN KEY (admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
