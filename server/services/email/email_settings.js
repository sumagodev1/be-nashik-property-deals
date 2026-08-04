/**
 * Global / Email master service.
 *
 * Owns:
 *  - CRUD on the email_settings singleton.
 *  - Encryption/decryption of the SMTP password (via security/crypto).
 *  - The "only one active at a time" invariant (activate() is transactional
 *    at the DB layer; other paths never flip is_active to 1 without going
 *    through activate()).
 *  - Building a nodemailer transport from an active row (used by
 *    services/email/transporter.js — the central sender).
 *  - Sending a "test" email so admins can validate the config without
 *    triggering a real workflow.
 *
 * NOT exposed to the API:
 *  - The plaintext password ever leaves the service. `toApi()` masks it
 *    with a boolean `hasPassword` flag so the UI can show "•••••• (set)"
 *    without ever transmitting the secret.
 */

const nodemailer = require('nodemailer');
const { HttpError } = require('../../middleware/errors');
const emailSettings = require('../../db/queries/email_settings');
const admins = require('../../db/queries/admins');
const subAdmins = require('../../db/queries/sub_admins');
const { encryptSecret, decryptSecret } = require('../security/crypto');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(field, value, { required = true } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new HttpError(400, 'VALIDATION_ERROR', `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string' || !EMAIL_REGEX.test(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} is not a valid email address.`);
  }
  return value.trim().toLowerCase();
}

function assertNonEmpty(field, value, max = 255) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} is required.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${field} must be at most ${max} characters.`);
  }
  return trimmed;
}

function normalizePort(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'SMTP Port must be an integer between 1 and 65535.');
  }
  return n;
}

function normalizeEncryption(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (['none', 'ssl', 'tls'].includes(v)) return v;
  throw new HttpError(400, 'VALIDATION_ERROR', 'Encryption must be one of: none, ssl, tls.');
}

/**
 * API projection: strips password_ciphertext, exposes only a boolean flag
 * so the UI can render "password is set / not set" without seeing the
 * secret. Also mirrors camelCase aliases for React ergonomics.
 */
function toApi(row) {
  if (!row) return null;
  const { password_ciphertext, ...safe } = row;
  return {
    ...safe,
    hasPassword: !!password_ciphertext,
    createdByName: safe.created_by_name || null,
    updatedByName: safe.updated_by_name || null,
  };
}

async function resolveActor(req) {
  const role = req?.auth?.role || null;
  const rawSub = req?.auth?.sub;
  const subjectId = rawSub != null ? Number(rawSub) : null;
  if (!subjectId || Number.isNaN(subjectId)) {
    return { adminId: null, actorName: null };
  }
  if (role === 'admin') {
    const found = await admins.findActiveById(subjectId);
    return { adminId: subjectId, actorName: found?.full_name || null };
  }
  if (role === 'sub_admin') {
    const found = await subAdmins.findById(subjectId);
    return { adminId: null, actorName: found?.full_name || null };
  }
  return { adminId: null, actorName: null };
}

async function list(params) {
  const res = await emailSettings.list(params);
  return { ...res, data: res.data.map(toApi) };
}

async function getOne(id) {
  const row = await emailSettings.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Email configuration not found.');
  return toApi(row);
}

function validateBody(body, { isCreate }) {
  const out = {};
  if (isCreate || 'smtp_host' in body) out.smtp_host = assertNonEmpty('SMTP Host', body.smtp_host);
  if (isCreate || 'smtp_port' in body) out.smtp_port = normalizePort(body.smtp_port ?? 587);
  if ('smtp_username' in body) {
    out.smtp_username = body.smtp_username
      ? String(body.smtp_username).trim().slice(0, 255)
      : null;
  }
  if (isCreate || 'sender_email' in body) out.sender_email = assertEmail('Sender Email', body.sender_email);
  if (isCreate || 'sender_name' in body) out.sender_name = assertNonEmpty('Sender Name', body.sender_name);
  if (isCreate || 'encryption' in body) out.encryption = normalizeEncryption(body.encryption ?? 'tls');
  if ('reply_to_email' in body) out.reply_to_email = body.reply_to_email
    ? assertEmail('Reply-To Email', body.reply_to_email, { required: false })
    : null;
  if (isCreate || 'admin_email' in body) out.admin_email = assertEmail('Administrator Email', body.admin_email);
  if ('is_active' in body) out.is_active = !!body.is_active;
  return out;
}

async function create(body, req) {
  const clean = validateBody(body || {}, { isCreate: true });
  const { adminId, actorName } = await resolveActor(req);

  // Password is optional (unauthenticated SMTP servers exist) but if the
  // caller sends `password: ""` we treat it as "no password". Only encrypt
  // when there's actually something to encrypt.
  const rawPassword = body?.password;
  const password_ciphertext = rawPassword ? encryptSecret(String(rawPassword)) : null;

  const requestedActive = clean.is_active === true;
  // Create with is_active=0 first — activate() is the one path that flips
  // is_active to 1 (transactional, exclusive).
  const created = await emailSettings.create({
    ...clean,
    is_active: 0,
    password_ciphertext,
    adminId,
    actorName,
  });

  if (requestedActive) {
    await emailSettings.activateExclusive(created.id, { adminId, actorName });
    invalidateActiveCache();
    return toApi(await emailSettings.getById(created.id));
  }

  return toApi(created);
}

async function update(id, body, req) {
  const existing = await emailSettings.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Email configuration not found.');

  const clean = validateBody(body || {}, { isCreate: false });
  const { adminId, actorName } = await resolveActor(req);

  const patch = { ...clean, adminId, actorName };

  // Password handling: only touch the column when the caller explicitly
  // sends a `password` key. Empty string means "clear the password".
  if (Object.prototype.hasOwnProperty.call(body || {}, 'password')) {
    patch.password_ciphertext = body.password ? encryptSecret(String(body.password)) : null;
  }

  // is_active is applied via activate() below, not directly, to preserve
  // the exclusive invariant. Strip it from the patch.
  const requestedActive = patch.is_active === true;
  const requestedInactive = patch.is_active === false;
  delete patch.is_active;

  await emailSettings.update(id, patch);

  if (requestedActive) {
    await emailSettings.activateExclusive(id, { adminId, actorName });
  } else if (requestedInactive && existing.is_active) {
    await emailSettings.update(id, { is_active: false, adminId, actorName });
  }
  invalidateActiveCache();
  return toApi(await emailSettings.getById(id));
}

async function remove(id, req) {
  const existing = await emailSettings.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Email configuration not found.');
  await emailSettings.softDelete(id);
  invalidateActiveCache();
}

async function activate(id, req) {
  const existing = await emailSettings.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Email configuration not found.');
  const { adminId, actorName } = await resolveActor(req);
  await emailSettings.activateExclusive(id, { adminId, actorName });
  invalidateActiveCache();
  return toApi(await emailSettings.getById(id));
}

// -----------------------------------------------------------------------
// Transport builder — used by the central sender (transporter.js) and by
// the test-email endpoint. Never returns plaintext to callers.
// -----------------------------------------------------------------------

/**
 * Build a nodemailer transport spec from a settings row. Decrypts the
 * password once, in memory, then hands the object to nodemailer. Not
 * exported — callers use buildActiveTransport().
 */
function buildTransportFromRow(row) {
  const encryption = row.encryption || 'tls';
  const secure = encryption === 'ssl'; // implicit TLS from the start
  // For 'tls' we let nodemailer negotiate STARTTLS on port 587.
  const password = decryptSecret(row.password_ciphertext);
  const auth = row.smtp_username || password ? {
    user: row.smtp_username || undefined,
    pass: password || undefined,
  } : undefined;
  const transport = nodemailer.createTransport({
    host: row.smtp_host,
    port: row.smtp_port,
    secure,
    auth,
    requireTLS: encryption === 'tls',
  });
  return {
    transporter: transport,
    from: `"${row.sender_name}" <${row.sender_email}>`,
    replyTo: row.reply_to_email || undefined,
    adminEmail: row.admin_email,
  };
}

let cachedTransport = null;
let cachedForId = null;

/**
 * Returns { transporter, from, replyTo, adminEmail } for the currently
 * active Email Master row, or null if no active config exists. Cached
 * between calls; invalidateActiveCache() (called on every write) forces
 * a rebuild on next use.
 */
async function buildActiveTransport() {
  if (cachedTransport && cachedForId != null) {
    const still = await emailSettings.getById(cachedForId);
    if (still && still.is_active && !still.deleted_at) return cachedTransport;
    invalidateActiveCache();
  }
  const active = await emailSettings.getActive();
  if (!active) return null;
  cachedTransport = buildTransportFromRow(active);
  cachedForId = active.id;
  return cachedTransport;
}

function invalidateActiveCache() {
  cachedTransport = null;
  cachedForId = null;
}

/**
 * Build a transport from a specific settings row without going through the
 * cache. Used by the "Test Email" endpoint so admins can validate an
 * inactive config before flipping the active switch.
 */
async function buildTransportForId(id) {
  const row = await emailSettings.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Email configuration not found.');
  return buildTransportFromRow(row);
}

/**
 * Send a self-test email using the given settings row. Recipient defaults
 * to the row's admin_email so the person configuring can confirm they
 * actually receive it.
 */
async function sendTestEmail(id, { recipient } = {}) {
  const t = await buildTransportForId(id);
  const to = recipient ? String(recipient).trim().toLowerCase() : t.adminEmail;
  if (!to || !EMAIL_REGEX.test(to)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Recipient email is not valid.');
  }
  try {
    await t.transporter.sendMail({
      from: t.from,
      to,
      replyTo: t.replyTo,
      subject: 'Nashik Property Deals — Email Configuration Test',
      text: `This is a test email from the Nashik Property Deals admin console.\n\nIf you received this message, the SMTP configuration is working correctly.\n\nSent: ${new Date().toISOString()}\n`,
      html: `<p>This is a test email from the <strong>Nashik Property Deals</strong> admin console.</p><p>If you received this message, the SMTP configuration is working correctly.</p><p style="color:#888;font-size:12px">Sent: ${new Date().toISOString()}</p>`,
    });
    return { ok: true, sentTo: to };
  } catch (err) {
    throw new HttpError(502, 'SMTP_ERROR', err?.message || 'Failed to send test email.');
  }
}

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
  activate,
  sendTestEmail,
  buildActiveTransport,
  invalidateActiveCache,
};
