-- ===========================================================
-- 088 — Key PIN: optional Username for identification
-- ===========================================================
-- Adds a nullable VARCHAR(100) column to key_pins so admins can
-- attach a human-readable label to each PIN (e.g. "Keshav",
-- "Nashik Office", "Super_Admin"). Purely identification —
-- PIN verification continues to compare only the hashed PIN
-- and never involves this column.
--
-- Nullable so historical rows (created before this migration)
-- remain valid; the listing UI shows "—" when null.
-- ===========================================================

SET NAMES utf8mb4;

ALTER TABLE key_pins
  ADD COLUMN username VARCHAR(100) NULL AFTER id;
