-- ============================================================================
-- 115_website_transaction_type_dedupe_lease.sql
--
-- Deactivate the duplicate, ENUM-INVALID 'lease-out' row in the
-- Website / Transaction Type master.
--
-- WHAT HAPPENED
-- -------------
-- Migration 055 seeded website_transaction_type with two rows: 'sale' (Sell)
-- and 'rent' (Rent Out). At some later point a row with code 'lease-out' and
-- label 'Lease Out' was added through the admin Masters UI. Migration 114 then
-- added the correct 'lease' row, leaving TWO rows both labelled "Lease Out":
--
--     code        label       sort_order
--     lease-out   Lease Out   0      <- added via admin UI, INVALID
--     lease       Lease Out   30     <- added by 114, valid
--
-- WHY 'lease-out' MUST NOT BE SELECTABLE
-- --------------------------------------
-- website_properties.transaction_type is ENUM('sale','rent','lease'). The code
-- 'lease-out' is not a member. Verified on this server:
--
--   * @@sql_mode = IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION
--     -- STRICT_TRANS_TABLES is NOT enabled.
--   * INSERT of 'lease-out' into that ENUM succeeded with NO error and stored
--     '' (empty string, length 0).
--
-- So a seller choosing "Lease Out" from the dropdown would have had their
-- transaction type SILENTLY DISCARDED rather than rejected -- the property
-- would save with a blank transaction type and disappear from every
-- transaction-filtered listing.
--
-- No damage has occurred yet: 0 rows currently have transaction_type = ''
-- (checked), and the 2 existing lease rows correctly store 'lease'.
--
-- WHY DEACTIVATE RATHER THAN DELETE
-- ---------------------------------
-- Deactivating is reversible and preserves the row for audit. is_active = 0
-- removes it from every dropdown (public master endpoints and the admin
-- Masters list both filter on it), which is all that is required to close the
-- trap. Nothing references the row: no website_properties row can hold the
-- value, since the ENUM cannot store it.
--
-- THE ALTERNATIVE, NOT TAKEN: widening the ENUM to include 'lease-out'. That
-- would be a schema change on a live column for no benefit -- 'lease' already
-- expresses the same thing, is already ENUM-valid, is already used by 2 rows,
-- and already resolves against the global master_transaction_types row
-- ('lease','Lease') that the seller save path validates through.
--
-- ROLLBACK
--   UPDATE master_lookups SET is_active = 1
--    WHERE master_key = 'website_transaction_type' AND code = 'lease-out';
--   (Only do this if the ENUM is widened first, or sellers will silently lose
--    their transaction type again.)
-- ============================================================================

SET NAMES utf8mb4;

UPDATE master_lookups
   SET is_active = 0
 WHERE master_key = 'website_transaction_type'
   AND code = 'lease-out';
