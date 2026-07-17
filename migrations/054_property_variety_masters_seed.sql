-- ===========================================================
-- 054 — Property Variety master (Global) + dashboard support
-- ===========================================================
-- Adds a new "Global / Property Variety" vocabulary to master_lookups so the
-- admin can manage the list end-to-end (Add / Edit / Delete / Search /
-- Active-Inactive / Sorting / Validation) through the existing generic
-- master admin surface (/admin/masters/:key).
--
-- The seed values come from the manager's 2026-07-16 brief:
--   Resale, New, Under Construction, Ready Possession, Joint Venture,
--   Agricultural, NA, Commercial
--
-- The `master_lookups` table itself (schema + indexes + triggers) was
-- created by migration 026; this file only adds rows. INSERT IGNORE keeps
-- the migration idempotent so re-runs don't fail on the unique
-- (master_key, code) constraint.
--
-- Dashboard aggregation reads `transaction_variant` on inventory_properties
-- and enquiry_properties (the closest existing analogue — see migration 027
-- comment: "Resale vs New Sale, Joint Venture, Hostel Let"). The
-- dashboard's "By Property Variety" card maps each aggregated variant code
-- through this master's labels so admins can rename or reorder without a
-- code change.
-- ===========================================================

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active)
VALUES
  ('property_variety', 'resale',              'Resale',               10, 1),
  ('property_variety', 'new',                 'New',                  20, 1),
  ('property_variety', 'under_construction',  'Under Construction',   30, 1),
  ('property_variety', 'ready_possession',    'Ready Possession',     40, 1),
  ('property_variety', 'joint_venture',       'Joint Venture',        50, 1),
  ('property_variety', 'agricultural',        'Agricultural',         60, 1),
  ('property_variety', 'na',                  'NA',                   70, 1),
  ('property_variety', 'commercial',          'Commercial',           80, 1);
