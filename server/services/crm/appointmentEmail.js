/**
 * T-2026-179 REWRITE: CRM booking notification emails route ONLY to the
 * admin address configured in Email Master. Prior to T-179 this module
 * sent to the lead's own email (leadEmail) on create / edit / cancel --
 * that leaked lead PII + spammed customers on every internal action.
 *
 * The public surface is preserved so appointmentSlots.js doesn't need
 * to know about the rewrite:
 *
 *   sendAppointmentEmail({
 *     mode: 'created' | 'edited' | 'cancelled' | 'reminder',
 *     enquiryCode, enquiryType, leadName, leadEmail, leadMobile,
 *     scheduledAt, previousScheduledAt?, propertyCodes?, propertyIds?,
 *     leadStage?, leadStatus?, leadRating?, notes?, updatedByName?,
 *     cancellationReason?, leadMinutes?,
 *   }) -> { sent, skipped_reason? }
 *
 * 'reminder' (migration 112) is the pre-call nudge dispatched by
 * services/crm/appointmentReminders.js, carrying `leadMinutes` (1440 / 60).
 *
 * `leadEmail` is captured for the defensive customer-email guard in
 * adminNotifications.sendAdminNotification; it is NEVER used as the
 * recipient. If leadEmail is missing/invalid the send still fires --
 * admin visibility does not depend on the lead's email being valid.
 */

const adminNotifications = require('../email/adminNotifications');
const { pool } = require('../../db/pool');

async function resolvePropertyCodesFromIds(propertyIds) {
  if (!Array.isArray(propertyIds) || propertyIds.length === 0) return [];
  const uniqIds = Array.from(new Set(
    propertyIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0),
  ));
  if (uniqIds.length === 0) return [];
  const placeholders = uniqIds.map(() => '?').join(',');
  try {
    const [rows] = await pool.query(
      `SELECT id, property_code, title
         FROM inventory_properties
        WHERE id IN (${placeholders})
          AND deleted_at IS NULL`,
      uniqIds,
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const out = [];
    for (const id of uniqIds) {
      const row = byId.get(Number(id));
      if (row && row.property_code) out.push(row.property_code);
    }
    return out;
  } catch (_err) {
    // Fail-open: if the lookup fails we still send the email with an
    // empty property list rather than dropping the whole notification.
    return [];
  }
}

/**
 * Fire an admin notification for a CRM booking lifecycle event. Never
 * throws (upstream commit already happened; a mail failure is not fatal).
 * Returns { sent, skipped_reason? }.
 */
async function sendAppointmentEmail(ctx) {
  if (!ctx || !ctx.mode) return { sent: false, skipped_reason: 'MISSING_MODE' };
  const {
    mode,
    enquiryCode,
    enquiryType,
    leadName,
    leadEmail,
    leadMobile,
    scheduledAt,
    previousScheduledAt,
    propertyCodes,
    propertyIds,
    leadStage,
    leadStatus,
    leadRating,
    notes,
    updatedByName,
    updatedAt,
    cancellationReason,
    leadMinutes,          // 'reminder' mode only: 1440 or 60
  } = ctx;

  // Resolve property codes if the caller only had numeric ids.
  let codes = Array.isArray(propertyCodes) && propertyCodes.length
    ? propertyCodes.filter(Boolean)
    : [];
  if (codes.length === 0 && Array.isArray(propertyIds) && propertyIds.length) {
    codes = await resolvePropertyCodesFromIds(propertyIds);
  }

  try {
    if (mode === 'created') {
      const rendered = adminNotifications.renderCrmBookingCreated({
        enquiryCode,
        enquiryName: leadName,
        mobile: leadMobile,
        email: leadEmail,
        source: enquiryType,
        scheduledAt,
        leadStage,
        leadStatus,
        leadRating,
        propertyCodes: codes,
        notes,
      });
      return adminNotifications.sendAdminNotification({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        type: adminNotifications.TYPES.CRM_BOOKING_CREATED,
        customerEmails: rendered.customerEmails,
      });
    }

    if (mode === 'edited') {
      const rendered = adminNotifications.renderCrmBookingRescheduled({
        enquiryCode,
        enquiryName: leadName,
        mobile: leadMobile,
        email: leadEmail,
        source: enquiryType,
        previousScheduledAt,
        newScheduledAt: scheduledAt,
        propertyCodes: codes,
        updatedByName,
        updatedAt: updatedAt || adminNotifications.nowIstDate(),
      });
      return adminNotifications.sendAdminNotification({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        type: adminNotifications.TYPES.CRM_BOOKING_RESCHEDULED,
        customerEmails: rendered.customerEmails,
      });
    }

    if (mode === 'cancelled') {
      const rendered = adminNotifications.renderCrmBookingCancelled({
        enquiryCode,
        enquiryName: leadName,
        mobile: leadMobile,
        email: leadEmail,
        source: enquiryType,
        propertyCodes: codes,
        previouslyScheduledAt: scheduledAt,
        cancelledAt: adminNotifications.nowIstDate(),
        cancellationReason,
      });
      return adminNotifications.sendAdminNotification({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        type: adminNotifications.TYPES.CRM_BOOKING_CANCELLED,
        customerEmails: rendered.customerEmails,
      });
    }

    // Pre-call reminder (migration 112). Fired by the cron-driven
    // appointmentReminders dispatcher at the booking's own
    // reminder_minutes_before_a / _b offsets (1 day / 1 hour), NOT by an
    // operator action -- so unlike the three lifecycle modes above there is
    // no actor to attribute and no before/after slot to diff.
    if (mode === 'reminder') {
      const rendered = adminNotifications.renderCrmBookingReminder({
        enquiryCode,
        enquiryName: leadName,
        mobile: leadMobile,
        email: leadEmail,
        source: enquiryType,
        scheduledAt,
        leadMinutes,
        leadStage,
        leadStatus,
        leadRating,
        propertyCodes: codes,
        notes,
      });
      return adminNotifications.sendAdminNotification({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        type: adminNotifications.TYPES.CRM_BOOKING_REMINDER,
        customerEmails: rendered.customerEmails,
      });
    }

    return { sent: false, skipped_reason: 'UNKNOWN_MODE' };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[appointmentEmail] send failed:', (e && e.message) || 'unknown');
    return { sent: false, skipped_reason: 'SEND_ERROR' };
  }
}

module.exports = {
  sendAppointmentEmail,
  // Exposed for tests / diagnostic callers.
  resolvePropertyCodesFromIds,
};
