-- ============================================================
-- 098 — Plot Corner master: expand to 4 road-count options + plural labels
-- ============================================================
-- T-2026-118: The Plot Registration forms (Inventory + Enquiry) now render
-- Corner as a road-count picker with exactly four options, each of which
-- drives how many Plot Facing + Road Approach input pairs the form
-- surfaces:
--
--   • 1 Road   → one pair  (bare labels: "Plot Facing" / "Road Approach")
--   • 2 Roads  → two pairs (numbered: "Plot Facing 1..2" / "Road Approach 1..2")
--   • 3 Roads  → three pairs
--   • 4 Roads  → four pairs
--
-- Migration 036 seeded the `plot_corner` master with three rows using
-- SINGULAR labels ("2 Road", "3 Road", "4 Road") and no "1 Road" option.
-- This migration:
--
--   1. INSERTs the missing `1_road` row (label "1 Road" — singular per
--      client copy, since one road really is one road).
--   2. UPDATEs the three existing rows' labels to plural form
--      ("2 Roads", "3 Roads", "4 Roads") to match the client-provided
--      dropdown copy.
--
-- CODE STABILITY (why we DO NOT rename `2_road` → `2_roads`)
-- ----------------------------------------------------------
-- Every historical Plot property row that carries a `corner` value in its
-- `details.dynamicData` JSON blob stores the master CODE, not the label.
-- Renaming the code would break the dropdown selection on every one of
-- those rows (the option element with the stored code would no longer
-- exist in the master and the dropdown would show "no selection"). The
-- client rule "Never break existing behavior" (and the project-wide
-- backward-compat rule "Draft/Edit/View/List/Filter/Export/PDF/Website/
-- Sharing must all still work after every change") forbids that. Instead
-- we preserve the CODEs verbatim (`1_road` / `2_road` / `3_road` /
-- `4_road`) and update ONLY the display LABELs. Existing rows continue
-- to hydrate + render correctly; the numeric mapping to pair-count is
-- encoded in the FE `plotCornerConfig.CORNER_ROAD_COUNT` map, which
-- accepts both the pre-existing (`2_road`) and any future codes without
-- schema-level churn.
--
-- IDEMPOTENCY / SAFETY
-- --------------------
-- INSERT ... ON DUPLICATE KEY UPDATE guarantees this migration is
-- idempotent: first run inserts `1_road` (new) and updates the labels /
-- sort_order on the three existing rows; every subsequent run re-issues
-- the same UPDATE (no-op on already-corrected labels). No DROP, no
-- DELETE, no schema change. Zero risk to production data.
--
-- See also:
--   • FE  src/admin/pages/Inventory/dynamic/plotCornerConfig.js
--   • FE  src/admin/pages/Inventory/dynamic/plotFormsConfig.js (cornerAndPairs)
--   • FE  src/admin/pages/Inventory/dynamic/DynamicPropertyForm.jsx
--          (label-as-function + preserveOnHide support)
--   • FE  src/admin/pages/Inventory/InventoryForm.jsx (hydrate coerce)
--   • BE  server/services/inventory/dynamicDataValidation.js (Joi allow-list)
-- ============================================================

SET NAMES utf8mb4;

INSERT INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('plot_corner', '1_road', '1 Road',  5,  1),
  ('plot_corner', '2_road', '2 Roads', 10, 1),
  ('plot_corner', '3_road', '3 Roads', 20, 1),
  ('plot_corner', '4_road', '4 Roads', 30, 1)
ON DUPLICATE KEY UPDATE
  label      = VALUES(label),
  sort_order = VALUES(sort_order),
  is_active  = VALUES(is_active);
