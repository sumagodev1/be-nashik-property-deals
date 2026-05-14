const bcrypt = require('bcrypt');
const { HttpError } = require('../../middleware/errors');
const subAdmins = require('../../db/queries/sub_admins');
const modulesRepo = require('../../db/queries/sub_admin_modules');
const { isValidModuleKey } = require('../../constants/modules');

const BCRYPT_COST = 12;

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
  await subAdmins.updateProfile(id, {
    fullName: fullName ?? existing.full_name,
    email: email ?? existing.email,
    isActive: typeof isActive === 'boolean' ? isActive : Boolean(existing.is_active),
  });
  if (password) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await subAdmins.updatePassword(id, passwordHash);
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
