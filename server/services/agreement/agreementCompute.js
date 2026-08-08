// Agreement Tracking & Reminder — pure computation module (T-2026-112).
//
// Given an `agreement_end_date` (DATE, YYYY-MM-DD or JS Date) and a
// reference "today", derives the fields the reminder list, dashboard
// widget, and topbar badge all consume:
//
//   • daysRemaining      — integer, positive when in the future, 0 on
//                          expiry day, negative once overdue.
//   • daysOverdue        — integer, positive after expiry, 0 on expiry
//                          day, negative when the agreement has not yet
//                          expired. Always the additive inverse of
//                          daysRemaining.
//   • statusCode         — machine key: 'active' | 'reminder_started' |
//                          'upcoming_expiry' | 'expiring_soon' |
//                          'expires_today' | 'overdue' | 'unset'.
//   • statusLabel        — human label matching the spec's color legend.
//   • displayLabel       — the exact string the "Remaining Days" column
//                          should render (e.g. "120 Days Remaining",
//                          "Expires Today", "1 Day Overdue",
//                          "365 Days Overdue").
//   • badgeCountable     — true when this agreement should count toward
//                          the topbar notification badge (i.e. the
//                          reminder has started OR the agreement is
//                          overdue). Explicit boolean so the SQL badge
//                          count and the JS-derived label stay aligned.
//
// The reference date defaults to the current server date. Callers that
// need to test deterministic scenarios can pass `{ today: '2026-12-01' }`.
//
// No DB access, no external calls — the module is pure so it can be
// composed into route handlers, aggregation queries, and unit tests
// without setup. Sibling utilities (server/services/inventory/
// landPricingCompute.js, landFrontageCompute.js) follow the same
// convention.

// ---- Constants ----------------------------------------------------------

const REMINDER_START_DAYS = 30;     // Reminder window opens 30 days before end
const UPCOMING_EXPIRY_MIN = 15;     // 15–29 days remaining → Upcoming Expiry
const EXPIRING_SOON_MAX = 7;        // 1–7 days remaining → Expiring Soon
const MAX_OVERDUE_TRACKING = 365;   // Overdue tracking window (spec: "up to at
                                    // least 365 Days Overdue"). We do NOT cap
                                    // the returned value; the list keeps
                                    // showing "N Days Overdue" past 365 too,
                                    // per the spec ("Do NOT auto-remove
                                    // expired agreements"). The constant is
                                    // exported for callers that DO want to
                                    // enforce a display ceiling.

const STATUS = {
  ACTIVE:            'active',
  REMINDER_STARTED:  'reminder_started',
  UPCOMING_EXPIRY:   'upcoming_expiry',
  EXPIRING_SOON:     'expiring_soon',
  EXPIRES_TODAY:     'expires_today',
  OVERDUE:           'overdue',
  UNSET:             'unset',
};

const STATUS_LABELS = {
  [STATUS.ACTIVE]:            'Active',
  [STATUS.REMINDER_STARTED]:  'Reminder Started',
  [STATUS.UPCOMING_EXPIRY]:   'Upcoming Expiry',
  [STATUS.EXPIRING_SOON]:     'Expiring Soon',
  [STATUS.EXPIRES_TODAY]:     'Expires Today',
  [STATUS.OVERDUE]:           'Overdue',
  [STATUS.UNSET]:             'No Agreement Date',
};

// ---- Date helpers -------------------------------------------------------

// Coerce any of {Date, ISO string 'YYYY-MM-DD', full ISO datetime,
// DATE row from mysql} into a `Date` at UTC midnight. Returns null if
// the input is empty or unparseable. UTC midnight is used so that
// day-difference arithmetic never trips on a DST boundary — both dates
// are normalised to the same time-of-day.
function toUtcMidnight(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === 'string') {
    // Accept 'YYYY-MM-DD' (most common — DATE columns + FE input)
    // and full ISO datetimes ('2026-12-01T00:00:00.000Z' — some ORM
    // paths).
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!iso) return null;
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    if (!y || !m || !d) return null;
    // Basic sanity — year in a plausible range, month 1-12, day 1-31.
    if (y < 1900 || y > 2200) return null;
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > 31) return null;
    return new Date(Date.UTC(y, m - 1, d));
  }
  return null;
}

function todayUtcMidnight() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Whole-day difference (endDate - today), positive when end is in the future.
function daysBetween(endDate, refDate) {
  if (!endDate || !refDate) return null;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((endDate.getTime() - refDate.getTime()) / MS_PER_DAY);
}

// ---- Label helpers ------------------------------------------------------

function daysRemainingLabel(days) {
  if (days === 0) return 'Expires Today';
  if (days === 1) return '1 Day Remaining';
  return `${days} Days Remaining`;
}

function daysOverdueLabel(days) {
  if (days === 1) return '1 Day Overdue';
  return `${days} Days Overdue`;
}

// ---- Core API -----------------------------------------------------------

/**
 * Compute agreement reminder state for a single agreement end date.
 *
 * @param {string|Date|null} endDateInput  agreement_end_date
 * @param {object} [opts]
 * @param {string|Date|null} [opts.today]  reference "today" (defaults to now)
 * @returns {object}                       see module docstring for shape
 */
function computeAgreementState(endDateInput, opts = {}) {
  const endDate = toUtcMidnight(endDateInput);
  const today = toUtcMidnight(opts.today) || todayUtcMidnight();

  if (!endDate) {
    return {
      daysRemaining: null,
      daysOverdue: null,
      statusCode: STATUS.UNSET,
      statusLabel: STATUS_LABELS[STATUS.UNSET],
      displayLabel: '—',
      badgeCountable: false,
    };
  }

  const daysRemaining = daysBetween(endDate, today);
  const daysOverdue = -daysRemaining;

  let statusCode;
  let displayLabel;

  if (daysRemaining > REMINDER_START_DAYS) {
    // >30 days remaining → Active. Reminder not yet started.
    statusCode = STATUS.ACTIVE;
    displayLabel = daysRemainingLabel(daysRemaining);
  } else if (daysRemaining === REMINDER_START_DAYS) {
    // Exactly 30 days remaining → Reminder Started (the moment the
    // reminder becomes visible in the list).
    statusCode = STATUS.REMINDER_STARTED;
    displayLabel = daysRemainingLabel(daysRemaining);
  } else if (daysRemaining >= UPCOMING_EXPIRY_MIN && daysRemaining < REMINDER_START_DAYS) {
    // 15–29 days remaining → Upcoming Expiry.
    statusCode = STATUS.UPCOMING_EXPIRY;
    displayLabel = daysRemainingLabel(daysRemaining);
  } else if (daysRemaining >= 1 && daysRemaining <= EXPIRING_SOON_MAX) {
    // 1–7 days remaining → Expiring Soon.
    statusCode = STATUS.EXPIRING_SOON;
    displayLabel = daysRemainingLabel(daysRemaining);
  } else if (daysRemaining >= EXPIRING_SOON_MAX + 1 && daysRemaining < UPCOMING_EXPIRY_MIN) {
    // 8–14 days remaining — falls between "Expiring Soon" and
    // "Upcoming Expiry" in the spec's color legend. Treated as
    // Expiring Soon (closer to expiry than to the 15-day threshold).
    statusCode = STATUS.EXPIRING_SOON;
    displayLabel = daysRemainingLabel(daysRemaining);
  } else if (daysRemaining === 0) {
    // Expiry day → Expires Today.
    statusCode = STATUS.EXPIRES_TODAY;
    displayLabel = 'Expires Today';
  } else {
    // After expiry → Overdue.
    statusCode = STATUS.OVERDUE;
    displayLabel = daysOverdueLabel(daysOverdue);
  }

  const badgeCountable = (
    statusCode === STATUS.REMINDER_STARTED
    || statusCode === STATUS.UPCOMING_EXPIRY
    || statusCode === STATUS.EXPIRING_SOON
    || statusCode === STATUS.EXPIRES_TODAY
    || statusCode === STATUS.OVERDUE
  );

  return {
    daysRemaining,
    daysOverdue,
    statusCode,
    statusLabel: STATUS_LABELS[statusCode] || statusCode,
    displayLabel,
    badgeCountable,
  };
}

/**
 * Attach computed agreement state onto a row-shaped object. Useful when
 * enriching a list of DB rows before sending them to the client.
 *
 * @param {object} row      any object carrying `agreement_end_date` or
 *                          `agreementEndDate`
 * @param {object} [opts]   passed through to computeAgreementState
 * @returns {object}        row + computed { agreement: {...} } key
 */
function enrichRow(row, opts = {}) {
  if (!row || typeof row !== 'object') return row;
  const endDate = row.agreement_end_date
    ?? row.agreementEndDate
    ?? null;
  const agreement = computeAgreementState(endDate, opts);
  return { ...row, agreement };
}

module.exports = {
  computeAgreementState,
  enrichRow,
  STATUS,
  STATUS_LABELS,
  REMINDER_START_DAYS,
  UPCOMING_EXPIRY_MIN,
  EXPIRING_SOON_MAX,
  MAX_OVERDUE_TRACKING,
  // Exported for tests
  _internals: { toUtcMidnight, daysBetween, todayUtcMidnight },
};
