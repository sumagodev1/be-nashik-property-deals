/**
 * Shared HTML email layout for every system-generated email (lead
 * notifications, general enquiries, OTPs, assignment alerts, etc).
 *
 * Why a shared template:
 *   - Consistency — every email carries the same brand bar, footer, and
 *     typography rules so recipients immediately recognise the sender.
 *   - Maintainability — when the brand colour / footer / signature
 *     changes, it changes in one place.
 *   - Inbox safety — table-based layout, inline CSS, 600px max width,
 *     web-safe font stack: works in every major email client including
 *     Gmail (web/mobile), Outlook, Apple Mail.
 *
 * Usage:
 *   const { renderEmail, kvRow, sectionTitle, ctaButton, infoCard } =
 *     require('../email/emailTemplate');
 *   const html = renderEmail({
 *     preheader: 'A new lead just came in.',
 *     accentColor: BRAND.primary,
 *     title: 'New Contact Seller enquiry',
 *     intro: 'A buyer is interested in your listing...',
 *     bodyHtml: `${infoCard(...)} ${sectionTitle('Buyer details')} ...`,
 *     ctaHref: 'https://example.com/admin/leads',
 *     ctaLabel: 'Open in Admin Panel',
 *   });
 */

const BRAND = {
  name: 'Nashik Property Deals',
  primary: '#001A2E',   // deep navy — header bar
  brand:   '#175a96',   // accent / links
  amber:   '#f59e0b',
  bg:      '#f3f4f6',
  card:    '#ffffff',
  border:  '#e5e7eb',
  text:    '#1f2937',
  muted:   '#6b7280',
  faint:   '#9ca3af',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Outer envelope. Caller provides `bodyHtml` which lives between the
 * brand bar and the footer. Everything else (preheader, title, intro,
 * optional CTA) is templated for them.
 */
function renderEmail({
  preheader = '',
  title,
  intro = '',
  bodyHtml = '',
  ctaHref = null,
  ctaLabel = null,
  accentColor = BRAND.primary,
  footerNote = null,
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.text};">

    <!-- Preheader: shows in the inbox preview pane but hidden in the email body -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
      ${escapeHtml(preheader || title)}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};padding:24px 12px;">
      <tr>
        <td align="center">

          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:${BRAND.card};border-radius:12px;overflow:hidden;border:1px solid ${BRAND.border};box-shadow:0 1px 3px rgba(0,0,0,0.04);">

            <!-- Brand bar -->
            <tr>
              <td style="background:${accentColor};padding:20px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.3px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      ${escapeHtml(BRAND.name)}
                    </td>
                    <td align="right" style="color:rgba(255,255,255,0.7);font-size:11px;text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                      Admin Notification
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:32px 28px 24px 28px;">
                <h1 style="margin:0 0 8px 0;font-size:22px;line-height:1.3;color:${BRAND.text};font-weight:700;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                  ${escapeHtml(title)}
                </h1>
                ${intro ? `<p style="margin:0 0 20px 0;font-size:14px;line-height:1.55;color:${BRAND.muted};">${escapeHtml(intro)}</p>` : ''}

                ${bodyHtml}

                ${ctaHref && ctaLabel ? `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 4px 0;">
                  <tr>
                    <td style="background:${accentColor};border-radius:8px;">
                      <a href="${escapeHtml(ctaHref)}" target="_blank" rel="noopener"
                         style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                        ${escapeHtml(ctaLabel)} &rarr;
                      </a>
                    </td>
                  </tr>
                </table>` : ''}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="background:#fafafa;padding:20px 28px;border-top:1px solid ${BRAND.border};">
                <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">
                  ${footerNote ? escapeHtml(footerNote) + '<br/>' : ''}
                  This is an automated message from ${escapeHtml(BRAND.name)}.
                  Please do not reply directly to this email.
                </p>
              </td>
            </tr>

          </table>

          <p style="margin:16px 0 0 0;font-size:11px;color:${BRAND.faint};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
            &copy; ${new Date().getFullYear()} ${escapeHtml(BRAND.name)}
          </p>

        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Inline section heading — used inside the email body to break up data
 * blocks (e.g. "Buyer details", "Property", "Message").
 */
function sectionTitle(label) {
  return `<div style="margin:24px 0 8px 0;font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND.muted};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${escapeHtml(label)}</div>`;
}

/**
 * Single key/value row rendered inside a table so columns align. Compose
 * several with kvTable() to produce a clean data block.
 */
function kvRow(label, value, { mono = false, link = null } = {}) {
  const v = value == null || value === '' ? '—' : String(value);
  const cell = link
    ? `<a href="${escapeHtml(link)}" style="color:${BRAND.brand};text-decoration:none;">${escapeHtml(v)}</a>`
    : escapeHtml(v);
  const cellFont = mono ? 'font-family:Menlo,Consolas,monospace;' : '';
  return `<tr>
    <td style="padding:7px 12px 7px 0;font-size:13px;color:${BRAND.muted};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
    <td style="padding:7px 0;font-size:14px;color:${BRAND.text};font-weight:600;${cellFont}">${cell}</td>
  </tr>`;
}

function kvTable(rowsHtml) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">${rowsHtml}</table>`;
}

/**
 * Highlighted card — for the headline fact of an email (property in a
 * lead notification, OTP code in an OTP email, etc).
 */
function infoCard({ eyebrow = '', title, subtitle = '', accent = BRAND.brand }) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:8px 0 0 0;border-collapse:separate;">
    <tr>
      <td style="background:#f8fafc;border:1px solid ${BRAND.border};border-left:4px solid ${accent};border-radius:8px;padding:16px 18px;">
        ${eyebrow ? `<div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:${BRAND.muted};margin-bottom:6px;">${escapeHtml(eyebrow)}</div>` : ''}
        <div style="font-size:15px;font-weight:700;color:${BRAND.text};line-height:1.4;font-family:Menlo,Consolas,monospace;">
          ${escapeHtml(title)}
        </div>
        ${subtitle ? `<div style="margin-top:4px;font-size:13px;color:${BRAND.muted};line-height:1.5;">${escapeHtml(subtitle)}</div>` : ''}
      </td>
    </tr>
  </table>`;
}

/**
 * Block-quoted message — buyer's free-text note in a lead, or the
 * rejection reason on a property reject email.
 */
function quoteBlock(text) {
  return `<div style="margin:16px 0 0 0;padding:12px 14px;background:#f9fafb;border-left:3px solid ${BRAND.border};border-radius:4px;font-size:13.5px;line-height:1.55;color:${BRAND.text};font-style:italic;">
    &ldquo;${escapeHtml(text)}&rdquo;
  </div>`;
}

module.exports = {
  BRAND,
  renderEmail,
  sectionTitle,
  kvRow,
  kvTable,
  infoCard,
  quoteBlock,
  escapeHtml,
};
