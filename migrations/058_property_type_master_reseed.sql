-- ===========================================================
-- 058  Global / Property Type: reseed to the 16 authoritative values
-- ===========================================================
-- T-2026-046: The Global / Property Type master must contain EXACTLY
-- these 16 values (and only these) as the single source of truth for
-- every Inventory Property Type dropdown across the app:
--
--   Bank Auction, Bungalow, Commercial Space, Flat, Hospital, Hostel,
--   Hotel, Industrial Plot, Land, Plot, Pre-Leased Property, Project
--   Registration, SEZ Land, SEZ Plot, Shop, TDR
--
-- The master already exists (created in migration 008, seeded in
-- migrations 008 / 012 / 028). It is currently CRUD-editable
-- (FIXED_MASTERS is empty in server/services/masters/management.js).
-- Two operations required, both idempotent:
--
--   1. Deactivate every existing row whose code is NOT in the
--      authoritative list. We SOFT-DELETE (deleted_at = NOW,
--      is_active = 0) rather than hard-delete because inventory /
--      enquiry / website property rows may still reference legacy
--      codes (e.g. flat, house, villa, plot, commercial,
--      agricultural, other  from migration 008). This mirrors the
--      pattern used by the Property Status master (migration 056/057)
--      which preserves historical data.
--
--   2. INSERT-or-UPDATE the 16 authoritative rows (upsert by code).
--      If any code was previously soft-deleted (e.g. bank_auction from
--      migration 028), we revive it in-place  clear deleted_at, set
--      is_active = 1, refresh label / sort_order. This preserves the
--      row id + audit history.
--
-- Codes follow the existing masters convention (snake-case, lower).
-- Sort order runs 10..160 alphabetically per the spec sentence
-- order.
--
-- IMPORTANT: This migration touches ONLY the master_property_types
-- table. It does NOT alter inventory / enquiry / website records. If
-- an existing property row stores a legacy code like 'agricultural',
-- that row remains intact  the frontend continues to render the
-- fallback PROPERTY_TYPE_LABELS map for historical rows (documented
-- pattern in src/shared/constants/property.js).
-- ===========================================================

-- Step 1: soft-deactivate every non-authoritative row (idempotent).
UPDATE master_property_types
   SET is_active = 0,
       deleted_at = COALESCE(deleted_at, NOW())
 WHERE deleted_at IS NULL
   AND code NOT IN (
     'bank_auction',
     'bungalow',
     'commercial_space',
     'flat',
     'hospital',
     'hostel',
     'hotel',
     'industrial_plot',
     'land',
     'plot',
     'pre_leased_property',
     'project_registration',
     'sez_land',
     'sez_plot',
     'shop',
     'tdr'
   );

-- Step 2: upsert each of the 16 authoritative rows.
-- INSERT if the code does not yet exist. If a soft-deleted twin
-- already occupies the (unique) code slot, revive it below via an
-- explicit UPDATE (INSERT IGNORE would silently skip and leave it
-- soft-deleted, which is not what we want).
INSERT IGNORE INTO master_property_types (code, label, sort_order, is_active) VALUES
  ('bank_auction',           'Bank Auction',           10, 1),
  ('bungalow',               'Bungalow',               20, 1),
  ('commercial_space',       'Commercial Space',       30, 1),
  ('flat',                   'Flat',                   40, 1),
  ('hospital',               'Hospital',               50, 1),
  ('hostel',                 'Hostel',                 60, 1),
  ('hotel',                  'Hotel',                  70, 1),
  ('industrial_plot',        'Industrial Plot',        80, 1),
  ('land',                   'Land',                   90, 1),
  ('plot',                   'Plot',                  100, 1),
  ('pre_leased_property',    'Pre-Leased Property',   110, 1),
  ('project_registration',   'Project Registration',  120, 1),
  ('sez_land',               'SEZ Land',              130, 1),
  ('sez_plot',               'SEZ Plot',              140, 1),
  ('shop',                   'Shop',                  150, 1),
  ('tdr',                    'TDR',                   160, 1);

-- Revive-in-place: any of the 16 codes that already exists (either
-- active or soft-deleted) gets its label / sort_order / is_active
-- refreshed to the authoritative values. This is what turns a
-- previously-soft-deleted row (e.g. from an earlier run of this
-- migration on a dev DB) back into an active canonical row without
-- creating a duplicate code.
UPDATE master_property_types SET label = 'Bank Auction',         sort_order = 10,  is_active = 1, deleted_at = NULL WHERE code = 'bank_auction';
UPDATE master_property_types SET label = 'Bungalow',             sort_order = 20,  is_active = 1, deleted_at = NULL WHERE code = 'bungalow';
UPDATE master_property_types SET label = 'Commercial Space',     sort_order = 30,  is_active = 1, deleted_at = NULL WHERE code = 'commercial_space';
UPDATE master_property_types SET label = 'Flat',                 sort_order = 40,  is_active = 1, deleted_at = NULL WHERE code = 'flat';
UPDATE master_property_types SET label = 'Hospital',             sort_order = 50,  is_active = 1, deleted_at = NULL WHERE code = 'hospital';
UPDATE master_property_types SET label = 'Hostel',               sort_order = 60,  is_active = 1, deleted_at = NULL WHERE code = 'hostel';
UPDATE master_property_types SET label = 'Hotel',                sort_order = 70,  is_active = 1, deleted_at = NULL WHERE code = 'hotel';
UPDATE master_property_types SET label = 'Industrial Plot',      sort_order = 80,  is_active = 1, deleted_at = NULL WHERE code = 'industrial_plot';
UPDATE master_property_types SET label = 'Land',                 sort_order = 90,  is_active = 1, deleted_at = NULL WHERE code = 'land';
UPDATE master_property_types SET label = 'Plot',                 sort_order = 100, is_active = 1, deleted_at = NULL WHERE code = 'plot';
UPDATE master_property_types SET label = 'Pre-Leased Property',  sort_order = 110, is_active = 1, deleted_at = NULL WHERE code = 'pre_leased_property';
UPDATE master_property_types SET label = 'Project Registration', sort_order = 120, is_active = 1, deleted_at = NULL WHERE code = 'project_registration';
UPDATE master_property_types SET label = 'SEZ Land',             sort_order = 130, is_active = 1, deleted_at = NULL WHERE code = 'sez_land';
UPDATE master_property_types SET label = 'SEZ Plot',             sort_order = 140, is_active = 1, deleted_at = NULL WHERE code = 'sez_plot';
UPDATE master_property_types SET label = 'Shop',                 sort_order = 150, is_active = 1, deleted_at = NULL WHERE code = 'shop';
UPDATE master_property_types SET label = 'TDR',                  sort_order = 160, is_active = 1, deleted_at = NULL WHERE code = 'tdr';
