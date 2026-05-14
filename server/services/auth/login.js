const bcrypt = require('bcrypt');
const { HttpError } = require('../../middleware/errors');
const admins = require('../../db/queries/admins');
const subAdmins = require('../../db/queries/sub_admins');
const subAdminModules = require('../../db/queries/sub_admin_modules');
const sellers = require('../../db/queries/sellers');
const { signAccessToken } = require('./tokens');

const GENERIC_FAILURE = new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
const DUMMY_HASH = '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalida';

/**
 * Tries admin table first, then sub_admin. Returns a uniform shape regardless
 * of role. Same timing for both miss-paths via dummy bcrypt.
 */
async function login({ email, password }) {
  const admin = await admins.findActiveByEmail(email);
  if (admin) {
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) throw GENERIC_FAILURE;
    await admins.updateLastLogin(admin.id);
    const token = signAccessToken({ subjectId: admin.id, role: 'admin', modules: [] });
    return {
      token,
      user: {
        id: admin.id,
        email: admin.email,
        fullName: admin.full_name,
        role: 'admin',
        modules: [],
      },
    };
  }

  const sub = await subAdmins.findActiveByEmail(email);
  if (sub) {
    const ok = await bcrypt.compare(password, sub.password_hash);
    if (!ok) throw GENERIC_FAILURE;
    const modules = await subAdminModules.listForSubAdmin(sub.id);
    await subAdmins.updateLastLogin(sub.id);
    const token = signAccessToken({ subjectId: sub.id, role: 'sub_admin', modules });
    return {
      token,
      user: {
        id: sub.id,
        email: sub.email,
        fullName: sub.full_name,
        role: 'sub_admin',
        modules,
      },
    };
  }

  // Neither account found — burn a dummy hash for timing symmetry.
  await bcrypt.compare(password, DUMMY_HASH);
  throw GENERIC_FAILURE;
}

async function me(auth) {
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Not signed in');

  if (auth.role === 'admin') {
    const admin = await admins.findActiveById(Number(auth.sub));
    if (!admin) throw new HttpError(401, 'UNAUTHENTICATED', 'Account no longer active');
    return {
      id: admin.id,
      email: admin.email,
      fullName: admin.full_name,
      role: 'admin',
      modules: [],
    };
  }

  if (auth.role === 'sub_admin') {
    const sub = await subAdmins.findActiveById(Number(auth.sub));
    if (!sub) throw new HttpError(401, 'UNAUTHENTICATED', 'Account no longer active');
    const modules = await subAdminModules.listForSubAdmin(sub.id);
    return {
      id: sub.id,
      email: sub.email,
      fullName: sub.full_name,
      role: 'sub_admin',
      modules,
    };
  }

  if (auth.role === 'seller') {
    const seller = await sellers.findActiveById(Number(auth.sub));
    if (!seller || !seller.is_verified) throw new HttpError(401, 'UNAUTHENTICATED', 'Account no longer active');
    return {
      id: seller.id,
      email: seller.email,
      mobile: seller.mobile_number,
      fullName: seller.full_name,
      userType: seller.user_type,
      role: 'seller',
      modules: [],
    };
  }

  throw new HttpError(401, 'UNAUTHENTICATED', 'Unknown role');
}

module.exports = { login, me };
