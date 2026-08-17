/**
 * Google Calendar (User-OAuth2, Strategy B) DB queries.
 *
 * T-2026-164. Companion to server/services/crm/googleCalendar.js.
 *
 * Two tables:
 *   * google_calendar_tokens          -- singleton token store (migration 107)
 *   * google_calendar_oauth_states    -- short-lived CSRF nonce (migration 107)
 *
 * Security invariants (enforced by callers, documented here):
 *   * The refresh_token column is a bearer credential. Callers must
 *     NEVER pass it into console.log, JSON.stringify(response), or any
 *     other serializer that could echo it out of the process.
 *   * Access-token cache is refreshed 60s before advertised expiry --
 *     see server/services/crm/googleCalendar.js#ensureFreshAccessToken.
 */

const { pool } = require('../pool');

const SINGLETON_SCOPE = 'singleton';

// -------------------- Tokens (singleton) --------------------

/**
 * Returns the singleton token row or null. Includes the refresh_token
 * so callers MUST treat the return value as sensitive -- never JSON-
 * serialize or log it.
 */
async function getSingletonToken() {
  const [rows] = await pool.query(
    'SELECT * FROM google_calendar_tokens WHERE scope=? AND admin_id IS NULL LIMIT 1',
    [SINGLETON_SCOPE],
  );
  return rows[0] || null;
}

/**
 * Upserts the singleton token row from a Google token exchange
 * response. The caller has already verified the response contains a
 * refresh_token (Google only issues one on first consent + prompt=
 * consent; without it we cannot maintain long-lived access).
 */
async function upsertSingletonToken({
  refresh_token,
  access_token = null,
  access_token_expires_at = null,
  scope_granted = null,
  token_type = null,
  connected_by_admin_id = null,
  connected_by_admin_email = null,
}) {
  if (!refresh_token) {
    const err = new Error('refresh_token required');
    err.code = 'GOOGLE_TOKEN_MISSING_REFRESH';
    throw err;
  }
  await pool.query(
    `INSERT INTO google_calendar_tokens
       (scope, admin_id, refresh_token, access_token, access_token_expires_at,
        scope_granted, token_type, connected_by_admin_id, connected_by_admin_email)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       refresh_token = VALUES(refresh_token),
       access_token = VALUES(access_token),
       access_token_expires_at = VALUES(access_token_expires_at),
       scope_granted = VALUES(scope_granted),
       token_type = VALUES(token_type),
       connected_by_admin_id = VALUES(connected_by_admin_id),
       connected_by_admin_email = VALUES(connected_by_admin_email),
       updated_at = CURRENT_TIMESTAMP`,
    [
      SINGLETON_SCOPE,
      refresh_token,
      access_token,
      access_token_expires_at,
      scope_granted,
      token_type,
      connected_by_admin_id,
      connected_by_admin_email,
    ],
  );
}

/**
 * Updates only the short-lived access token cache columns. Called by
 * ensureFreshAccessToken() after a silent refresh so subsequent calls
 * reuse the fresh access token until it nears expiry again.
 */
async function updateAccessTokenCache({ access_token, access_token_expires_at }) {
  await pool.query(
    `UPDATE google_calendar_tokens
       SET access_token = ?,
           access_token_expires_at = ?
     WHERE scope = ? AND admin_id IS NULL`,
    [access_token || null, access_token_expires_at || null, SINGLETON_SCOPE],
  );
}

async function deleteSingletonToken() {
  await pool.query(
    'DELETE FROM google_calendar_tokens WHERE scope=? AND admin_id IS NULL',
    [SINGLETON_SCOPE],
  );
}

// -------------------- OAuth state nonces --------------------

async function insertOAuthState({ state, admin_id, admin_email = null, expires_at }) {
  await pool.query(
    `INSERT INTO google_calendar_oauth_states
       (state, admin_id, admin_email, expires_at)
     VALUES (?, ?, ?, ?)`,
    [state, admin_id, admin_email, expires_at],
  );
}

/**
 * Pops (single-use) a state row by value. Returns the row if found
 * AND unexpired; otherwise null. Deletes the row unconditionally to
 * prevent replay -- even an expired nonce should be one-shot.
 */
async function popOAuthState(state) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT * FROM google_calendar_oauth_states WHERE state=? FOR UPDATE',
      [state],
    );
    const row = rows[0] || null;
    if (row) {
      await conn.query('DELETE FROM google_calendar_oauth_states WHERE id=?', [row.id]);
    }
    await conn.commit();
    if (!row) return null;
    // Expiry check post-delete (single-use even if expired).
    const now = new Date();
    if (new Date(row.expires_at) < now) {
      return { ...row, expired: true };
    }
    return row;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Reaps every expired OAuth state row. Called opportunistically from
 * the sync worker's tick so the table doesn't grow unbounded even if
 * users abandon the consent flow.
 */
async function reapExpiredOAuthStates() {
  const [res] = await pool.query(
    'DELETE FROM google_calendar_oauth_states WHERE expires_at < NOW()',
  );
  return res.affectedRows || 0;
}

// -------------------- Calendar activity retry queue --------------------

/**
 * Returns the next batch of calendar activities that need syncing.
 * Used by the sync worker + the /retry-sync endpoint.
 */
async function listPendingCalendarActivities(limit = 20) {
  const [rows] = await pool.query(
    `SELECT ca.*, e.enquiry_code, e.source_type, e.source_id, e.status_code AS current_status_code
       FROM crm_calendar_activities ca
       JOIN crm_enquiries e ON e.id = ca.enquiry_id
      WHERE ca.sync_status IN ('PENDING', 'FAILED')
        AND ca.booking_status = 'active'
      ORDER BY ca.id ASC
      LIMIT ?`,
    [Number(limit) || 20],
  );
  return rows;
}

async function getCalendarActivityById(id) {
  const [rows] = await pool.query(
    `SELECT ca.*, e.enquiry_code, e.source_type, e.source_id, e.status_code AS current_status_code
       FROM crm_calendar_activities ca
       JOIN crm_enquiries e ON e.id = ca.enquiry_id
      WHERE ca.id = ?
      LIMIT 1`,
    [Number(id)],
  );
  return rows[0] || null;
}

/**
 * Updates a calendar activity row after a sync attempt (success or
 * failure). ALSO denormalizes google_event_id onto the linked
 * crm_status_history row (T-2026-164 migration 107 added the column).
 */
async function updateCalendarActivitySyncResult({
  id,
  google_event_id = null,
  sync_status,
  sync_last_error = null,
}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE crm_calendar_activities
          SET google_event_id = ?,
              sync_status = ?,
              sync_last_attempt_at = NOW(),
              sync_last_error = ?
        WHERE id = ?`,
      [google_event_id, sync_status, sync_last_error, Number(id)],
    );
    // Denormalized column on crm_status_history: only update to
    // non-null on success; leave existing null-or-value on failure.
    if (google_event_id) {
      await conn.query(
        `UPDATE crm_status_history
            SET google_event_id = ?
          WHERE calendar_activity_id = ?`,
        [google_event_id, Number(id)],
      );
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  SINGLETON_SCOPE,
  getSingletonToken,
  upsertSingletonToken,
  updateAccessTokenCache,
  deleteSingletonToken,
  insertOAuthState,
  popOAuthState,
  reapExpiredOAuthStates,
  listPendingCalendarActivities,
  getCalendarActivityById,
  updateCalendarActivitySyncResult,
};
