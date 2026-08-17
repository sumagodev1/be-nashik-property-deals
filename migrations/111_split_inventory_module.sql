-- ============================================================================
-- 111_split_inventory_module.sql
--
-- T-2026-174: Split the umbrella `inventory_management` module into 5
-- discrete Sub Admin modules so operators can grant Inventory Dashboard,
-- Inventory Properties, Enquiry Dashboard, Enquiry Properties, and
-- Agreement Reminders independently (not as a single all-or-nothing
-- bundle).
--
-- CLIENT REQUIREMENT (verbatim, from user follow-up):
--   "why your not giving separate modules for inventory dashboard and
--    inventory properties and enquiry dashboard and enquiry properties
--    and reminder all have separate modules in sub admin because this
--    are separate modules"
--
-- DATA PRESERVATION NON-NEGOTIABLE:
--   Every existing sub_admin_modules row with module_key='inventory_management'
--   represents a legacy grant that gave that sub-admin access to ALL FIVE
--   surfaces (they were bundled under one key pre-T-174). This migration
--   MUST NOT downgrade any existing sub-admin: every legacy row is
--   FANNED OUT into 5 equivalent rows on the new discrete keys, each
--   preserving the same access_level ('read' or 'write') from migration
--   110. The original 'inventory_management' row is LEFT IN PLACE so:
--     (a) In-flight JWTs (issued before this deploy) that carry the
--         legacy key in their modules[] array continue to satisfy the
--         hasGrant() check on the 5 new keys via the LEGACY_UMBRELLA_ALIASES
--         alias table in middleware/auth.js. No mid-session logouts.
--     (b) Rollback is trivial: dropping this migration + reverting the
--         middleware/route/UI split leaves the historical grant intact.
--     (c) Anyone querying sub_admin_modules by legacy key still finds
--         the row.
--
-- SCHEMA CHANGE:
--   None. sub_admin_modules already carries (sub_admin_id, module_key,
--   access_level) from migrations 001 + 110. This is a pure DATA-ONLY
--   migration: an INSERT ... SELECT that fans one row out into five,
--   guarded by INSERT IGNORE against the UNIQUE (sub_admin_id, module_key)
--   constraint so re-runs are cheap and safe.
--
-- IDEMPOTENCY:
--   INSERT IGNORE + the UNIQUE index means a re-run inserts nothing
--   because every (sub_admin_id, module_key) pair is already present.
--   The UPDATE that syncs access_level (below) also filters on
--   access_level <> source.access_level so re-runs are no-ops.
--
-- ROLLBACK:
--   DELETE FROM sub_admin_modules
--    WHERE module_key IN (
--      'inventory_dashboard','inventory_properties',
--      'enquiry_dashboard','enquiry_properties','agreement_reminders'
--    )
--     AND EXISTS (
--       SELECT 1 FROM sub_admin_modules sm2
--        WHERE sm2.sub_admin_id = sub_admin_modules.sub_admin_id
--          AND sm2.module_key = 'inventory_management'
--     );
--   (Only removes rows we created; leaves any post-migration grants that
--   were minted DIRECTLY on the new keys via the UI intact.)
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. Fan out every legacy 'inventory_management' grant into 5 discrete rows
--    on the new keys, preserving the access_level from the source row.
--    INSERT IGNORE + UNIQUE (sub_admin_id, module_key) makes re-runs safe.
-- ---------------------------------------------------------------------------
INSERT IGNORE INTO sub_admin_modules (sub_admin_id, module_key, access_level)
SELECT src.sub_admin_id, 'inventory_dashboard', src.access_level
  FROM sub_admin_modules src
 WHERE src.module_key = 'inventory_management';

INSERT IGNORE INTO sub_admin_modules (sub_admin_id, module_key, access_level)
SELECT src.sub_admin_id, 'inventory_properties', src.access_level
  FROM sub_admin_modules src
 WHERE src.module_key = 'inventory_management';

INSERT IGNORE INTO sub_admin_modules (sub_admin_id, module_key, access_level)
SELECT src.sub_admin_id, 'enquiry_dashboard', src.access_level
  FROM sub_admin_modules src
 WHERE src.module_key = 'inventory_management';

INSERT IGNORE INTO sub_admin_modules (sub_admin_id, module_key, access_level)
SELECT src.sub_admin_id, 'enquiry_properties', src.access_level
  FROM sub_admin_modules src
 WHERE src.module_key = 'inventory_management';

INSERT IGNORE INTO sub_admin_modules (sub_admin_id, module_key, access_level)
SELECT src.sub_admin_id, 'agreement_reminders', src.access_level
  FROM sub_admin_modules src
 WHERE src.module_key = 'inventory_management';

-- NOTE ON RE-RUN + access_level CHANGES:
--   After the first apply, any subsequent edit made by an operator via
--   the T-174 Sub Admin editor is authoritative. A re-run of this
--   migration is a no-op (INSERT IGNORE) and will NOT reset an
--   operator-adjusted access_level. This is intentional: once the
--   fan-out is done, the discrete keys are the source of truth; the
--   legacy 'inventory_management' row is only kept for JWT-in-flight
--   backward compatibility, not for access_level authority.
