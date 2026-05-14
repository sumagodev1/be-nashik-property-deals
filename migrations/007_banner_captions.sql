-- ===========================================================
-- Migration 007: per-banner caption + subcaption for the
-- homepage hero. Both optional — banners with neither fall back
-- to the generic brand headline rendered by HeroBanner.jsx.
-- ===========================================================

ALTER TABLE cms_banners
  ADD COLUMN caption VARCHAR(255) NULL AFTER alt_text,
  ADD COLUMN subcaption VARCHAR(500) NULL AFTER caption;
