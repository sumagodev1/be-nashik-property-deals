const nodemailer = require('nodemailer');

let cached;

function getTransporter() {
  if (cached) return cached;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER || undefined;
  const pass = process.env.SMTP_PASS || undefined;

  if (!host) {
    throw new Error('SMTP_HOST is not configured');
  }

  cached = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  });

  return cached;
}

function buildFromAddress() {
  // Prefer the explicit `SMTP_FROM` if provided (legacy). Otherwise build
  // "Name <email>" from SMTP_FROM_NAME + SMTP_FROM_EMAIL. Falls back to
  // SMTP_USER (the authenticated mailbox) when no display name is set —
  // this is what Gmail enforces anyway: the From: header MUST match the
  // authenticated account or it'll silently rewrite / bounce.
  if (process.env.SMTP_FROM) return process.env.SMTP_FROM;
  const name = process.env.SMTP_FROM_NAME;
  const email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  if (email && name) return `"${name}" <${email}>`;
  if (email) return email;
  return 'no-reply@example.com';
}

async function sendMail({ to, subject, text, html, replyTo }) {
  const transporter = getTransporter();
  const from = buildFromAddress();
  return transporter.sendMail({ from, to, subject, text, html, replyTo });
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
      // Lazy-require to dodge the circular dep: outbox.js → transporter.js.
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

module.exports = { getTransporter, sendMail, trySendMail };
