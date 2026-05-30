-- ===========================================================
-- Migration 025: CMS-managed sidebar advertisement.
--
-- Powers the <StickySidebarAd /> right-column promo on the public
-- website. The public endpoint returns ONE active row per request
-- (newest active, within the start/end date window). If no row
-- qualifies, the website falls back to a static promo — the slot
-- is never empty, so admin downtime never affects the page.
--
-- Columns mirror the fields the admin form exposes
-- (Frontend/src/admin/pages/Cms/SidebarAdsList.jsx). Image lives on
-- disk via the existing cms upload pipeline (uploads/public/cms/),
-- so we only store the URL — same pattern as cms_banners.
-- ===========================================================

CREATE TABLE IF NOT EXISTS cms_sidebar_ads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  image_url VARCHAR(512) NULL,
  title VARCHAR(120) NOT NULL,
  subtitle VARCHAR(240) NULL,
  cta_text VARCHAR(60) NULL,
  cta_url VARCHAR(500) NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Active-window lookup is the hot path: the public endpoint scans
  -- this table on every visitor hit. Index the columns it filters /
  -- orders on so the query stays O(log n) as the table grows.
  KEY ix_cms_sidebar_ads_active_window (is_active, start_date, end_date, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
