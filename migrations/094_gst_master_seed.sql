-- ============================================================
-- 094 — Global "GST" master seed
-- ============================================================
-- Introduces ONE reusable GLOBAL master vocabulary `gst`, used by the
-- master-backed GST dropdown on the Financial subsection of the Advanced
-- Land Pricing & Government Valuation module (Land + SEZ Land Sale /
-- Purchase forms).
--
-- Design notes:
--   • GLOBAL scope (label prefixed "Global / Sale Forms / GST"), same shape
--     as the other percentage vocabularies (`yearly_hike_percent`,
--     `booking_amount_percent`, `payment_white_percent`,
--     `plot_emi_booking_percent`). Registered in
--     server/services/masters/management.js LOOKUP_KEYS / MASTER_LABELS /
--     AMOUNT_MASTER_KEYS (as a percent vocab) and mirrored in the frontend
--     src/shared/api/masters.js LOOKUP_MASTER_KEYS + MASTER_LABELS and
--     src/shared/constants/numericMasterKeys.js PERCENT_MASTER_KEYS.
--   • Code convention: `<percent>-pct` matches the sibling percent masters
--     seeded in migration 026 (`5-pct`, `10-pct`, `15-pct`, …). Label is
--     the user-friendly "<percent>%".
--   • Frontend calculator (src/admin/pages/Inventory/dynamic/landPricingCalc.js)
--     parses the code with a first-digit-run regex, so both the preset codes
--     (`5-pct` → 5) and any admin-created "Other" codes (raw numeric labels
--     turned into slugs by codeFromLabel) parse correctly.
--   • INSERT IGNORE against the (master_key, code) unique key → idempotent;
--     safe to re-run. Existing rows are preserved.
--   • Client mandate: three initial rows — 5%, 1%, 0%. Admins extend via
--     the standard "Other → Save → Refresh" flow on NumericMasterSelect;
--     no hardcoded percentages remain in the frontend.
-- ============================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('gst', '5-pct', '5%', 10, 1),
  ('gst', '1-pct', '1%', 20, 1),
  ('gst', '0-pct', '0%', 30, 1);
