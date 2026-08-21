-- ============================================================================
-- 119_sale_spelling.sql
--
-- Use the spelling "Sale" everywhere, never "Sell" (client request 2026-08-18).
--
-- Three places carried "Sell":
--
--   1. WEBSITE transaction type. `master_lookups` master_key
--      'website_transaction_type' has code 'sale' already, but its LABEL read
--      "Sell" — that is the tab on the public site's home page and the value
--      shown on every website listing. Pure display fix; the code is untouched
--      so nothing that keys on 'sale' is affected.
--
--   2. Hospital / Hotel inventory forms. These are the same FE↔DB drift that
--      migration 118 fixed for TDR. Both form configs have always declared
--      `transactionType: 'sale'`:
--
--        dynamic/hospitalFormsConfig.js  code: 'hospital-sell', transactionType: 'sale'
--        dynamic/hotelFormsConfig.js     code: 'hotel-sell',    transactionType: 'sale'
--
--      and formCodeCanonicalMap.js resolves them off `tx === 'sale'` too — but
--      the CHOOSER sent 'sell' and master_property_forms stored 'sell', so
--      propertyFormCatalog#resolveFormCode could not match the row and logged
--      "no form matches ... transaction_type=sale" on every save.
--
--      The form_code stays 'hospital-sell' / 'hotel-sell'. Those strings are
--      registered in three places (FE formCategoryMap + formCodeCanonicalMap,
--      BE formCodeCatalog REGISTERED_FORM_CODES); renaming them is a much
--      larger change than a spelling fix and buys nothing — the code is an
--      internal identifier and is never shown to an operator.
--
--   3. The now-orphaned `sell` transaction type. After (2) nothing references
--      master_transaction_types.code='sell', and NO property row has ever used
--      it (verified: inventory_properties has 3 rows on 'sale', 0 on 'sell').
--      It is DEACTIVATED, not deleted or relabelled:
--        * relabelling it "Sale" would leave TWO active rows labelled "Sale",
--          and PropertyTypeChooser resolves the chooser's label back to a
--          master row via findMasterRowByLabel() — with a duplicate label it
--          could stamp the wrong transaction_type_id onto a saved property.
--        * deleting it would break any future audit of historical values.
--      is_active = 0 keeps the row readable while removing it from every
--      picker and filter.
--
-- Each statement is guarded on the OLD value, so re-running is a no-op.
--
-- ROLLBACK
--   UPDATE master_lookups SET label='Sell'
--    WHERE master_key='website_transaction_type' AND code='sale';
--   UPDATE master_property_forms SET transaction_type_code='sell', label='Hospital [Sell]'
--    WHERE form_code='hospital-sell' AND mode='inventory';
--   UPDATE master_property_forms SET transaction_type_code='sell', label='Hotel [Sell]'
--    WHERE form_code='hotel-sell' AND mode='inventory';
--   UPDATE master_transaction_types SET is_active=1 WHERE code='sell';
-- ============================================================================

SET NAMES utf8mb4;

-- 1. Website transaction type label.
UPDATE master_lookups
   SET label = 'Sale'
 WHERE master_key = 'website_transaction_type'
   AND code       = 'sale'
   AND label      = 'Sell';

-- 2. Hospital / Hotel inventory form catalog rows.
UPDATE master_property_forms
   SET transaction_type_code = 'sale',
       label                 = 'Hospital [Sale]'
 WHERE form_code             = 'hospital-sell'
   AND mode                  = 'inventory'
   AND transaction_type_code = 'sell';

UPDATE master_property_forms
   SET transaction_type_code = 'sale',
       label                 = 'Hotel [Sale]'
 WHERE form_code             = 'hotel-sell'
   AND mode                  = 'inventory'
   AND transaction_type_code = 'sell';

-- 3. Retire the orphaned 'sell' transaction type.
UPDATE master_transaction_types
   SET is_active = 0
 WHERE code      = 'sell'
   AND is_active = 1;
