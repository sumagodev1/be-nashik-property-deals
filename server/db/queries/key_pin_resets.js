/**
 * DB layer for the Forget-PIN reset flow (table key_pin_reset_requests)
 * and the audit log (table key_pin_audit_log).
 *
 * The service enforces the "one pending request per PIN" rule by calling
 * invalidatePendingForPin() before inserting a new row — plaintext PINs
 * and OTPs never touch this layer.
 */

const { pool } = require('../pool');

const RESET_COLUMNS = `
  id, key_pin_id, requested_by_admin_id, requested_by_role, requested_by_name,
  otp_hash, verification_token, recipient_email,
  expires_at, verified_at, used_at,
  ip_address, user_agent, created_at
`;

async function createResetRequest({
  keyPinId,
  adminId = null,
  role = 'admin',
  actorName = null,
  otpHash,
  token,
  recipientEmail,
  expiresAt,
  ipAddress = null,
  userAgent = null,
}) {
  const [r] = await pool.query(
    `INSERT INTO key_pin_reset_requests
       (key_pin_id, requested_by_admin_id, requested_by_role, requested_by_name,
        otp_hash, verification_token, recipient_email,
        expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      keyPinId, adminId, role, actorName,
      otpHash, token, recipientEmail,
      expiresAt, ipAddress, userAgent,
    ],
  );
  const [rows] = await pool.query(
    `SELECT ${RESET_COLUMNS} FROM key_pin_reset_requests WHERE id = ?`,
    [r.insertId],
  );
  return rows[0] || null;
}

/**
 * "Mark superseded" — treats every currently-pending row for a PIN as
 * used_at=NOW so a new request replaces them cleanly. Prevents multiple
 * live OTPs / tokens for the same PIN at the same time.
 */
async function invalidatePendingForPin(keyPinId) {
  await pool.query(
    `UPDATE key_pin_reset_requests
       SET used_at = CURRENT_TIMESTAMP
     WHERE key_pin_id = ? AND used_at IS NULL AND verified_at IS NULL`,
    [keyPinId],
  );
}

async function findPendingByToken(token) {
  const [rows] = await pool.query(
    `SELECT ${RESET_COLUMNS} FROM key_pin_reset_requests
     WHERE verification_token = ? AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [token],
  );
  return rows[0] || null;
}

/**
 * Fetch the most recent pending reset row for a given PIN. Used by the
 * OTP-entry code path (the user has the OTP but not the token, so we
 * look up by PIN).
 */
async function findPendingByPinId(keyPinId) {
  const [rows] = await pool.query(
    `SELECT ${RESET_COLUMNS} FROM key_pin_reset_requests
     WHERE key_pin_id = ? AND used_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [keyPinId],
  );
  return rows[0] || null;
}

async function markVerified(id) {
  await pool.query(
    `UPDATE key_pin_reset_requests
       SET verified_at = CURRENT_TIMESTAMP
     WHERE id = ? AND verified_at IS NULL AND used_at IS NULL`,
    [id],
  );
}

async function markUsed(id) {
  await pool.query(
    `UPDATE key_pin_reset_requests
       SET used_at = CURRENT_TIMESTAMP
     WHERE id = ? AND used_at IS NULL`,
    [id],
  );
}

/**
 * Count requests initiated by a given admin over a window — used for
 * rate-limiting OTP generation.
 */
async function countRecentByAdmin(adminId, sinceMinutes = 15) {
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM key_pin_reset_requests
     WHERE requested_by_admin_id = ?
       AND created_at >= (NOW() - INTERVAL ? MINUTE)`,
    [adminId, sinceMinutes],
  );
  return Number(total);
}

/**
 * Same as above but scoped by PIN — belt-and-braces cap on any one PIN
 * being flooded from multiple admin accounts.
 */
async function countRecentByPin(keyPinId, sinceMinutes = 15) {
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM key_pin_reset_requests
     WHERE key_pin_id = ?
       AND created_at >= (NOW() - INTERVAL ? MINUTE)`,
    [keyPinId, sinceMinutes],
  );
  return Number(total);
}

// -----------------------------------------------------------------------
// Audit log
// -----------------------------------------------------------------------
async function appendAudit({
  keyPinId = null,
  adminId = null,
  role = null,
  actorName = null,
  action,
  ipAddress = null,
  userAgent = null,
}) {
  if (!action) return;
  await pool.query(
    `INSERT INTO key_pin_audit_log
       (key_pin_id, admin_id, admin_role, actor_name, action, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [keyPinId, adminId, role, actorName, action, ipAddress, userAgent],
  );
}

module.exports = {
  createResetRequest,
  invalidatePendingForPin,
  findPendingByToken,
  findPendingByPinId,
  markVerified,
  markUsed,
  countRecentByAdmin,
  countRecentByPin,
  appendAudit,
};
