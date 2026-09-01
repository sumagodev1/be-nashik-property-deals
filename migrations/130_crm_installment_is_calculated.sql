-- ============================================================================
-- 130_crm_installment_is_calculated.sql
--
-- Separate PLANNED installments from CONFIRMED ones.
--
-- THE BEHAVIOUR THIS FIXES
--   Until now every saved installment counted toward Total Amount Paid the
--   moment it had an amount. That is wrong: an installment is usually a
--   SCHEDULE entry — "₹50,000 expected on 02-09-2026" — and entering it does
--   not mean the money has arrived. The client reported exactly this: typing a
--   future installment immediately inflated Total Amount Paid and deflated
--   Total Amount Pending.
--
--   An installment now counts only once the operator explicitly confirms it
--   with the row's "Calculate Amount" action, which sets this flag.
--
-- WHY A COLUMN AND NOT AN INFERENCE
--   The obvious shortcut — "count it if payment_date is in the past" — would be
--   wrong in both directions: a payment can be recorded late (past date, money
--   not yet received) or early (future date, money already taken). Only the
--   operator knows, so the confirmation is stored rather than derived, and it
--   survives reload and re-edit.
--
-- DEFAULT 0, AND NO BACKFILL NEEDED
--   New installments start planned, which is the safe default: an unconfirmed
--   row understates Total Paid, and understating what a customer has paid is a
--   recoverable error, whereas overstating it is not.
--
--   crm_deal_payments and crm_deal_installments are both empty at the time of
--   writing (verified: 0 rows in each — the tables landed in migration 129
--   earlier in this same session), so there is no historical data whose totals
--   this could silently change. Had there been rows, they would have needed
--   backfilling to 1 to preserve the totals already shown against them, since
--   the old model counted every installment.
--
-- Additive only. Re-run safe.
-- ============================================================================

SET NAMES utf8mb4;

ALTER TABLE crm_deal_installments
  ADD COLUMN IF NOT EXISTS is_calculated TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'T-2026-201: 1 = operator confirmed this installment via "Calculate Amount", so it counts toward Total Amount Paid. 0 = planned/scheduled only.'
    AFTER amount;

-- Totals are computed as SUM(amount) WHERE is_calculated = 1 per deal, so the
-- index leads with deal_id and carries the flag and the amount to keep that a
-- covering read.
ALTER TABLE crm_deal_installments
  ADD INDEX IF NOT EXISTS ix_crm_deal_installments_calc (deal_id, is_calculated, amount);
