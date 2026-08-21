-- ============================================================================
-- 116_district_short_code_ahilyanagar.sql
--
-- Give the Ahilyanagar district the short_code it never received, so seller
-- property registrations in that district stop failing.
--
-- WHAT HAPPENED
-- -------------
-- Migration 078 back-filled master_lookups.short_code for every district by
-- matching on label:
--
--     UPDATE master_lookups SET short_code = 'AHN'
--       WHERE master_key = 'district' AND label LIKE '%Ahmednagar%' ...
--     UPDATE master_lookups SET short_code = 'AHN'
--       WHERE master_key = 'district' AND label LIKE '%Ahmadnagar%' ...
--
-- Ahmednagar was officially renamed **Ahilyanagar** in 2023, and this database
-- carries the post-rename label. Neither LIKE pattern matches "Ahilyanagar",
-- so the row was skipped and left with short_code = NULL.
--
-- WHY IT BREAKS SUBMISSIONS
-- -------------------------
-- services/seller/properties.js#createOwn derives the property-code prefix
-- from the district:
--
--     const districtShortCode = await getDistrictShortCode(payload.district);
--     if (!districtShortCode) throw new HttpError(400, 'INVALID_DISTRICT', ...);
--
-- so choosing this district fails with
--   400 INVALID_DISTRICT - "Selected district does not have a property ID code
--   configured"
-- AFTER the seller has filled in the entire multi-step form.
--
-- This is the worst possible row to have broken: the district dropdown is
-- ordered by label ASC (db/queries/locations.js), and "Ahilyanagar" sorts
-- FIRST. It is the first district a seller sees, its taluka/village cascade
-- works normally, and nothing looks wrong until the final submit.
--
-- Verified on this server before the fix:
--   code 466  Ahilyanagar  short_code = NULL   <- 1 of 35 active districts
--   code 467  Akola        short_code = AKL
--   code 468  Amravati     short_code = AMR
--
-- 'AHN' is the code migration 078 intended for this district; reusing it keeps
-- any property codes issued under the old name consistent with new ones.
--
-- Guarded with `short_code IS NULL` so re-running is a no-op and an operator
-- who has already set a code by hand is not overwritten.
--
-- ROLLBACK
--   UPDATE master_lookups SET short_code = NULL
--    WHERE master_key = 'district' AND label LIKE '%Ahilyanagar%';
-- ============================================================================

SET NAMES utf8mb4;

UPDATE master_lookups
   SET short_code = 'AHN'
 WHERE master_key = 'district'
   AND label LIKE '%Ahilyanagar%'
   AND (short_code IS NULL OR short_code = '');
