-- ============================================================
-- 087 — Enquiry / Relation master seed
-- ============================================================
-- Introduces a NEW dedicated master vocabulary `enquiry_relation` used as the
-- searchable dropdown for the "Relation" field on the ENQUIRY registration
-- forms (Owner Details + Key Person Details).
--
-- Design notes:
--   * Fully SEPARATE from `contact_relation` (which serves Inventory + other
--     contact surfaces). Keeping them independent so the Enquiry workflow can
--     evolve its Relation vocabulary without affecting Inventory / global
--     contact records, and vice-versa.
--   * Registration (what makes the key "managed" / visible in the Masters
--     admin + accepted by the master CRUD + public dropdown APIs) happens in
--     server/services/masters/management.js (LOOKUP_KEYS + MASTER_LABELS) —
--     rows alone are NOT sufficient.
--   * INSERT IGNORE against the (master_key, code) unique key -> idempotent;
--     safe to re-run. Existing rows are preserved.
--   * Values persist as the master LABEL under the same
--     `contacts[].relation` / `keyPersons[].relation` payload keys the
--     pre-existing free-text input used, so historical enquiry records keep
--     loading + displaying unchanged (stale-value fallback in the dropdown).
-- ============================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('enquiry_relation', 'self',      'Self',      10,  1),
  ('enquiry_relation', 'father',    'Father',    20,  1),
  ('enquiry_relation', 'mother',    'Mother',    30,  1),
  ('enquiry_relation', 'brother',   'Brother',   40,  1),
  ('enquiry_relation', 'sister',    'Sister',    50,  1),
  ('enquiry_relation', 'husband',   'Husband',   60,  1),
  ('enquiry_relation', 'wife',      'Wife',      70,  1),
  ('enquiry_relation', 'son',       'Son',       80,  1),
  ('enquiry_relation', 'daughter',  'Daughter',  90,  1),
  ('enquiry_relation', 'uncle',     'Uncle',     100, 1),
  ('enquiry_relation', 'aunt',      'Aunt',      110, 1),
  ('enquiry_relation', 'friend',    'Friend',    120, 1),
  ('enquiry_relation', 'other',     'Other',     130, 1);
