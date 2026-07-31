-- ============================================================
-- 083 — Rowhouse property type + form catalog + property variety
-- ============================================================
-- Introduces a brand-new Property Type "Rowhouse" as a complete parallel
-- to the existing "Bungalow" type. No Bungalow record is modified.
--
-- Idempotent — INSERT IGNORE + UPDATE (idem revive) throughout.
--
-- Scope:
--   1. master_property_types: add row (code='rowhouse', label='Rowhouse',
--      id_code='RWH').
--   2. master_lookups (property_variety): ensure 'resale' and 'new' rows
--      exist under master_key='property_variety' so the Rowhouse tree
--      resolves. Bungalow already relies on them — this migration reasserts
--      idempotently.
--   3. master_property_forms: add 12 Rowhouse form-code rows — 6 inventory
--      (Sell / Lease Out / Rent Out × Resale / New) and 6 enquiry
--      (Purchase / Lease In / Rent In × Resale / New). Same transaction/
--      variety grid as Bungalow. No Paying Guest variant.
--
-- Existing Bungalow rows are NOT touched (read-only reference).
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Property Type master row + id_code
-- ────────────────────────────────────────────────────────────

INSERT IGNORE INTO master_property_types (code, label, sort_order, is_active) VALUES
  ('rowhouse', 'Rowhouse', 125, 1);

-- Revive-in-place if a prior run soft-deleted the row, and set id_code.
UPDATE master_property_types
   SET label = 'Rowhouse',
       sort_order = 125,
       is_active = 1,
       deleted_at = NULL,
       id_code = 'RWH'
 WHERE code = 'rowhouse';

-- ────────────────────────────────────────────────────────────
-- 2. property_variety rows (idempotent reassertion)
-- ────────────────────────────────────────────────────────────

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('property_variety', 'resale', 'Resale', 10, 1),
  ('property_variety', 'new',    'New',    20, 1);

UPDATE master_lookups SET label = 'Resale', is_active = 1, deleted_at = NULL
 WHERE master_key = 'property_variety' AND code = 'resale';
UPDATE master_lookups SET label = 'New', is_active = 1, deleted_at = NULL
 WHERE master_key = 'property_variety' AND code = 'new';

-- ────────────────────────────────────────────────────────────
-- 3. master_property_forms — 12 Rowhouse form-code rows
--    Mirrors migration 063's Bungalow block one-for-one, minus PG.
-- ────────────────────────────────────────────────────────────

INSERT INTO master_property_forms
  (form_code, mode, property_type_code, transaction_type_code, property_variety_code, label, sort_order)
VALUES
  -- Inventory (6)
  ('rowhouse-resale-lease-out', 'inventory', 'rowhouse', 'lease_out', 'resale', 'Rowhouse [Lease Out Resale]', 500),
  ('rowhouse-new-lease-out',    'inventory', 'rowhouse', 'lease_out', 'new',    'Rowhouse [Lease Out New]',    510),
  ('rowhouse-resale-rent-out',  'inventory', 'rowhouse', 'rent_out',  'resale', 'Rowhouse [Rent Out Resale]',  520),
  ('rowhouse-new-rent-out',     'inventory', 'rowhouse', 'rent_out',  'new',    'Rowhouse [Rent Out New]',     530),
  ('rowhouse-resale',           'inventory', 'rowhouse', 'sale',      'resale', 'Rowhouse [Sale Resale]',      540),
  ('rowhouse-new-sale',         'inventory', 'rowhouse', 'sale',      'new',    'Rowhouse [Sale New]',         550),
  -- Enquiry (6)
  ('rowhouse-resale-lease-in',  'enquiry',   'rowhouse', 'lease_in',  'resale', 'Rowhouse [Lease In Resale]',  500),
  ('rowhouse-new-lease-in',     'enquiry',   'rowhouse', 'lease_in',  'new',    'Rowhouse [Lease In New]',     510),
  ('rowhouse-resale-purchase',  'enquiry',   'rowhouse', 'purchase',  'resale', 'Rowhouse [Purchase Resale]',  520),
  ('rowhouse-new-purchase',     'enquiry',   'rowhouse', 'purchase',  'new',    'Rowhouse [Purchase New]',     530),
  ('rowhouse-resale-rent-in',   'enquiry',   'rowhouse', 'rent_in',   'resale', 'Rowhouse [Rent In Resale]',   540),
  ('rowhouse-new-rent-in',      'enquiry',   'rowhouse', 'rent_in',   'new',    'Rowhouse [Rent In New]',      550)
ON DUPLICATE KEY UPDATE
  property_type_code    = VALUES(property_type_code),
  transaction_type_code = VALUES(transaction_type_code),
  property_variety_code = VALUES(property_variety_code),
  label                 = VALUES(label),
  sort_order            = VALUES(sort_order),
  is_active             = 1,
  deleted_at            = NULL;
