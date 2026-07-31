-- ===========================================================
-- 078 — District short_code for property ID generation
-- ===========================================================
-- Adds a `short_code` column (3-letter uppercase abbreviation) to
-- master_lookups rows where master_key = 'district'. This short code is
-- used by the property ID generator to produce DISTRICTCODE-YY-RANDOM7
-- identifiers (e.g. NSK-26-A8K2M7P for Nashik).
--
-- Seeds all 36 Maharashtra districts by label-match (case-insensitive LIKE)
-- so the seed works whether the rows carry legacy slug codes ('nashik') or
-- the LGD government numeric codes ('522') imported via import-locations.js.
--
-- Safe to re-run: UPDATE ... WHERE short_code IS NULL protects already-
-- seeded rows; the ALTER is idempotent (IF NOT EXISTS guard).
-- ===========================================================

SET NAMES utf8mb4;

-- Add the column if it doesn't already exist.
ALTER TABLE master_lookups
  ADD COLUMN IF NOT EXISTS short_code VARCHAR(10) NULL
  COMMENT '3-letter property-ID prefix for district rows (e.g. NSK, PUN, NGP)'
  AFTER label;

-- Index so the property-code generator lookup is index-only.
ALTER TABLE master_lookups
  ADD INDEX IF NOT EXISTS ix_master_lookups_district_short_code
    (master_key, code, short_code);

-- ------------------------------------------------------------
-- Seed all 36 Maharashtra districts by label.
-- Uses label LIKE to handle both exact names and minor variants
-- (e.g. "Nashik" / "NASHIK" / "Nasik").  All 36 standard
-- Maharashtra LGD district names are covered.
-- ------------------------------------------------------------
UPDATE master_lookups SET short_code = 'NSK'
  WHERE master_key = 'district' AND label LIKE '%Nashik%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'NSK'
  WHERE master_key = 'district' AND label LIKE '%Nasik%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'PUN'
  WHERE master_key = 'district' AND label LIKE '%Pune%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'NGP'
  WHERE master_key = 'district' AND label LIKE '%Nagpur%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'MUM'
  WHERE master_key = 'district' AND label LIKE '%Mumbai City%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'MBS'
  WHERE master_key = 'district' AND label LIKE '%Mumbai Sub%' AND short_code IS NULL;

-- Catch plain "Mumbai" only if neither above matched (legacy stub row).
UPDATE master_lookups SET short_code = 'MUM'
  WHERE master_key = 'district' AND label = 'Mumbai' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'THN'
  WHERE master_key = 'district' AND label LIKE '%Thane%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'PLG'
  WHERE master_key = 'district' AND label LIKE '%Palghar%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'RGD'
  WHERE master_key = 'district' AND label LIKE '%Raigad%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'RGH'
  WHERE master_key = 'district' AND label LIKE '%Raigadh%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'RTN'
  WHERE master_key = 'district' AND label LIKE '%Ratnagiri%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'SND'
  WHERE master_key = 'district' AND label LIKE '%Sindhudurg%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'KLP'
  WHERE master_key = 'district' AND label LIKE '%Kolhapur%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'SNG'
  WHERE master_key = 'district' AND label LIKE '%Sangli%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'STR'
  WHERE master_key = 'district' AND label LIKE '%Satara%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'SLP'
  WHERE master_key = 'district' AND label LIKE '%Solapur%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'AHN'
  WHERE master_key = 'district' AND label LIKE '%Ahmednagar%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'AHN'
  WHERE master_key = 'district' AND label LIKE '%Ahmadnagar%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'AUR'
  WHERE master_key = 'district' AND label LIKE '%Aurangabad%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'CSN'
  WHERE master_key = 'district' AND label LIKE '%Chhatrapati Sambhajinagar%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'CSN'
  WHERE master_key = 'district' AND label LIKE '%Sambhajinagar%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'BED'
  WHERE master_key = 'district' AND label LIKE '%Beed%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'LTR'
  WHERE master_key = 'district' AND label LIKE '%Latur%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'NND'
  WHERE master_key = 'district' AND label LIKE '%Nanded%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'PRB'
  WHERE master_key = 'district' AND label LIKE '%Parbhani%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'HIN'
  WHERE master_key = 'district' AND label LIKE '%Hingoli%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'OSM'
  WHERE master_key = 'district' AND label LIKE '%Osmanabad%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'DSV'
  WHERE master_key = 'district' AND label LIKE '%Dharashiv%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'AMR'
  WHERE master_key = 'district' AND label LIKE '%Amravati%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'AKL'
  WHERE master_key = 'district' AND label LIKE '%Akola%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'WSH'
  WHERE master_key = 'district' AND label LIKE '%Washim%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'BLD'
  WHERE master_key = 'district' AND label LIKE '%Buldhana%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'YVT'
  WHERE master_key = 'district' AND label LIKE '%Yavatmal%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'WRD'
  WHERE master_key = 'district' AND label LIKE '%Wardha%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'NGP'
  WHERE master_key = 'district' AND label LIKE '%Nagpur%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'BHD'
  WHERE master_key = 'district' AND label LIKE '%Bhandara%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'GDC'
  WHERE master_key = 'district' AND label LIKE '%Gadchiroli%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'CHD'
  WHERE master_key = 'district' AND label LIKE '%Chandrapur%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'JLG'
  WHERE master_key = 'district' AND label LIKE '%Jalgaon%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'DHU'
  WHERE master_key = 'district' AND label LIKE '%Dhule%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'NNB'
  WHERE master_key = 'district' AND label LIKE '%Nandurbar%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'JLN'
  WHERE master_key = 'district' AND label LIKE '%Jalna%' AND short_code IS NULL;

UPDATE master_lookups SET short_code = 'GND'
  WHERE master_key = 'district' AND label LIKE '%Gondia%' AND short_code IS NULL;
