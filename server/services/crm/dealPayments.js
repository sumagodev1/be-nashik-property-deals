/**
 * CRM Deal / Payment Details.
 *
 * A lead that reaches the "Converted to Deal" stage can record what the
 * customer has paid: an advance, plus up to ten installments each with its own
 * date and remarks. The money the customer OWES is not entered here — it is the
 * Cost to Customer already captured on the allocated inventory property, read
 * live on every request so a re-priced property is reflected immediately.
 *
 * PLANNED vs CONFIRMED
 *   An installment is a SCHEDULE entry until the operator confirms it. Entering
 *   "₹50,000 due 02-09-2026" does not mean the money arrived, so only rows with
 *   is_calculated = 1 count toward Total Amount Paid (migration 130).
 *
 * DERIVED, NEVER STORED
 *   totalAmountPaid    = advance + sum(CONFIRMED installments)
 *   totalAmountPending = totalCustomerCost - totalAmountPaid
 * Storing either would create a second source of truth that drifts the first
 * time a row is edited outside this service.
 *
 * VALIDATION IS SERVER-SIDE FIRST
 *   The client hides the Add button at ten installments and blocks an overpaid
 *   total, but every one of those rules is re-checked here. A direct API call
 *   must not be able to record a negative amount, an eleventh installment, a
 *   deal against a property the lead has no allocation for, or a total that
 *   exceeds what the property costs.
 */

const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const deals = require('../../db/queries/crmDealPayments');

const MAX_INSTALLMENTS = 10;

/** The stage code that means "a deal was struck" — master_lookups crm_lead_stage. */
const DEAL_STAGE_CODE = 'converted_to_deal';

/** Two-decimal money, so repeated float addition cannot drift a rupee. */
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function parseAmount(raw, label) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${label} must be a number.`);
  }
  if (n < 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${label} cannot be negative.`);
  }
  // DECIMAL(14,2) tops out below this; rejecting here gives a readable message
  // instead of a driver-level out-of-range error.
  if (n > 999999999999) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${label} is too large.`);
  }
  return round2(n);
}

/** ISO date, or null. Anything else is a client bug worth reporting. */
function parseDate(raw, label) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${label} must be a valid date (YYYY-MM-DD).`);
  }
  // Catches 2026-02-31, which the regex alone accepts.
  const [y, m, d] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${label} is not a real date.`);
  }
  return text;
}

function totalsFor(cost, advance, installments) {
  // Only confirmed installments count. A planned one carries an amount and a
  // date but no money has changed hands, so adding it would overstate what the
  // customer has paid and understate what they still owe.
  const paid = round2(
    installments.reduce(
      (sum, it) => (it.isCalculated ? sum + Number(it.amount || 0) : sum),
      Number(advance || 0),
    ),
  );
  return {
    totalAmountPaid: paid,
    // Never negative: an overpaid deal is rejected on save, and clamping keeps
    // a legacy row (or one whose property was re-priced downward) from
    // rendering a negative "pending".
    totalAmountPending: cost === null ? null : round2(Math.max(0, cost - paid)),
  };
}

/**
 * Everything the Deal section needs for one lead.
 *
 * Always returns a shape, even when there is no deal and no allocation, so the
 * client can render its own empty/blocked states from one response rather than
 * inferring them from a 404.
 */
async function getForLead(enquiryId) {
  const [deal, allocatable] = await Promise.all([
    deals.findDealForEnquiry(enquiryId),
    deals.listAllocatableProperties(enquiryId),
  ]);

  const propertyCode = deal?.propertyCode
    // Exactly one allocation is not a choice — preselect it so the operator
    // never picks from a list of one.
    || (allocatable.length === 1 ? allocatable[0].propertyCode : '');

  const totalCustomerCost = deal
    ? deal.totalCustomerCost
    : (allocatable.find((p) => p.propertyCode === propertyCode)?.costToCustomer ?? null);

  const advanceAmount = deal?.advanceAmount ?? 0;
  const installments = deal?.installments ?? [];

  return {
    dealStageCode: DEAL_STAGE_CODE,
    maxInstallments: MAX_INSTALLMENTS,
    hasDeal: Boolean(deal),
    propertyCode,
    totalCustomerCost,
    propertyDeleted: deal?.propertyDeleted ?? false,
    advanceAmount,
    installments,
    ...totalsFor(totalCustomerCost, advanceAmount, installments),
    // The client renders the "why you cannot save" message from these two
    // rather than composing its own wording from a guess.
    allocatableProperties: allocatable,
    blockedReason: blockedReasonFor(allocatable, propertyCode, totalCustomerCost),
  };
}

/**
 * Why the Deal section cannot be saved yet, or null when it can.
 *
 * Two distinct blockers, and they need different wording because they need
 * different fixes: no inventory property allocated at all (allocate one), and
 * a property allocated but with no Cost to Customer recorded on it (go and
 * price the property). The second is the common case in this database — three
 * of the four allocated properties have no cost — and reporting it as "no
 * property allocated" would send the operator to the wrong screen.
 */
function blockedReasonFor(allocatable, propertyCode, cost) {
  if (!allocatable.length) {
    return 'No Inventory Property is allocated to this lead. Allocate one before recording payment details.';
  }
  if (!propertyCode) {
    return 'Select which allocated Inventory Property this deal is for.';
  }
  if (cost === null) {
    return `The selected Inventory Property has no "Cost to Customer (Rs.)" recorded, so the deal total cannot be determined. Add it on the property first.`;
  }
  return null;
}

/**
 * Persist the deal for a lead.
 *
 * `payload` = { propertyCode, advanceAmount, installments: [{amount, paymentDate, remarks}] }
 */
async function saveForLead(enquiryId, payload = {}) {
  const allocatable = await deals.listAllocatableProperties(enquiryId);
  if (!allocatable.length) {
    throw new HttpError(400, 'VALIDATION_ERROR',
      'No Inventory Property is allocated to this lead. Allocate one before recording payment details.');
  }

  const propertyCode = String(payload.propertyCode || '').trim()
    || (allocatable.length === 1 ? allocatable[0].propertyCode : '');
  if (!propertyCode) {
    throw new HttpError(400, 'VALIDATION_ERROR',
      'Select which allocated Inventory Property this deal is for.');
  }
  // The deal may only name a property the lead actually holds. Without this a
  // caller could price a deal off an unrelated property's cost.
  const chosen = allocatable.find((p) => p.propertyCode === propertyCode);
  if (!chosen) {
    throw new HttpError(400, 'VALIDATION_ERROR',
      `Inventory Property ${propertyCode} is not allocated to this lead.`);
  }
  if (chosen.costToCustomer === null) {
    throw new HttpError(400, 'VALIDATION_ERROR',
      'The selected Inventory Property has no "Cost to Customer (Rs.)" recorded, so the deal total cannot be determined.');
  }

  const advanceAmount = parseAmount(payload.advanceAmount, 'Advance Amount');

  const rawInstallments = Array.isArray(payload.installments) ? payload.installments : [];
  if (rawInstallments.length > MAX_INSTALLMENTS) {
    throw new HttpError(400, 'VALIDATION_ERROR',
      `A deal can have at most ${MAX_INSTALLMENTS} installments.`);
  }
  const installments = rawInstallments.map((it, i) => ({
    amount: parseAmount(it?.amount, `Installment ${i + 1} amount`),
    // Confirmation is the client's to assert, but it is stored server-side so
    // it survives reload — it is never re-derived from the date, which would be
    // wrong in both directions (a payment can be recorded late or taken early).
    isCalculated: Boolean(it?.isCalculated),
    paymentDate: parseDate(it?.paymentDate, `Installment ${i + 1} payment date`),
    remarks: it?.remarks == null ? null : String(it.remarks).slice(0, 500),
  }));

  const { totalAmountPaid } = totalsFor(chosen.costToCustomer, advanceAmount, installments);
  // Measured on CONFIRMED amounts only — totalsFor already excludes planned
  // rows, so scheduling more than the property costs is allowed (a schedule can
  // legitimately be revised), while confirming more than it costs is not.
  if (totalAmountPaid > chosen.costToCustomer) {
    throw new HttpError(400, 'VALIDATION_ERROR',
      'Total paid amount cannot be greater than Total Customer Cost.');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const dealId = await deals.upsertDealForConn(conn, enquiryId, { propertyCode, advanceAmount });
    await deals.replaceInstallmentsForConn(conn, dealId, installments);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return getForLead(enquiryId);
}

module.exports = {
  DEAL_STAGE_CODE,
  MAX_INSTALLMENTS,
  getForLead,
  saveForLead,
};
