/**
 * T-2026-179 — Centralised admin notification service.
 *
 * Contract:
 *   All application notification emails (Website enquiry, Seller
 *   registration, CRM booking created / cancelled / rescheduled) route
 *   through this module. Recipient is ALWAYS the Admin Email loaded
 *   dynamically from the active Email Master row. The caller CANNOT
 *   override the recipient -- the function signature deliberately omits
 *   `to` so no future caller can accidentally leak PII to a customer.
 *
 * Guard rails (belt-and-braces):
 *   1. adminEmail resolved fresh on every call via getAdminEmail() -- no
 *      module-scope caching that could go stale on config change.
 *   2. If no admin email configured -> log a warning and return
 *      { sent:false, skipped_reason:'NO_ADMIN_EMAIL' }. NEVER throws
 *      (upstream request must still succeed; enquiry / seller /
 *      booking data is already persisted).
 *   3. Defensive customer-email guard: an OPTIONAL payload.customerEmails
 *      array MAY be passed. Before the transport call we verify that the
 *      resolved adminEmail is NOT equal (case-insensitive, trimmed) to
 *      ANY entry in that array. If it does match, we log a warning and
 *      still send to adminEmail (the guard is defensive; the assertion
 *      is that the caller shouldn't be able to spoof `to` to a customer,
 *      because there is no `to` parameter to spoof).
 *   4. Templates centralised here so subject / field ordering / IST
 *      formatting is uniform across every flow.
 *
 * Notification types (`type` is required, used only for logging today
 * -- reserved so future rate-limit / muting rules can key off it):
 *   NEW_WEBSITE_ENQUIRY
 *   SELLER_REGISTRATION
 *   CRM_BOOKING_CREATED
 *   CRM_BOOKING_CANCELLED
 *   CRM_BOOKING_RESCHEDULED
 *
 * Public API:
 *   sendAdminNotification({ subject, html, text, type, customerEmails? })
 *     -> { sent, skipped_reason?, admin_email?, warnings? }
 *
 *   renderNewWebsiteEnquiry(ctx)
 *   renderSellerRegistration(ctx)
 *   renderCrmBookingCreated(ctx)
 *   renderCrmBookingCancelled(ctx)
 *   renderCrmBookingRescheduled(ctx)
 *     -> { subject, html, text, customerEmails }
 *
 *   formatIstDateTime(dateLike)
 *     -> 'DD-MM-YYYY HH:MM AM/PM'
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TYPES = Object.freeze({
  NEW_WEBSITE_ENQUIRY:     'NEW_WEBSITE_ENQUIRY',
  SELLER_REGISTRATION:     'SELLER_REGISTRATION',
  CRM_BOOKING_CREATED:     'CRM_BOOKING_CREATED',
  CRM_BOOKING_CANCELLED:   'CRM_BOOKING_CANCELLED',
  CRM_BOOKING_RESCHEDULED: 'CRM_BOOKING_RESCHEDULED',
  CRM_BOOKING_REMINDER:    'CRM_BOOKING_REMINDER',
});

// Lazy-required so the module graph stays acyclic and tests can
// monkey-patch transporterModule.getAdminEmail / trySendMail without
// touching a captured reference.
function loadTransporter() {
  // eslint-disable-next-line global-require
  return require('./transporter');
}

function isValidEmail(x) {
  if (!x) return false;
  const s = String(x).trim();
  return EMAIL_RE.test(s);
}

function normalizeEmail(x) {
  return String(x || '').trim().toLowerCase();
}

// -------------------- IST formatting --------------------
//
// Project convention (pool session TZ = UTC): DATETIME columns returned
// as JS Dates already carry IST wall-clock components in their UTC
// getters. Callers pass in either a Date (from a DB column) or an
// ISO string with an explicit offset. formatIstDateTime handles both:
//
//   * Date with UTC-getters = IST wall-clock (project convention)
//     -> read getUTC* directly
//   * ISO string 'YYYY-MM-DDTHH:MM:SS+05:30'
//     -> parse and shift back to IST wall-clock components
//
// Output: "DD-MM-YYYY HH:MM AM/PM" -- exact per T-179 spec §C.

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;

function formatIstDateTime(dateLike) {
  if (dateLike == null || dateLike === '') return '';
  let d;
  if (dateLike instanceof Date) {
    d = dateLike;
  } else if (typeof dateLike === 'string') {
    const trimmed = dateLike.trim();
    // Plain 'YYYY-MM-DD HH:MM:SS' (MySQL DATETIME string with no TZ) -->
    // treat as IST wall-clock (project convention).
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      const iso = trimmed.replace(' ', 'T');
      const parsed = new Date(`${iso}Z`); // read components as-is
      if (Number.isNaN(parsed.getTime())) return '';
      return renderIstFromUtcParts(parsed);
    }
    d = new Date(trimmed);
  } else {
    return '';
  }
  if (Number.isNaN(d.getTime())) return '';
  // If the Date came from a DB column, its UTC getters already yield
  // IST wall-clock (project convention). If it came from a real ISO
  // (with a TZ suffix) new Date() normalised to UTC; shift +5:30.
  //
  // Heuristic: DB Dates round-trip through pool with TZ=UTC session -->
  // the UTC hour reads as IST. But if a caller passed `new Date()`
  // (system time) we must shift. We can't distinguish reliably, so we
  // adopt the calling-convention: if the caller wants IST, they pass
  // EITHER a DB-origin Date OR an ISO string with +05:30. For plain
  // `new Date()` (like "cancellation date/time = now") the caller can
  // use nowIstDate() which pre-shifts.
  return renderIstFromUtcParts(d);
}

function renderIstFromUtcParts(d) {
  const da = String(d.getUTCDate()).padStart(2, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  let h = d.getUTCHours();
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const period = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  const hh = String(h).padStart(2, '0');
  return `${da}-${mo}-${y} ${hh}:${mi} ${period}`;
}

/**
 * Current wall-clock as an IST "as-if-UTC" Date (getUTC* returns IST
 * components). Used by CRM cancellation flow to stamp "Cancellation
 * Date/Time" in IST regardless of the server's local TZ.
 */
function nowIstDate() {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MS);
}

function enquiryTypeLabel(source) {
  if (source === 'website') return 'Website Enquiry';
  if (source === 'npd')     return 'NPD Enquiry';
  return source || '—';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapHtml(title, tableRows, extraHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="background:#C62828;padding:18px 24px;color:#ffffff;font-size:17px;font-weight:700;">
              ${escHtml(title)}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;table-layout:fixed;">
                <colgroup><col width="34%" style="width:34%;"/><col width="66%" style="width:66%;"/></colgroup>
                ${tableRows}
              </table>
              ${extraHtml || ''}
            </td>
          </tr>
          <tr>
            <td style="padding:14px 24px 20px;color:#6b7280;font-size:11px;border-top:1px solid #e5e7eb;">
              You are receiving this because your address is configured as the Administrator Email in
              <strong>Global → Email</strong>.
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function rowHtml(label, value) {
  const v = (value === null || value === undefined || value === '') ? '—' : String(value);
  const cellValue = escHtml(v).replace(/\r?\n/g, '<br/>');
  return `<tr>
    <td width="34%" style="width:34%;padding:8px 14px 8px 0;color:#6b7280;vertical-align:top;white-space:normal;word-wrap:break-word;overflow-wrap:break-word;font-size:13px;line-height:1.45;">${escHtml(label)}</td>
    <td width="66%" style="width:66%;padding:8px 0;color:#111827;vertical-align:top;white-space:normal;word-wrap:break-word;overflow-wrap:break-word;font-size:13px;line-height:1.5;">${cellValue}</td>
  </tr>`;
}

function textLines(pairs) {
  return pairs.map(([k, v]) => {
    const val = (v === null || v === undefined || v === '') ? '—' : String(v);
    const wrappedValue = val.replace(/\r?\n/g, '\n  ');
    return `${k}: ${wrappedValue}`;
  }).join('\n');
}

// -------------------- Template: NEW_WEBSITE_ENQUIRY --------------------
//
// Spec §C.1:
//   Subject: `New Website Enquiry Received – <ENQ_ID>`
//   Body: New Website Enquiry Received / Enquiry ID / Source /
//         Enquiry Type / Name / Mobile / Email / Message /
//         Property Details (if attached) / Created Date.
//
// enquiryCode MUST be the DB-generated ENQ-YYYY-NNNNN (T-179 spec §C.1);
// caller MUST NOT invent a different id. Do NOT include the numeric DB id.

function renderNewWebsiteEnquiry(ctx) {
  const {
    enquiryCode,         // 'ENQ-YYYY-NNNNN' -- CRM-persisted business id
    source,              // 'website' | 'npd' | free label
    enquiryTypeLabel: typeLabelOverride, // optional override
    name,
    mobile,
    email,
    message,
    propertyDetails,     // optional string OR array of { code, title }
    createdAt,           // Date | ISO string
  } = ctx || {};

  const subject = `New Website Enquiry Received – ${enquiryCode || '—'}`;
  const typeLabel = typeLabelOverride || enquiryTypeLabel(source);
  const created = formatIstDateTime(createdAt);
  const propStr = Array.isArray(propertyDetails)
    ? (propertyDetails.length
        ? propertyDetails.map((p) => (p && p.code)
            ? `${p.code}${p.title ? ` — ${p.title}` : ''}`
            : String(p || ''))
          .filter(Boolean).join('\n')
        : '')
    : (propertyDetails || '');

  const pairs = [
    ['Enquiry ID',       enquiryCode],
    ['Source',           'Website'],
    ['Enquiry Type',     typeLabel],
    ['Name',             name],
    ['Mobile',           mobile],
    ['Email',            email],
    ['Message',          message],
    ['Property Details', propStr],
    ['Created Date',     created],
  ];

  const text = ['New Website Enquiry Received', ''].concat(textLines(pairs)).join('\n');
  const rows = pairs.map(([k, v]) => rowHtml(k, v)).join('');
  const html = wrapHtml('New Website Enquiry Received', rows);

  const customerEmails = [email].filter(isValidEmail).map(normalizeEmail);

  return { subject, text, html, customerEmails };
}

// -------------------- Template: SELLER_REGISTRATION --------------------
//
// Spec §C.2:
//   Subject: `New Seller Registration Received`
//   Body: Seller Name / Mobile / Email / Registration Date /
//         Account Status + any other registration fields that already
//         exist. Do NOT invent fields.

function renderSellerRegistration(ctx) {
  const {
    fullName,
    mobile,
    email,
    userType,            // 'individual' | 'agent' | ... optional
    accountStatus,       // 'verified' | 'active' | ... optional
    registeredAt,        // Date | ISO
  } = ctx || {};

  const subject = 'New Seller Registration Received';
  const registered = formatIstDateTime(registeredAt);

  const pairs = [
    ['Seller Name',       fullName],
    ['Mobile',            mobile],
    ['Email',             email],
    ['User Type',         userType],
    ['Registration Date', registered],
    ['Account Status',    accountStatus],
  ];

  const text = ['New Seller Registration Received', ''].concat(textLines(pairs)).join('\n');
  const rows = pairs.map(([k, v]) => rowHtml(k, v)).join('');
  const html = wrapHtml('New Seller Registration Received', rows);

  const customerEmails = [email].filter(isValidEmail).map(normalizeEmail);

  return { subject, text, html, customerEmails };
}

// -------------------- Template: CRM_BOOKING_CREATED --------------------
//
// Spec §C.3:
//   Subject: `CRM Call Scheduled – <ENQ_ID>`
//   Body: Enquiry ID / Enquiry Name / Mobile / Email / Enquiry Type /
//         Scheduled Date / Scheduled Time / Lead Stage / Lead Status /
//         Lead Rating / Property (use property_code, NOT DB id) / Notes.

function renderCrmBookingCreated(ctx) {
  const {
    enquiryCode,
    enquiryName,
    mobile,
    email,
    source,
    scheduledAt,     // Date | ISO (IST wall-clock)
    leadStage,       // resolved LABEL preferred; falls back to code
    leadStatus,
    leadRating,
    propertyCodes,   // array of strings OR single string
    notes,
  } = ctx || {};

  const subject = `CRM Call Scheduled – ${enquiryCode || '—'}`;
  const dt = formatIstDateTime(scheduledAt);
  const [scheduledDate, ...scheduledRest] = dt ? dt.split(' ') : [''];
  const scheduledTime = scheduledRest.join(' ');
  const props = Array.isArray(propertyCodes) ? propertyCodes.filter(Boolean).join(', ') : (propertyCodes || '');

  const pairs = [
    ['Enquiry ID',      enquiryCode],
    ['Enquiry Name',    enquiryName],
    ['Mobile',          mobile],
    ['Email',           email],
    ['Enquiry Type',    enquiryTypeLabel(source)],
    ['Scheduled Date',  scheduledDate],
    ['Scheduled Time',  scheduledTime],
    // Codes arrive snake_case from crm_enquiries (there is no label join on
    // this path), so soften them the same way the reminder template does --
    // otherwise the operator gets "follow_up" in their inbox.
    ['Lead Stage',      prettifyTaxonomyCode(leadStage)],
    ['Lead Status',     prettifyTaxonomyCode(leadStatus)],
    ['Lead Rating',     prettifyTaxonomyCode(leadRating)],
    ['Property',        props],
    ['Notes',           notes],
  ];

  const text = ['CRM Call Scheduled', ''].concat(textLines(pairs)).join('\n');
  const rows = pairs.map(([k, v]) => rowHtml(k, v)).join('');
  const html = wrapHtml('CRM Call Scheduled', rows);

  const customerEmails = [email].filter(isValidEmail).map(normalizeEmail);

  return { subject, text, html, customerEmails };
}

// -------------------- Template: CRM_BOOKING_REMINDER --------------------
//
// Sent by services/crm/appointmentReminders.js at the two offsets stored on
// the booking (1 day and 1 hour before, per migration 112). This is the
// "you have a call coming up, here is who to ring and what it is about"
// email -- so it carries the same identity block as CRM_BOOKING_CREATED
// plus an explicit lead-time line, and it leads with the countdown rather
// than the booking action.
//
// `leadMinutes` is rendered as a human phrase ("1 day" / "1 hour") rather
// than a raw number so the subject line reads naturally in a crowded inbox.

function reminderLeadLabel(leadMinutes) {
  const m = Number(leadMinutes);
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m % 1440 === 0) { const d = m / 1440; return d === 1 ? '1 day' : `${d} days`; }
  if (m % 60 === 0)   { const h = m / 60;   return h === 1 ? '1 hour' : `${h} hours`; }
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/**
 * Taxonomy codes are stored snake_case ('follow_up', 'no_response'). The
 * dispatcher reads them straight off crm_enquiries -- there is no label
 * join on that path -- so soften them here rather than mailing the operator
 * a raw enum. A caller that already has a resolved label passes it through
 * unchanged (no underscore, so only the capitalisation applies).
 */
function prettifyTaxonomyCode(value) {
  if (value == null || value === '') return '';
  return String(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function renderCrmBookingReminder(ctx) {
  const {
    enquiryCode,
    enquiryName,
    mobile,
    email,
    source,
    scheduledAt,     // Date | ISO (IST wall-clock)
    leadMinutes,     // 1440 | 60
    leadStage,
    leadStatus,
    leadRating,
    propertyCodes,   // array of strings OR single string
    notes,
  } = ctx || {};

  const lead = reminderLeadLabel(leadMinutes);
  const inPhrase = lead ? `in ${lead}` : 'upcoming';
  const subject = `Reminder: CRM Call ${inPhrase} – ${enquiryCode || '—'}`;
  const dt = formatIstDateTime(scheduledAt);
  const [scheduledDate, ...scheduledRest] = dt ? dt.split(' ') : [''];
  const scheduledTime = scheduledRest.join(' ');
  const props = Array.isArray(propertyCodes) ? propertyCodes.filter(Boolean).join(', ') : (propertyCodes || '');

  const pairs = [
    ['Call Due In',     lead],
    ['Scheduled Date',  scheduledDate],
    ['Scheduled Time',  scheduledTime],
    ['Enquiry ID',      enquiryCode],
    ['Enquiry Name',    enquiryName],
    ['Mobile',          mobile],
    ['Email',           email],
    ['Enquiry Type',    enquiryTypeLabel(source)],
    ['Lead Stage',      prettifyTaxonomyCode(leadStage)],
    ['Lead Status',     prettifyTaxonomyCode(leadStatus)],
    ['Lead Rating',     prettifyTaxonomyCode(leadRating)],
    ['Property',        props],
    ['Notes',           notes],
  ];

  const heading = `Upcoming CRM Call ${inPhrase}`;
  const text = [heading, ''].concat(textLines(pairs)).join('\n');
  const rows = pairs.map(([k, v]) => rowHtml(k, v)).join('');
  const html = wrapHtml(heading, rows);

  const customerEmails = [email].filter(isValidEmail).map(normalizeEmail);

  return { subject, text, html, customerEmails };
}

// -------------------- Template: CRM_BOOKING_CANCELLED --------------------
//
// Spec §C.4:
//   Subject: `CRM Follow-up Cancelled – <ENQ_ID>`
//   Body: Enquiry ID / Name / Mobile / Email / Enquiry Type / Property /
//         Previously Scheduled Date / Previously Scheduled Time /
//         Cancellation Date/Time / Cancellation reason (if any).

function renderCrmBookingCancelled(ctx) {
  const {
    enquiryCode,
    enquiryName,
    mobile,
    email,
    source,
    propertyCodes,
    previouslyScheduledAt,   // Date | ISO (IST wall-clock)
    cancelledAt,             // Date (usually nowIstDate())
    cancellationReason,
  } = ctx || {};

  const subject = `CRM Follow-up Cancelled – ${enquiryCode || '—'}`;
  const dtPrev = formatIstDateTime(previouslyScheduledAt);
  const [prevDate, ...prevRest] = dtPrev ? dtPrev.split(' ') : [''];
  const prevTime = prevRest.join(' ');
  const cancelled = formatIstDateTime(cancelledAt);
  const props = Array.isArray(propertyCodes) ? propertyCodes.filter(Boolean).join(', ') : (propertyCodes || '');

  const pairs = [
    ['Enquiry ID',                   enquiryCode],
    ['Name',                         enquiryName],
    ['Mobile',                       mobile],
    ['Email',                        email],
    ['Enquiry Type',                 enquiryTypeLabel(source)],
    ['Property',                     props],
    ['Previously Scheduled Date',    prevDate],
    ['Previously Scheduled Time',    prevTime],
    ['Cancellation Date/Time',       cancelled],
    ['Cancellation Reason',          cancellationReason],
  ];

  const text = ['CRM Follow-up Cancelled', ''].concat(textLines(pairs)).join('\n');
  const rows = pairs.map(([k, v]) => rowHtml(k, v)).join('');
  const html = wrapHtml('CRM Follow-up Cancelled', rows);

  const customerEmails = [email].filter(isValidEmail).map(normalizeEmail);

  return { subject, text, html, customerEmails };
}

// -------------------- Template: CRM_BOOKING_RESCHEDULED --------------------
//
// Spec §C.5:
//   Subject: `CRM Follow-up Rescheduled – <ENQ_ID>`
//   Body: Enquiry ID / Enquiry Name / Mobile / Enquiry Type /
//         Previous Schedule (date + time) / New Schedule (date + time) /
//         Property / Updated By / Updated Date/Time.

function renderCrmBookingRescheduled(ctx) {
  const {
    enquiryCode,
    enquiryName,
    mobile,
    email,             // still captured for the defensive guard test
    source,
    previousScheduledAt,
    newScheduledAt,
    propertyCodes,
    updatedByName,
    updatedAt,
  } = ctx || {};

  const subject = `CRM Follow-up Rescheduled – ${enquiryCode || '—'}`;
  const prev = formatIstDateTime(previousScheduledAt);
  const [prevDate, ...prevRest] = prev ? prev.split(' ') : [''];
  const prevTime = prevRest.join(' ');
  const nu = formatIstDateTime(newScheduledAt);
  const [newDate, ...newRest] = nu ? nu.split(' ') : [''];
  const newTime = newRest.join(' ');
  const updated = formatIstDateTime(updatedAt);
  const props = Array.isArray(propertyCodes) ? propertyCodes.filter(Boolean).join(', ') : (propertyCodes || '');

  const pairs = [
    ['Enquiry ID',            enquiryCode],
    ['Enquiry Name',          enquiryName],
    ['Mobile',                mobile],
    ['Enquiry Type',          enquiryTypeLabel(source)],
    ['Previous Schedule',     prev ? `${prevDate} ${prevTime}` : ''],
    ['New Schedule',          nu   ? `${newDate} ${newTime}`   : ''],
    ['Property',              props],
    ['Updated By',            updatedByName],
    ['Updated Date/Time',     updated],
  ];

  const text = ['CRM Follow-up Rescheduled', ''].concat(textLines(pairs)).join('\n');
  const rows = pairs.map(([k, v]) => rowHtml(k, v)).join('');
  const html = wrapHtml('CRM Follow-up Rescheduled', rows);

  const customerEmails = [email].filter(isValidEmail).map(normalizeEmail);

  return { subject, text, html, customerEmails };
}

// -------------------- Public sender --------------------

/**
 * Route a rendered notification to the Admin Email loaded from the
 * active Email Master row.
 *
 * IMPORTANT: no `to` parameter is accepted. The recipient is decided
 * exclusively by getAdminEmail() at call time. Callers pass
 * `customerEmails` only so the defensive guard can assert that the
 * resolved adminEmail is not one of them.
 */
async function sendAdminNotification({
  subject,
  html,
  text,
  type,
  customerEmails,
} = {}) {
  if (!subject) {
    // Malformed caller -- log and return without send.
    // eslint-disable-next-line no-console
    console.warn('[adminNotifications] refuse: missing subject', { type });
    return { sent: false, skipped_reason: 'MISSING_SUBJECT' };
  }
  if (!type || !TYPES[type]) {
    // eslint-disable-next-line no-console
    console.warn('[adminNotifications] refuse: unknown type', { type });
    return { sent: false, skipped_reason: 'UNKNOWN_TYPE' };
  }
  const transporter = loadTransporter();
  const adminEmail = await transporter.getAdminEmail();
  if (!isValidEmail(adminEmail)) {
    // Missing / malformed admin email in Email Master. Do NOT throw --
    // upstream request (enquiry / booking / registration) must still
    // succeed. Log an actionable warning so the operator sees it.
    // eslint-disable-next-line no-console
    console.error(
      '[adminNotifications] NO_ADMIN_EMAIL configured in Email Master. Notification not sent.',
      { type, subject: String(subject).slice(0, 120) },
    );
    return { sent: false, skipped_reason: 'NO_ADMIN_EMAIL' };
  }

  const warnings = [];
  const resolvedAdmin = normalizeEmail(adminEmail);
  if (Array.isArray(customerEmails) && customerEmails.length) {
    const bad = customerEmails
      .map(normalizeEmail)
      .filter((e) => e && e === resolvedAdmin);
    if (bad.length) {
      // The admin_email in Email Master literally matches a customer email
      // in the payload. Highly unusual (admin set their own address as the
      // customer email on a form?) -- log a loud warning but still send:
      // the operator explicitly configured this address to receive admin
      // notifications, so the send is legitimate. The guard exists to
      // catch a BUG (a caller trying to hijack `to`) not a legitimate
      // coincidence.
      // eslint-disable-next-line no-console
      console.warn(
        '[adminNotifications] adminEmail equals a customer email in payload -- proceeding (admin owns this address)',
        { type, adminEmail: resolvedAdmin },
      );
      warnings.push('ADMIN_EQUALS_CUSTOMER');
    }
  }

  // The transport layer accepts (to, subject, text, html) -- we force
  // `to = adminEmail` here. There is no path for a caller to override it.
  const ok = await transporter.trySendMail({
    to: adminEmail,
    subject,
    text,
    html,
  });
  return {
    sent: !!ok,
    admin_email: resolvedAdmin,
    warnings: warnings.length ? warnings : undefined,
  };
}

module.exports = {
  TYPES,
  sendAdminNotification,
  renderNewWebsiteEnquiry,
  renderSellerRegistration,
  renderCrmBookingCreated,
  renderCrmBookingCancelled,
  renderCrmBookingRescheduled,
  renderCrmBookingReminder,
  reminderLeadLabel,
  // Exposed for tests + reuse:
  formatIstDateTime,
  nowIstDate,
  isValidEmail,
  normalizeEmail,
  enquiryTypeLabel,
};
