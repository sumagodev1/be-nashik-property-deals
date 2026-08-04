/**
 * DB layer for the Global / Email master.
 *
 * The password_ciphertext column stores the SMTP password encrypted by the
 * service layer. This queries file never touches plaintext — encryption /
 * decryption happens exclusively in server/services/email/email_settings.js.
 *
 * "Only one active at a time" is enforced by the service (activate() runs
 * a transaction that flips all other rows to inactive). We do NOT use a
 * partial unique index here because MariaDB versions vary in their
 * support for that; the transactional flip is portable and race-safe
 * enough for a single-writer admin master.
 */

const { pool } = require('../pool');

const PUBLIC_COLUMNS = `
  id, smtp_host, smtp_port, smtp_username, password_ciphertext,
  sender_email, sender_name, encryption, reply_to_email, admin_email,
  is_active,
  created_by_admin_id, created_by_name,
  updated_by_admin_id, updated_by_name,
  created_at, updated_at
`;

async function list({ page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM email_settings WHERE deleted_at IS NULL`,
  );
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM email_settings
     WHERE deleted_at IS NULL
     ORDER BY is_active DESC, id DESC
     LIMIT ? OFFSET ?`,
    [pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getById(id) {
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM email_settings
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function getActive() {
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM email_settings
     WHERE is_active = 1 AND deleted_at IS NULL
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  return rows[0] || null;
}

async function create(payload) {
  const {
    smtp_host, smtp_port = 587, smtp_username = null, password_ciphertext = null,
    sender_email, sender_name, encryption = 'tls', reply_to_email = null,
    admin_email, is_active = 0,
    adminId = null, actorName = null,
  } = payload;

  const [r] = await pool.query(
    `INSERT INTO email_settings
       (smtp_host, smtp_port, smtp_username, password_ciphertext,
        sender_email, sender_name, encryption, reply_to_email,
        admin_email, is_active,
        created_by_admin_id, created_by_name,
        updated_by_admin_id, updated_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      smtp_host, smtp_port, smtp_username, password_ciphertext,
      sender_email, sender_name, encryption, reply_to_email,
      admin_email, is_active ? 1 : 0,
      adminId, actorName, adminId, actorName,
    ],
  );
  return getById(r.insertId);
}

/**
 * Partial update. Any field not present in `patch` is left untouched.
 * `password_ciphertext` uses `undefined` as the sentinel for "unchanged"
 * so callers can explicitly pass `null` to clear the password.
 */
async function update(id, patch = {}) {
  const sets = [];
  const args = [];
  const fields = [
    'smtp_host', 'smtp_port', 'smtp_username',
    'sender_email', 'sender_name', 'encryption', 'reply_to_email',
    'admin_email',
  ];
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) {
      sets.push(`${f} = ?`);
      args.push(patch[f]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'password_ciphertext')) {
    sets.push('password_ciphertext = ?');
    args.push(patch.password_ciphertext);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'is_active')) {
    sets.push('is_active = ?');
    args.push(patch.is_active ? 1 : 0);
  }
  sets.push('updated_by_admin_id = ?');
  args.push(patch.adminId ?? null);
  sets.push('updated_by_name = ?');
  args.push(patch.actorName ?? null);

  if (sets.length === 2) {
    // Only actor fields — no real change. Skip the write.
    return getById(id);
  }

  args.push(id);
  await pool.query(
    `UPDATE email_settings SET ${sets.join(', ')}
     WHERE id = ? AND deleted_at IS NULL`,
    args,
  );
  return getById(id);
}

async function softDelete(id) {
  await pool.query(
    `UPDATE email_settings SET deleted_at = CURRENT_TIMESTAMP, is_active = 0
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/**
 * Transactionally activate one row and deactivate all others. Guarantees
 * the "only one active at a time" invariant.
 */
async function activateExclusive(id, actor = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE email_settings SET is_active = 0,
         updated_by_admin_id = ?, updated_by_name = ?
       WHERE is_active = 1 AND deleted_at IS NULL AND id <> ?`,
      [actor.adminId ?? null, actor.actorName ?? null, id],
    );
    await conn.query(
      `UPDATE email_settings SET is_active = 1,
         updated_by_admin_id = ?, updated_by_name = ?
       WHERE id = ? AND deleted_at IS NULL`,
      [actor.adminId ?? null, actor.actorName ?? null, id],
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getById(id);
}

module.exports = {
  list, getById, getActive, create, update, softDelete, activateExclusive,
};
