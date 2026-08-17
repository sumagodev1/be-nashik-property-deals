-- ============================================================================
-- 114_website_transaction_type_lease_out.sql
--
-- Add "Lease Out" to the Website / Transaction Type master.
--
-- WHY
-- ---
-- The seller Post-Property flow is being converted to a dependent
-- PropertyType -> TransactionType -> PropertyVariety form. The spec requires
-- three transaction types for every property type:
--     Lease Out, Rent Out, Sell
-- but migration 055 only seeded two rows into website_transaction_type:
--     ('sale','Sell',10) and ('rent','Rent Out',20)
-- so "Lease Out" could not be selected at all.
--
-- WHY THIS IS SAFE / PURELY ADDITIVE — verified, not assumed:
--   1. website_properties.transaction_type is ENUM('sale','rent','lease')
--      (001_initial_schema.sql:125). 'lease' is ALREADY a permitted value, so
--      no ALTER TABLE is needed. This is exactly the constraint migration 055
--      documented at its lines 19-22: website master codes must be one of the
--      three ENUM codes until the schema is widened. 'lease' is one of them.
--   2. The seller create path validates transactionType against the GLOBAL
--      master_transaction_types via services/masters/propertyMasters.js, and
--      that table already contains ('lease','Lease',30)
--      (008_masters.sql:86). So the code resolves rather than being silently
--      skipped by the validator's permissive branch.
--   3. INSERT IGNORE + the existing unique key on (master_key, code) makes a
--      re-run a no-op.
--
-- LABEL: 'Lease Out' (not 'Lease') to match the sibling website label
-- 'Rent Out' and the wording in the seller spec. The website masters are
-- deliberately independent of the admin Global masters (see the manager brief
-- quoted in 055's header), so this label does NOT have to match the global
-- master's 'Lease' and does not affect any admin surface.
--
-- SORT ORDER: 30, appended after Sell(10) and Rent Out(20) so the existing
-- dropdown order is unchanged for anyone already using the master.
--
-- ROLLBACK
--   DELETE FROM master_lookups
--    WHERE master_key = 'website_transaction_type' AND code = 'lease';
--   (Safe only while no website_properties row uses transaction_type='lease'.)
-- ============================================================================

SET NAMES utf8mb4;

INSERT IGNORE INTO master_lookups (master_key, code, label, sort_order, is_active)
VALUES ('website_transaction_type', 'lease', 'Lease Out', 30, 1);
