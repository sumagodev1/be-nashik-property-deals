/**
 * Read-only query layer for the three CRM-backed report sections
 * (Sold Property / Financial / Marketing) under /admin/reports.
 *
 * THERE IS NOTHING BUT SELECT IN THIS FILE.
 * A report never writes. No INSERT, UPDATE or DELETE appears below, and none
 * should be added - the CRM screens remain the only place any of this data is
 * created or changed.
 *
 * WHY A DEDICATED QUERY RATHER THAN REUSING listEnquiries
 *   listEnquiries pages by PARENT and caps a page at 200, because the CRM list
 *   renders one row per customer. A report needs every lead in one pass, and it
 *   needs the property attributes (type / transaction / variety / district /
 *   taluka / village) that the CRM list has no column for. Paging that list to
 *   exhaustion and then issuing a per-row property lookup would be the same
 *   data, fetched N times, in an order the report does not want.
 *
 *   What IS reused verbatim is the part that decides WHICH leads exist: the
 *   join topology and the orphan guard below are copied from listEnquiries so
 *   the reports describe exactly the set of leads the CRM page shows. If a
 *   lead's source row has been soft-deleted, CRM hides that lead and so does
 *   this.
 *
 * WHERE A LEAD'S PROPERTY ATTRIBUTES COME FROM
 *   A lead has up to three property contexts, in increasing specificity:
 *     1. the SOURCE property - the website/NPD listing the enquiry came from,
 *     2. the ALLOCATED inventory properties - interested_property_ids,
 *     3. the DEAL property - the one allocated property the deal is priced on.
 *   They are fetched separately here and resolved into a single property
 *   context per lead in services/crm/leadReports.js, which is where that
 *   decision is documented. Keeping them separate in SQL means the Marketing
 *   report can still filter on the whole allocation list even when a deal has
 *   narrowed the lead to one property.
 */

const { pool } = require('../pool');
const { COST_JSON_PATH } = require('./crmDealPayments');

/**
 * Copied from listEnquiries (db/queries/crm.js). Same joins, same aliases.
 *
 * If that topology ever changes, this must change with it - the two are
 * required to agree on which leads exist, and a report that lists a lead the
 * CRM page hides (or vice versa) is worse than no report at all.
 */
const FROM_JOINS = `
       FROM crm_enquiries e
       JOIN crm_parents p ON p.id = e.parent_id
       LEFT JOIN leads l
         ON e.source_type = 'website'
        AND l.id = e.source_id
        AND l.deleted_at IS NULL
       LEFT JOIN website_properties wp
         ON wp.id = l.website_property_id
        AND wp.deleted_at IS NULL
       LEFT JOIN enquiry_properties ep
         ON e.source_type = 'npd'
        AND ep.id = e.source_id
        AND ep.deleted_at IS NULL`;

/** The orphan guard, verbatim from listEnquiries. */
const ORPHAN_GUARD = `(
    (e.source_type = 'website' AND l.id IS NOT NULL) OR
    (e.source_type = 'npd'     AND ep.id IS NOT NULL)
  )`;

/**
 * One page of leads, with their identity columns and their SOURCE property's
 * attributes.
 *
 * LIMIT is applied HERE rather than by slicing the result in the service. The
 * cap exists to stop this becoming an unbounded read as the CRM grows, and a
 * cap enforced after MySQL has sorted and returned every row - and after Node
 * has materialised them - does not do that.
 *
 * The identity projection (live_website_* / live_npd_*) is copied from
 * listEnquiries including the JSON-first COALESCE for NPD contacts, so a lead
 * reads the same here as it does in CRM. Masking is applied in the service
 * layer through services/crm/parents.js - the same masking the CRM list uses.
 *
 * website_properties has no property-variety column (verified against the
 * table), so a website-sourced lead reports a null variety rather than an
 * invented one.
 */
/**
 * The search clause, copied from listEnquiries so the report's Global Search
 * finds exactly what the CRM listing's search finds.
 *
 * It has to run in SQL: the report DTO masks name, mobile and email
 * (parents.js), so "Vinayak" matches nothing once the rows reach the client -
 * verified: 0 rows client-side, against the 1 the CRM search returns. Only the
 * database holds the values a person actually types.
 *
 * interested_property_ids is matched as raw JSON text, which the CRM list does
 * client-side over its current page instead. Doing it here means a Property ID
 * search finds a lead on page 4 too.
 */
const SEARCH_SQL = `(
      e.enquiry_code LIKE ?
      OR l.buyer_name LIKE ? OR l.buyer_mobile LIKE ? OR l.buyer_email LIKE ?
      OR ep.owner_name LIKE ? OR ep.owner_contact LIKE ?
      OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].name')) LIKE ?
      OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].mobiles[0]')) LIKE ?
      OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]')) LIKE ?
      OR ep.property_code LIKE ?
      OR wp.property_code LIKE ?
      OR e.interested_property_ids LIKE ?
    )`;
/** How many placeholders SEARCH_SQL binds. */
const SEARCH_PARAMS = 12;

async function listLeadRows(limit, search = '') {
  const term = String(search || '').trim();
  const searchClause = term ? ` AND ${SEARCH_SQL}` : '';
  const searchArgs = term ? Array(SEARCH_PARAMS).fill(`%${term}%`) : [];
  const [rows] = await pool.query(
    `SELECT
            e.id, e.parent_id, e.enquiry_code, e.source_type, e.source_id,
            e.status_code,
            e.lead_stage_code, e.lead_status_code, e.lead_rating_code,
            e.interested_property_ids, e.created_at, e.updated_at,
            p.full_name         AS parent_full_name,

            l.buyer_name        AS live_website_name,
            l.buyer_mobile      AS live_website_mobile,
            l.buyer_email       AS live_website_email,

            wp.property_code    AS wp_property_code,
            wp.title            AS wp_title,
            wp.property_type    AS wp_property_type,
            wp.transaction_type AS wp_transaction_type,
            wp.district         AS wp_district,
            wp.taluka           AS wp_taluka,
            wp.shivar           AS wp_shivar,

            COALESCE(
              NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].name')), ''), 'null'),
              ep.owner_name
            )                   AS live_npd_owner_name,
            COALESCE(
              NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].mobiles[0]')), ''), 'null'),
              ep.owner_contact
            )                   AS live_npd_owner_contact,
            NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]')), ''), 'null')
                                AS live_npd_owner_email,

            ep.property_code         AS ep_property_code,
            ep.title                 AS ep_title,
            ep.property_type         AS ep_property_type,
            ep.property_type_name    AS ep_property_type_name,
            ep.transaction_type      AS ep_transaction_type,
            ep.transaction_type_name AS ep_transaction_type_name,
            ep.transaction_variant   AS ep_transaction_variant,
            ep.property_variety_name AS ep_property_variety,
            ep.district              AS ep_district,
            ep.taluka                AS ep_taluka,
            ep.shivar                AS ep_shivar
       ${FROM_JOINS}
      WHERE ${ORPHAN_GUARD}${searchClause}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?`,
    [...searchArgs, limit],
  );
  return rows;
}

/**
 * Allocated inventory properties for the given leads, one row per (lead,
 * property).
 *
 * Only INVENTORY rows, matching listAllocatableProperties in
 * queries/crmDealPayments.js: Cost to Customer is an inventory field and the
 * other two surfaces must never be a source for it.
 *
 * ANCHORED ON enquiryIds, and that is not merely a filter. JSON_CONTAINS gives
 * the optimiser no equality predicate to index, so without a bound on `e` this
 * evaluates once per (enquiry x property) pair across both whole tables.
 * listAllocatableProperties gets away with the same construct because it is
 * anchored by `WHERE e.id = ?`; an earlier version of this function dropped
 * that anchor and inherited the full cross product.
 */
async function listAllocationRows(enquiryIds) {
  if (!enquiryIds.length) return [];
  const [rows] = await pool.query(
    `SELECT e.id AS enquiry_id,
            ip.property_code,
            ip.title,
            ip.property_type,
            ip.property_type_name,
            ip.transaction_type,
            ip.transaction_type_name,
            ip.transaction_variant,
            ip.property_variety_name,
            ip.district, ip.taluka, ip.shivar,
            JSON_UNQUOTE(JSON_EXTRACT(ip.details, ?)) AS cost_to_customer
       FROM crm_enquiries e
       JOIN inventory_properties ip
         ON JSON_CONTAINS(e.interested_property_ids, JSON_QUOTE(ip.property_code))
      WHERE e.id IN (${enquiryIds.map(() => '?').join(',')})
        AND ip.deleted_at IS NULL
      ORDER BY e.id, ip.property_code`,
    [COST_JSON_PATH, ...enquiryIds],
  );
  return rows;
}

/**
 * Every saved deal with its priced property, plus its installments.
 *
 * Mirrors findDealForEnquiry: the property is LEFT JOINed WITHOUT a deleted_at
 * filter, because a deal recorded against a since-deleted property must still
 * report its numbers rather than drop out of the financial totals.
 */
async function listDealRows(enquiryIds) {
  if (!enquiryIds.length) return { deals: [], installments: [] };
  const [deals] = await pool.query(
    `SELECT d.id, d.enquiry_id, d.property_code, d.advance_amount,
            ip.title                 AS property_title,
            ip.property_type,
            ip.property_type_name,
            ip.transaction_type,
            ip.transaction_type_name,
            ip.transaction_variant,
            ip.property_variety_name,
            ip.district, ip.taluka, ip.shivar,
            ip.deleted_at            AS property_deleted_at,
            JSON_UNQUOTE(JSON_EXTRACT(ip.details, ?)) AS cost_to_customer
       FROM crm_deal_payments d
       LEFT JOIN inventory_properties ip ON ip.property_code = d.property_code
      WHERE d.enquiry_id IN (${enquiryIds.map(() => '?').join(',')})
        AND d.deleted_at IS NULL`,
    [COST_JSON_PATH, ...enquiryIds],
  );
  if (!deals.length) return { deals, installments: [] };

  const [installments] = await pool.query(
    `SELECT deal_id, id, seq, amount, is_calculated, payment_date, remarks
       FROM crm_deal_installments
      WHERE deal_id IN (${deals.map(() => '?').join(',')})
      ORDER BY deal_id, seq`,
    deals.map((d) => d.id),
  );
  return { deals, installments };
}

/**
 * The next upcoming scheduled meeting per lead.
 *
 * Same definition of "a genuinely scheduled meeting" as the CRM reminder cards
 * (services/crm/followUpReminders.js): a real Google Calendar event that has
 * not been cancelled. `nowIst` is IST wall-clock because scheduled_at is too -
 * see the comment on nowIstSql, which this caller reuses rather than forming a
 * second opinion about what "now" means.
 */
async function nextFollowUpRows(nowIst, enquiryIds) {
  if (!enquiryIds.length) return [];
  const [rows] = await pool.query(
    `SELECT a.enquiry_id, MIN(a.scheduled_at) AS next_scheduled_at
       FROM crm_calendar_activities a
      WHERE a.enquiry_id IN (${enquiryIds.map(() => '?').join(',')})
        AND a.google_event_id IS NOT NULL
        AND a.booking_status = 'active'
        AND a.scheduled_at >= ?
      GROUP BY a.enquiry_id`,
    [...enquiryIds, nowIst],
  );
  return rows;
}

module.exports = {
  listLeadRows,
  listAllocationRows,
  listDealRows,
  nextFollowUpRows,
};
