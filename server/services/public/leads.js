const { HttpError } = require('../../middleware/errors');
const publicProps = require('../../db/queries/public_properties');
const leadsQ = require('../../db/queries/leads');
const notificationsQ = require('../../db/queries/notifications');
const otp = require('../auth/otp');
const { trySendMail } = require('../email/transporter');
const { MODULES } = require('../../constants/modules');

const ACTION_LABELS = {
  contact_seller: 'Contact Seller',
  view_location: 'View Location',
};

/**
 * Step 1: validate property exists and is publicly visible, then issue a
 * mobile (SMS) OTP to the buyer. Email is optional — kept only as a
 * follow-up contact channel for admin if the buyer chose to share it.
 */
async function start({ propertyId, name, mobile, email }) {
  const prop = await publicProps.findActiveById(propertyId);
  if (!prop) throw new HttpError(404, 'PROPERTY_UNAVAILABLE', 'This property is no longer available.');

  const issued = await otp.issue({
    purpose: 'buyer_lead',
    channel: 'sms',
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

  await otp.verify({
    purpose: 'buyer_lead',
    channel: 'sms',
    mobileNumber: mobile,
    code,
  });

  const buyerEmail = email && email.trim() ? email.trim().toLowerCase() : null;

  const leadId = await leadsQ.create({
    websitePropertyId: propertyId,
    actionType,
    buyerName: name.trim(),
    buyerMobile: mobile.trim(),
    buyerEmail,
    message,
  });

  try {
    await notificationsQ.create({
      kind: 'lead.created',
      title: `New ${ACTION_LABELS[actionType]} enquiry: ${prop.title}`,
      body: `${name.trim()} (${mobile.trim()}${buyerEmail ? ` / ${buyerEmail}` : ''}) clicked "${ACTION_LABELS[actionType]}" on ${prop.property_code}.`,
      relatedKind: 'lead',
      relatedId: leadId,
      moduleKey: MODULES.LEAD_MANAGEMENT,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[lead] notification insert failed:', err.message);
  }

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail) {
    void trySendMail({
      to: adminEmail,
      subject: `[Lead] ${ACTION_LABELS[actionType]} — ${prop.property_code} ${prop.title}`,
      text: buildAdminEmailText({ prop, actionType, name, mobile, email: buyerEmail, message }),
      html: buildAdminEmailHtml({ prop, actionType, name, mobile, email: buyerEmail, message }),
    });
  }

  return { ok: true, leadId, property: { id: prop.id, code: prop.property_code } };
}

function buildAdminEmailText({ prop, actionType, name, mobile, email, message }) {
  return [
    `New ${ACTION_LABELS[actionType]} enquiry`,
    '',
    `Property: ${prop.property_code} — ${prop.title}`,
    `Buyer:    ${name.trim()}`,
    `Mobile:   ${mobile.trim()}`,
    email ? `Email:    ${email}` : '',
    message ? `Message:  ${message}` : '',
    '',
    'Manage at: /admin/leads',
  ].filter(Boolean).join('\n');
}

function buildAdminEmailHtml({ prop, actionType, name, mobile, email, message }) {
  return `<div style="font-family: Arial, sans-serif; max-width: 560px;">
  <h2 style="color:#175a96;">New ${ACTION_LABELS[actionType]} enquiry</h2>
  <p><strong>Property:</strong> ${escapeHtml(prop.property_code)} — ${escapeHtml(prop.title)}</p>
  <p><strong>Buyer:</strong> ${escapeHtml(name)}<br/>
     <strong>Mobile:</strong> ${escapeHtml(mobile)}${email ? `<br/><strong>Email:</strong> ${escapeHtml(email)}` : ''}</p>
  ${message ? `<p><strong>Message:</strong><br/>${escapeHtml(message)}</p>` : ''}
  <p style="color:#666;font-size:12px;">Manage at /admin/leads</p>
</div>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { start, verify };
