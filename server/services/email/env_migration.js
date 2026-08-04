/**
 * One-shot boot-time migration: legacy `.env` SMTP → email_settings.
 *
 * Runs on every boot but is idempotent — it does nothing when the
 * `email_settings` table already contains at least one (non-deleted)
 * row. That makes it safe to leave enabled forever: fresh installs
 * get seeded automatically on first startup; every subsequent boot
 * short-circuits after a single count query.
 *
 * Behavior:
 *   1. If `email_settings` has any non-deleted row → skip (already
 *      configured, either via the UI or by a prior boot).
 *   2. If the minimum env vars needed for a working config are missing
 *      (SMTP_HOST + a sender email) → skip and log a warning so the
 *      operator knows to configure Global / Email via the UI.
 *   3. Otherwise: parse env vars, encrypt SMTP_PASS, insert a fresh
 *      row with is_active=1, and log a success message.
 *
 * Errors are never allowed to prevent server startup — they log a
 * warning and return. Callers should invoke via `.catch(() => {})` or
 * inside a fire-and-forget context.
 */

const { pool } = require('../../db/pool');
const emailSettings = require('../../db/queries/email_settings');
const { encryptSecret } = require('../security/crypto');

const LEGACY_ADMIN_EMAIL_KEYS = ['ADMIN_NOTIFICATION_EMAIL', 'ADMIN_EMAIL'];

/**
 * Parse an RFC-822-ish "Name <email>" string, or a bare email, into
 * { name, email }. Returns { name: null, email: null } if the input
 * doesn't yield a usable email.
 */
function parseFromHeader(raw) {
  if (!raw || typeof raw !== 'string') return { name: null, email: null };
  const trimmed = raw.trim();
  // "Display Name <user@example.com>" — extract angle-bracket address + name.
  const match = trimmed.match(/^\s*(?:"?([^"]*?)"?\s+)?<\s*([^>\s]+@[^>\s]+)\s*>\s*$/);
  if (match) {
    return {
      name: (match[1] || '').trim() || null,
      email: match[2].trim(),
    };
  }
  // Bare email — no display name.
  if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(trimmed)) {
    return { name: null, email: trimmed };
  }
  return { name: null, email: null };
}

/**
 * Confirm the `email_settings` table exists — the seeder must be a no-op
 * on installations where migration 089 hasn't been applied yet, rather
 * than crash the process. Returns true if the table is queryable.
 */
async function tableExists() {
  try {
    await pool.query('SELECT 1 FROM email_settings LIMIT 1');
    return true;
  } catch (err) {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist|no such table/i.test(err.message || ''))) {
      return false;
    }
    // Some other DB error — surface via the outer catch so it gets logged.
    throw err;
  }
}

async function hasAnyRow() {
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM email_settings WHERE deleted_at IS NULL',
  );
  return Number(total) > 0;
}

/**
 * Read env, build the payload, insert as active. Returns { migrated:true }
 * on success; { migrated:false, reason } otherwise.
 */
async function migrateFromEnv() {
  if (!(await tableExists())) {
    return { migrated: false, reason: 'email_settings table does not exist yet (run migration 089).' };
  }
  if (await hasAnyRow()) {
    return { migrated: false, reason: 'already-configured' };
  }

  const smtpHost = (process.env.SMTP_HOST || '').trim();
  if (!smtpHost) {
    return { migrated: false, reason: 'SMTP_HOST not set in env — nothing to migrate.' };
  }

  const smtpPort = Number(process.env.SMTP_PORT) || 587;
  // SMTP_SECURE=true meant implicit TLS (port 465). Any other value defaults
  // to STARTTLS on 587 which we map to 'tls'.
  const secureFlag = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const encryption = secureFlag ? 'ssl' : 'tls';

  const smtpUsername = (process.env.SMTP_USER || '').trim() || null;
  const smtpPassword = process.env.SMTP_PASS || '';

  // Sender identity: prefer SMTP_FROM ("Name <email>") when present, then
  // fall back to explicit SMTP_FROM_NAME / SMTP_FROM_EMAIL, then to the
  // authenticated username (many providers require From: to match auth).
  let senderName = (process.env.SMTP_FROM_NAME || '').trim() || null;
  let senderEmail = (process.env.SMTP_FROM_EMAIL || '').trim() || null;
  if (!senderEmail || !senderName) {
    const parsed = parseFromHeader(process.env.SMTP_FROM);
    senderEmail = senderEmail || parsed.email;
    senderName = senderName || parsed.name;
  }
  if (!senderEmail && smtpUsername && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(smtpUsername)) {
    senderEmail = smtpUsername;
  }
  if (!senderEmail) {
    return { migrated: false, reason: 'No sender email in env (SMTP_FROM / SMTP_FROM_EMAIL) — skipping seed.' };
  }
  if (!senderName) {
    // Non-fatal — pick a sensible default that admins can rename via the UI.
    senderName = 'Nashik Property Deals';
  }

  // Administrator recipient — used by PIN recovery + admin notifications.
  // Prefer an explicit ADMIN_NOTIFICATION_EMAIL / ADMIN_EMAIL if the
  // operator still has one set (this env var is no longer read at runtime,
  // but we honor it during migration for continuity). Otherwise reuse the
  // sender address so PIN recovery can still function.
  let adminEmail = null;
  for (const key of LEGACY_ADMIN_EMAIL_KEYS) {
    const v = (process.env[key] || '').trim();
    if (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { adminEmail = v; break; }
  }
  if (!adminEmail) adminEmail = senderEmail;

  const password_ciphertext = smtpPassword ? encryptSecret(smtpPassword) : null;

  await emailSettings.create({
    smtp_host: smtpHost,
    smtp_port: smtpPort,
    smtp_username: smtpUsername,
    password_ciphertext,
    sender_email: senderEmail.toLowerCase(),
    sender_name: senderName,
    encryption,
    reply_to_email: null,
    admin_email: adminEmail.toLowerCase(),
    is_active: 1, // seed directly as Active — this is the whole point of the migration
    adminId: null,
    actorName: 'Env Migration',
  });

  return {
    migrated: true,
    summary: {
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      encryption,
      sender_email: senderEmail,
      sender_name: senderName,
      admin_email: adminEmail,
      hasPassword: !!password_ciphertext,
    },
  };
}

/**
 * Boot-hook wrapper: never throws, always logs. Intended to be called
 * once, right before the HTTP listener starts.
 */
async function runIfNeeded() {
  try {
    const result = await migrateFromEnv();
    if (result.migrated) {
      // eslint-disable-next-line no-console
      console.log('[email-master] Seeded initial Active configuration from .env:', {
        host: result.summary.smtp_host,
        port: result.summary.smtp_port,
        encryption: result.summary.encryption,
        sender: `${result.summary.sender_name} <${result.summary.sender_email}>`,
        admin: result.summary.admin_email,
        password: result.summary.hasPassword ? 'set (encrypted)' : 'none',
      });
      // eslint-disable-next-line no-console
      console.log('[email-master] You may now remove SMTP_* and ADMIN_NOTIFICATION_EMAIL from .env — they are no longer read at runtime.');
    } else if (result.reason && result.reason !== 'already-configured') {
      // eslint-disable-next-line no-console
      console.warn('[email-master] Env migration skipped:', result.reason);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[email-master] Env migration failed (server still starting):', err && err.message);
  }
}

module.exports = { runIfNeeded, migrateFromEnv, parseFromHeader };
