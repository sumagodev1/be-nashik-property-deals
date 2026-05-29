-- ===========================================================
-- 019 — Per-property view count (seller analytics)
-- ===========================================================
-- Adds a denormalized `view_count` column on website_properties. Each
-- public-website detail fetch (`GET /api/public/properties/:identifier`)
-- bumps this counter by 1 via a simple UPDATE. A dedicated counter column
-- is cheaper than a per-view audit row and good enough for the seller's
-- "your listing has been viewed N times" widget.
--
-- Bot-filtering / unique-visitor dedup is deliberately out of scope for
-- this MVP — we surface raw page-load counts. If/when real analytics are
-- needed, fold it through a property_views table instead.
-- ===========================================================

ALTER TABLE website_properties
  ADD COLUMN view_count BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER is_featured;
