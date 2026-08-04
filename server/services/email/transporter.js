/**
 * Central email sender.
 *
 * Single source of truth: the ACTIVE row in the `email_settings` table
 * (Global / Email master). Legacy SMTP_* / ADMIN_NOTIFICATION_EMAIL env
 * vars are no longer consulted — every outbound message routes through
 * the Email Master.
 *
 * If no active row exists (or the Email Master hasn't been configured
 * yet), sendMail() throws `EMAIL_NOT_CONFIGURED`. Callers using the
 * best-effort variant `trySendMail()` still swallow the failure and
 * enqueue for later retry — same behavior as before.
 *
 * The `sendMail` / `trySendMail` / `getAdminEmail` signatures are
 * preserved so every existing caller works without further changes.
 */

const { HttpError } = require('../../middleware/errors');

function loadEmailSettingsService() {
  // Lazy-require to keep the module graph acyclic (email_settings.js
  // never imports transporter.js, but we defer the load so requiring
  // this file at boot time doesn't pull the DB layer in eagerly).
  // eslint-disable-next-line global-require
  return require('./email_settings');
}

/**
 * Resolve the active transport spec from the Email Master.
 * Returns { transporter, from, replyTo, adminEmail }.
 * Throws EMAIL_NOT_CONFIGURED if no active row is present.
 */
async function resolveTransport() {
  const active = await loadEmailSettingsService().buildActiveTransport();
  if (!active) {
    throw new HttpError(
      412,
      'EMAIL_NOT_CONFIGURED',
      'No active email configuration. Please set up an Active row in Global / Email before sending mail.',
    );
  }
  return active;
}

async function sendMail({ to, subject, text, html, replyTo, attachments } = {}) {
  const t = await resolveTransport();
  return t.transporter.sendMail({
    from: t.from,
    to,
    subject,
    text,
    html,
    replyTo: replyTo || t.replyTo,
    attachments,
  });
}

/**
 * Best-effort variant. Logs errors but does not throw — appropriate for places
 * where a failed send shouldn't block the user's action (lead capture, OTP,
 * admin notifications).
 *
 * On failure, drops the message into `email_outbox` so the cron-driven worker
 * can retry it later. Returns true on immediate-success, false otherwise (the
 * message is still queued for retry — callers shouldn't treat false as "lost").
 */
async function trySendMail(opts) {
  try {
    await sendMail(opts);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[email] send failed, enqueueing:', err.code || err.message, '— to:', opts.to);
    try {
      // eslint-disable-next-line global-require
      const outbox = require('./outbox');
      await outbox.enqueue({
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
    } catch (queueErr) {
      // eslint-disable-next-line no-console
      console.error('[email] enqueue failed (message lost):', queueErr.message);
    }
    return false;
  }
}

/**
 * Return the administrator email address configured in the active Email
 * Master, or null if no active config exists. Used by public/lead and
 * public/general-enquiry admin notifications, and by the PIN recovery
 * flow to route OTP + verification link.
 */
async function getAdminEmail() {
  try {
    const t = await resolveTransport();
    return t.adminEmail || null;
  } catch (err) {
    // No active config → no admin recipient. Callers already tolerate
    // null (they skip the notification), so we don't surface the error.
    return null;
  }
}

module.exports = { sendMail, trySendMail, getAdminEmail };
