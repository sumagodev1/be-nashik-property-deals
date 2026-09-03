/**
 * The dataset behind the three CRM-backed report sections under /admin/reports:
 * Sold Property Reports, Financial Reports and Marketing Report.
 *
 * READ-ONLY. This module SELECTs, resolves labels and derives nothing that is
 * not already derived somewhere else. It creates no data, stores no copy of the
 * CRM taxonomy and owns no calculation of its own - every number and every
 * label below comes from the module that already owns it:
 *
 *   Total Paid / Total Pending  -> dealPayments.totalsFor   (the ONE rule; a
 *                                  planned installment does not count)
 *   Cost to Customer            -> crmDealPayments.COST_JSON_PATH + toAmount
 *   Name / Mobile / Email mask  -> parents.maskName/Mobile/Email
 *   District / Taluka / Village -> locationLabels.attachLocationNames
 *   Lead Stage/Status/Rating    -> masters.listAll on the live master keys
 *   Which leads exist at all    -> the join topology + orphan guard copied
 *                                  from listEnquiries
 *
 * If a figure here ever disagrees with the CRM screen, that is a bug in this
 * file, not a difference of opinion - the report has no opinions.
 *
 * WHY THE WHOLE DATASET IN ONE RESPONSE
 *   The reports filter, chart and tabulate the same rows, and the filter
 *   dropdowns narrow themselves to the values actually present in the current
 *   result. All of that needs the full set, not a page of it. This mirrors the
 *   existing General Report, which likewise walks its sources to exhaustion
 *   client-side before charting. The route's MAX_ROWS becomes a SQL LIMIT on
 *   the lead query, and every other query here is anchored to the ids that
 *   returned - so the cap bounds what the DATABASE reads, not just what is
 *   serialised back.
 *
 * THE THREE CRM MASTERS ARE STILL INDEPENDENT
 *   Nothing here relates Lead Stage to Lead Status to Lead Rating. There is no
 *   combination table and no parent_code between them - per the CRM 3-separate-
 *   masters decision. The report UI narrows those three dropdowns by what the
 *   currently filtered rows actually contain, which is a property of the DATA,
 *   not a taxonomy, and needs no schema to express.
 */

const query = require('../../db/queries/crmLeadReports');
const { toAmount } = require('../../db/queries/crmDealPayments');
const {
  totalsFor, dealSubjectFor, DEAL_STAGE_CODE, MAX_INSTALLMENTS,
} = require('./dealPayments');
const { nowIstSql } = require('./followUpReminders');
const { maskName, maskMobile, maskEmail } = require('./parents');
const { attachLocationNames } = require('../locationLabels');
const masters = require('../masters/management');

/**
 * Master keys whose labels this report resolves.
 *
 * Inventory and enquiry properties already carry denormalised *_name columns
 * (property_type_name / transaction_type_name / property_variety_name), so
 * they need no lookup - their labels come straight off the row. Only WEBSITE
 * properties store a bare code, and only those two vocabularies are looked up
 * here. There is deliberately no `property_type` master key in master_lookups
 * (verified) - inventory/enquiry types come from the property form catalog,
 * which is exactly why the denormalised name column exists.
 */
const WEBSITE_TYPE_KEYS = Object.freeze(['website_property_type', 'website_transaction_type']);
const CRM_TAXONOMY_KEYS = Object.freeze(['crm_lead_stage', 'crm_lead_status', 'crm_lead_rating']);

/** The live master rows for one key, or [] when the lookup fails. */
async function masterRows(key) {
  try {
    // Unfiltered by is_active on purpose: a lead sitting on a since-deactivated
    // value must still report its label rather than a raw code. Deactivating a
    // master removes it from "pick a new one" lists; it does not rewrite
    // history.
    const { data } = await masters.listAll(key, {});
    return data || [];
  } catch {
    return [];
  }
}

/** code -> label, for resolving what a lead holds. */
const labelMapOf = (rows) => Object.fromEntries(rows.map((m) => [m.code, m.label]));

/**
 * Every master this report touches, loaded once.
 *
 * The CRM three are returned as OPTION LISTS as well as label maps. A report
 * filter has to offer every configured value, not only the ones some lead
 * happens to hold today: a freshly added stage has no leads by definition, so
 * a list derived from the rows could never show it. Deriving the dropdowns
 * from the rows is exactly why Lead Rating offered one value out of four.
 *
 * Inactive rows are excluded from the OPTIONS - "choose a new one" lists are
 * what is_active governs - while the label maps keep them, so a lead sitting on
 * a deactivated value still renders its label.
 */
async function loadMasters() {
  const keys = [...WEBSITE_TYPE_KEYS, ...CRM_TAXONOMY_KEYS];
  const entries = await Promise.all(keys.map(async (k) => [k, await masterRows(k)]));
  const rowsByKey = Object.fromEntries(entries);
  const maps = Object.fromEntries(
    Object.entries(rowsByKey).map(([k, rows]) => [k, labelMapOf(rows)]),
  );
  const options = Object.fromEntries(CRM_TAXONOMY_KEYS.map((k) => [k, rowsByKey[k]
    .filter((m) => m.is_active !== 0 && m.is_active !== false)
    .map((m) => ({ code: m.code, label: m.label }))]));
  return { maps, options };
}

/** A label if one resolves, else the raw code, else null. Never an invention. */
const labelOr = (map, code) => (code ? (map[code] || code) : null);

/** The identity fields, masked exactly as the CRM list masks them. */
function identityFor(row) {
  let name = '';
  let mobile = '';
  let email = '';
  if (row.source_type === 'website') {
    name = row.live_website_name || '';
    mobile = row.live_website_mobile || '';
    email = row.live_website_email || '';
  } else if (row.source_type === 'npd') {
    name = row.live_npd_owner_name || '';
    mobile = row.live_npd_owner_contact || '';
    email = row.live_npd_owner_email || '';
  }
  // Same fallback as enquiryDto: an identity-less source row still gets the
  // parent's placeholder label ("Enquiry #19") rather than reading as blank.
  const displayName = name || (row.parent_full_name && !mobile && !email ? row.parent_full_name : '');
  return {
    customerName: maskName(displayName) || null,
    mobile: maskMobile(mobile) || null,
    email: maskEmail(email) || null,
  };
}

/**
 * The property context of a lead: ONE property, chosen by specificity.
 *
 *   deal       - the lead has a deal, so the priced property is the subject.
 *   allocation - no deal, but inventory has been allocated to the lead.
 *   enquiry    - neither, so the listing the enquiry originally came from.
 *
 * One property per lead is what makes a report row mean something: a lead
 * counted once under "Flat" and again under "Plot" would inflate every chart
 * and every total. The full allocation list stays available separately on
 * `inventoryProperties`, which is what the Marketing report's Inventory
 * Property filter matches against - so narrowing to one context here does not
 * lose a lead that is interested in several properties.
 *
 * A lead with several allocations and no deal has no single subject, so the
 * first by property code is used and `ambiguous` marks it. That is reported
 * rather than hidden.
 */
function propertyContextFor(row, allocations, deal, maps) {
  if (deal) {
    return {
      origin: 'deal',
      ambiguous: false,
      code: deal.property_code || null,
      title: deal.property_title || null,
      propertyType: deal.property_type || null,
      propertyTypeLabel: deal.property_type_name || deal.property_type || null,
      transactionType: deal.transaction_type || null,
      transactionTypeLabel: deal.transaction_type_name || deal.transaction_type || null,
      propertyVariety: deal.transaction_variant || null,
      propertyVarietyLabel: deal.property_variety_name || deal.transaction_variant || null,
      district: deal.district || null,
      taluka: deal.taluka || null,
      shivar: deal.shivar || null,
    };
  }
  if (allocations.length) {
    const a = allocations[0];
    return {
      origin: 'allocation',
      ambiguous: allocations.length > 1,
      code: a.property_code || null,
      title: a.title || null,
      propertyType: a.property_type || null,
      propertyTypeLabel: a.property_type_name || a.property_type || null,
      transactionType: a.transaction_type || null,
      transactionTypeLabel: a.transaction_type_name || a.transaction_type || null,
      propertyVariety: a.transaction_variant || null,
      propertyVarietyLabel: a.property_variety_name || a.transaction_variant || null,
      district: a.district || null,
      taluka: a.taluka || null,
      shivar: a.shivar || null,
    };
  }
  if (row.source_type === 'website') {
    return {
      origin: 'enquiry',
      ambiguous: false,
      code: row.wp_property_code || null,
      title: row.wp_title || null,
      propertyType: row.wp_property_type || null,
      propertyTypeLabel: labelOr(maps.website_property_type, row.wp_property_type),
      transactionType: row.wp_transaction_type || null,
      transactionTypeLabel: labelOr(maps.website_transaction_type, row.wp_transaction_type),
      // website_properties has no variety column. Null, not a guess.
      propertyVariety: null,
      propertyVarietyLabel: null,
      district: row.wp_district || null,
      taluka: row.wp_taluka || null,
      shivar: row.wp_shivar || null,
    };
  }
  return {
    origin: 'enquiry',
    ambiguous: false,
    code: row.ep_property_code || null,
    title: row.ep_title || null,
    propertyType: row.ep_property_type || null,
    propertyTypeLabel: row.ep_property_type_name || row.ep_property_type || null,
    transactionType: row.ep_transaction_type || null,
    transactionTypeLabel: row.ep_transaction_type_name || row.ep_transaction_type || null,
    propertyVariety: row.ep_transaction_variant || null,
    propertyVarietyLabel: row.ep_property_variety || row.ep_transaction_variant || null,
    district: row.ep_district || null,
    taluka: row.ep_taluka || null,
    shivar: row.ep_shivar || null,
  };
}

/** Group rows by a numeric key into a Map of arrays, preserving order. */
function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    const k = Number(r[key]);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

/**
 * The whole report dataset.
 *
 * `maxRows` truncates rather than paginating: a truncated report is a wrong
 * report, so the caller is told (`truncated: true`) instead of being handed a
 * quietly partial set to chart. The limit reaches the database - see
 * listLeadRows - rather than trimming a full read after the fact.
 */
async function list({
  maxRows = 5000, search = '', leadStage = '', leadStatus = '', leadRating = '',
} = {}) {
  const now = nowIstSql();

  // Two round trips, not one: the page of leads has to be known before the
  // allocations, deals and follow-ups can be fetched FOR that page. Fetching
  // all four in parallel meant reading three whole tables and discarding most
  // of them, and it left the allocation join with nothing to anchor on.
  // One extra row is requested so "there are more" can be answered without a
  // second COUNT.
  const [pagePlusOne, { maps, options }] = await Promise.all([
    query.listLeadRows(maxRows + 1, { search, leadStage, leadStatus, leadRating }),
    loadMasters(),
  ]);
  const truncated = pagePlusOne.length > maxRows;
  const leadRows = truncated ? pagePlusOne.slice(0, maxRows) : pagePlusOne;
  const enquiryIds = leadRows.map((r) => r.id);

  const [allocRows, dealData, followUps] = await Promise.all([
    query.listAllocationRows(enquiryIds),
    query.listDealRows(enquiryIds),
    query.nextFollowUpRows(now, enquiryIds),
  ]);

  const allocByEnquiry = groupBy(allocRows, 'enquiry_id');
  const dealByEnquiry = new Map(dealData.deals.map((d) => [Number(d.enquiry_id), d]));
  const instByDeal = groupBy(dealData.installments, 'deal_id');
  const followUpByEnquiry = new Map(
    followUps.map((f) => [Number(f.enquiry_id), f.next_scheduled_at]),
  );

  const assembled = leadRows.map((row) => {
    const allocations = allocByEnquiry.get(Number(row.id)) || [];
    const dealRow = dealByEnquiry.get(Number(row.id)) || null;

    // `deal` is ALWAYS an object, never null; `hasDeal` says whether a payment
    // record has been saved. A lead sitting at the Deal stage before anyone
    // opened its payment details still has a subject and a price - CRM's own
    // getForLead resolves them from the single allocation - so reporting
    // nothing for such a lead would disagree with the screen it reports on.
    const deal = (() => {
      const installments = (instByDeal.get(Number(dealRow?.id)) || []).map((i) => ({
        id: i.id,
        seq: i.seq,
        amount: toAmount(i.amount) ?? 0,
        // Whether the operator confirmed this one through "Calculate Amount".
        // A planned installment carries an amount and a date but no money has
        // changed hands, and totalsFor below is what enforces that.
        isCalculated: Boolean(i.is_calculated),
        // DATE columns arrive as plain 'YYYY-MM-DD' (db/pool.js typeCast), so
        // no timezone shifting happens on the way out.
        paymentDate: i.payment_date || null,
        remarks: i.remarks || '',
      }));
      // Which property, and what it costs - resolved through the Deal
      // section's own rule so a lead with no saved deal reports the same
      // subject and price CRM would show for it.
      const subject = dealSubjectFor(
        allocations.map((a) => ({
          propertyCode: a.property_code,
          costToCustomer: toAmount(a.cost_to_customer),
        })),
        dealRow && {
          propertyCode: dealRow.property_code,
          // Live from the property, never a stored copy - the same rule as the
          // Deal section, so re-pricing a property moves the report too.
          totalCustomerCost: toAmount(dealRow.cost_to_customer),
        },
      );
      const advanceAmount = toAmount(dealRow?.advance_amount) ?? 0;
      const fromAllocation = allocations.find((a) => a.property_code === subject.propertyCode);
      return {
        hasDeal: Boolean(dealRow),
        propertyCode: subject.propertyCode || null,
        propertyTitle: dealRow
          ? (dealRow.property_title || null)
          : (fromAllocation?.title || null),
        propertyDeleted: Boolean(dealRow?.property_deleted_at),
        totalCustomerCost: subject.totalCustomerCost,
        advanceAmount,
        installments,
        installmentCount: installments.length,
        // The one rule, imported. Not re-implemented here.
        ...totalsFor(subject.totalCustomerCost, advanceAmount, installments),
      };
    })();

    return {
      enquiryId: row.id,
      enquiryCode: row.enquiry_code,
      sourceType: row.source_type,
      ...identityFor(row),
      createdAt: row.created_at,
      // The CRM listing prints this beside the lead chips, so the report can
      // show the same "last changed" moment without a second lookup.
      updatedAt: row.updated_at,
      nextFollowUpAt: followUpByEnquiry.get(Number(row.id)) || null,
      leadStageCode: row.lead_stage_code || null,
      leadStageLabel: labelOr(maps.crm_lead_stage, row.lead_stage_code),
      leadStatusCode: row.lead_status_code || null,
      leadStatusLabel: labelOr(maps.crm_lead_status, row.lead_status_code),
      leadRatingCode: row.lead_rating_code || null,
      leadRatingLabel: labelOr(maps.crm_lead_rating, row.lead_rating_code),
      property: propertyContextFor(row, allocations, dealRow, maps),
      inventoryProperties: allocations.map((a) => ({
        code: a.property_code,
        title: a.title || null,
        costToCustomer: toAmount(a.cost_to_customer),
      })),
      deal,
    };
  });

  // Location labels resolved in ONE batched pass over every row's property
  // context, through the same resolver the other report surfaces use.
  // attachLocationNames reads district/taluka/shivar off the row it is given,
  // so it is fed the property contexts and the names are folded back.
  const withNames = await attachLocationNames(
    assembled.map((r) => r.property),
    (p) => p,
  );
  const rows = assembled.map((r, i) => ({
    ...r,
    property: {
      ...r.property,
      districtLabel: withNames[i].districtName,
      talukaLabel: withNames[i].talukaName,
      shivarLabel: withNames[i].shivarName,
    },
  }));

  return {
    rows,
    total: rows.length,
    truncated,
    // Echoed so the client never hardcodes a value the server owns: the stage
    // code it filters on, and the installment cap the detail view prints as
    // "N of 10".
    dealStageCode: DEAL_STAGE_CODE,
    maxInstallments: MAX_INSTALLMENTS,
    // Every ACTIVE value each CRM master offers, so a report's filters can list
    // what is configured rather than what happens to be in use. Shipped with
    // the rows so the client needs no second request - and no CRM_MANAGEMENT
    // grant, which /admin/crm/lead-stages would have required.
    masters: {
      leadStage: options.crm_lead_stage,
      leadStatus: options.crm_lead_status,
      leadRating: options.crm_lead_rating,
    },
    generatedAt: now,
  };
}

module.exports = { list };
