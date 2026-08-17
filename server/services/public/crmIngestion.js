/**
 * T-2026-168: Shared post-lead-insert CRM ingestion helper for every
 * PUBLIC buyer-facing enquiry surface.
 *
 * Why this exists
 * ---------------
 * T-2026-156 originally attached the CRM ingestion hook to a single
 * code path -- services/public/leads.js#verify (the OTP-verified
 * property-specific buyer flow used by "Contact Seller" / "View
 * Location"). That fixed the Website Buyer Enquiry -> CRM ingestion
 * for those two buttons.
 *
 * But there are TWO other public leads-insert paths that never had
 * the hook:
 *
 *   (1) services/public/general_enquiries.js#verify -- OTP-verified
 *       general enquiry from the standalone Contact page and from
 *       the "Send Enquiry" section of PropertyDetailPage when a
 *       property object is passed to EnquiryForm.
 *   (2) services/public/general_enquiries.js#submit -- captcha-gated,
 *       no-OTP path used by the public ContactPage's "Send an
 *       Inquiry" form when the visitor is not on a property detail
 *       page.
 *
 * Both wrote a `leads` row (visible in /admin/leads) but never called
 * duplicateResolver.ingest -- so those enquiries silently disappeared
 * from /admin/crm. This helper centralises the hook so any future
 * public buyer-lead entry point can call one function and cannot
 * accidentally miss the CRM projection.
 *
 * Contract
 * --------
 *   ingestWebsiteLeadIntoCrm({ leadId, buyerName, buyerMobile, buyerEmail })
 *     -> Promise<void>  (best-effort; never throws)
 *
 * The call is fire-and-forget: a resolver failure is logged (lead_id
 * only -- no PII) and swallowed. CRM ingestion MUST NEVER block the
 * buyer's response path -- the buyer flow is the customer-facing
 * surface and the CRM is a downstream projection.
 *
 * The payload is the exact shape T-156 established at the leads.js
 * hook so the duplicate resolver's identity dedup + parent linking
 * logic is byte-identical for every website-source lead regardless of
 * which buyer button triggered it.
 */

const crmResolver = require('../crm/duplicateResolver');

async function ingestWebsiteLeadIntoCrm({ leadId, buyerName, buyerMobile, buyerEmail }) {
  // T-2026-179: return the resolver's outcome so callers can chain an
  // admin notification whose Enquiry ID column matches the CRM row
  // exactly (spec §C.1 CRITICAL: "the enquiry ID in the email = the
  // exact same ID stored in CRM"). Still fire-and-forget: a resolver
  // failure resolves to `null` so the caller falls back gracefully.
  try {
    const result = await crmResolver.ingest({
      full_name:   buyerName || null,
      mobile:      buyerMobile || null,
      email:       buyerEmail || null,
      source_type: 'website',
      source_id:   leadId,
      status_code: 'new',
    });
    return result || null;
  } catch (err) {
    // PII-safe log: only lead_id + err.message (never buyer name / mobile /
    // email). Matches the T-156 hook's warn format.
    // eslint-disable-next-line no-console
    console.warn(
      '[crm-ingest][website-lead] non-fatal:',
      { lead_id: leadId, reason: err && err.message },
    );
    return null;
  }
}

module.exports = { ingestWebsiteLeadIntoCrm };
