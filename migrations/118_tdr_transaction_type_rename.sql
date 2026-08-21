-- ============================================================================
-- 118_tdr_transaction_type_rename.sql
--
-- TDR transaction types renamed (client request, 2026-08-18):
--   Inventory  "Out" -> "Sale"
--   Enquiry    "In"  -> "Purchase"
--
-- WHY A MIGRATION IS NEEDED
-- -------------------------
-- Renaming the labels in the FE chooser tree alone is not enough. Saves are
-- checked against master_property_forms, which is the AUTHORITATIVE catalog:
--
--   services/masters/propertyFormCatalog.js#validateCombination
--     -> resolveFormCode({ mode, propertyType, transactionType, ... })
--        -> queries.findFormCode(mode, pt, tx, pv)   <- matches on CODES
--
-- Those rows still carried the old transaction codes:
--
--   form_code  mode       property_type  transaction_type  label
--   tdr-sale   inventory  tdr            out               TDR [Out]
--   tdr-in     enquiry    tdr            in                TDR [In]
--
-- so a TDR saved from the renamed chooser (transaction_type 'sale' /
-- 'purchase') would find no matching row and log
--
--   [inventory.save] DB catalog: no form matches property_type=tdr
--   transaction_type=sale property_variety=<empty> — record still saves.
--   Reconcile master_property_forms with the FE chooser.
--
-- on every single save. The record still persists (validateCombination warns
-- and returns '' rather than throwing), so this is not a hard failure — but it
-- leaves the DB catalog permanently out of step with the UI, which is exactly
-- what that warning exists to catch.
--
-- After this migration all four layers agree on `sale` / `purchase`:
--   FE chooser tree      admin/pages/Inventory/chooserTree.js
--   FE form config       dynamic/tdrFormsConfig.js  (already declared these)
--   BE JS catalog        server/constants/formCodeCatalog.js  (already did)
--   BE DB catalog        master_property_forms                <- this file
--
-- `label` is display-only: findFormCode matches on the code columns and _slug()
-- strips any bracket suffix, so relabelling cannot affect resolution.
--
-- The unique key is (form_code, mode), NOT the code triple, so changing
-- transaction_type_code cannot collide with another row.
--
-- Guarded on the OLD value so re-running is a no-op and an operator who has
-- already corrected a row by hand is not overwritten.
--
-- DATA: no property rows need migrating. Zero TDR records were stored under
-- the old codes — verified before writing this:
--   inventory_properties  property_type='tdr'  -> no rows with 'out'
--   enquiry_properties    transaction_type='in' -> 0 rows
-- (the single 'out' record in inventory_properties is a paying_guest listing,
-- which keeps its own, unrelated "Out" transaction type.)
--
-- ROLLBACK
--   UPDATE master_property_forms SET transaction_type_code='out',
--          label='TDR [Out]'  WHERE form_code='tdr-sale' AND mode='inventory';
--   UPDATE master_property_forms SET transaction_type_code='in',
--          label='TDR [In]'   WHERE form_code='tdr-in'   AND mode='enquiry';
-- ============================================================================

SET NAMES utf8mb4;

UPDATE master_property_forms
   SET transaction_type_code = 'sale',
       label                 = 'TDR [Sale]'
 WHERE form_code             = 'tdr-sale'
   AND mode                  = 'inventory'
   AND transaction_type_code = 'out';

UPDATE master_property_forms
   SET transaction_type_code = 'purchase',
       label                 = 'TDR [Purchase]'
 WHERE form_code             = 'tdr-in'
   AND mode                  = 'enquiry'
   AND transaction_type_code = 'in';
