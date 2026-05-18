const bcrypt = require('bcrypt');
const { HttpError } = require('../../middleware/errors');
const subAdmins = require('../../db/queries/sub_admins');
const modulesRepo = require('../../db/queries/sub_admin_modules');
const { isValidModuleKey } = require('../../constants/modules');
const { trySendMail } = require('../email/transporter');

const BCRYPT_COST = 12;

function buildLoginUrl() {
  const base = (process.env.APP_PUBLIC_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/admin/login`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function passwordResetEmail({ email, fullName, newPassword }) {
  const safeName = fullName ? `, ${fullName}` : '';
  const loginUrl = buildLoginUrl();
  const subject = 'Your Nasik Property Deals admin password has been updated';
  const text = [
    `Hello${safeName},`,
    '',
    'An administrator has set a new password on your Nasik Property Deals admin account.',
    'You can sign in with these credentials:',
    '',
    `Email:    ${email}`,
    `Password: ${newPassword}`,
    '',
    `Sign in: ${loginUrl}`,
    '',
    'For your security, please sign in and change your password as soon as you can.',
    "If you didn't expect this change, contact your administrator immediately.",
    '',
    '— Nasik Property Deals',
  ].join('\n');
  const html = `
    <p>Hello${escapeHtml(safeName)},</p>
    <p>An administrator has set a new password on your Nasik Property Deals admin account.</p>
    <p>You can sign in with these credentials:</p>
    <table style="border-collapse:collapse;margin:8px 0 16px 0;font-size:14px">
      <tr>
        <td style="padding:6px 14px 6px 0;color:#5d6878">Email</td>
        <td style="padding:6px 0;font-family:Consolas,Menlo,monospace">${escapeHtml(email)}</td>
      </tr>
      <tr>
        <td style="padding:6px 14px 6px 0;color:#5d6878">Password</td>
        <td style="padding:6px 0;font-family:Consolas,Menlo,monospace;font-weight:600">${escapeHtml(newPassword)}</td>
      </tr>
    </table>
    <p>
      <a href="${loginUrl}" style="display:inline-block;padding:10px 16px;background:#255593;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a>
    </p>
    <p style="font-size:13px;color:#5d6878">For your security, please sign in and change your password as soon as you can.</p>
    <hr style="border:none;border-top:1px solid #eaeef2;margin:24px 0">
    <p style="font-size:12px;color:#5d6878">If you didn't expect this change, contact your administrator immediately.</p>
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
    // Email the sub admin their new credentials. `trySendMail` attempts an
    // immediate send and queues for retry on SMTP failure — we never roll
    // back the password change because email delivery hiccupped (same rule
    // as lead notifications: the write of record takes precedence).
    const { subject, text, html } = passwordResetEmail({
      email: nextEmail,
      fullName: nextFullName,
      newPassword: password,
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
