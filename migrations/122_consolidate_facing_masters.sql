-- 122: collapse 17 facing vocabularies into one global `facing` master.
--
-- Every property type carried its own facing master (bunglow_facing_any,
-- flat_facing_specific, land_facing, tdr_plot_facing, …). 11 of them held an
-- identical option set (east / north / south / west); the rest differed only
-- by an extra `south_not_required`, plus the legacy `facing` master which
-- also carried the four intercardinals.
--
-- Per the client: facing is four directions. The frontend now points every
-- facing field at masterKey 'facing'; this migration makes the data match.
--
-- Nothing is hard-deleted — every row is soft-deleted via deleted_at, so the
-- whole change is reversible by clearing those timestamps.
--
-- Verified before writing this migration:
--   * no property record stores an intercardinal (north-east / …) facing
--   * no property record stores `south_not_required`
--   * codes are identical across all 17 masters, so stored values such as
--     'east' keep resolving against the surviving master
--   * 5 enquiry records store the junk value 'ok' in facing (see step 3)

-- ── 1. Trim the surviving global master to the four cardinal directions ────
UPDATE master_lookups
   SET deleted_at = NOW(), is_active = 0
 WHERE master_key = 'facing'
   AND code IN ('north-east', 'north-west', 'south-east', 'south-west')
   AND deleted_at IS NULL;

-- ── 2. Retire the 16 per-property-type facing masters ─────────────────────
UPDATE master_lookups
   SET deleted_at = NOW(), is_active = 0
 WHERE master_key IN (
         'bunglow_facing_specific',   'bunglow_facing_any',
         'rowhouse_facing_specific',  'rowhouse_facing_any',
         'commercial_facing_specific','commercial_facing_any',
         'flat_facing_specific',      'flat_facing_any',
         'shop_facing_specific',      'shop_facing_any',
         'hostel_facing',             'land_facing',
         'paying_guest_facing',       'plot_facing',
         'tdr_plot_facing',           'project_facing'
       )
   AND deleted_at IS NULL;

-- ── 3. Clear the junk 'ok' facing value on enquiry records ────────────────
-- `ok` was a stray row in bunglow_facing_specific that never belonged to the
-- vocabulary. Only the facing field is touched: the same 'ok' value also
-- appears under age / condition / location on these records and those are
-- left exactly as they are.
UPDATE enquiry_properties
   SET details = JSON_SET(details, '$.dynamicData.facing.specific', '')
 WHERE JSON_UNQUOTE(JSON_EXTRACT(details, '$.dynamicData.facing.specific')) = 'ok';
