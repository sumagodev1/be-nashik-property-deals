/**
 * CRM Follow-ups — a READ-ONLY admin view over the follow-ups the CRM already
 * schedules.
 *
 * NOTHING HERE CREATES A REMINDER.
 * The follow-up, its Google Calendar event and its two reminder emails are all
 * produced by the existing flow (services/crm/appointmentSlots.js →
 * googleCalendar.js → appointmentReminders.js). This module only SELECTs from
 * crm_calendar_activities so the same records can be listed across every lead
 * instead of one enquiry at a time. There is no INSERT, UPDATE or DELETE in
 * this file, by design — adding one would risk a second calendar event or a
 * duplicate email for a follow-up that already has both.
 *
 * NO NEW TABLE EITHER. crm_calendar_activities already carries everything the
 * page needs: scheduled_at + timezone, reminder_minutes_before_a/_b with their
 * *_sent_at timestamps, context_note and detailed_note, google_event_id,
 * sync_status, and booking_status.
 *
 * ONLY REAL GOOGLE CALENDAR MEETINGS
 *   Every row here is filtered on google_event_id IS NOT NULL, so the page
 *   lists follow-ups that genuinely reached Google Calendar and nothing else.
 *   Note this table already holds ONE ROW PER SCHEDULED FOLLOW-UP, not one per
 *   enquiry — an enquiry that never had a meeting has no row at all, so the
 *   "100 enquiries but only 20 follow-ups" case is structural rather than
 *   something this filter has to enforce.
 *
 *   The test is google_event_id, NOT sync_status = 'SYNCED'. A cancelled
 *   meeting keeps its event id but moves to sync_status 'CANCELLED', and a
 *   cancelled meeting must stay visible so its status can read Cancelled.
 *   The event id is the durable evidence that the meeting once existed in
 *   Google Calendar; sync_status only describes the latest sync attempt.
 *
 *   Rows with no event id — a follow-up saved while the Google sync was
 *   pending or failing — are excluded from both the list and the summary, and
 *   counted separately into meta.pendingCalendarSync. They are not displayed as
 *   records, but the count is surfaced so a broken sync shows up as a number on
 *   screen rather than as follow-ups that quietly disappeared.
 *
 * WHAT "STATUS" MEANS HERE
 *   booking_status is the stored lifecycle: 'active' | 'cancelled' |
 *   'superseded' (a rebooked slot supersedes its predecessor). There is NO
 *   "completed" column anywhere — nothing in the system records that a meeting
 *   took place — so an active follow-up whose time has passed is reported as
 *   ELAPSED rather than being called "Completed", which would assert something
 *   the data does not know.
 */

const { pool } = require('../../db/pool');
const masters = require('../masters/management');

/** Same masking as appointmentSlots.js — last 4 digits kept. */
function maskMobile(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length < 4) return 'XXXX';
  return 'X'.repeat(digits.length - 4) + digits.slice(-4);
}

function maskName(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (s.length <= 2) return `${s.charAt(0)}*`;
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(2, s.length - 2))}`;
}

/**
 * scheduled_at is IST WALL-CLOCK, not UTC.
 *
 * db/pool.js typeCast turns every DATETIME into `YYYY-MM-DDTHH:MM:SSZ`, and
 * that trailing Z is a lie for this column — the CRM writes the operator's
 * chosen IST time straight in. HistoryPanel.jsx records the bug this caused:
 * running it through a UTC→IST conversion rendered a 1:30 PM booking as
 * 7:00 PM. The date and time are therefore split here, from the raw string,
 * with no conversion at all, and the client prints them verbatim.
 */
function splitWallClock(raw) {
  if (!raw) return { date: null, time: null };
  const text = String(raw);
  const [datePart, rest = ''] = text.replace('Z', '').split('T');
  return { date: datePart || null, time: (rest.slice(0, 5) || null) };
}

/** Today in IST, as YYYY-MM-DD, to compare against those wall-clock dates. */
function todayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * The reminder offsets that actually exist on a row, with whether each has
 * already been sent. Only offsets greater than zero are reported — a follow-up
 * configured without one must not show a reminder it will never get.
 */
function remindersFor(row) {
  const out = [];
  const add = (minutes, sentAt) => {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n <= 0) return;
    out.push({
      minutesBefore: n,
      label: n % 1440 === 0
        ? `${n / 1440} Day${n / 1440 === 1 ? '' : 's'} Before`
        : (n % 60 === 0
          ? `${n / 60} Hour${n / 60 === 1 ? '' : 's'} Before`
          : `${n} Minutes Before`),
      sentAt: sentAt || null,
    });
  };
  add(row.reminder_minutes_before_a, row.reminder_a_sent_at);
  add(row.reminder_minutes_before_b, row.reminder_b_sent_at);
  return out;
}

/**
 * Derived lifecycle for display. `booking_status` is the stored truth; the only
 * thing added is splitting 'active' by whether its time has passed.
 */
function derivedStatus(row, today) {
  if (row.booking_status === 'cancelled') return 'cancelled';
  if (row.booking_status === 'superseded') return 'superseded';
  const { date } = splitWallClock(row.scheduled_at);
  if (!date) return 'scheduled';
  if (date === today) return 'today';
  return date > today ? 'scheduled' : 'elapsed';
}

const STATUS_LABEL = Object.freeze({
  scheduled: 'Scheduled',
  today: 'Today',
  elapsed: 'Elapsed',
  cancelled: 'Cancelled',
  superseded: 'Superseded',
});

/** code -> label for the three CRM taxonomies, resolved from the live masters. */
async function taxonomyLabelMaps() {
  const keys = ['crm_lead_stage', 'crm_lead_status', 'crm_lead_rating'];
  const entries = await Promise.all(keys.map(async (key) => {
    try {
      // Unfiltered: a lead sitting on a since-deactivated value must still
      // render its label rather than a raw code.
      const { data } = await masters.listAll(key, {});
      return [key, Object.fromEntries((data || []).map((m) => [m.code, m.label]))];
    } catch (err) {
      return [key, {}];
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * List follow-ups across every lead.
 *
 * Filters are applied in SQL so the summary counts and the page both describe
 * the same set. The summary is computed over the WHOLE filtered set, not the
 * current page, so "Total 12" does not become "Total 10" on page two.
 */
async function list(params = {}) {
  const {
    search = '', dateFrom = '', dateTo = '',
    leadStage = '', leadStatus = '', leadRating = '',
    status = '', page = 1, pageSize = 25, unmasked = false,
  } = params;

  // First and non-negotiable: a follow-up only belongs on this page if it
  // actually reached Google Calendar. Seeded before any user filter so no call
  // path can omit it.
  const where = ['a.google_event_id IS NOT NULL'];
  const args = [];

  if (search) {
    const like = `%${String(search).trim()}%`;
    // Identity lives on the PARENT, not the enquiry: crm_enquiries has no
    // name/mobile/email columns — a person is one crm_parents row that may own
    // several enquiries (that is what the duplicate resolver is for).
    where.push(`(p.full_name LIKE ? OR p.normalized_mobile LIKE ? OR p.normalized_email LIKE ?
                 OR e.enquiry_code LIKE ? OR CAST(e.id AS CHAR) = ?)`);
    args.push(like, like, like, like, String(search).trim());
  }
  // DATE(scheduled_at) rather than a range on the raw value: the column is
  // wall-clock, so a plain >= '2026-09-03' would exclude that day's afternoon.
  if (dateFrom) { where.push('DATE(a.scheduled_at) >= ?'); args.push(dateFrom); }
  if (dateTo) { where.push('DATE(a.scheduled_at) <= ?'); args.push(dateTo); }
  if (leadStage) { where.push('e.lead_stage_code = ?'); args.push(leadStage); }
  if (leadStatus) { where.push('e.lead_status_code = ?'); args.push(leadStatus); }
  if (leadRating) { where.push('e.lead_rating_code = ?'); args.push(leadRating); }

  const today = todayIso();
  // The lifecycle filter mixes a stored column with a date comparison, so it
  // is expressed in SQL rather than filtered in JS — otherwise paging would
  // return short pages.
  if (status === 'cancelled') where.push("a.booking_status = 'cancelled'");
  else if (status === 'superseded') where.push("a.booking_status = 'superseded'");
  else if (status === 'today') { where.push("a.booking_status = 'active' AND DATE(a.scheduled_at) = ?"); args.push(today); }
  else if (status === 'scheduled') { where.push("a.booking_status = 'active' AND DATE(a.scheduled_at) > ?"); args.push(today); }
  else if (status === 'elapsed') { where.push("a.booking_status = 'active' AND DATE(a.scheduled_at) < ?"); args.push(today); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, Number(pageSize) || 25));
  const offset = (Math.max(1, Number(page) || 1) - 1) * limit;

  // LEFT JOIN on the parent: an enquiry with no parent row is still a real
  // follow-up and must not drop out of the list.
  //
  // GOOGLE_EVENT_FILTER is applied to the list AND to the summary below, so the
  // cards count exactly the rows the table can show.
  const baseFrom = `
      FROM crm_calendar_activities a
      JOIN crm_enquiries e ON e.id = a.enquiry_id
      LEFT JOIN crm_parents p ON p.id = e.parent_id
    ${whereSql}`;

  const [rows] = await pool.query(
    `SELECT a.id, a.enquiry_id, a.scheduled_at, a.timezone,
            a.reminder_minutes_before_a, a.reminder_minutes_before_b,
            a.reminder_a_sent_at, a.reminder_b_sent_at,
            a.context_note, a.detailed_note,
            a.google_event_id, a.sync_status, a.booking_status, a.cancelled_at,
            e.enquiry_code,
            p.full_name AS name, p.normalized_mobile AS mobile, p.normalized_email AS email,
            e.lead_stage_code, e.lead_status_code, e.lead_rating_code
       ${baseFrom}
      ORDER BY a.scheduled_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...args, limit, offset],
  );

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${baseFrom}`, args);

  // Summary over the filtered set, in one pass, so the cards and the table can
  // never disagree.
  const [[summaryRow]] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(a.booking_status = 'active' AND DATE(a.scheduled_at) = ?)  AS today,
       SUM(a.booking_status = 'active' AND DATE(a.scheduled_at) > ?)  AS upcoming,
       SUM(a.booking_status = 'active' AND DATE(a.scheduled_at) < ?)  AS elapsed,
       SUM(a.booking_status = 'cancelled')                            AS cancelled,
       SUM(a.booking_status = 'superseded')                           AS superseded
     ${baseFrom}`,
    [today, today, today, ...args],
  );

  // How many follow-ups exist but have no Google Calendar event yet. Reported
  // so a stalled sync is visible instead of looking like missing data.
  const [[pendingRow]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM crm_calendar_activities
      WHERE google_event_id IS NULL`,
  );

  const labelMaps = await taxonomyLabelMaps();
  const label = (key, code) => (code ? (labelMaps[key]?.[code] || code) : null);

  return {
    data: rows.map((r) => {
      const when = splitWallClock(r.scheduled_at);
      const st = derivedStatus(r, today);
      return {
        id: r.id,
        enquiryId: r.enquiry_id,
        enquiryCode: r.enquiry_code || null,
        leadName: unmasked ? (r.name || '') : maskName(r.name),
        leadMobile: unmasked ? (r.mobile || '') : maskMobile(r.mobile),
        leadStageCode: r.lead_stage_code || null,
        leadStageLabel: label('crm_lead_stage', r.lead_stage_code),
        leadStatusCode: r.lead_status_code || null,
        leadStatusLabel: label('crm_lead_status', r.lead_status_code),
        leadRatingCode: r.lead_rating_code || null,
        leadRatingLabel: label('crm_lead_rating', r.lead_rating_code),
        // Wall-clock, already split — the client prints these verbatim rather
        // than re-parsing a value whose trailing Z would mislead it.
        followUpDate: when.date,
        followUpTime: when.time,
        timezone: r.timezone || 'Asia/Kolkata',
        // The note the operator typed when scheduling. context_note is the
        // Context / Reminder Note field; detailed_note is the longer one. Both
        // are passed through exactly as stored — never defaulted.
        contextNote: r.context_note || null,
        detailedNote: r.detailed_note || null,
        reminders: remindersFor(r),
        bookingStatus: r.booking_status,
        status: st,
        statusLabel: STATUS_LABEL[st] || st,
        googleEventId: r.google_event_id || null,
        syncStatus: r.sync_status,
        cancelledAt: r.cancelled_at || null,
      };
    }),
    meta: {
      page: Math.max(1, Number(page) || 1),
      pageSize: limit,
      total: Number(total) || 0,
      today,
      pendingCalendarSync: Number(pendingRow.n) || 0,
      summary: {
        total: Number(summaryRow.total) || 0,
        today: Number(summaryRow.today) || 0,
        upcoming: Number(summaryRow.upcoming) || 0,
        elapsed: Number(summaryRow.elapsed) || 0,
        cancelled: Number(summaryRow.cancelled) || 0,
        superseded: Number(summaryRow.superseded) || 0,
      },
    },
  };
}

module.exports = { list, STATUS_LABEL };
