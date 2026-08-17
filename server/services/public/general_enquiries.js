/**
 * Public "general enquiry" flow — the optional Contact-page form. Same
 * OTP gate as property-specific leads, but no property reference. Categories
 * (Buy / Rent / Lease) are prepended to the message field at storage time so
 * we don't need a separate schema column.
 *
 * Per CLAUDE.md the OTP delivery channel is SMTP (email). Email is REQUIRED
 * — without it we have no OTP delivery address. Mobile is captured as the
 * contact-back number the admin will dial.
 *
 * PUBLIC / ADMIN BOUNDARY (T-2026-141):
 *   This service serves the public Contact Us form. It composes only
 *   against `leads`, `notifications`, `otp_codes`, and email. It MUST
 *   NOT read or write inventory_properties / inventory_property_units.
 *   Builder Property masters and their units are ADMIN-ONLY per
 *   T-2026-136 spec sections 12 / 26 / T13-T14. See public_properties.js
 *   for the guard rules that MUST be applied if a future ticket ever
 *   exposes inventory data on the public surface.
 */

const { HttpError } = require('../../middleware/errors');
const leadsQ = require('../../db/queries/leads');
const notificationsQ = require('../../db/queries/notifications');
const otp = require('../auth/otp');
// T-2026-179: notification emails now route ONLY through the centralised
// admin-notification service. The old trySendMail(getAdminEmail()) pattern
// is removed here (still exists in transporter.js for OTP / auth / share
// flows that are out of scope). The emailTemplate helpers are no longer
// needed by this module since template rendering moved into
// adminNotifications.renderNewWebsiteEnquiry().
const adminNotifications = require('../email/adminNotifications');
const { MODULES } = require('../../constants/modules');
// T-2026-168: general enquiry (OTP-verified /verify AND captcha-only
// /submit) also creates a `leads` row -- must project into CRM the
// same way the property-specific leads.js#verify path does. Prior to
// T-168 these two paths silently missed CRM ingestion, so "Send an
// Inquiry" (ContactPage) and "Send Enquiry" (PropertyDetailPage with
// property prop) showed up in /admin/leads but never /admin/crm.
const { ingestWebsiteLeadIntoCrm } = require('./crmIngestion');

const TRANSACTION_TYPE_LABELS = {
  sale: 'Buy',
  rent: 'Rent',
  lease: 'Lease',
};

async function start({ name, mobile, email }) {
  if (!email || !String(email).trim()) {
    throw new HttpError(
      400,
      'EMAIL_REQUIRED',
      'Email is required so we can send your verification code.',
    );
  }
  const buyerEmail = String(email).trim().toLowerCase();

  const issued = await otp.issue({
    purpose: 'buyer_lead',
    channel: 'email',
    email: buyerEmail,
    mobileNumber: mobile,
    label: 'enquiry',
  });
  return {
    ok: true,
    ...(issued && issued.code && process.env.NODE_ENV !== 'production' ? { devOtpCode: issued.code } : {}),
  };
}

async function verify({ name, mobile, email, code, message, categories }) {
  if (!email || !String(email).trim()) {
    throw new HttpError(400, 'EMAIL_REQUIRED', 'Email is required to verify your code.');
  }
  const buyerEmail = String(email).trim().toLowerCase();

  await otp.verify({
    purpose: 'buyer_lead',
    channel: 'email',
    email: buyerEmail,
    code,
  });

  const cleanedMessage = composeMessage({ categories, message });
  const buyerName = name.trim();
  const buyerMobile = mobile.trim();

  const leadId = await leadsQ.create({
    websitePropertyId: null,
    actionType: 'general_enquiry',
    buyerName,
    buyerMobile,
    buyerEmail,
    message: cleanedMessage,
  });

  // T-2026-168 + T-2026-179: CRM Website ingestion hook. We now AWAIT
  // the resolver so the follow-on admin notification can carry the CRM
  // enquiry_code (business ID). The resolver already runs
  // fire-and-forget internally in the sense that a failure returns null
  // rather than throwing, so the buyer response is never blocked by it.
  const crmIngest = await ingestWebsiteLeadIntoCrm({
    leadId,
    buyerName,
    buyerMobile,
    buyerEmail,
  });

  try {
    await notificationsQ.create({
      kind: 'lead.created',
      title: `New general enquiry from ${buyerName}`,
      body: `${buyerName} (${buyerMobile}${buyerEmail ? ` / ${buyerEmail}` : ''}) submitted a general enquiry${categoriesSummary(categories) ? ` — interested in: ${categoriesSummary(categories)}` : ''}.`,
      relatedKind: 'lead',
      relatedId: leadId,
      moduleKey: MODULES.LEAD_MANAGEMENT,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[general-enquiry] notification insert failed:', err.message);
  }

  // T-2026-179: admin-only notification. sendAdminNotification loads the
  // recipient dynamically from Email Master; buyerEmail is captured only
  // for the defensive guard.
  const rendered = adminNotifications.renderNewWebsiteEnquiry({
    enquiryCode: crmIngest?.enquiry_code || null,
    source: 'website',
    enquiryTypeLabel: 'General Enquiry (Contact Us)',
    name: buyerName,
    mobile: buyerMobile,
    email: buyerEmail,
    message: composeMessage({ categories, message }) || null,
    propertyDetails: null,
    createdAt: adminNotifications.nowIstDate(),
  });
  void adminNotifications.sendAdminNotification({
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
    customerEmails: rendered.customerEmails,
  });

  return { ok: true, leadId };
}

function categoriesSummary(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  return categories.map((c) => TRANSACTION_TYPE_LABELS[c] || c).join(', ');
}

function composeMessage({ categories, message }) {
  const parts = [];
  const summary = categoriesSummary(categories);
  if (summary) parts.push(`Interested in: ${summary}`);
  const cleanedBody = (message || '').trim();
  if (cleanedBody) parts.push(cleanedBody);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * One-step submit used by the public Contact Us form. No OTP — captcha is the
 * spam gate at the route level. Property-specific lead capture flows
 * (Contact Seller / View Location on a property detail page) still go through
 * start() + verify() per CLAUDE.md.
 */
async function submit({ name, mobile, email, message, categories }) {
  const buyerEmail = email && String(email).trim()
    ? String(email).trim().toLowerCase()
    : null;
  const buyerName = name.trim();
  const buyerMobile = mobile.trim();
  const cleanedMessage = composeMessage({ categories, message });

  const leadId = await leadsQ.create({
    websitePropertyId: null,
    actionType: 'general_enquiry',
    buyerName,
    buyerMobile,
    buyerEmail,
    message: cleanedMessage,
  });

  // T-2026-168 + T-2026-179: CRM Website ingestion hook -- awaited so
  // the admin notification carries the CRM enquiry_code exactly.
  const crmIngest = await ingestWebsiteLeadIntoCrm({
    leadId,
    buyerName,
    buyerMobile,
    buyerEmail,
  });

  try {
    await notificationsQ.create({
      kind: 'lead.created',
      title: `New general enquiry from ${buyerName}`,
      body: `${buyerName} (${buyerMobile}${buyerEmail ? ` / ${buyerEmail}` : ''}) submitted a general enquiry${categoriesSummary(categories) ? ` — interested in: ${categoriesSummary(categories)}` : ''}.`,
      relatedKind: 'lead',
      relatedId: leadId,
      moduleKey: MODULES.LEAD_MANAGEMENT,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[general-enquiry] notification insert failed:', err.message);
  }

  // T-2026-179: admin-only notification (identical shape to /verify).
  const rendered = adminNotifications.renderNewWebsiteEnquiry({
    enquiryCode: crmIngest?.enquiry_code || null,
    source: 'website',
    enquiryTypeLabel: 'General Enquiry (Contact Us)',
    name: buyerName,
    mobile: buyerMobile,
    email: buyerEmail,
    message: composeMessage({ categories, message }) || null,
    propertyDetails: null,
    createdAt: adminNotifications.nowIstDate(),
  });
  void adminNotifications.sendAdminNotification({
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
    customerEmails: rendered.customerEmails,
  });

  return { ok: true, leadId };
}

module.exports = { start, verify, submit };
