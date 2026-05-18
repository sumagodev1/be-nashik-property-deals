-- Migration 010: drop the magic-link reset columns added in 009.
--
-- The admin forgot-password flow now uses a 6-digit email OTP via the shared
-- `otp_codes` table (purpose='admin_password_reset'), same channel and same
-- service as buyer/seller verification. The dedicated columns on `admins`
-- are no longer read or written by any code path.

ALTER TABLE admins
  DROP KEY ix_admins_reset_expires,
  DROP COLUMN password_reset_expires_at,
  DROP COLUMN password_reset_token_hash;
