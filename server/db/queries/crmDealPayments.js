/**
 * DB layer for CRM Deal / Payment Details (migration 129).
 *
 * A deal is one row in crm_deal_payments per lead, plus up to ten rows in
 * crm_deal_installments. The Total Customer Cost is NOT stored: it is read live
 * from the inventory property the deal names, so re-pricing that property is
 * reflected the next time the deal is opened rather than leaving a frozen copy
 * behind. Total Paid and Total Pending are derived from the rows for the same
 * reason.
 *
 * Every statement is a prepared statement, per the convention in queries/crm.js.
 */

const { pool } = require('../pool');

/**
 * `costToCustomer` is written into the inventory property's dynamic-form blob
 * (inventory_properties.details -> $.dynamicData.costToCustomer) rather than a
 * column, and it is stored as a STRING ('6713800'). It is genuinely absent on
 * most properties — of the four allocated in this database, three have no value
 * — so callers must handle null rather than assuming a number.
 */
const COST_JSON_PATH = '$.dynamicData.costToCustomer';

/** Coerce the JSON string to a finite number, or null when unusable. */
function toAmount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * The inventory properties a lead may raise a deal against.
 *
 * A lead's allocation is a JSON ARRAY of property codes
 * (crm_enquiries.interested_property_ids) which can legitimately hold several,
 * and those codes are unique across the inventory / enquiry / website tables.
 * Only INVENTORY rows are returned: Cost to Customer is an inventory field, and
 * the other two surfaces must never be a source for it.
 *
 * Soft-deleted properties are excluded — a deleted property cannot price a new
 * deal — but see findDealForEnquiry, which still resolves the cost of a
 * property already recorded on a deal so an existing deal stays readable.
 */
async function listAllocatableProperties(enquiryId) {
  const [rows] = await pool.query(
    `SELECT ip.property_code,
            ip.title,
            JSON_UNQUOTE(JSON_EXTRACT(ip.details, ?)) AS cost_to_customer
       FROM crm_enquiries e
       JOIN inventory_properties ip
         ON JSON_CONTAINS(e.interested_property_ids, JSON_QUOTE(ip.property_code))
      WHERE e.id = ?
        AND ip.deleted_at IS NULL
      ORDER BY ip.property_code`,
    [COST_JSON_PATH, enquiryId],
  );
  return rows.map((r) => ({
    propertyCode: r.property_code,
    title: r.title || null,
    costToCustomer: toAmount(r.cost_to_customer),
  }));
}

/** Live Cost to Customer for one inventory property, or null when unset. */
async function costForProperty(propertyCode) {
  if (!propertyCode) return null;
  const [rows] = await pool.query(
    `SELECT JSON_UNQUOTE(JSON_EXTRACT(details, ?)) AS cost_to_customer
       FROM inventory_properties
      WHERE property_code = ?
      LIMIT 1`,
    [COST_JSON_PATH, propertyCode],
  );
  return rows.length ? toAmount(rows[0].cost_to_customer) : null;
}

/**
 * The saved deal for a lead, or null.
 *
 * Note this does NOT filter the property on deleted_at: a deal already recorded
 * against a property that was later soft-deleted must still open, show its
 * numbers and be correctable. Blocking that would strand the deal.
 */
async function findDealForEnquiry(enquiryId) {
  const [deals] = await pool.query(
    `SELECT d.id, d.enquiry_id, d.property_code, d.advance_amount,
            JSON_UNQUOTE(JSON_EXTRACT(ip.details, ?)) AS cost_to_customer,
            ip.deleted_at AS property_deleted_at
       FROM crm_deal_payments d
       LEFT JOIN inventory_properties ip ON ip.property_code = d.property_code
      WHERE d.enquiry_id = ? AND d.deleted_at IS NULL
      LIMIT 1`,
    [COST_JSON_PATH, enquiryId],
  );
  if (!deals.length) return null;
  const d = deals[0];

  const [installments] = await pool.query(
    `SELECT id, seq, amount, payment_date, remarks
       FROM crm_deal_installments
      WHERE deal_id = ?
      ORDER BY seq`,
    [d.id],
  );

  return {
    id: d.id,
    enquiryId: d.enquiry_id,
    propertyCode: d.property_code,
    // Live from the property, never a stored copy.
    totalCustomerCost: toAmount(d.cost_to_customer),
    propertyDeleted: Boolean(d.property_deleted_at),
    advanceAmount: toAmount(d.advance_amount) ?? 0,
    installments: installments.map((i) => ({
      id: i.id,
      seq: i.seq,
      amount: toAmount(i.amount) ?? 0,
      // DATE columns come back as plain 'YYYY-MM-DD' strings (db/pool.js
      // typeCast), so no timezone shifting happens on the way out.
      paymentDate: i.payment_date || null,
      remarks: i.remarks || '',
    })),
  };
}

/**
 * Create or update the deal header. Returns the deal id.
 *
 * ON DUPLICATE KEY rather than a select-then-branch: the UNIQUE key on
 * enquiry_id is what makes "one deal per lead" true, and going through it means
 * two concurrent saves cannot both insert.
 */
async function upsertDealForConn(conn, enquiryId, { propertyCode, advanceAmount }) {
  await conn.query(
    `INSERT INTO crm_deal_payments (enquiry_id, property_code, advance_amount)
          VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
          property_code = VALUES(property_code),
          advance_amount = VALUES(advance_amount),
          deleted_at = NULL`,
    [enquiryId, propertyCode, advanceAmount],
  );
  const [rows] = await conn.query(
    'SELECT id FROM crm_deal_payments WHERE enquiry_id = ? LIMIT 1', [enquiryId],
  );
  return rows[0].id;
}

/**
 * Replace the whole installment set for a deal.
 *
 * Delete-then-insert rather than a per-row diff: the client sends the complete
 * list it is showing, removals are as meaningful as edits, and the seq numbers
 * renumber when a middle row is removed. Diffing would have to reproduce that
 * renumbering exactly to avoid tripping the UNIQUE (deal_id, seq) key. Both
 * statements run on the caller's transaction, so a failure leaves the previous
 * set intact.
 */
async function replaceInstallmentsForConn(conn, dealId, installments) {
  await conn.query('DELETE FROM crm_deal_installments WHERE deal_id = ?', [dealId]);
  if (!installments || !installments.length) return 0;
  const values = installments.map((it, i) => [
    dealId, i + 1, it.amount, it.paymentDate || null, it.remarks || null,
  ]);
  await conn.query(
    `INSERT INTO crm_deal_installments (deal_id, seq, amount, payment_date, remarks)
     VALUES ?`,
    [values],
  );
  return values.length;
}

module.exports = {
  listAllocatableProperties,
  costForProperty,
  findDealForEnquiry,
  upsertDealForConn,
  replaceInstallmentsForConn,
  toAmount,
};
