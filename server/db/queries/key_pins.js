/**
 * DB layer for the Key PIN master.
 *
 * Rows are stored with bcrypt-hashed PINs — plaintext PINs never enter this
 * layer beyond the initial hash produced by the service. The `hashed_pin`
 * column is intentionally NOT included in the public-facing SELECT list;
 * callers who need to verify a PIN use `listActiveForVerification()` which
 * returns the hashes explicitly (never returned by any HTTP response).
 */

const { pool } = require('../pool');

// Safe projection — omits `hashed_pin` so it can never leak via list/getById.
const PUBLIC_COLUMNS = `
  id, username, status,
  created_by_admin_id, created_by_name,
  updated_by_admin_id, updated_by_name,
  created_at, updated_at
`;

async function list({ page = 1, pageSize = 10, status = null, search = null } = {}) {
  const offset = (page - 1) * pageSize;
  const args = [];
  let where = 'WHERE deleted_at IS NULL';
  if (status === 'active' || status === 'inactive') {
    where += ' AND status = ?';
    args.push(status);
  }
  const term = typeof search === 'string' ? search.trim() : '';
  if (term) {
    // PIN is bcrypt-hashed so it cannot be searched. We search only the
    // identification fields exposed on the listing (username + creator name).
    where += ' AND (username LIKE ? OR created_by_name LIKE ?)';
    const like = `%${term}%`;
    args.push(like, like);
  }
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM key_pins ${where}`,
    args,
  );
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM key_pins ${where}
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...args, pageSize, offset],
  );
  return { data: rows, total: Number(total), page, pageSize };
}

async function getById(id) {
  const [rows] = await pool.query(
    `SELECT ${PUBLIC_COLUMNS} FROM key_pins
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] || null;
}

async function countActive() {
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM key_pins
     WHERE status = 'active' AND deleted_at IS NULL`,
  );
  return Number(total);
}

async function create({ hashedPin, username = null, status = 'active', adminId = null, actorName = null }) {
  const [r] = await pool.query(
    `INSERT INTO key_pins
       (username, hashed_pin, status,
        created_by_admin_id, created_by_name,
        updated_by_admin_id, updated_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [username, hashedPin, status, adminId, actorName, adminId, actorName],
  );
  return getById(r.insertId);
}

async function update(id, { hashedPin = null, username, status = null, adminId = null, actorName = null } = {}) {
  const sets = [];
  const args = [];
  if (hashedPin !== null) {
    sets.push('hashed_pin = ?');
    args.push(hashedPin);
  }
  // `username` uses `undefined` as the sentinel for "unchanged" so callers
  // can explicitly pass `null` to clear the field.
  if (username !== undefined) {
    sets.push('username = ?');
    args.push(username);
  }
  if (status !== null) {
    sets.push('status = ?');
    args.push(status);
  }
  sets.push('updated_by_admin_id = ?');
  args.push(adminId);
  sets.push('updated_by_name = ?');
  args.push(actorName);
  args.push(id);

  await pool.query(
    `UPDATE key_pins SET ${sets.join(', ')}
     WHERE id = ? AND deleted_at IS NULL`,
    args,
  );
  return getById(id);
}

async function softDelete(id) {
  await pool.query(
    `UPDATE key_pins SET deleted_at = CURRENT_TIMESTAMP
     WHERE id = ? AND deleted_at IS NULL`,
    [id],
  );
}

/**
 * Returns only { id, hashed_pin } for every active, non-deleted PIN. Used
 * exclusively by the verify flow to bcrypt-compare an incoming plaintext
 * PIN against each active hash. This is the ONE place hashes leave the
 * DB layer — the service never returns them further.
 */
async function listActiveForVerification() {
  const [rows] = await pool.query(
    `SELECT id, hashed_pin FROM key_pins
     WHERE status = 'active' AND deleted_at IS NULL`,
  );
  return rows;
}

module.exports = {
  list,
  getById,
  countActive,
  create,
  update,
  softDelete,
  listActiveForVerification,
};
