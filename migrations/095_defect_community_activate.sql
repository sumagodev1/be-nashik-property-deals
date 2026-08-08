-- ============================================================
-- 095 — Activate `*_defect_community` master rows
-- ============================================================
-- T-2026-108: On every Inventory/Enquiry Purchase form for Bungalow,
-- Flat, Row House, Commercial Space, and Shop, the "Defect — Will Do
-- (Community)" and "Defect — Will Not Do (Community)" multi-select
-- fields render their label but no checkbox options. Root cause: the
-- original master seeds (migrations 030, 031, 032, 038, 084) inserted
-- the three community codes with is_active = 0 based on an earlier
-- sensitivity concern. The public masters API (`/public/masters/:key`)
-- correctly filters to active rows only, so `is_active = 0` produces
-- an empty option list and the FE MasterMultiSelect renders an empty
-- grid under the label — the exact symptom the client reported.
--
-- Fix: activate every existing community-defect row. This is additive
-- and non-destructive:
--   • No schema change (no ALTER, no new columns, no new tables).
--   • No API contract change.
--   • Idempotent: the WHERE clause targets is_active = 0, so re-running
--     the migration on an already-activated database is a no-op.
--   • Preserves any admin's manual deactivations on rows that already
--     read is_active = 1 (this migration only flips 0 -> 1, never the
--     other direction).
--   • Preserves data. Previously-saved records that reference these
--     codes as chosen values were already round-tripping fine (the
--     write path never checked is_active); this only affects visibility
--     in NEW dropdowns.
--
-- Post-migration behavior:
--   • `/public/masters/bunglow_defect_community` returns 3 rows.
--   • Same for flat / rowhouse / commercial / shop community variants.
--   • Admins retain full control via the Masters admin UI to deactivate
--     any specific row (per-code, per-master) if a particular label is
--     objectionable in their deployment. The `sensitive: true` flag on
--     the FE masters config (bungalowMastersConfig.js, etc.) remains as
--     a soft signal for any future admin-only visibility layer.
-- ============================================================

SET NAMES utf8mb4;

UPDATE master_lookups
   SET is_active = 1
 WHERE master_key IN (
         'bunglow_defect_community',
         'flat_defect_community',
         'rowhouse_defect_community',
         'commercial_defect_community',
         'shop_defect_community'
       )
   AND is_active = 0
   AND deleted_at IS NULL;
