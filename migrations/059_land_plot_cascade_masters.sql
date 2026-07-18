-- T-2026-047: Wire parent_code on Land Sub-Type + seed a new Plot Category
-- (Residential) master so Land Type -> Land Sub-Type and Plot Type -> Plot
-- Category dropdowns cascade correctly on both Inventory and Enquiry forms.
--
-- Design:
--   * `land_sub_type` values are shared across four parent categories
--     (Agriculture / Residential / Commercial / Industrial). This migration
--     assigns parent_code to each existing row so /public/masters/land_sub_type?parentCode=X
--     returns only the sub-types for the picked Land Type.
--
--   * `land_category_residential`, `land_category_commercial`,
--     `land_category_industrial` already are per-parent by KEY (not by
--     parent_code), so no changes needed to their rows — the frontend
--     visibleWhen predicate hides the wrong-category rows entirely.
--
--   * Plot Category (Residential) becomes a NEW master vocabulary
--     `plot_category_residential` — replaces the historical inline
--     ['Independent', 'Attached'] radio. Codes are lowercase equivalents
--     of the legacy labels so `coercePlotCategoryValue` (frontend) can
--     translate saved data at load time without a DB backfill.
--
--   * Plot Sub-Type is per-parent by KEY (plot_sub_residential /
--     plot_sub_commercial / plot_sub_industrial) — same as land category
--     above — so no parent_code changes needed on those rows.
--
-- Idempotent: uses INSERT IGNORE for new rows and UPDATE with WHERE for
-- parent_code assignments. Re-running the migration is a no-op after the
-- first successful pass.

-- ────────────────────────────────────────────────────────────────────
-- 1. Assign parent_code to land_sub_type rows
--    Mapping is derived from the existing seed (migration 034):
--    bagayati/jirayati/malran     -> agriculture
--    pure_yellow/gaothan_yellow/proposed_yellow/special_yellow -> residential
--    c1_local/c2_district/sc      -> commercial
--    i1_service/i2_general/i3_special/ie -> industrial
-- ────────────────────────────────────────────────────────────────────

UPDATE master_lookups
SET parent_code = 'agriculture'
WHERE master_key = 'land_sub_type'
  AND code IN ('bagayati', 'jirayati', 'malran')
  AND (parent_code IS NULL OR parent_code = '');

UPDATE master_lookups
SET parent_code = 'residential'
WHERE master_key = 'land_sub_type'
  AND code IN ('pure_yellow', 'gaothan_yellow', 'proposed_yellow', 'special_yellow')
  AND (parent_code IS NULL OR parent_code = '');

UPDATE master_lookups
SET parent_code = 'commercial'
WHERE master_key = 'land_sub_type'
  AND code IN ('c1_local', 'c2_district', 'sc')
  AND (parent_code IS NULL OR parent_code = '');

UPDATE master_lookups
SET parent_code = 'industrial'
WHERE master_key = 'land_sub_type'
  AND code IN ('i1_service', 'i2_general', 'i3_special', 'ie')
  AND (parent_code IS NULL OR parent_code = '');

-- ────────────────────────────────────────────────────────────────────
-- 2. Seed the new plot_category_residential master
--    Two initial values matching the legacy inline radio. Admins can
--    extend this vocabulary from Global Masters > Plot Category.
-- ────────────────────────────────────────────────────────────────────

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('plot_category_residential', 'independent', 'Independent', 10, 1),
  ('plot_category_residential', 'attached',    'Attached',    20, 1);

-- ────────────────────────────────────────────────────────────────────
-- 3. Revive-in-place any rows that were soft-deleted before this seed
--    (mirrors T-2026-046 idempotency pattern).
-- ────────────────────────────────────────────────────────────────────

UPDATE master_lookups
SET is_active = 1, deleted_at = NULL, sort_order = 10, label = 'Independent'
WHERE master_key = 'plot_category_residential' AND code = 'independent';

UPDATE master_lookups
SET is_active = 1, deleted_at = NULL, sort_order = 20, label = 'Attached'
WHERE master_key = 'plot_category_residential' AND code = 'attached';
