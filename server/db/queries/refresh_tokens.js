const { pool } = require('../pool');

/**
 * Refresh-token persistence. The on-the-wire token is a high-entropy random
 * string; we store its SHA-256 hash, not the token itself, so a DB read
 * doesn't leak valid session credentials. Lookup happens by hash — the
 * caller is expected to hash the cookie value before calling find().
 *
 * Tokens are issued with an `expires_at` (long TTL, e.g. 30 days). Rotation:
 * each refresh call revokes the old row and points it at the new row via
 * `replaced_by_id`, then inserts a fresh row. Re-use of a revoked token is
 * detectable (find() returns a row with revoked_at != null) and is treated
 * as compromise — the entire subject's token family should be revoked.
 *
 * Schema:
 *   refresh_tokens(
 *     id BIGINT PK,
 *     subject_kind ENUM('admin','sub_admin') NOT NULL,
 *     subject_id   BIGINT NOT NULL,
 *     token_hash   VARCHAR(255) UNIQUE NOT NULL,
 *     expires_at   DATETIME NOT NULL,
 *     revoked_at   DATETIME NULL,
 *     replaced_by_id BIGINT NULL,
 *     created_at   DATETIME DEFAULT NOW()
 *   )
 */

async function create({ subjectKind, subjectId, tokenHash, expiresAt }) {
  const [res] = await pool.query(
    `INSERT INTO refresh_tokens (subject_kind, subject_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [subjectKind, subjectId, tokenHash, expiresAt],
  );
  return res.insertId;
}

async function findByHash(tokenHash) {
  const [rows] = await pool.query(
    `SELECT id, subject_kind, subject_id, token_hash, expires_at, revoked_at, replaced_by_id, created_at
     FROM refresh_tokens
     WHERE token_hash = ?
     LIMIT 1`,
    [tokenHash],
  );
  return rows[0] || null;
}

async function revoke(id, replacedById = null) {
  await pool.query(
    `UPDATE refresh_tokens
       SET revoked_at = NOW(), replaced_by_id = ?
     WHERE id = ? AND revoked_at IS NULL`,
    [replacedById, id],
  );
}

// Reuse of a revoked token suggests the cookie was stolen. Revoke ALL of the
// subject's currently-active refresh tokens so the attacker (and the
// legitimate user) both have to sign in again.
async function revokeAllForSubject(subjectKind, subjectId) {
  await pool.query(
    `UPDATE refresh_tokens
       SET revoked_at = NOW()
     WHERE subject_kind = ? AND subject_id = ? AND revoked_at IS NULL`,
    [subjectKind, subjectId],
  );
}

// Cron-callable: delete fully-expired rows older than `keepDays` so the
// table doesn't grow forever. Default 90d so we have a history window for
// audit / forensic use before pruning.
async function purgeExpired(keepDays = 90) {
  const [res] = await pool.query(
    `DELETE FROM refresh_tokens
     WHERE expires_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [keepDays],
  );
  return res.affectedRows || 0;
}

module.exports = { create, findByHash, revoke, revokeAllForSubject, purgeExpired };
