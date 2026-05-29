-- ===========================================================
-- 024 — Allow sellers in refresh_tokens.subject_kind
-- ===========================================================
-- Sellers log in via OTP and get an access token, but the original
-- schema only knew about ('admin', 'sub_admin') subjects. Without a
-- seller refresh token, the seller's session dies on every page reload
-- (no cookie to silently refresh from), forcing them through OTP again.
--
-- Extending the ENUM is non-destructive — existing rows keep their
-- current values, and seller-issued rows can now coexist.
-- ===========================================================

ALTER TABLE refresh_tokens
  MODIFY COLUMN subject_kind ENUM('admin', 'sub_admin', 'seller') NOT NULL;
