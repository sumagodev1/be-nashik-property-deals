-- ===========================================================
-- 086 — Key PIN: denormalized creator/updater display names
-- ===========================================================
-- Adds VARCHAR(255) columns to persist the human-readable name
-- of whoever created or last updated a Key PIN.
--
-- Why denormalized (instead of relying on a JOIN through
-- created_by_admin_id → admins.full_name):
--   1. sub_admins can hold MASTER_MANAGEMENT and therefore
--      manage Key PINs, but sub_admin IDs do not exist in
--      admins.id — the existing FK on created_by_admin_id
--      cannot represent them.
--   2. If an admin/sub_admin account is later deleted, the
--      audit-friendly "who created this PIN" answer should
--      survive.
--   3. Avoids a per-row JOIN on the listing endpoint.
--
-- Nullable so historical rows (created before this migration)
-- remain valid; the listing UI shows "—" when null.
-- ===========================================================

SET NAMES utf8mb4;

ALTER TABLE key_pins
  ADD COLUMN created_by_name VARCHAR(255) NULL AFTER created_by_admin_id,
  ADD COLUMN updated_by_name VARCHAR(255) NULL AFTER updated_by_admin_id;
