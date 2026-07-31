-- Migration 079: Add id_code column to master_property_types
-- Stores the 2-3 letter abbreviation used in property ID generation
-- (e.g. 'FLT' for flat, 'PLT' for plot, 'LND' for land).
-- Seeded for all 17 known property types. New types added via the admin
-- Masters UI are left NULL until an admin sets them; propertyCode.js
-- falls back to a hardcoded map so ID generation never fails.

ALTER TABLE master_property_types
  ADD COLUMN id_code VARCHAR(10) NULL DEFAULT NULL
    COMMENT '2-3 letter code used in property ID (e.g. FLT, PLT, LND)'
  AFTER label;

UPDATE master_property_types SET id_code = 'BAU' WHERE code = 'bank_auction';
UPDATE master_property_types SET id_code = 'BNG' WHERE code = 'bungalow';
UPDATE master_property_types SET id_code = 'CMS' WHERE code = 'commercial_space';
UPDATE master_property_types SET id_code = 'FLT' WHERE code = 'flat';
UPDATE master_property_types SET id_code = 'HSP' WHERE code = 'hospital';
UPDATE master_property_types SET id_code = 'HST' WHERE code = 'hostel';
UPDATE master_property_types SET id_code = 'HOT' WHERE code = 'hotel';
UPDATE master_property_types SET id_code = 'IPL' WHERE code = 'industrial_plot';
UPDATE master_property_types SET id_code = 'LND' WHERE code = 'land';
UPDATE master_property_types SET id_code = 'PG'  WHERE code = 'paying_guest';
UPDATE master_property_types SET id_code = 'PLT' WHERE code = 'plot';
UPDATE master_property_types SET id_code = 'PLP' WHERE code = 'pre_leased_property';
UPDATE master_property_types SET id_code = 'PRJ' WHERE code = 'project_registration';
UPDATE master_property_types SET id_code = 'SZL' WHERE code = 'sez_land';
UPDATE master_property_types SET id_code = 'SZP' WHERE code = 'sez_plot';
UPDATE master_property_types SET id_code = 'SHP' WHERE code = 'shop';
UPDATE master_property_types SET id_code = 'TDR' WHERE code = 'tdr';
