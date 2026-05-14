/**
 * Email outbox: durable retry queue for failed admin notifications + system
 * mail. Only the per-row claim-and-process path uses transactions because
 * cron + admin manual-run can race.
 */

const { pool } = require('../pool');

async function enqueue({ to, subject, text, html, nextAttemptAt = null }) {
  const [result] = await pool.query(
    `INSERT INTO email_outbox (to_address, subject, body_text, body_html, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    [to, subject, text || null, html || null, nextAttemptAt],
  );
  return result.insertId;
}

/**
 * Atomically claim up to `limit` due rows by pushing their next_attempt_at
 * forward (so a concurrent worker skips them). Returns the rows to process.
 *
 * Race-safety: SELECT FOR UPDATE inside a transaction holds the row locks
 * until COMMIT, so two workers can't both claim the same row.
 */
async function claimBatch(limit) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, to_address, subject, body_text, body_html, attempts
       FROM email_outbox
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY id ASC
       LIMIT ?
       FOR UPDATE`,
      [limit],
    );
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      // Push due time forward by 5 minutes so a parallel worker / next cron
      // tick skips these rows. The actual outcome (sent / failed / retry)
      // is written below after the SMTP attempt.
      await conn.query(
        `UPDATE email_outbox SET next_attempt_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE) WHERE id IN (?)`,
        [ids],
      );
    }
    await conn.commit();
    return rows;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function markSent(id) {
  await pool.query(
    `UPDATE email_outbox SET status = 'sent', sent_at = NOW(), last_error = NULL, next_attempt_at = NULL
     WHERE id = ?`,
    [id],
  );
}

async function markRetry(id, { attempts, nextAttemptAt, error }) {
  await pool.query(
    `UPDATE email_outbox
     SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?
     WHERE id = ?`,
    [attempts, nextAttemptAt, error || null, id],
  );
}

async function markFailedPermanent(id, { attempts, error }) {
  await pool.query(
    `UPDATE email_outbox
     SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL
     WHERE id = ?`,
    [attempts, error || null, id],
  );
}

async function findById(id) {
  const [rows] = await pool.query(
    `SELECT id, to_address, subject, body_text, body_html, status, attempts,
            last_error, next_attempt_at, sent_at, created_at, updated_at
     FROM email_outbox WHERE id = ? LIMIT 1`,
    [id],
  );
  return rows[0] || null;
}

async function listForAdmin({ page, pageSize, status }) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM email_outbox ${whereSql}`,
    params,
  );

  const offset = (page - 1) * pageSize;
  const [rows] = await pool.query(
    `SELECT id, to_address, subject, status, attempts, last_error,
            next_attempt_at, sent_at, created_at, updated_at
     FROM email_outbox
     ${whereSql}
     ORDER BY id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );

  return { rows, total };
}

async function counters() {
  const [[r]] = await pool.query(`
    SELECT
      SUM(status = 'pending') AS pending,
      SUM(status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())) AS due_now,
      SUM(status = 'sent') AS sent,
      SUM(status = 'failed') AS failed,
      COUNT(*) AS total
    FROM email_outbox
  `);
  return {
    pending: Number(r.pending || 0),
    dueNow: Number(r.due_now || 0),
    sent: Number(r.sent || 0),
    failed: Number(r.failed || 0),
    total: Number(r.total || 0),
  };
}

async function requeue(id) {
  // Resets attempts to 0 so the row gets a fresh chance at the full backoff
  // schedule. Use case: admin diagnoses + fixes the SMTP issue, then clicks
  // "Retry now" — they expect a real attempt, not an instant re-fail because
  // attempts is already at MAX.
  await pool.query(
    `UPDATE email_outbox
     SET status = 'pending', attempts = 0, next_attempt_at = NOW(), last_error = NULL
     WHERE id = ?`,
    [id],
  );
}

async function deleteRow(id) {
  await pool.query('DELETE FROM email_outbox WHERE id = ?', [id]);
}

module.exports = {
  enqueue,
  claimBatch,
  markSent,
  markRetry,
  markFailedPermanent,
  findById,
  listForAdmin,
  counters,
  requeue,
  deleteRow,
};
