-- Migration 009: admin password reset support.
--
-- Adds the columns the forgot-password flow uses. We store the bcrypt hash
-- of the random token (never the token itself) plus a hard expiry. On a
-- POST /auth/reset-password we look up the admin whose `expires_at` is in
-- the future and whose stored hash matches the supplied token; on use, the
-- columns are cleared so the token cannot be replayed.
--
-- Sub admins are deliberately NOT given the same flow — they get the
-- "contact your administrator" message because their account is created and
-- managed by the admin, not self-service.

ALTER TABLE admins
  ADD COLUMN password_reset_token_hash VARCHAR(255) NULL AFTER password_hash,
  ADD COLUMN password_reset_expires_at DATETIME NULL AFTER password_reset_token_hash,
  ADD KEY ix_admins_reset_expires (password_reset_expires_at);
