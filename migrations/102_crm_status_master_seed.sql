-- ============================================================
-- 102 - CRM Status Master seed  (T-2026-151 Phase 1)
-- ============================================================
-- Registers the `crm_status` vocabulary in the generic master_lookups
-- framework (services/masters/management.js#LOOKUP_KEYS handles the
-- rest -- CRUD, dropdown, delete-safety, admin sidebar entry).
--
-- Codes cover the standard CRM funnel described in spec sections
-- 27-29 + 64. Admins can extend the list at runtime via the master
-- admin (Add / Edit / Deactivate).
--
-- The `new` status is the seed value assigned by the crm_enquiries
-- default (see migration 101). Every ingested enquiry lands on `new`
-- until an admin changes it via the status-change dialog.
--
-- Backward compat: `master_lookups` is the existing generic table
-- (migration 026). No schema change here -- only seed rows. INSERT
-- IGNORE on the (master_key, code) unique key so re-run is a no-op.
-- ============================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('crm_status', 'new',                    'New',                    10, 1),
  ('crm_status', 'first_call_done',        'First Call Done',        20, 1),
  ('crm_status', 'follow_up',              'Follow-Up',              30, 1),
  ('crm_status', 'meeting_scheduled',      'Meeting Scheduled',      40, 1),
  ('crm_status', 'site_visit_scheduled',   'Site Visit Scheduled',   50, 1),
  ('crm_status', 'site_visit_done',        'Site Visit Done',        60, 1),
  ('crm_status', 'negotiation',            'Negotiation',            70, 1),
  ('crm_status', 'booked',                 'Booked',                 80, 1),
  ('crm_status', 'closed_won',             'Closed - Won',           90, 1),
  ('crm_status', 'closed_lost',            'Closed - Lost',         100, 1),
  ('crm_status', 'on_hold',                'On Hold',               110, 1);
