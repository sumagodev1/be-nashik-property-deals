const { pool } = require('../pool');

async function create({ purpose, email, mobileNumber, codeHash, expiresAt }) {
  const [result] = await pool.query(
    `INSERT INTO otp_codes (purpose, email, mobile_number, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [purpose, email || null, mobileNumber || null, codeHash, expiresAt],
  );
  return result.insertId;
}

async function findLatestUnconsumed({ purpose, email }) {
  const [rows] = await pool.query(
    `SELECT id, code_hash, attempts, expires_at, created_at
     FROM otp_codes
     WHERE purpose = ? AND email = ? AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [purpose, email],
  );
  return rows[0] || null;
}

async function findLatestUnconsumedByMobile({ purpose, mobileNumber }) {
  const [rows] = await pool.query(
    `SELECT id, code_hash, attempts, expires_at, created_at
     FROM otp_codes
     WHERE purpose = ? AND mobile_number = ? AND consumed_at IS NULL AND expires_at > NOW()
     ORDER BY id DESC
     LIMIT 1`,
    [purpose, mobileNumber],
  );
  return rows[0] || null;
}

async function incrementAttempts(id) {
  await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [id]);
}

async function consume(id) {
  await pool.query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = ?', [id]);
}

async function countRecentForEmail({ purpose, email, sinceSeconds }) {
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM otp_codes
     WHERE purpose = ? AND email = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [purpose, email, sinceSeconds],
  );
  return Number(n);
}

async function countRecentForMobile({ purpose, mobileNumber, sinceSeconds }) {
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM otp_codes
     WHERE purpose = ? AND mobile_number = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
    [purpose, mobileNumber, sinceSeconds],
  );
  return Number(n);
}

module.exports = {
  create,
  findLatestUnconsumed,
  findLatestUnconsumedByMobile,
  incrementAttempts,
  consume,
  countRecentForEmail,
  countRecentForMobile,
};
