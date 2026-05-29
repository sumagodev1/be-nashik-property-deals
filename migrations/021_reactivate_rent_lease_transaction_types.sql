-- ===========================================================
-- 021 — Reactivate the public-facing 'rent' and 'lease' transaction codes
-- ===========================================================
-- Migration 016 retired `rent` and `lease` from the masters table on the
-- assumption that the granular variants (`rent_in` / `rent_out` /
-- `lease_in` / `lease_out`) would replace them everywhere. But the public
-- website and the seller's Post Property form still use the simpler
-- 3-code model (sale / rent / lease) — and the PRD locks that model as
-- the buyer-facing categorization. With `rent` / `lease` inactive, every
-- new seller submission fails master validation:
--
--   "Unknown or inactive transaction type: \"rent\""
--
-- This migration just flips them back to active. The granular admin-only
-- variants stay active — both shapes coexist (admins can use either when
-- recording inventory; sellers only ever see the simple three).
-- ===========================================================

UPDATE master_transaction_types
   SET is_active = 1
 WHERE code IN ('rent', 'lease');
