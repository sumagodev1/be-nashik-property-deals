-- Migration 127: reconcile master_transaction_types with the Inventory /
-- Enquiry form catalogue, so the fixed Global / Transaction Type master
-- lists only values a property can actually be created against.
--
-- WHY 14 CODES — this list was derived by auditing every Property Type on
-- both surfaces, not copied from the existing master rows. Two independent
-- sources were walked and they agree exactly:
--
--   1. master_property_forms (the DB chooser tree, authoritative)
--      101 active rows -> 14 inventory property types, 17 enquiry property
--      types.
--   2. src/admin/pages/Inventory/chooserTree.js (the frontend bootstrap
--      fallback, which is what the running app is currently serving —
--      see the note at the bottom of this file).
--
--   INVENTORY                        ENQUIRY
--     Bungalow        sale, rent_out, lease_out    Bank Auction     purchase
--     Commercial Sp.  sale, rent_out, lease_out    Bungalow         purchase, rent_in, lease_in, paying_guest
--     Flat            sale, rent_out, lease_out,   Commercial Sp.   purchase, rent_in, lease_in
--                     joint_venture                Flat             purchase, rent_in, lease_in, paying_guest, rate_finder
--     Hospital        sale, rent_out               Hospital         rent_in, buy
--     Hostel          let_out                      Hostel           let_in
--     Hotel           sale, rent_out               Hotel            rent_in, buy
--     Land            sale, rent_out, lease_out    Industrial Plot  purchase
--     Paying Guest    out                          Land             purchase, rent_in, lease_in, rate_finder
--     Plot            sale, rent_out, lease_out    Plot             purchase, rent_in, lease_in, rate_finder
--     Rowhouse        sale, rent_out, lease_out    Pre-Leased Prop. purchase
--     SEZ Land        sale                         Project Regn.    registration
--     SEZ Plot        sale                         Rowhouse         purchase, rent_in, lease_in
--     Shop            sale, rent_out, lease_out    SEZ Land         purchase
--     TDR             sale                         SEZ Plot         purchase
--                                                  Shop             purchase, rent_in, lease_in, rate_finder
--     -> 6 distinct codes                          TDR              purchase
--                                                  -> 8 distinct codes
--
--   UNION (14): buy, joint_venture, lease_in, lease_out, let_in, let_out,
--               out, paying_guest, purchase, rate_finder, registration,
--               rent_in, rent_out, sale
--
-- WHAT THIS REMOVES — the 12 rows below are in the master but in neither
-- chooser tree. Every one was checked for references before being listed
-- and NONE is referenced by:
--   * inventory_properties / enquiry_properties (transaction_type or
--     transaction_type_id), including a JSON_SEARCH of the details blob,
--   * master_property_forms.transaction_type_code,
--   * master_lookups.parent_code.
--
--   rent, lease            legacy coarse values, superseded by the
--                          directional rent_in/rent_out + lease_in/lease_out
--                          pairs the forms actually use.
--   resale, new_sale,      PROPERTY VARIETY values that were seeded into the
--   new_purchase,          transaction master by mistake. Variety lives in
--   new_rent_in,           master_lookups(master_key='property_variety') and
--   new_rent_out,          is a separate step in the chooser.
--   new_lease_in,
--   new_lease_out
--   hostel_let_in,         Seeded by migration 046 from the hostel form
--   hostel_let_out         configs' internal `transactionType`. The chooser
--                          persists the tree label instead (Hostel -> "Let
--                          Out" -> let_out, see PropertyTypeChooser.jsx
--                          `labelToCanonicalCode`), so these two codes are
--                          unreachable from the form flow and unused by any
--                          record. Migration 065 seeded let_in/let_out,
--                          which is what the catalogue and the tree use.
--   in                     Seeded by migration 065 for a chooser branch that
--                          no form row ever referenced.
--
-- HOW: soft delete only. Rows keep their IDs and stay in the table, so any
-- historical reference still resolves and the change is reversible with the
-- statement at the bottom. Nothing is renamed, re-coded or re-numbered, and
-- no Property Type or Property Variety row is touched.
--
-- Idempotent: the WHERE clause already excludes rows previously soft-deleted.

UPDATE master_transaction_types
   SET is_active  = 0,
       deleted_at = NOW()
 WHERE deleted_at IS NULL
   AND code IN (
     'rent', 'lease',
     'resale', 'new_sale', 'new_purchase',
     'new_rent_in', 'new_rent_out', 'new_lease_in', 'new_lease_out',
     'hostel_let_in', 'hostel_let_out',
     'in'
   );

-- Safety net: never leave a code the form catalogue still points at in a
-- deleted state. If a future catalogue row reintroduces one of the codes
-- above, this revives it rather than silently breaking that form's chooser
-- branch (listByMode requires the master row to be active AND not deleted).
-- The COLLATE is required because master_property_forms is utf8mb4_general_ci
-- while the master tables are utf8mb4_unicode_ci.
UPDATE master_transaction_types mtt
   SET mtt.is_active = 1,
       mtt.deleted_at = NULL
 WHERE mtt.deleted_at IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM master_property_forms pf
      WHERE pf.deleted_at IS NULL
        AND pf.is_active = 1
        AND pf.transaction_type_code COLLATE utf8mb4_unicode_ci = mtt.code
   );

-- REVERSAL (run manually if this needs backing out):
--   UPDATE master_transaction_types SET is_active = 1, deleted_at = NULL
--    WHERE code IN ('rent','lease','resale','new_sale','new_purchase',
--                   'new_rent_in','new_rent_out','new_lease_in',
--                   'new_lease_out','hostel_let_in','hostel_let_out','in');
--
-- SEPARATE PRE-EXISTING DEFECT, deliberately NOT fixed here:
-- master_property_forms was created utf8mb4_general_ci while the three
-- parent masters are utf8mb4_unicode_ci, so the join in
-- db/queries/property_form_catalog.js#listByMode throws
-- ER_CANT_AGGREGATE_2COLLATIONS. routes/public/property-catalog.js swallows
-- it with `.catch(() => [])`, so GET /api/public/property-catalog answers
-- {"seeded":true,"tree":[]} and the frontend silently serves the
-- chooserTree.js fallback. The app works because the two trees are
-- identical — which this migration verified — but the DB catalogue is
-- currently dead code. Fixing the collation is a schema change with its own
-- blast radius and is out of scope for this task.
