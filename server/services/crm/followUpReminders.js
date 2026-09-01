/**
 * CRM follow-up reminder counters — the two cards on the CRM page.
 *
 * NOTHING HERE CREATES OR STORES A REMINDER.
 * The follow-up, its Google Calendar event and its 1-day / 1-hour reminder
 * emails are all produced by the existing scheduling flow
 * (services/crm/appointmentSlots.js → googleCalendar.js →
 * appointmentReminders.js). This module only SELECTs, so there is no second
 * calendar event, no duplicate email and no reminder table of its own. There is
 * deliberately no INSERT, UPDATE or DELETE in this file.
 *
 * WHAT COUNTS
 *   An enquiry is counted only when it has a Google Calendar meeting that is
 *   genuinely scheduled:
 *     google_event_id IS NOT NULL   the event really exists in Google Calendar,
 *                                   not merely a row saved while the sync was
 *                                   pending or failing
 *     booking_status = 'active'     still on — a cancelled meeting will never
 *                                   fire a reminder
 *   ...and then by the offset that meeting carries:
 *     reminder_minutes_before_b = 60    -> the 1-hour card
 *     reminder_minutes_before_a = 1440  -> the 1-day card
 *
 *   The unit is the ENQUIRY, not the meeting: an enquiry with three qualifying
 *   meetings counts once, hence COUNT(DISTINCT enquiry_id). The two cards
 *   overlap by design — a meeting normally carries both offsets, so the same
 *   enquiry appears in both numbers.
 *
 * WHY booking_status AND NOT sync_status
 *   booking_status is what says a meeting is still on. sync_status only
 *   describes the last sync attempt, and a cancelled meeting keeps its event id
 *   — so the event id plus booking_status is what actually expresses "has a
 *   scheduled Google Calendar meeting".
 */

const { pool } = require('../../db/pool');
const masters = require('../masters/management');

/** 1 day and 1 hour, in the minutes the scheduler stores. */
const ONE_DAY_MINUTES = 1440;
const ONE_HOUR_MINUTES = 60;

/**
 * The clause defining "has a scheduled Google Calendar meeting". Shared by the
 * counts and the drill-down, so a card's number and the list it opens can never
 * describe different sets.
 */
const SCHEDULED_MEETING_SQL = "a.google_event_id IS NOT NULL AND a.booking_status = 'active'";

/** reminder key -> the column and value that define it. */
const REMINDER_CLAUSE = Object.freeze({
  '1h': `a.reminder_minutes_before_b = ${ONE_HOUR_MINUTES}`,
  '1d': `a.reminder_minutes_before_a = ${ONE_DAY_MINUTES}`,
});

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

function maskEmail(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const at = s.indexOf('@');
  if (at < 1) return '****';
  const local = s.slice(0, at);
  const shown = local.slice(0, Math.min(2, local.length));
  return `${shown}${'*'.repeat(Math.max(2, local.length - shown.length))}${s.slice(at)}`;
}

/**
 * scheduled_at is IST WALL-CLOCK, not UTC.
 *
 * Migration 101's column comment claims "stored as UTC" and db/pool.js stamps
 * every DATETIME with a trailing Z — both misleading. The CRM writes the
 * operator's chosen IST time straight in, and HistoryPanel.jsx records what
 * converting it did: a 1:30 PM booking rendered as 7:00 PM. Date and time are
 * split from the raw string with no conversion, and the client prints them
 * verbatim.
 */
function splitWallClock(raw) {
  if (!raw) return { date: null, time: null };
  const [datePart, rest = ''] = String(raw).replace('Z', '').split('T');
  return { date: datePart || null, time: (rest.slice(0, 5) || null) };
}

/**
 * The two card numbers, plus the meeting counts behind them so a surprising
 * number (many meetings, few enquiries) can be explained.
 */
async function counts() {
  const [[row]] = await pool.query(
    `SELECT
       COUNT(DISTINCT CASE WHEN ${REMINDER_CLAUSE['1h']} THEN a.enquiry_id END) AS one_hour_enquiries,
       COUNT(DISTINCT CASE WHEN ${REMINDER_CLAUSE['1d']} THEN a.enquiry_id END) AS one_day_enquiries,
       SUM(${REMINDER_CLAUSE['1h']}) AS one_hour_meetings,
       SUM(${REMINDER_CLAUSE['1d']}) AS one_day_meetings
     FROM crm_calendar_activities a
     WHERE ${SCHEDULED_MEETING_SQL}`,
  );
  return {
    oneHour: Number(row.one_hour_enquiries) || 0,
    oneDay: Number(row.one_day_enquiries) || 0,
    oneHourMeetings: Number(row.one_hour_meetings) || 0,
    oneDayMeetings: Number(row.one_day_meetings) || 0,
  };
}

/** code -> label for the three CRM taxonomies, from the live masters. */
async function taxonomyLabelMaps() {
  const keys = ['crm_lead_stage', 'crm_lead_status', 'crm_lead_rating'];
  const entries = await Promise.all(keys.map(async (key) => {
    try {
      // Unfiltered: a lead on a since-deactivated value must still show its
      // label rather than a raw code.
      const { data } = await masters.listAll(key, {});
      return [key, Object.fromEntries((data || []).map((m) => [m.code, m.label]))];
    } catch (err) {
      return [key, {}];
    }
  }));
  return Object.fromEntries(entries);
}

/** interested_property_ids is a JSON array of property CODES (migration 113). */
function parsePropertyCodes(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

/**
 * The enquiries behind one card — what opens when a count is clicked.
 *
 * Uses the same SCHEDULED_MEETING_SQL as the counter plus that card's offset,
 * so the list always matches the number that was clicked.
 */
async function listByReminder(reminder, { unmasked = false } = {}) {
  const clause = REMINDER_CLAUSE[reminder];
  if (!clause) return [];

  const [rows] = await pool.query(
    `SELECT a.id, a.enquiry_id, a.scheduled_at, a.timezone,
            a.reminder_a_sent_at, a.reminder_b_sent_at,
            a.context_note, a.detailed_note, a.google_event_id,
            e.enquiry_code, e.source_type, e.interested_property_ids,
            e.lead_stage_code, e.lead_status_code, e.lead_rating_code,
            p.full_name, p.normalized_mobile, p.normalized_email
       FROM crm_calendar_activities a
       JOIN crm_enquiries e ON e.id = a.enquiry_id
       LEFT JOIN crm_parents p ON p.id = e.parent_id
      WHERE ${SCHEDULED_MEETING_SQL} AND ${clause}
      ORDER BY a.scheduled_at ASC, a.id ASC`,
  );

  const labelMaps = await taxonomyLabelMaps();
  const label = (key, code) => (code ? (labelMaps[key]?.[code] || code) : null);

  return rows.map((r) => {
    const when = splitWallClock(r.scheduled_at);
    return {
      id: r.id,
      enquiryId: r.enquiry_id,
      enquiryCode: r.enquiry_code || null,
      // Lead identity lives on crm_parents — crm_enquiries has no name, mobile
      // or email columns of its own.
      name: unmasked ? (r.full_name || '') : maskName(r.full_name),
      mobile: unmasked ? (r.normalized_mobile || '') : maskMobile(r.normalized_mobile),
      email: unmasked ? (r.normalized_email || '') : maskEmail(r.normalized_email),
      enquiryType: r.source_type || null,
      propertyCodes: parsePropertyCodes(r.interested_property_ids),
      leadStageLabel: label('crm_lead_stage', r.lead_stage_code),
      leadStatusLabel: label('crm_lead_status', r.lead_status_code),
      leadRatingLabel: label('crm_lead_rating', r.lead_rating_code),
      meetingDate: when.date,
      meetingTime: when.time,
      timezone: r.timezone || 'Asia/Kolkata',
      // The operator's own text, exactly as stored. Never defaulted.
      remarks: r.context_note || r.detailed_note || null,
      reminderSentAt: reminder === '1h' ? (r.reminder_b_sent_at || null) : (r.reminder_a_sent_at || null),
    };
  });
}

module.exports = { counts, listByReminder, ONE_DAY_MINUTES, ONE_HOUR_MINUTES };
