-- ===========================================================
-- 077 — Hospital Buy: assign Resale property variety
-- ===========================================================
-- The `hospital-resale` form (Enquiry side, Hospital → Buy) was
-- originally seeded in migration 063 with property_variety_code
-- NULL, so the chooser skipped the variety step in the UI. The
-- reference spec (`reference of forms/Hospital Registration
-- Form.md`) titles this form "Hospital Registration Form[Re-Sale]"
-- and the FE `chooserTree.js` now wraps it in a single-option
-- Resale variety picker to match the other buy-only-Resale forms
-- (bank-auction-resale, industrial-plot-resale, pre-leased-resale,
-- project-resale).
--
-- This migration aligns master_property_forms with that spec so
-- the DB catalog (source of truth once seeded — see T-2026-058
-- and hooks/usePropertyCatalog.js) surfaces the same Resale
-- variety.
--
-- Idempotent: UPDATE by (form_code, mode) unique key. Safe to
-- re-run; safe to run before or after the FE change is deployed
-- (the FE has always accepted the tree either way).
-- ===========================================================

UPDATE master_property_forms
   SET property_variety_code = 'resale'
 WHERE form_code = 'hospital-resale'
   AND mode      = 'enquiry';
