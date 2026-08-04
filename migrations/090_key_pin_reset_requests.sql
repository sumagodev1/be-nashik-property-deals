-- ===========================================================
-- 090 — Key PIN reset requests (Forget PIN OTP + link flow)
-- ===========================================================
-- One row per Forget-PIN request. Stores the bcrypt-hashed OTP,
-- the verification token used in the email link, the recipient
-- email (denormalized from the Email Master at request time for
-- audit reproducibility), and the expiry/lifecycle timestamps.
--
-- Security invariants (enforced at the service layer):
--   - Only one row per key_pin_id may be `pending` (verified_at
--     NULL AND used_at NULL AND expires_at > NOW()) at any time.
--     A new request supersedes any older pending request.
--   - OTP + token both expire after 15 minutes.
--   - `used_at` is set on successful reset-complete; a row can
--     never be re-used.
--   - `verification_token` is a 32-byte random hex string (64
--     chars) — safe to embed in a URL.
--   - `otp_hash` is bcrypt(6-digit OTP) — plaintext OTP is only
--     in the email body and never persisted.
-- ===========================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS key_pin_reset_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  key_pin_id BIGINT UNSIGNED NOT NULL,
  requested_by_admin_id BIGINT UNSIGNED NULL,
  requested_by_role VARCHAR(20) NOT NULL DEFAULT 'admin',
  requested_by_name VARCHAR(255) NULL,
  otp_hash VARCHAR(255) NOT NULL,
  verification_token CHAR(64) NOT NULL,
  recipient_email VARCHAR(255) NOT NULL,
  expires_at DATETIME NOT NULL,
  verified_at DATETIME NULL,
  used_at DATETIME NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_reset_token (verification_token),
  KEY ix_reset_pin_pending (key_pin_id, used_at, verified_at, expires_at),
  KEY ix_reset_admin (requested_by_admin_id, created_at),
  CONSTRAINT fk_reset_key_pin
    FOREIGN KEY (key_pin_id) REFERENCES key_pins (id) ON DELETE CASCADE,
  CONSTRAINT fk_reset_admin
    FOREIGN KEY (requested_by_admin_id) REFERENCES admins (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
