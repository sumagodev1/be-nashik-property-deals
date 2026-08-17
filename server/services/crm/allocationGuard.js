/**
 * Shared "is this property still allocated to a lead?" delete guard.
 *
 * WHY THIS IS SHARED: crm_enquiries.interested_property_ids can now reference
 * a property in ANY of the three property tables (inventory, enquiry,
 * website), because it stores globally-unique property CODES rather than
 * table-scoped row ids. So all three delete paths need the identical check.
 *
 * Before codes, only inventory properties could be allocated, so only
 * services/inventory/management.js had a guard. services/enquiry/management.js
 * and services/website_property/management.js had NONE -- which was fine while
 * they could not be allocated, and becomes a data-integrity hole the moment
 * they can. Deleting an allocated property without this check leaves the CRM
 * pointing at a property that no longer exists.
 *
 * Kept as its own tiny module rather than living in one of the three
 * management services, so no property surface has to import another
 * property surface just to borrow a guard.
 */

const { HttpError } = require('../../middleware/errors');
const crmQueries = require('../../db/queries/crm');

/**
 * Throw 409 PROPERTY_ASSIGNED_TO_ENQUIRY when `propertyCode` is still listed
 * in any CRM enquiry's allocation array. No-op when it is unallocated.
 *
 * Fails CLOSED on a blank code: if the caller could not supply a code we
 * cannot prove the property is unallocated, and silently permitting the
 * delete is the failure mode this guard exists to prevent.
 *
 * @param {string} propertyCode  the property's business code
 * @param {string} [label]       surface name for the error text
 */
async function assertNotAllocatedToAnyLead(propertyCode, label = 'property') {
  const code = String(propertyCode == null ? '' : propertyCode).trim();
  if (!code) {
    throw new HttpError(
      500,
      'PROPERTY_CODE_MISSING',
      `Cannot verify lead allocations for this ${label}: it has no property code.`,
    );
  }

  const linked = await crmQueries.listEnquiriesReferencingPropertyCode(code);
  if (linked.length === 0) return;

  const codes = linked.map((e) => e.enquiry_code).filter(Boolean);
  const shown = codes.slice(0, 5).join(', ');
  const more = codes.length > 5 ? ` and ${codes.length - 5} more` : '';
  throw new HttpError(
    409,
    'PROPERTY_ASSIGNED_TO_ENQUIRY',
    `${code} is assigned to ${codes.length} CRM ${codes.length === 1 ? 'enquiry' : 'enquiries'} (${shown}${more}). Remove it from ${codes.length === 1 ? 'that enquiry' : 'those enquiries'} before deleting the property.`,
  );
}

module.exports = { assertNotAllocatedToAnyLead };
