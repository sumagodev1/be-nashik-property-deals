-- ============================================================================
-- 117_district_short_code_backfill_all.sql
--
-- Close the "Selected district does not have a property ID code configured"
-- failure for EVERY district, not just the one row migration 116 patched.
--
-- WHY THIS EXISTS ON TOP OF 116
-- -----------------------------
-- Property codes are built as DISTRICT-TYPE-YY-RANDOM7, and all four create
-- paths resolve the first segment from master_lookups.short_code:
--
--     services/enquiry/management.js:189
--     services/inventory/management.js:244
--     services/seller/properties.js:106
--     services/website_property/management.js:102
--
--       const districtShortCode = await getDistrictShortCode(payload.district);
--       if (!districtShortCode) throw new HttpError(400, 'INVALID_DISTRICT', ...);
--
-- A district row with short_code NULL therefore fails the submit AFTER the
-- operator has filled in the whole form — the error surfaces at the very end,
-- with no hint on the District field itself.
--
-- Migration 078 back-filled these by matching on label, and migration 116
-- repaired the single row it missed (Ahmednagar -> renamed "Ahilyanagar").
-- Both are label-matched, so any district whose label differs from what 078
-- expected is still exposed — and a database that has not yet run 116 still
-- fails on the alphabetically FIRST district in the dropdown.
--
-- This migration is written to be safe to run on any of those databases:
-- it fills ONLY rows where short_code is NULL or '', so an operator's manual
-- code is never overwritten and re-running is a no-op.
--
-- Pass 1 assigns the curated code for every Maharashtra district, matching
-- both current and pre-rename labels (Ahmednagar/Ahilyanagar,
-- Aurangabad/Chhatrapati Sambhajinagar, Osmanabad/Dharashiv).
--
-- Pass 2 is a safety net: anything Pass 1 did not recognise (a newly seeded
-- district, an unexpected spelling) gets the first three letters of its label
-- rather than being left NULL. A derived code may duplicate another district's
-- prefix, which is cosmetic only — property_code uniqueness is enforced
-- globally with retry-on-collision in services/properties/propertyCode.js —
-- and that is strictly better than a submit that cannot succeed at all.
--
-- ROLLBACK (reverts BOTH passes to the pre-migration state)
--   UPDATE master_lookups SET short_code = NULL
--    WHERE master_key = 'district' AND <the codes you wish to clear>;
-- ============================================================================

SET NAMES utf8mb4;

-- Pass 1 — curated codes, current + pre-rename labels.
UPDATE master_lookups
   SET short_code = CASE
     WHEN label LIKE '%Ahilyanagar%' OR label LIKE '%Ahmednagar%'
       OR label LIKE '%Ahmadnagar%'                            THEN 'AHN'
     WHEN label LIKE '%Sambhajinagar%' OR label LIKE '%Aurangabad%' THEN 'CSN'
     WHEN label LIKE '%Dharashiv%' OR label LIKE '%Osmanabad%'  THEN 'DSV'
     WHEN label LIKE '%Akola%'                                  THEN 'AKL'
     WHEN label LIKE '%Amravati%'                               THEN 'AMR'
     WHEN label LIKE '%Beed%'                                   THEN 'BED'
     WHEN label LIKE '%Bhandara%'                               THEN 'BHD'
     WHEN label LIKE '%Buldhana%' OR label LIKE '%Buldana%'     THEN 'BLD'
     WHEN label LIKE '%Chandrapur%'                             THEN 'CHD'
     WHEN label LIKE '%Dhule%'                                  THEN 'DHU'
     WHEN label LIKE '%Gadchiroli%'                             THEN 'GDC'
     WHEN label LIKE '%Gondia%'                                 THEN 'GND'
     WHEN label LIKE '%Hingoli%'                                THEN 'HIN'
     WHEN label LIKE '%Jalgaon%'                                THEN 'JLG'
     WHEN label LIKE '%Jalna%'                                  THEN 'JLN'
     WHEN label LIKE '%Kolhapur%'                               THEN 'KLP'
     WHEN label LIKE '%Latur%'                                  THEN 'LTR'
     WHEN label LIKE '%Mumbai Suburban%'                        THEN 'MBS'
     WHEN label LIKE '%Mumbai%'                                 THEN 'MUM'
     WHEN label LIKE '%Nagpur%'                                 THEN 'NGP'
     WHEN label LIKE '%Nandurbar%'                              THEN 'NNB'
     WHEN label LIKE '%Nanded%'                                 THEN 'NND'
     WHEN label LIKE '%Nashik%' OR label LIKE '%Nasik%'         THEN 'NSK'
     WHEN label LIKE '%Palghar%'                                THEN 'PLG'
     WHEN label LIKE '%Parbhani%'                               THEN 'PRB'
     WHEN label LIKE '%Pune%'                                   THEN 'PUN'
     WHEN label LIKE '%Raigad%'                                 THEN 'RGD'
     WHEN label LIKE '%Ratnagiri%'                              THEN 'RTN'
     WHEN label LIKE '%Sangli%'                                 THEN 'SNG'
     WHEN label LIKE '%Satara%'                                 THEN 'STR'
     WHEN label LIKE '%Sindhudurg%'                             THEN 'SND'
     WHEN label LIKE '%Solapur%' OR label LIKE '%Sholapur%'     THEN 'SLP'
     WHEN label LIKE '%Thane%'                                  THEN 'THN'
     WHEN label LIKE '%Wardha%'                                 THEN 'WRD'
     WHEN label LIKE '%Washim%'                                 THEN 'WSH'
     WHEN label LIKE '%Yavatmal%'                               THEN 'YVT'
     ELSE short_code
   END
 WHERE master_key = 'district'
   AND deleted_at IS NULL
   AND (short_code IS NULL OR short_code = '');

-- Pass 2 — safety net for any label Pass 1 did not recognise.
UPDATE master_lookups
   SET short_code = UPPER(LEFT(REGEXP_REPLACE(label, '[^A-Za-z]', ''), 3))
 WHERE master_key = 'district'
   AND deleted_at IS NULL
   AND (short_code IS NULL OR short_code = '')
   AND label IS NOT NULL
   AND REGEXP_REPLACE(label, '[^A-Za-z]', '') <> '';
