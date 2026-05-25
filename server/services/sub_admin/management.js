const bcrypt = require('bcrypt');
const { HttpError } = require('../../middleware/errors');
const subAdmins = require('../../db/queries/sub_admins');
const modulesRepo = require('../../db/queries/sub_admin_modules');
const { isValidModuleKey } = require('../../constants/modules');
const { trySendMail } = require('../email/transporter');

const BCRYPT_COST = 12;

function buildLoginUrl() {
  const base = (process.env.APP_PUBLIC_URL || 'https://nashikpropertybackend.sumagodemo.com/').replace(/\/+$/, '');
  return `${base}/admin/login`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// Sub-admin notification email — sent when an administrator (re)sets their
// password OR creates a new sub-admin account. We deliberately DO NOT send
// the password itself: plaintext credentials in email violate CLAUDE.md
// ("never log passwords, never return password hashes in responses"). The
// sub-admin sets their own password using the standard email-OTP Forgot
// Password flow that admins already use.
function notifyEmail({ email, fullName, kind }) {
  // `kind` is one of: 'created' | 'password-reset'
  const isCreate = kind === 'created';
  const safeName = fullName ? `, ${fullName}` : '';
  const loginUrl = buildLoginUrl();
  const subject = isCreate
    ? 'Your Nasik Property Deals admin account is ready'
    : 'Your Nasik Property Deals admin password was updated';
  const opener = isCreate
    ? 'An administrator has created an admin account for you on Nasik Property Deals.'
    : 'An administrator has updated the password on your Nasik Property Deals admin account.';
  const instruction = isCreate
    ? 'To set your password, open the sign-in page below, click "Forgot password?", and enter this email. You will receive a 6-digit code by email and can then choose your own password.'
    : 'For security, the new password is not included in this email. To sign in, open the sign-in page below, click "Forgot password?", and choose a new password using the 6-digit code we email you.';
  const text = [
    `Hello${safeName},`,
    '',
    opener,
    '',
    `Account email: ${email}`,
    '',
    instruction,
    '',
    `Sign in: ${loginUrl}`,
    '',
    "If you didn't expect this email, contact your administrator immediately.",
    '',
    '— Nasik Property Deals',
  ].join('\n');
  const html = `
    <p>Hello${escapeHtml(safeName)},</p>
    <p>${escapeHtml(opener)}</p>
    <table style="border-collapse:collapse;margin:8px 0 16px 0;font-size:14px">
      <tr>
        <td style="padding:6px 14px 6px 0;color:#5d6878">Account email</td>
        <td style="padding:6px 0;font-family:Consolas,Menlo,monospace">${escapeHtml(email)}</td>
      </tr>
    </table>
    <p style="font-size:13px;color:#374151">${escapeHtml(instruction)}</p>
    <p>
      <a href="${loginUrl}" style="display:inline-block;padding:10px 16px;background:#255593;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open sign-in page</a>
    </p>
    <hr style="border:none;border-top:1px solid #eaeef2;margin:24px 0">
    <p style="font-size:12px;color:#5d6878">If you didn't expect this email, contact your administrator immediately.</p>
  `;
  return { subject, text, html };
}

function dedupeModules(keys) {
  const seen = new Set();
  for (const k of keys) {
    if (!isValidModuleKey(k)) {
      throw new HttpError(400, 'INVALID_MODULE', `Unknown module key: ${k}`);
    }
    seen.add(k);
  }
  return Array.from(seen);
}

async function list({ page, pageSize, search, isActive }) {
  const { rows, total } = await subAdmins.list({ page, pageSize, search, isActive });
  return {
    data: rows.map(toListItem),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function getOne(id) {
  const sub = await subAdmins.findById(id);
  if (!sub) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  const modules = await modulesRepo.listForSubAdmin(id);
  return toDetail(sub, modules);
}

async function create({ email, password, fullName, isActive, modules, createdByAdminId }) {
  if (await subAdmins.emailTaken(email)) {
    throw new HttpError(409, 'EMAIL_TAKEN', 'A sub admin with this email already exists');
  }
  const moduleKeys = dedupeModules(modules || []);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const id = await subAdmins.create({
    email,
    passwordHash,
    fullName,
    isActive: isActive !== false,
    createdByAdminId,
  });
  await modulesRepo.replaceForSubAdmin(id, moduleKeys);
  // Email the new sub admin so they know the account exists. We deliberately
  // do NOT email the password the admin typed — they must use Forgot Password
  // to set their own. The admin-typed password is a placeholder so the column
  // (NOT NULL) is satisfied; in practice the sub-admin will reset it before
  // first login.
  const { subject, text, html } = notifyEmail({
    email,
    fullName,
    kind: 'created',
  });
  await trySendMail({ to: email, subject, text, html });
  return getOne(id);
}

async function update(id, { email, fullName, isActive, password }) {
  const existing = await subAdmins.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  if (email && email !== existing.email) {
    if (await subAdmins.emailTaken(email, id)) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'A sub admin with this email already exists');
    }
  }
  const nextEmail = email ?? existing.email;
  const nextFullName = fullName ?? existing.full_name;
  await subAdmins.updateProfile(id, {
    fullName: nextFullName,
    email: nextEmail,
    isActive: typeof isActive === 'boolean' ? isActive : Boolean(existing.is_active),
  });
  if (password) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await subAdmins.updatePassword(id, passwordHash);
    // Notify the sub admin that their password was updated. We do NOT email
    // the new password itself — plaintext credentials in email violate
    // CLAUDE.md. They use Forgot Password to set their own from here.
    const { subject, text, html } = notifyEmail({
      email: nextEmail,
      fullName: nextFullName,
      kind: 'password-reset',
    });
    await trySendMail({ to: nextEmail, subject, text, html });
  }
  return getOne(id);
}

async function updateModules(id, moduleKeys) {
  const existing = await subAdmins.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  const deduped = dedupeModules(moduleKeys || []);
  await modulesRepo.replaceForSubAdmin(id, deduped);
  return getOne(id);
}

async function remove(id) {
  const existing = await subAdmins.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  await subAdmins.softDelete(id);
}

function toListItem(row) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

function toDetail(row, modules) {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    modules,
  };
}

module.exports = { list, getOne, create, update, updateModules, remove };
