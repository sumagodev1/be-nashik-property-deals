const bcrypt = require('bcrypt');
const { HttpError } = require('../../middleware/errors');
const subAdmins = require('../../db/queries/sub_admins');
const modulesRepo = require('../../db/queries/sub_admin_modules');
const { isValidModuleKey } = require('../../constants/modules');
const { trySendMail } = require('../email/transporter');
const audit = require('../admin/audit');

const BCRYPT_COST = 12;

function buildLoginUrl() {
  const base = (process.env.APP_PUBLIC_URL || 'http://nasikpropertydeals.betaprojects.in/admin/').replace(/\/+$/, '');
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
      <a href="${loginUrl}" style="display:inline-block;padding:10px 16px;background:#C62828;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Open sign-in page</a>
    </p>
    <hr style="border:none;border-top:1px solid #eaeef2;margin:24px 0">
    <p style="font-size:12px;color:#5d6878">If you didn't expect this email, contact your administrator immediately.</p>
  `;
  return { subject, text, html };
}

// T-2026-173: dedupeModules now accepts EITHER shape (legacy string array
// OR array of { module_key, access_level }). Returns a normalized array of
// { module_key, access_level } objects — the shape sub_admin_modules table
// persists.
//
// Backward compat rule (matches migration 110 DEFAULT and the query-layer
// normalizeGrants): a bare string key is treated as an implicit 'write'
// grant so pre-T-173 API callers keep the same effective permission.
function dedupePermissions(input) {
  const byKey = new Map();
  for (const entry of input || []) {
    let key;
    let level;
    if (typeof entry === 'string') {
      key = entry;
      level = 'write';
    } else if (entry && typeof entry === 'object') {
      key = entry.module_key;
      level = entry.access_level === 'read' ? 'read' : 'write';
    } else {
      throw new HttpError(400, 'INVALID_MODULE', 'Malformed module grant');
    }
    if (!isValidModuleKey(key)) {
      throw new HttpError(400, 'INVALID_MODULE', `Unknown module key: ${key}`);
    }
    byKey.set(key, { module_key: key, access_level: level });
  }
  return Array.from(byKey.values());
}

/**
 * How many sub-admin accounts may exist at once.
 *
 * The product allows exactly one delegated account alongside the single
 * built-in Administrator. Enforced HERE, in the service, so it holds for
 * every caller — the "+ New Sub Admin" button is hidden in the UI, but a
 * direct POST /api/admin/sub-admins would otherwise walk straight past that.
 *
 * A seat is held by an ACTIVE account. Deactivating or deleting the current
 * sub admin frees the slot immediately — an account that cannot sign in is
 * not using its seat, and deactivating is the non-destructive way to hand the
 * seat to someone else while keeping the old account's history.
 */
const MAX_SUB_ADMINS = 1;

async function list({ page, pageSize, search, isActive }) {
  const { rows, total } = await subAdmins.list({ page, pageSize, search, isActive });
  // `total` is filtered by search / isActive, so it cannot drive the seat
  // cap — a search that matches nothing would look like a free slot. Send the
  // unfiltered live count and the cap alongside it.
  const activeCount = await subAdmins.countActive();
  return {
    data: rows.map(toListItem),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    activeCount,
    maxSubAdmins: MAX_SUB_ADMINS,
    canCreate: activeCount < MAX_SUB_ADMINS,
  };
}

async function getOne(id) {
  const sub = await subAdmins.findById(id);
  if (!sub) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  const modules = await modulesRepo.listForSubAdmin(id);
  return toDetail(sub, modules);
}

async function create({ email, password, fullName, isActive, modules, createdByAdminId, req = null }) {
  // Seat cap. Checked before anything else so a rejected attempt neither
  // hashes a password nor touches a row. Covers the restore-in-place branch
  // below too: reviving a soft-deleted account also consumes a seat.
  const activeCount = await subAdmins.countActive();
  if (activeCount >= MAX_SUB_ADMINS) {
    throw new HttpError(
      409,
      'SUB_ADMIN_LIMIT_REACHED',
      `Only ${MAX_SUB_ADMINS} active sub admin account is allowed. `
      + 'Deactivate or delete the existing sub admin before creating another one.',
    );
  }
  if (await subAdmins.emailTaken(email)) {
    throw new HttpError(409, 'EMAIL_TAKEN', 'A sub admin with this email already exists');
  }
  const permissions = dedupePermissions(modules || []);
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  // sub_admins.email is UNIQUE at the DB level across ALL rows including
  // soft-deleted ones. If a previous sub admin with this email was deleted,
  // a fresh INSERT would crash with ER_DUP_ENTRY. Restore-in-place instead:
  // wipe deleted_at, re-key the row with the new password / name / modules.
  // The id stays the same so any historical audit-log / lead-assignment
  // entries still resolve to a real row, but the row is functionally a
  // brand-new account.
  const existing = await subAdmins.findAnyByEmail(email);
  let id;
  if (existing && existing.deleted_at) {
    await subAdmins.restoreSoftDeleted(existing.id, {
      passwordHash,
      fullName,
      isActive: isActive !== false,
    });
    id = existing.id;
  } else {
    id = await subAdmins.create({
      email,
      passwordHash,
      fullName,
      isActive: isActive !== false,
      createdByAdminId,
    });
  }
  await modulesRepo.replaceForSubAdmin(id, permissions);
  if (req) {
    void audit.record(req, {
      action: 'sub_admin.created',
      entityType: 'sub_admin',
      entityId: id,
      summary: `Created sub admin ${fullName} (${email})`,
      metadata: {
        entityLabel: fullName,
        entitySubLabel: email,
        // T-173: audit metadata records the full grant shape so the log
        // preserves the read/write intent, not just the module list.
        modules: permissions,
        restored: !!(existing && existing.deleted_at),
      },
    });
  }
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

async function update(id, { email, fullName, isActive, password }, req = null) {
  const existing = await subAdmins.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  if (email && email !== existing.email) {
    if (await subAdmins.emailTaken(email, id)) {
      throw new HttpError(409, 'EMAIL_TAKEN', 'A sub admin with this email already exists');
    }
  }
  // Activating consumes a seat, so it is capped exactly like creating.
  // Without this, the seat freed by deactivating account A could be used to
  // create account B, and A could then simply be switched back on — leaving
  // two active sub admins. `excludeId` keeps THIS row out of the count so
  // re-saving an already-active account is never blocked by itself.
  const willBeActive = typeof isActive === 'boolean' ? isActive : Boolean(existing.is_active);
  if (willBeActive && !existing.is_active) {
    const otherActive = await subAdmins.countActive(id);
    if (otherActive >= MAX_SUB_ADMINS) {
      throw new HttpError(
        409,
        'SUB_ADMIN_LIMIT_REACHED',
        `Only ${MAX_SUB_ADMINS} active sub admin account is allowed. `
        + 'Deactivate the other sub admin before activating this one.',
      );
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
  if (req) {
    // Track which of the mutable fields actually changed so the audit
    // metadata isn't polluted with no-op renames.
    const changed = {};
    if (nextEmail !== existing.email) changed.email = { from: existing.email, to: nextEmail };
    if (nextFullName !== existing.full_name) changed.fullName = { from: existing.full_name, to: nextFullName };
    if (typeof isActive === 'boolean' && Boolean(isActive) !== Boolean(existing.is_active)) {
      changed.isActive = { from: Boolean(existing.is_active), to: isActive };
    }
    if (password) changed.password = true;
    // Skip the audit entry entirely if literally nothing changed.
    if (Object.keys(changed).length > 0) {
      void audit.record(req, {
        action: 'sub_admin.updated',
        entityType: 'sub_admin',
        entityId: id,
        summary: `Updated sub admin ${nextFullName}`,
        metadata: {
          entityLabel: nextFullName,
          entitySubLabel: nextEmail,
          changed,
        },
      });
    }
  }
  return getOne(id);
}

async function updateModules(id, moduleGrants, req = null) {
  const existing = await subAdmins.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  const deduped = dedupePermissions(moduleGrants || []);
  const before = await modulesRepo.listForSubAdmin(id);
  await modulesRepo.replaceForSubAdmin(id, deduped);
  if (req) {
    // T-173: diff on the { module_key, access_level } tuple so a change from
    // read → write (or write → read) is captured, not just add/remove.
    const beforeMap = new Map(before.map((g) => [g.module_key, g.access_level]));
    const afterMap = new Map(deduped.map((g) => [g.module_key, g.access_level]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [k, level] of afterMap.entries()) {
      if (!beforeMap.has(k)) added.push({ module_key: k, access_level: level });
      else if (beforeMap.get(k) !== level) {
        changed.push({ module_key: k, from: beforeMap.get(k), to: level });
      }
    }
    for (const [k, level] of beforeMap.entries()) {
      if (!afterMap.has(k)) removed.push({ module_key: k, access_level: level });
    }
    if (added.length > 0 || removed.length > 0 || changed.length > 0) {
      void audit.record(req, {
        action: 'sub_admin.modules_changed',
        entityType: 'sub_admin',
        entityId: id,
        summary: `Module access changed for ${existing.full_name}`,
        metadata: {
          entityLabel: existing.full_name,
          entitySubLabel: existing.email,
          added,
          removed,
          changed,
          after: deduped,
        },
      });
    }
  }
  return getOne(id);
}

async function remove(id, req = null) {
  const existing = await subAdmins.findById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Sub admin not found');
  await subAdmins.softDelete(id);
  if (req) {
    void audit.record(req, {
      action: 'sub_admin.deleted',
      entityType: 'sub_admin',
      entityId: id,
      summary: `Deleted sub admin ${existing.full_name} (${existing.email})`,
      metadata: {
        entityLabel: existing.full_name,
        entitySubLabel: existing.email,
      },
    });
  }
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
  // T-173: `modules` is now an array of { module_key, access_level }.
  // The FE Sub Admin editor consumes this shape directly to render the
  // Read/Write matrix. The subAdmins API wrapper on the FE side ships a
  // compat shim so a pre-T-173 FE consumer would still see something
  // usable (though the editor would collapse Read+Write into a single
  // boolean — which is exactly the pre-T-173 UX).
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

module.exports = {
  MAX_SUB_ADMINS, list, getOne, create, update, updateModules, remove };
