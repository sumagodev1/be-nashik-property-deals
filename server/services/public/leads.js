const { HttpError } = require('../../middleware/errors');
const publicProps = require('../../db/queries/public_properties');
const leadsQ = require('../../db/queries/leads');
const notificationsQ = require('../../db/queries/notifications');
const otp = require('../auth/otp');
// T-2026-179: notification emails route ONLY through the centralised
// admin-notification service. Old trySendMail(getAdminEmail()) removed.
const adminNotifications = require('../email/adminNotifications');
const { MODULES } = require('../../constants/modules');
// T-2026-156 (corrective for T-2026-151 Phase 1): the CRM Website
// ingestion hook lives HERE, on the OTP-verified buyer-enquiry POST
// (not on Website Property create -- see the removal comment in
// services/website_property/management.js). Best-effort: a resolver
// failure is logged but never blocks the buyer-side lead capture.
//
// T-2026-168: hook extracted into services/public/crmIngestion.js so
// every public buyer-lead surface (Contact Seller / View Location /
// Send Enquiry on property / Send an Inquiry on Contact page) uses
// the SAME call. Prior to T-168 only this leads.js#verify path
// ingested; the general_enquiries.js paths silently missed.
const { ingestWebsiteLeadIntoCrm } = require('./crmIngestion');

const ACTION_LABELS = {
  contact_seller: 'Contact Seller',
  view_location: 'View Location',
};

/**
 * Step 1: validate property exists and is publicly visible, then issue an
 * EMAIL OTP to the buyer. Per CLAUDE.md the OTP channel is SMTP (email);
 * mobile stays the contact-back number the seller/admin will dial.
 *
 * Email is REQUIRED — without it we have no OTP delivery address.
 */
async function start({ propertyId, name, mobile, email }) {
  const prop = await publicProps.findActiveById(propertyId);
  if (!prop) throw new HttpError(404, 'PROPERTY_UNAVAILABLE', 'This property is no longer available.');

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
    property: { id: prop.id, code: prop.property_code, title: prop.title },
    ...(issued && issued.code && process.env.NODE_ENV !== 'production' ? { devOtpCode: issued.code } : {}),
  };
}

async function verify({ propertyId, actionType, name, mobile, email, code, message }) {
  const prop = await publicProps.findActiveById(propertyId);
  if (!prop) throw new HttpError(404, 'PROPERTY_UNAVAILABLE', 'This property is no longer available.');

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

  return record({
    prop,
    propertyId,
    actionType,
    buyerName: name.trim(),
    buyerMobile: mobile.trim(),
    buyerEmail,
    message,
  });
}

/**
 * One-step capture — no OTP. The website's Contact Seller / View Location
 * forms post straight here: the visitor fills the form once and the lead is
 * in Leads immediately. The captcha at the route is the spam gate, matching
 * the public Contact Us form (general_enquiries.submit).
 *
 * start() + verify() are deliberately left in place, so the OTP gate can be
 * switched back on from the frontend without a backend change.
 */
async function submit({ propertyId, actionType, name, mobile, email, message }) {
  const prop = await publicProps.findActiveById(propertyId);
  if (!prop) throw new HttpError(404, 'PROPERTY_UNAVAILABLE', 'This property is no longer available.');

  // No code to deliver any more, so email is optional here — the mobile
  // number is enough to reply on. Still normalised when one is given, so a
  // buyer who types "Rohini@Gmail.Com" is stored the same as everyone else.
  const buyerEmail = email && String(email).trim()
    ? String(email).trim().toLowerCase()
    : null;

  return record({
    prop,
    propertyId,
    actionType,
    buyerName: name.trim(),
    buyerMobile: mobile.trim(),
    buyerEmail,
    message,
  });
}

/**
 * Everything an accepted enquiry does once the buyer's details are known:
 * create the lead, push it into the CRM, raise the in-app notification and
 * send the admin email. Shared by verify() and submit() so the OTP and
 * no-OTP paths can never drift apart.
 */
async function record({ prop, propertyId, actionType, buyerName, buyerMobile, buyerEmail, message }) {
  const leadId = await leadsQ.create({
    websitePropertyId: propertyId,
    actionType,
    buyerName,
    buyerMobile,
    buyerEmail,
    message,
  });

  // T-2026-156 + T-2026-168 + T-2026-179: CRM Website ingestion hook.
  // Now AWAITED so the admin notification can carry the CRM
  // enquiry_code (business ID). Resolver failure returns null; the
  // buyer response is never blocked.
  const crmIngest = await ingestWebsiteLeadIntoCrm({
    leadId,
    buyerName,
    buyerMobile,
    buyerEmail,
  });

  try {
    await notificationsQ.create({
      kind: 'lead.created',
      title: `New ${ACTION_LABELS[actionType]} enquiry: ${prop.title}`,
      body: `${buyerName} (${buyerMobile}${buyerEmail ? ` / ${buyerEmail}` : ''}) clicked "${ACTION_LABELS[actionType]}" on ${prop.property_code}.`,
      relatedKind: 'lead',
      relatedId: leadId,
      moduleKey: MODULES.LEAD_MANAGEMENT,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[lead] notification insert failed:', err.message);
  }

  // T-2026-179: admin-only notification via the centralised service.
  const actionLabel = ACTION_LABELS[actionType] || 'Enquiry';
  const rendered = adminNotifications.renderNewWebsiteEnquiry({
    enquiryCode: crmIngest?.enquiry_code || null,
    source: 'website',
    enquiryTypeLabel: actionLabel,
    name: buyerName,
    mobile: buyerMobile,
    email: buyerEmail,
    message: message || null,
    propertyDetails: [{ code: prop.property_code, title: prop.title }],
    createdAt: adminNotifications.nowIstDate(),
  });
  void adminNotifications.sendAdminNotification({
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
    customerEmails: rendered.customerEmails,
  });

  return { ok: true, leadId, property: { id: prop.id, code: prop.property_code } };
}

module.exports = { start, verify, submit };
