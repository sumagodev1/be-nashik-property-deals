-- ============================================================
-- 072 — Global "Project Name" master seed
-- ============================================================
-- Introduces ONE reusable GLOBAL master vocabulary `project_name`, used as
-- the single source of truth for the "Project Name" / "Name of Project"
-- dropdowns across every surface that references a project:
--   • Flat Registration forms (Inventory + Enquiry) — the dualMode
--     "specific" side + the plain projectName field.
--   • Project / Pre-Leased / Bank Auction Registration forms.
--
-- Design notes:
--   • GLOBAL scope (label prefixed "Global /"), mirroring `property_variety`
--     (migration 054). Do NOT create per-family duplicates.
--   • The vocabulary is admin-curated and grows over time via the master
--     admin UI + the in-form "Other → Save" flow (POST /admin/masters/
--     project_name). This migration only seeds a few real starter values so
--     the dropdown is not empty on a fresh install; admins add the rest.
--   • Registration (what makes the key "managed" / visible in the Masters
--     admin + accepted by the master CRUD + public dropdown APIs) happens in
--     server/services/masters/management.js (LOOKUP_KEYS + MASTER_LABELS) —
--     rows alone are NOT sufficient. See migration 055's note.
--   • INSERT IGNORE against the (master_key, code) unique key → idempotent;
--     safe to re-run. Existing rows are preserved.
--   • Values persist in details.dynamicData.projectName as the master LABEL
--     (backward compatible with the pre-existing free-text values, which keep
--     loading + displaying as-is even when not present in this vocabulary).
-- ============================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('project_name', 'abh-treeland', 'ABH Treeland', 10, 1),
  ('project_name', 'parksyde',     'Parksyde',     20, 1),
  ('project_name', 'nayantara',    'Nayantara',    30, 1);
