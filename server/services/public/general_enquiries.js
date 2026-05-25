/**
 * Public "general enquiry" flow — the optional Contact-page form. Same
 * OTP gate as property-specific leads, but no property reference. Categories
 * (Buy / Rent / Lease) are prepended to the message field at storage time so
 * we don't need a separate schema column.
 *
 * Per CLAUDE.md the OTP delivery channel is SMTP (email). Email is REQUIRED
 * — without it we have no OTP delivery address. Mobile is captured as the
 * contact-back number the admin will dial.
 */

const { HttpError } = require('../../middleware/errors');
const leadsQ = require('../../db/queries/leads');
const notificationsQ = require('../../db/queries/notifications');
const otp = require('../auth/otp');
const { trySendMail } = require('../email/transporter');
const { MODULES } = require('../../constants/modules');

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

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail) {
    void trySendMail({
      to: adminEmail,
      subject: `[Enquiry] General — ${buyerName}`,
      text: buildAdminEmailText({ buyerName, buyerMobile, buyerEmail, message, categories }),
      html: buildAdminEmailHtml({ buyerName, buyerMobile, buyerEmail, message, categories }),
    });
  }

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

function buildAdminEmailText({ buyerName, buyerMobile, buyerEmail, message, categories }) {
  const summary = categoriesSummary(categories);
  return [
    `New general enquiry`,
    '',
    `Buyer:  ${buyerName}`,
    `Mobile: ${buyerMobile}`,
    buyerEmail ? `Email:  ${buyerEmail}` : '',
    summary ? `Interested in: ${summary}` : '',
    message && message.trim() ? `Message:\n${message.trim()}` : '',
    '',
    'Manage at: /admin/leads',
  ].filter(Boolean).join('\n');
}

function buildAdminEmailHtml({ buyerName, buyerMobile, buyerEmail, message, categories }) {
  const summary = categoriesSummary(categories);
  return `<div style="font-family: Arial, sans-serif; max-width: 560px;">
  <h2 style="color:#175a96;">New general enquiry</h2>
  <p><strong>Buyer:</strong> ${escapeHtml(buyerName)}<br/>
     <strong>Mobile:</strong> ${escapeHtml(buyerMobile)}${buyerEmail ? `<br/><strong>Email:</strong> ${escapeHtml(buyerEmail)}` : ''}</p>
  ${summary ? `<p><strong>Interested in:</strong> ${escapeHtml(summary)}</p>` : ''}
  ${message && message.trim() ? `<p><strong>Message:</strong><br/>${escapeHtml(message)}</p>` : ''}
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

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (adminEmail) {
    void trySendMail({
      to: adminEmail,
      subject: `[Enquiry] General — ${buyerName}`,
      text: buildAdminEmailText({ buyerName, buyerMobile, buyerEmail, message, categories }),
      html: buildAdminEmailHtml({ buyerName, buyerMobile, buyerEmail, message, categories }),
    });
  }

  return { ok: true, leadId };
}

module.exports = { start, verify, submit };
