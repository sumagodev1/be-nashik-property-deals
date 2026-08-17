-- ============================================================================
-- 113_crm_allocation_property_codes.sql
--
-- CRM lead allocation switches from numeric row ids to globally-unique
-- property CODES.
--
-- CLIENT REQUIREMENT (verbatim):
--   "if i have created any inventory prperty and enquiry prperty and receiving
--    website proeprty those have a unque id generating like this
--    AKL-BNG-26-0XCQYR5 and this ids i will use for crm lead assign and when
--    clicking on this ids the particular proeprty should be open"
--
-- WHY
-- ---
-- crm_enquiries.interested_property_ids held bare auto-increment ids resolved
-- against inventory_properties ONLY. The three property tables number their
-- rows independently, so a stored `19` was genuinely ambiguous: inventory #19
-- is NSK-COM-26-JEUEBA while enquiry #19 is NSK-FLT-26-LCKTZ9P -- unrelated
-- properties. Allocating from the wrong surface therefore corrupted the field
-- silently, and the CRM rendered the result as "Property unavailable".
--
-- property_code is unique within each table AND has zero overlap across them
-- (audited: 43 + 22 + 30 = 95 codes, all distinct), and is never rewritten
-- after creation. So a code names exactly one property, permanently -- and
-- unlike a dead id, it still names it after the property is soft-deleted.
--
-- NO DDL IS REQUIRED FOR THE DATA CHANGE
-- --------------------------------------
-- The column is realized as LONGTEXT + CHECK json_valid(...) (MariaDB aliases
-- JSON to that), which already accepts ["AKL-BNG-26-0XCQYR5"]. Only the COMMENT
-- from 101_crm_module.sql was left describing the old format.
--
-- The MODIFY below was verified on MariaDB 10.4 against a throwaway table NOT
-- to drop the json_valid CHECK constraint: the constraint was present before
-- and after, malformed JSON was still rejected afterwards, and a string array
-- was accepted. It is a comment-only change.
--
-- DATA CONVERSION
-- ---------------
-- Every numeric entry is resolved against inventory_properties, because that
-- is the ONLY table the old writer could produce -- allocations.js enforced an
-- inventory-only existence check on write. Resolution for this database:
--
--   crm_enquiries.id  enquiry_code      before        after
--   25                ENQ-2026-00013    [54]          ["PUN-FLT-26-MSFTB4M"]
--   32                ENQ-2026-00017    [54]          ["PUN-FLT-26-MSFTB4M"]
--   42                ENQ-2026-00027    [56,46]       ["NSK-FLT-26-7C6M6WG","NSK-PLT-26-QVY2AJJ"]
--
-- 3 rows, 4 entries, 0 unresolvable. Array order is preserved. Every other
-- enquiry has NULL or [] and needs nothing. (Dead ids were already removed in
-- a prior cleanup, which is why nothing here is unresolvable.)
--
-- Each UPDATE is GUARDED on the exact pre-state it expects, so:
--   * re-running is a no-op -- after conversion JSON_CONTAINS(...,'54') is 0,
--     because JSON_CONTAINS('["..."]','54') does not match a string element;
--   * if the data drifted since this was written the WHERE simply misses and
--     the row is left ALONE rather than overwritten with wrong codes.
--
-- Literal statements rather than a set-based rewrite: MariaDB 10.4 has no
-- JSON_TABLE (10.6+), and with 4 entries explicit is safer and reviewable.
-- For any OTHER environment use scripts/migrate-allocations-to-codes.js,
-- which resolves dynamically and defaults to --dry-run.
--
-- NO DUAL-READ WINDOW
-- -------------------
-- Verified: JSON_CONTAINS('[54]', '"54"') returns 0 -- a numeric 54 and the
-- string "54" do NOT match. A half-migrated column is invisible to whichever
-- query form runs. This migration must therefore ship together with the code
-- change, not before or after it.
--
-- ROLLBACK
--   UPDATE crm_enquiries SET interested_property_ids = '[54]'    WHERE id = 25;
--   UPDATE crm_enquiries SET interested_property_ids = '[54]'    WHERE id = 32;
--   UPDATE crm_enquiries SET interested_property_ids = '[56,46]' WHERE id = 42;
--   (plus reverting the COMMENT, and the application code.)
-- ============================================================================

SET NAMES utf8mb4;

-- 1. Correct the now-false column comment. Comment-only; the json_valid CHECK
--    is preserved by MODIFY (verified on 10.4 -- see header).
ALTER TABLE crm_enquiries
  MODIFY interested_property_ids JSON NULL
  COMMENT 'JSON array of property_code strings, globally unique across inventory_properties / enquiry_properties / website_properties. Resolve via db/queries/property_codes.js#resolvePropertyCodes. NOT row ids.';

-- 2. Convert existing allocations. Guarded + idempotent (see header).
UPDATE crm_enquiries
   SET interested_property_ids = '["PUN-FLT-26-MSFTB4M"]'
 WHERE id = 25
   AND JSON_VALID(interested_property_ids)
   AND JSON_LENGTH(interested_property_ids) = 1
   AND JSON_CONTAINS(interested_property_ids, '54');

UPDATE crm_enquiries
   SET interested_property_ids = '["PUN-FLT-26-MSFTB4M"]'
 WHERE id = 32
   AND JSON_VALID(interested_property_ids)
   AND JSON_LENGTH(interested_property_ids) = 1
   AND JSON_CONTAINS(interested_property_ids, '54');

UPDATE crm_enquiries
   SET interested_property_ids = '["NSK-FLT-26-7C6M6WG","NSK-PLT-26-QVY2AJJ"]'
 WHERE id = 42
   AND JSON_VALID(interested_property_ids)
   AND JSON_LENGTH(interested_property_ids) = 2
   AND JSON_CONTAINS(interested_property_ids, '56')
   AND JSON_CONTAINS(interested_property_ids, '46');
