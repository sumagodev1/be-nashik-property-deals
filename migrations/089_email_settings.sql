-- ===========================================================
-- 089 — Global / Email Master (central SMTP + admin email)
-- ===========================================================
-- Central configuration for every outbound email sent by the
-- application (OTPs, property share, submissions, approvals,
-- PIN recovery, future notifications). At most ONE row is
-- allowed to be active at any time (enforced at the service
-- layer + the unique index on is_active where 1).
--
-- SMTP password is stored encrypted (AES-256-GCM at the
-- service layer) — never persisted in plaintext. `password_ciphertext`
-- holds "iv:tag:ciphertext" as a base64 triple; NULL when the
-- SMTP server is unauthenticated.
--
-- `admin_email` is the recipient address for administrator-only
-- notifications: PIN recovery OTP + link, PIN change confirmation,
-- future security alerts. Not the same as `sender_email` (the
-- FROM header) or `reply_to_email` (the Reply-To header).
--
-- Soft-delete via deleted_at preserves audit trail after config
-- rotation.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS email_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  smtp_host VARCHAR(255) NOT NULL,
  smtp_port SMALLINT UNSIGNED NOT NULL DEFAULT 587,
  smtp_username VARCHAR(255) NULL,
  password_ciphertext TEXT NULL,
  sender_email VARCHAR(255) NOT NULL,
  sender_name VARCHAR(255) NOT NULL,
  encryption ENUM('none', 'ssl', 'tls') NOT NULL DEFAULT 'tls',
  reply_to_email VARCHAR(255) NULL,
  admin_email VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 0,
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_by_name VARCHAR(255) NULL,
  updated_by_admin_id BIGINT UNSIGNED NULL,
  updated_by_name VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY ix_email_settings_active (is_active, deleted_at),
  CONSTRAINT fk_email_settings_created_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL,
  CONSTRAINT fk_email_settings_updated_admin
    FOREIGN KEY (updated_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
