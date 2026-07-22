-- ===========================================================
-- 065 - Seed the master rows the chooser tree references
-- ===========================================================
-- T-2026-066: after PropertyTypeChooser.jsx started emitting canonical
-- ptCode / ttCode / pvCode into the URL (so a user's "Paying Guest > Out
-- > Flat" selection can no longer be silently overwritten by form-code
-- projection), every code that appears in the chooser tree must resolve
-- to an active master row so:
--   1. FE save-time guard passes,
--   2. BE validatePropertyClassification passes,
--   3. list/detail APIs return a labelled name for the homepage.
--
-- Codes here are DERIVED FROM CHOOSER TREE LABELS via
-- src/admin/pages/Inventory/PropertyTypeChooser.jsx :: labelToCanonicalCode
-- (lowercase, ASCII-fold, non-alphanumerics -> underscore). The list below
-- is the diff between the chooser labels and the pre-mig-065 master seed
-- (mig 008 / 016 / 021 / 045 / 046 for transaction types; mig 054 for
-- property varieties).
--
-- INSERT IGNORE keeps re-runs safe. UPDATE-revive clauses reactivate any
-- row that was soft-deleted by a prior migration (so hostile
-- upgrade/downgrade cycles converge to the intended state).
-- ===========================================================

-- --------------------- master_transaction_types --------------------------
-- Chooser labels that had no matching TT code pre-065:
--   Buy         -> buy          (Hotel / Enquiry)
--   In          -> in           (TDR / Enquiry)
--   Let In      -> let_in       (Hostel / Enquiry)
--   Let Out     -> let_out      (Hostel / Inventory)
--   Out         -> out          (Paying Guest / Inventory, TDR / Inventory)
--   Rate Finder -> rate_finder  (Flat / Land / Plot / Shop enquiries)
--   Registration-> registration (Project Registration)
--   Sell        -> sell         (Hospital / Hotel / Inventory)
INSERT IGNORE INTO master_transaction_types (code, label, sort_order, is_active) VALUES
  ('buy',          'Buy',           200, 1),
  ('in',           'In',            210, 1),
  ('let_in',       'Let In',        220, 1),
  ('let_out',      'Let Out',       230, 1),
  ('out',          'Out',           240, 1),
  ('rate_finder',  'Rate Finder',   250, 1),
  ('registration', 'Registration',  260, 1),
  ('sell',         'Sell',          270, 1);

-- Revive-in-place if any of these codes was previously soft-deleted.
UPDATE master_transaction_types SET label = 'Buy',          sort_order = 200, is_active = 1, deleted_at = NULL WHERE code = 'buy';
UPDATE master_transaction_types SET label = 'In',           sort_order = 210, is_active = 1, deleted_at = NULL WHERE code = 'in';
UPDATE master_transaction_types SET label = 'Let In',       sort_order = 220, is_active = 1, deleted_at = NULL WHERE code = 'let_in';
UPDATE master_transaction_types SET label = 'Let Out',      sort_order = 230, is_active = 1, deleted_at = NULL WHERE code = 'let_out';
UPDATE master_transaction_types SET label = 'Out',          sort_order = 240, is_active = 1, deleted_at = NULL WHERE code = 'out';
UPDATE master_transaction_types SET label = 'Rate Finder',  sort_order = 250, is_active = 1, deleted_at = NULL WHERE code = 'rate_finder';
UPDATE master_transaction_types SET label = 'Registration', sort_order = 260, is_active = 1, deleted_at = NULL WHERE code = 'registration';
UPDATE master_transaction_types SET label = 'Sell',         sort_order = 270, is_active = 1, deleted_at = NULL WHERE code = 'sell';

-- --------------------- master_lookups (property_variety) -----------------
-- Chooser labels that had no matching PV code pre-065:
--   Bungalow -> bungalow  (Paying Guest / Out / Bungalow)
--   Flat     -> flat      (Paying Guest / Out / Flat)
--
-- These are DELIBERATELY the same slug as some property_type codes -
-- the property_variety master is a SEPARATE vocabulary (mig 054), so the
-- collision is only structural (same string, different table + role).
INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active) VALUES
  ('property_variety', 'bungalow', 'Bungalow', 100, 1),
  ('property_variety', 'flat',     'Flat',     110, 1);

UPDATE master_lookups SET label = 'Bungalow', sort_order = 100, is_active = 1, deleted_at = NULL
 WHERE master_key = 'property_variety' AND code = 'bungalow';
UPDATE master_lookups SET label = 'Flat',     sort_order = 110, is_active = 1, deleted_at = NULL
 WHERE master_key = 'property_variety' AND code = 'flat';
