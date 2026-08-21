/**
 * T-2026-165: DB queries for CRM follow-up appointment slot validation +
 * edit / cancel flows.
 *
 * All queries operate on crm_calendar_activities (extended by migration
 * 108) plus the new crm_appointment_history table.
 *
 * Semantics:
 *   * scheduled_at stores IST wall-clock (existing T-151 convention).
 *   * active_slot_key stores YYYYMMDDHHMM where MM is rounded DOWN to
 *     the nearest 15-minute boundary (00, 15, 30, 45). Cleared to NULL
 *     when booking_status transitions away from 'active' so the slot
 *     is released.
 *   * booking_status: 'active' | 'cancelled' | 'superseded'.
 *
 * Concurrency guard: the UNIQUE index uq_cal_active_slot on
 * active_slot_key means racing INSERTs / UPDATEs for the same slot
 * receive exactly one success + one ER_DUP_ENTRY (1062). The service
 * layer catches that error code and re-raises as HTTP 409 SLOT_CONFLICT.
 */

const { pool } = require('../pool');

// ─────────────────────────────────────────────────────────────────────
// Slot key helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Round a Date DOWN to the nearest 15-minute boundary (00, 15, 30, 45).
 * Preserves the caller-supplied wall-clock; does NOT convert timezones.
 */
function floorToSlot(dateLike) {
  const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const floored = new Date(d.getTime());
  const mins = floored.getMinutes();
  const slotMin = Math.floor(mins / 15) * 15;
  floored.setMinutes(slotMin, 0, 0);
  return floored;
}

/**
 * Compute the active_slot_key VARCHAR for a given IST wall-clock Date /
 * datetime string. Format: YYYYMMDDHHMM (12 chars). Returns null when
 * the input is not a valid date.
 *
 * Uses IST components via a +5:30 shift from the JS Date's internal
 * UTC representation. Callers pass either a Date parsed from an ISO
 * string with +05:30 offset OR a JS Date whose local time is IST (e.g.
 * a mysql DATETIME row read from the pool -- which sets session tz to
 * UTC per T-2026-091). In both cases the shift below yields the correct
 * IST components.
 *
 * Two-input contract:
 *   * If input is a Date object AND its .toISOString() ends with 'Z' at
 *     the UTC-equivalent of the intended wall clock, we treat it as
 *     already-IST-shifted (mysql DATETIME reads land this way when the
 *     column stores IST wall-clock and the session is UTC -- .getHours()
 *     on such a Date returns the local machine hours, which is why we
 *     use getUTC*() to read the raw stored components).
 *   * Callers that constructed the Date from an ISO string with an
 *     explicit +05:30 offset should call floorSlotKeyFromIso() instead
 *     (see below) which handles the offset consistently.
 */
function slotKeyFromIstWallClock(dateLike) {
  const d = (dateLike instanceof Date) ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const floored = floorToSlot(d);
  // IST wall-clock components. The pool sets session tz to UTC, so
  // DATETIME columns return as Date objects whose getUTC* reads yield
  // the stored wall-clock components verbatim -- exactly what we need.
  const y = String(floored.getUTCFullYear()).padStart(4, '0');
  const mo = String(floored.getUTCMonth() + 1).padStart(2, '0');
  const da = String(floored.getUTCDate()).padStart(2, '0');
  const h = String(floored.getUTCHours()).padStart(2, '0');
  const mi = String(floored.getUTCMinutes()).padStart(2, '0');
  return `${y}${mo}${da}${h}${mi}`;
}

/**
 * Parse a "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS" IST wall-clock
 * string and floor to the 15-min bucket. Returns { istDate, slotKey }.
 * The istDate is a Date whose UTC components equal the IST wall-clock
 * -- suitable for direct INSERT into a DATETIME column when the pool
 * session is UTC.
 */
function parseAndFloorIstWallClock(dateStr, timeStr) {
  const d = String(dateStr || '').trim();
  const t = String(timeStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(t)) return null;
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mm] = t.split(':').map(Number);
  // Build a Date whose UTC components match the IST wall clock (so a
  // subsequent INSERT into a DATETIME column with session tz=UTC stores
  // the IST wall-clock verbatim).
  const flooredMin = Math.floor(mm / 15) * 15;
  const istAsUtc = new Date(Date.UTC(y, (mo - 1), da, hh, flooredMin, 0));
  if (Number.isNaN(istAsUtc.getTime())) return null;
  return {
    istDate: istAsUtc,
    slotKey: slotKeyFromIstWallClock(istAsUtc),
    hh,
    mm: flooredMin,
  };
}

/**
 * Compute the next 15-min slot AFTER a given slot on the same day.
 * Returns 'HH:MM' or null if the day is exhausted.
 *
 * The day grid ends at 23:45 (see
 * services/crm/appointmentSlots.js#buildDayGrid), so there is no slot
 * after 23:45 -> null. The synthetic '00:00' midnight-boundary slot that
 * T-2026-169 Phase C used to append has been removed; returning it here
 * would suggest a slot the picker no longer renders.
 */
function nextSlotHhmm(hh, mm) {
  let h = Number(hh);
  let m = Number(mm) + 15;
  if (m >= 60) { m = 0; h += 1; }
  if (h >= 24) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────
// Appointment CRUD (uses conn for FOR UPDATE locking)
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert a new appointment row. Requires an existing DB connection so
 * the caller can wrap in a transaction with FOR UPDATE on the enquiry.
 */
async function insertAppointmentForConn(conn, {
  enquiryId,
  scheduledAt,
  activeSlotKey,
  timezone,
  reminderA,
  reminderB,
  contextNote,
  detailedNote,
  statusHistoryId,
  googleEventId,
  syncStatus,
  syncLastError,
  createdByAdminId,
}) {
  const [res] = await conn.query(
    `INSERT INTO crm_calendar_activities
       (enquiry_id, scheduled_at, timezone,
        reminder_minutes_before_a, reminder_minutes_before_b,
        context_note, detailed_note,
        google_event_id, sync_status, sync_last_attempt_at, sync_last_error,
        booking_status, active_slot_key,
        status_history_id,
        created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      enquiryId,
      scheduledAt,
      timezone || 'Asia/Kolkata',
      Number.isInteger(reminderA) ? reminderA : 1440,
      Number.isInteger(reminderB) ? reminderB : 60,
      contextNote || null,
      detailedNote || null,
      googleEventId || null,
      syncStatus || 'PENDING',
      (syncStatus && syncStatus !== 'PENDING') ? new Date() : null,
      syncLastError || null,
      activeSlotKey || null,
      statusHistoryId || null,
      createdByAdminId || null,
    ],
  );
  return res.insertId;
}

/**
 * Update the google_event_id + sync_status on an already-inserted
 * appointment. Used after createEvent returns SYNCED so we don't
 * insert-with-NULL then need a separate call.
 */
async function updateAppointmentSyncForConn(conn, {
  appointmentId, googleEventId, syncStatus, syncLastError,
}) {
  await conn.query(
    `UPDATE crm_calendar_activities
        SET google_event_id = ?,
            sync_status = ?,
            sync_last_attempt_at = NOW(),
            sync_last_error = ?
      WHERE id = ?`,
    [googleEventId || null, syncStatus || 'PENDING', syncLastError || null, Number(appointmentId)],
  );
}

/**
 * Find an active appointment whose slot key matches the given key,
 * OPTIONALLY excluding a specific appointment id (edit flow). Uses
 * SELECT ... FOR UPDATE so the caller's transaction locks the row.
 */
async function findActiveAppointmentBySlotKeyForConn(conn, slotKey, { excludeAppointmentId = null } = {}) {
  if (!slotKey) return null;
  const params = [slotKey];
  let sql = `SELECT ca.*, e.enquiry_code, e.source_type, e.source_id
               FROM crm_calendar_activities ca
               JOIN crm_enquiries e ON e.id = ca.enquiry_id
              WHERE ca.active_slot_key = ?
                AND ca.booking_status = 'active'`;
  if (excludeAppointmentId) {
    sql += ` AND ca.id <> ?`;
    params.push(Number(excludeAppointmentId));
  }
  sql += ` LIMIT 1 FOR UPDATE`;
  const [rows] = await conn.query(sql, params);
  return rows[0] || null;
}

/**
 * Get the current active appointment for an enquiry (there's at most
 * one because scheduling a new follow-up implicitly supersedes any
 * prior active one -- but we don't enforce that at the DB level; the
 * service just returns the most recent).
 */
async function getActiveAppointmentForEnquiry(enquiryId) {
  const [rows] = await pool.query(
    `SELECT * FROM crm_calendar_activities
      WHERE enquiry_id = ?
        AND booking_status = 'active'
      ORDER BY scheduled_at DESC, id DESC
      LIMIT 1`,
    [Number(enquiryId)],
  );
  return rows[0] || null;
}

/**
 * Batch variant used by the CRM listing to avoid an N+1 select.
 * Returns Map<enquiryId, appointmentRow>. Empty map when the input
 * is empty.
 */
async function getActiveAppointmentsForEnquiries(enquiryIds) {
  if (!Array.isArray(enquiryIds) || !enquiryIds.length) return new Map();
  const ids = enquiryIds.map((n) => Number(n)).filter((n) => Number.isInteger(n));
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  // Window function-style pick-latest-per-enquiry using GROUP BY on the
  // MRU (scheduled_at desc, id desc). MariaDB 10.4 supports window
  // functions; keeping this portable-simple with a subquery.
  const [rows] = await pool.query(
    `SELECT ca.*
       FROM crm_calendar_activities ca
       JOIN (
         SELECT enquiry_id, MAX(id) AS max_id
           FROM crm_calendar_activities
          WHERE enquiry_id IN (${placeholders})
            AND booking_status = 'active'
          GROUP BY enquiry_id
       ) mru ON mru.enquiry_id = ca.enquiry_id AND mru.max_id = ca.id`,
    ids,
  );
  const byId = new Map();
  for (const r of rows) byId.set(r.enquiry_id, r);
  return byId;
}

async function getAppointmentByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `SELECT ca.*, e.enquiry_code, e.source_type, e.source_id
       FROM crm_calendar_activities ca
       JOIN crm_enquiries e ON e.id = ca.enquiry_id
      WHERE ca.id = ?
      LIMIT 1 FOR UPDATE`,
    [Number(id)],
  );
  return rows[0] || null;
}

async function getAppointmentById(id) {
  const [rows] = await pool.query(
    `SELECT ca.*, e.enquiry_code, e.source_type, e.source_id
       FROM crm_calendar_activities ca
       JOIN crm_enquiries e ON e.id = ca.enquiry_id
      WHERE ca.id = ?
      LIMIT 1`,
    [Number(id)],
  );
  return rows[0] || null;
}

/**
 * Update an appointment's scheduled_at + slot key + notes (edit flow).
 * Runs inside caller's transaction; if the new slot conflicts (via the
 * uq_cal_active_slot UNIQUE index), MySQL raises ER_DUP_ENTRY which
 * the service catches.
 */
async function updateAppointmentSlotForConn(conn, {
  appointmentId,
  scheduledAt,
  activeSlotKey,
  contextNote,
  detailedNote,
  updatedByAdminId,
  resetReminders = false,
}) {
  // Migration 112: moving a booking to a different slot invalidates any
  // reminder already dispatched against the OLD time. Clearing both stamps
  // re-arms the dispatcher so the new time gets its own 1-day / 1-hour pair
  // -- otherwise a call rescheduled after its 1-day reminder had gone out
  // would silently never be reminded again.
  //
  // Gated on the caller's `slotChanged` (not applied unconditionally): a
  // notes-only save must NOT re-arm, or every such save would re-send a
  // reminder for a time that never moved.
  const reminderReset = resetReminders
    ? ', reminder_a_sent_at = NULL, reminder_b_sent_at = NULL'
    : '';
  await conn.query(
    `UPDATE crm_calendar_activities
        SET scheduled_at = ?,
            active_slot_key = ?,
            context_note = ?,
            detailed_note = ?,
            updated_by_admin_id = ?${reminderReset}
      WHERE id = ?`,
    [
      scheduledAt,
      activeSlotKey || null,
      contextNote || null,
      detailedNote || null,
      updatedByAdminId || null,
      Number(appointmentId),
    ],
  );
}

async function cancelAppointmentForConn(conn, { appointmentId, cancelledByAdminId }) {
  await conn.query(
    `UPDATE crm_calendar_activities
        SET booking_status = 'cancelled',
            active_slot_key = NULL,
            cancelled_at = NOW(),
            cancelled_by_admin_id = ?
      WHERE id = ?`,
    [cancelledByAdminId || null, Number(appointmentId)],
  );
}

// ─────────────────────────────────────────────────────────────────────
// Appointment history
// ─────────────────────────────────────────────────────────────────────

/**
 * ISO-8601 → the literal MySQL DATETIME wants.
 *
 * db/pool.js installs a typeCast that returns every DATETIME/TIMESTAMP READ as
 * "YYYY-MM-DDTHH:MM:SSZ", so the browser parses the zone correctly. Feeding
 * that same value back into a DATETIME column fails:
 *
 *   ER_TRUNCATED_WRONG_VALUE: Incorrect datetime value:
 *   '2026-08-18T17:00:00Z' for column 'from_scheduled_at'
 *
 * which is exactly what rescheduling a booking did — `fromScheduledAt` is the
 * appointment's existing scheduled_at, read through that typeCast. Anything
 * already in MySQL's own shape passes through untouched.
 */
function toMysqlDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString().slice(0, 19).replace('T', ' ');
  }
  const s = String(value).trim();
  // "2026-08-18T17:00:00Z" / "...T17:00:00.123Z" / "...T17:00:00+00:00"
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (iso) return `${iso[1]} ${iso[2]}`;
  return s;
}

async function insertHistoryForConn(conn, {
  appointmentId, action, fromScheduledAt, toScheduledAt, adminId, actionNote,
}) {
  const [res] = await conn.query(
    `INSERT INTO crm_appointment_history
       (appointment_id, action, from_scheduled_at, to_scheduled_at, admin_id, action_note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      Number(appointmentId),
      action,
      toMysqlDateTime(fromScheduledAt),
      toMysqlDateTime(toScheduledAt),
      adminId || null,
      actionNote || null,
    ],
  );
  return res.insertId;
}

async function listHistoryByAppointment(appointmentId) {
  const [rows] = await pool.query(
    `SELECT * FROM crm_appointment_history
      WHERE appointment_id = ?
      ORDER BY created_at ASC, id ASC`,
    [Number(appointmentId)],
  );
  return rows;
}

/**
 * List every active appointment on a given IST calendar date. Used by
 * the slot-availability endpoint. Returns rows sorted by slot key
 * ascending. Includes the joined enquiry row for masked-conflict UX.
 */
async function listActiveAppointmentsOnDate(dateStr /* YYYY-MM-DD */) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return [];
  // Slot key prefix: YYYYMMDD
  const [y, mo, da] = dateStr.split('-').map((s) => s);
  const prefix = `${y}${mo}${da}`;
  const [rows] = await pool.query(
    `SELECT ca.*, e.enquiry_code, e.source_type, e.source_id
       FROM crm_calendar_activities ca
       JOIN crm_enquiries e ON e.id = ca.enquiry_id
      WHERE ca.booking_status = 'active'
        AND ca.active_slot_key LIKE ?
      ORDER BY ca.active_slot_key ASC, ca.id ASC`,
    [`${prefix}%`],
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────
// Admin reminder-email dispatch (migration 112)
// ─────────────────────────────────────────────────────────────────────
//
// `scheduled_at` holds IST WALL-CLOCK in a naive DATETIME (the long-standing
// T-151 convention — the pool pins the session to UTC precisely so MySQL
// never re-interprets these values). Every predicate below therefore
// compares against an IST wall-clock string supplied by the caller, NOT
// against NOW(), which would be the server's UTC clock and land 5h30m off.

const REMINDER_COLUMN = Object.freeze({ a: 'reminder_a_sent_at', b: 'reminder_b_sent_at' });

/**
 * Active bookings whose reminder of the given kind is now due.
 *
 * Due means: the appointment is still in the future, we are already inside
 * its lead window, and the stamp for this kind is still NULL.
 *
 *   kind 'a' -> 1 day before  (reminder_minutes_before_a, 1440)
 *   kind 'b' -> 1 hour before (reminder_minutes_before_b, 60)
 *
 * `floorMinutes` excludes bookings that are ALREADY inside a nearer window.
 * Without it, a call booked 30 minutes ahead would satisfy both the 1-day
 * and the 1-hour condition on the very next tick and fire two emails back
 * to back. Passing floorMinutes=60 for kind 'a' means such a booking gets
 * only the 1-hour reminder, which is the one that is actually useful.
 *
 * The lead window is read per-row from the appointment's own
 * reminder_minutes_before_* column rather than a constant, so a booking
 * created under different offsets still reminds on the offsets it was
 * created with.
 *
 * No upper bound on lateness is applied: if cron was down for six hours the
 * 1-day reminder still goes out (late but useful) as long as the call has
 * not already happened. Once scheduled_at passes, the row drops out for good.
 */
async function listDueAppointmentReminders({ kind, istNowSql, floorMinutes = 0, limit = 100 }) {
  const column = REMINDER_COLUMN[kind];
  if (!column) throw new Error(`listDueAppointmentReminders: bad kind ${kind}`);
  const offsetColumn = kind === 'a' ? 'reminder_minutes_before_a' : 'reminder_minutes_before_b';
  const [rows] = await pool.query(
    `SELECT ca.id, ca.enquiry_id, ca.scheduled_at, ca.timezone,
            ca.context_note, ca.detailed_note,
            ca.${offsetColumn} AS lead_minutes,
            e.enquiry_code, e.source_type, e.source_id,
            e.lead_stage_code, e.lead_status_code, e.lead_rating_code
       FROM crm_calendar_activities ca
       JOIN crm_enquiries e ON e.id = ca.enquiry_id
      WHERE ca.booking_status = 'active'
        AND ca.${column} IS NULL
        AND ca.${offsetColumn} > 0
        AND ca.scheduled_at > ?
        AND ca.scheduled_at <= DATE_ADD(?, INTERVAL ca.${offsetColumn} MINUTE)
        AND ca.scheduled_at > DATE_ADD(?, INTERVAL ? MINUTE)
      ORDER BY ca.scheduled_at ASC, ca.id ASC
      LIMIT ?`,
    [istNowSql, istNowSql, istNowSql, Number(floorMinutes) || 0, Number(limit) || 100],
  );
  return rows;
}

/**
 * Atomically claim a reminder for dispatch. Returns true only for the caller
 * that flipped the stamp from NULL — a concurrent cron tick gets false and
 * skips the row, so the admin never receives the same reminder twice.
 *
 * Claim happens BEFORE the send. A crash between claim and send loses that
 * one reminder rather than risking a duplicate-email storm; SMTP failures
 * are separately covered because transporter.trySendMail falls back to
 * email_outbox, which the existing outbox cron retries with backoff.
 */
async function claimAppointmentReminder({ appointmentId, kind, istNowSql }) {
  const column = REMINDER_COLUMN[kind];
  if (!column) throw new Error(`claimAppointmentReminder: bad kind ${kind}`);
  const [res] = await pool.query(
    `UPDATE crm_calendar_activities
        SET ${column} = ?
      WHERE id = ?
        AND ${column} IS NULL
        AND booking_status = 'active'`,
    [istNowSql, Number(appointmentId)],
  );
  return res.affectedRows === 1;
}

/**
 * Release a claim so the next tick can retry. Used when building the email
 * fails before anything was handed to the mailer — without this the reminder
 * would be silently swallowed by its own claim stamp.
 */
async function releaseAppointmentReminder({ appointmentId, kind }) {
  const column = REMINDER_COLUMN[kind];
  if (!column) throw new Error(`releaseAppointmentReminder: bad kind ${kind}`);
  await pool.query(
    `UPDATE crm_calendar_activities SET ${column} = NULL WHERE id = ?`,
    [Number(appointmentId)],
  );
}

module.exports = {
  // helpers
  floorToSlot,
  slotKeyFromIstWallClock,
  parseAndFloorIstWallClock,
  nextSlotHhmm,
  // CRUD
  insertAppointmentForConn,
  updateAppointmentSyncForConn,
  findActiveAppointmentBySlotKeyForConn,
  getActiveAppointmentForEnquiry,
  getActiveAppointmentsForEnquiries,
  getAppointmentByIdForConn,
  getAppointmentById,
  updateAppointmentSlotForConn,
  cancelAppointmentForConn,
  // history
  insertHistoryForConn,
  listHistoryByAppointment,
  // list-by-date
  listActiveAppointmentsOnDate,
  // reminder-email dispatch (migration 112)
  listDueAppointmentReminders,
  claimAppointmentReminder,
  releaseAppointmentReminder,
};
