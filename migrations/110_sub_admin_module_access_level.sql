-- ============================================================================
-- 110_sub_admin_module_access_level.sql
--
-- T-2026-173 Phase 1: Add per-grant Read/Write access level to
-- sub_admin_modules so Sub Admins can be granted view-only access on some
-- modules and full write access on others.
--
-- CLIENT REQUIREMENT (verbatim):
--   Each module must have two separate permissions:
--     - Read  – User can view/access the module but cannot modify data.
--     - Write – User can create, edit, update, delete, change status,
--               upload, or otherwise modify data in that module.
--   Write implies Read. If neither is granted the module is completely
--   hidden (sidebar + direct URL + API).
--
-- DATA PRESERVATION NON-NEGOTIABLE:
--   Every existing row in sub_admin_modules represents a legacy grant that
--   was implicitly full Read+Write (the pre-T-173 middleware only checked
--   "module is listed" — it did not distinguish read from write). This
--   migration MUST NOT downgrade any existing sub-admin. Every existing
--   grant is preserved as 'write' (which implies read in the middleware).
--
-- SCHEMA CHANGE (additive, idempotent, non-destructive):
--   1. ADD COLUMN access_level ENUM('read','write') NOT NULL DEFAULT 'write'
--      — DEFAULT 'write' means:
--        (a) All existing rows get access_level='write' the moment MariaDB
--            fills the new column, so nobody loses access on deploy.
--        (b) Any NEW insert that omits access_level (e.g. from a pre-T-173
--            code path) defaults to 'write', keeping backward compat.
--      Idempotent via ADD COLUMN IF NOT EXISTS. Safe to re-run.
--
--   2. Explicit UPDATE to normalize any historical NULLs (defensive; the
--      NOT NULL DEFAULT above already guarantees non-NULL, but if the
--      column already exists from a prior partial apply the UPDATE guards
--      against garbage). WHERE-guarded on access_level IS NULL so re-runs
--      are cheap.
--
-- ROLLBACK PLAN:
--   Reverting the FE (Phase 4/5) restores the boolean checkbox UI which
--   sends every grant as 'write' via the compat layer in the API wrapper.
--   The BE middleware without the second-arg 'write' check simply treats
--   every grant as a valid module presence — pre-T-173 behavior exactly.
--   The column can stay in place indefinitely with zero cost.
-- ============================================================================

ALTER TABLE sub_admin_modules
  ADD COLUMN IF NOT EXISTS access_level ENUM('read','write') NOT NULL DEFAULT 'write'
    COMMENT 'T-173: per-grant read/write level. write implies read at the middleware. Legacy grants default to write to preserve access.'
    AFTER module_key;

-- Defensive backfill: normalize any NULLs (shouldn't happen with NOT NULL DEFAULT,
-- but guards against partial-apply edge cases). Also normalizes any accidental
-- lowercased-or-not values in case some earlier hand-edit landed unusual values.
UPDATE sub_admin_modules
   SET access_level = 'write'
 WHERE access_level IS NULL
    OR access_level NOT IN ('read', 'write');
