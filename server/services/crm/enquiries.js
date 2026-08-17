/**
 * CRM Enquiry service (T-2026-151 Phase 1).
 *
 * List / detail / status-change flows for individual enquiries. Uses
 * the parents service for PII masking of the joined parent columns.
 *
 * The status-change flow is the CRM-wide "change status + optionally
 * schedule follow-up" operation:
 *   1. Validate the new status against the crm_status master.
 *   2. Insert a crm_calendar_activities row when a scheduled_at is
 *      supplied (calls the googleCalendar stub -> PENDING).
 *   3. Update crm_enquiries.status_code.
 *   4. Insert a crm_status_history row (immutable).
 *   All four happen in a single transaction so a failure anywhere
 *   rolls back the whole thing (no orphaned calendar rows, no half-
 *   applied status changes).
 */

const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const crm = require('../../db/queries/crm');
const masters = require('../masters/management');
const parents = require('./parents');
const googleCalendar = require('./googleCalendar');
// T-2026-165: appointment slot validation / edit / cancel service.
const appointmentSlots = require('./appointmentSlots');
const appts = require('../../db/queries/appointments');

// T-2026-166: exact CLOSED status master codes (seeded by migration 102
// -- 'closed_won' + 'closed_lost'). When an enquiry transitions INTO
// one of these codes we auto-cancel any active future appointment for
// that enquiry so its Google Calendar event goes away, its 15-min slot
// frees up for other bookings, and the admin stops getting phantom
// reminders. See changeStatus() below for the post-commit hook.
const CLOSED_STATUS_CODES = new Set(['closed_won', 'closed_lost']);

// T-2026-156: DTO now projects Name/Mobile/Email from the LIVE source
// row (crm_enquiries.source_type + source_id -> leads OR
// enquiry_properties) rather than from the crm_parents cache (which
// was a stale seeded snapshot). The `parent` block is still exposed
// (used by the FE for parent-grouping keys) but its display fields
// are now the LIVE source values -- crm_parents columns are used only
// for the parent_id grouping key + the normalized_mobile/email
// deduplication logic in the resolver.
//
// If the source row is missing (soft-delete race between the listing
// SQL and the DTO), we still return the row but mark it orphaned so
// the FE can render "(source deleted)" instead of masking blank
// fields into confusing "**" strings. The listing WHERE already
// filters orphans out, so this is a belt-and-braces guard.
function enquiryDto(row, { unmasked = false } = {}) {
  if (!row) return null;

  // Pick the live source columns per row's source_type.
  let liveName = '';
  let liveMobile = '';
  let liveEmail = '';
  let liveSourcePropertyCode = null;
  let liveSourcePropertyTitle = null;
  let isOrphan = false;

  if (row.source_type === 'website') {
    liveName   = row.live_website_name   || '';
    liveMobile = row.live_website_mobile || '';
    liveEmail  = row.live_website_email  || '';
    liveSourcePropertyCode  = row.live_website_property_code || null;
    liveSourcePropertyTitle = null;
    // If the JOIN produced no live name/mobile/email at all AND we
    // had a source_id, the source has been soft-deleted since
    // ingestion. Migration 104 hard-deletes such rows on run, but
    // this handles the mid-day race.
    if (!liveName && !liveMobile && !liveEmail && row.source_id) {
      isOrphan = true;
    }
  } else if (row.source_type === 'npd') {
    liveName   = row.live_npd_owner_name    || '';
    liveMobile = row.live_npd_owner_contact || '';
    // T-2026-162: NPD email now resolved from the Enquiry Person
    // Details JSON (details.dynamicData.contacts[0].emails[0]) via
    // the live_npd_owner_email alias added in listEnquiries +
    // findEnquiryByIdForDisplay. enquiry_properties still has no
    // top-level email column, so the JSON path is the only source
    // and a missing / blank JSON key correctly resolves to ''.
    liveEmail  = row.live_npd_owner_email   || '';
    liveSourcePropertyCode  = row.live_npd_property_code  || null;
    liveSourcePropertyTitle = row.live_npd_property_title || null;
    // T-2026-162: orphan check does NOT require an identity anymore.
    // The T-155/156 orphan-guard purpose is to hide rows whose
    // source_id no longer resolves in the source table (soft-delete
    // race). A live enquiry_properties row with no captured Enquiry
    // Person Details is NOT an orphan -- it must still appear in CRM
    // so the operator can complete the follow-up. Use property_code
    // presence as the "source is alive" signal instead.
    if (!liveName && !liveMobile && !liveEmail && !liveSourcePropertyCode && row.source_id) {
      isOrphan = true;
    }
  }

  // Compose the parent DTO from LIVE fields. parents.toDto masks
  // Name/Mobile/Email by default; passing unmasked=true (after PIN
  // header re-validation on the route) returns raw values.
  //
  // T-2026-162: for identity-less source rows (no owner_name /
  // contacts JSON name / mobile / email), fall back to the
  // crm_parents.full_name -- migration 106 stamps a placeholder
  // like 'Enquiry #19' / 'Lead #7' on the parent so the CRM row
  // has a stable, informative label instead of '(unnamed)' until
  // the operator captures the Enquiry Person Details.
  const displayName = liveName
    || (row.parent_full_name && !liveMobile && !liveEmail ? row.parent_full_name : '');
  const parentDto = parents.toDto({
    id:                row.parent_id,
    full_name:         displayName,
    normalized_mobile: liveMobile,
    normalized_email:  liveEmail,
    source_hint:       row.source_type,
    created_at:        null,
    updated_at:        null,
  }, { unmasked });

  return {
    id:                 row.id,
    enquiry_code:       row.enquiry_code,
    parent_id:          row.parent_id,
    parent:             parentDto,
    source_type:        row.source_type,
    source_id:          row.source_id,
    // Live source metadata so the FE can surface Property ID + Title
    // next to the enquiry ID without a second round-trip.
    source_property_code:  liveSourcePropertyCode,
    source_property_title: liveSourcePropertyTitle,
    status_code:        row.status_code,
    // T-2026-169 Phase A: three new lead-taxonomy fields. status_code
    // is preserved verbatim (T-166 auto-cancel + pre-T-169 UI still
    // read it) so nothing existing breaks. FE Change Lead modal +
    // Listing chips read these three; pre-T-169 rows populated via
    // migration 109 back-fill mapping.
    lead_stage_code:    row.lead_stage_code || null,
    lead_status_code:   row.lead_status_code || null,
    lead_rating_code:   row.lead_rating_code || null,
    interested_property_ids:
      row.interested_property_ids == null ? [] :
        (typeof row.interested_property_ids === 'string'
          ? JSON.parse(row.interested_property_ids)
          : row.interested_property_ids),
    is_orphan:          isOrphan,
    created_at:         row.created_at,
    updated_at:         row.updated_at,
  };
}

async function list(query = {}) {
  const { unmasked = false } = query;
  const res = await crm.listEnquiries(query);
  const rows = res.rows.map((r) => enquiryDto(r, { unmasked }));
  // T-2026-165: enrich each row with its current active appointment
  // (if any) so the FE CrmList can decide whether to render the
  // "Edit Booking" / "Cancel Booking" action icons without a per-row
  // round-trip. Uses a single batched SELECT (join subquery) rather
  // than N+1 lookups.
  if (rows.length) {
    const byEnquiry = await appts.getActiveAppointmentsForEnquiries(rows.map((r) => r.id));
    for (const r of rows) {
      const raw = byEnquiry.get(r.id);
      r.active_appointment = raw ? appointmentSlots.appointmentToDto(raw) : null;
    }
  }
  return { ...res, rows };
}

async function getById(id, { unmasked = false } = {}) {
  // T-2026-156: use the display-oriented lookup that joins live
  // sources (leads / enquiry_properties) so the detail response
  // matches the listing response contract.
  const row = await crm.findEnquiryByIdForDisplay(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Enquiry not found');
  const dto = enquiryDto(row, { unmasked });
  // T-2026-165: attach the current active appointment.
  dto.active_appointment = await appointmentSlots.getActiveForEnquiry(id);
  return dto;
}

/**
 * Change an enquiry's status, optionally scheduling a Google Calendar
 * follow-up (Strategy-C stub for Phase 1 -> PENDING).
 *
 * payload = {
 *   to_status:                required string (crm_status master code)
 *   note:                     optional string (goes on history + calendar)
 *   scheduled_at:             optional ISO string; if present, create a
 *                             calendar activity row
 *   timezone:                 optional string (default Asia/Kolkata)
 *   reminder_minutes_before_a: optional int (default 1440 = 1 day)
 *   reminder_minutes_before_b: optional int (default 60 = 1 hour)
 *   context_note:             optional string (calendar body text)
 * }
 */
async function changeStatus(id, payload, options = {}) {
  const { adminId, unmasked } = options;
  const raw = payload || {};
  // T-2026-178: BE-side defensive filter for the "No change" sentinel
  // ('' / null / undefined) forwarded by the T-176 dialogs. Per T-176
  // spec §1: an empty-string dropdown value means "do not touch that
  // column". FE modals already strip empties for Stage/Status; Rating
  // has additional semantics (see below). Belt-and-braces filter here
  // so any future caller (webhook, external integration, direct curl)
  // that forwards '' cannot corrupt the DB or trigger a malformed
  // UPDATE.
  const toStatus     = (raw.to_status     === '' || raw.to_status     == null) ? null : raw.to_status;
  const toLeadStage  = (raw.to_lead_stage === '' || raw.to_lead_stage == null) ? null : raw.to_lead_stage;
  const toLeadStatus = (raw.to_lead_status === '' || raw.to_lead_status == null) ? null : raw.to_lead_status;
  // Lead Rating is polymorphic on the FE:
  //   • undefined / null  -> not sent / not editable this pass -> no touch
  //   • ''                -> T-176 "No change" sentinel -> no touch
  //   • 'CLEAR'           -> explicit "Clear rating" action -> reset to NULL
  //   • any other string  -> master code (validated below)
  // We keep undefined vs 'CLEAR' distinct in the intermediate variable
  // (`normalizedLeadRating`) so the DB writer + history row + response
  // envelope can distinguish "not touched" from "explicitly cleared".
  const toLeadRating =
    (raw.to_lead_rating === undefined || raw.to_lead_rating === null || raw.to_lead_rating === '')
      ? undefined
      : raw.to_lead_rating;
  const { note, scheduled_at: scheduledAt, context_note: contextNote } = raw;

  // At least one field to change is required; otherwise this is a no-op.
  // T-2026-178: after the empty-string filter above, an all-"No change"
  // payload correctly bounces here as VALIDATION_ERROR before any SQL
  // runs -- matching the delegation's "no-op success or error, never
  // a malformed empty UPDATE" contract.
  if (!toStatus && !toLeadStage && !toLeadStatus && toLeadRating === undefined) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'At least one of to_status | to_lead_stage | to_lead_status | to_lead_rating is required');
  }
  // Legacy status master validation preserved: only fires when caller
  // supplied a legacy status change (pre-T-169 callers).
  if (toStatus) {
    await masters.assertActiveCode('crm_status', toStatus);
  }
  // T-2026-169 Phase A: validate each of the three new fields
  // independently against its own master. Any invalid code triggers a
  // 400 before any DB write, so partial-write bugs are impossible.
  if (toLeadStage) {
    await masters.assertActiveCode('crm_lead_stage', toLeadStage);
  }
  if (toLeadStatus) {
    await masters.assertActiveCode('crm_lead_status', toLeadStatus);
  }
  // Lead Rating -- T-178: the empty-string case has already been folded
  // to undefined above. Here we only see undefined | 'CLEAR' | code.
  let normalizedLeadRating; // undefined | 'CLEAR' | validated code
  if (toLeadRating !== undefined) {
    if (toLeadRating === 'CLEAR') {
      normalizedLeadRating = 'CLEAR';
    } else {
      await masters.assertActiveCode('crm_lead_rating', toLeadRating);
      normalizedLeadRating = toLeadRating;
    }
  }

  // T-2026-165: when the caller also supplied a scheduled_at, book the
  // appointment FIRST. If the slot conflicts we throw 409 BEFORE any
  // status change hits the DB -- so a picker retry lands cleanly
  // without producing a duplicate status history row. The status
  // change + history + denorm then follow inside a normal transaction.
  //
  // The appointment service runs its own transaction (needed for the
  // FOR UPDATE conflict check + UNIQUE(active_slot_key) belt-and-braces
  // race handling), so it commits before we open the status-change tx.
  // If the subsequent status-change transaction fails for any reason,
  // the appointment is left orphaned -- but that's the failure mode we
  // want: the appointment is the expensive external side-effect (Google
  // event created + email dispatched), and the operator can re-issue
  // the status change to bind it. Rolling back the appointment would
  // require a compensating cancelEvent call which risks user confusion.
  let appointment = null;
  if (scheduledAt) {
    appointment = await appointmentSlots.createAppointment({
      enquiryId:       id,
      scheduledAt,     // ISO string with +05:30
      contextNote:     contextNote || note || null,
      detailedNote:    note || null,
      statusHistoryId: null, // filled by the UPDATE below
      adminId:         adminId || null,
      unmasked:        !!unmasked,
      // Because we book BEFORE the taxonomy write below, the confirmation
      // email would otherwise read the enquiry back mid-flight and report
      // the values this request is about to REPLACE. Hand it the intended
      // trio so the mail matches what the operator just selected.
      // `undefined` = field not being changed -> the email keeps the
      // current DB value. 'CLEAR' maps to null (rating explicitly cleared).
      leadTaxonomyOverride: {
        stage:  toLeadStage  || undefined,
        status: toLeadStatus || undefined,
        rating: normalizedLeadRating === undefined
          ? undefined
          : (normalizedLeadRating === 'CLEAR' ? null : normalizedLeadRating),
      },
    });
  }

  const conn = await pool.getConnection();
  let statusHistoryId = null;
  // T-2026-169 Phase A: capture per-field history row IDs for the
  // response so the FE can chain forward if it needs to link the
  // per-field timeline entries.
  const leadTaxonomyHistoryIds = { lead_stage: null, lead_status: null, lead_rating: null };
  try {
    await conn.beginTransaction();
    const existing = await crm.findEnquiryByIdForConn(conn, id);
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Enquiry not found');

    // ------------------------------------------------------------------
    // Legacy status_code transition (T-2026-151, preserved for backward
    // compat + T-166 auto-cancel semantics). Only runs when the caller
    // supplied `to_status`. Historic call-sites (pre-T-169 FE) always
    // supplied it; the new T-169 FE modal MAY omit it when updating
    // only the new taxonomy fields.
    // ------------------------------------------------------------------
    const fromStatus = existing.status_code;
    if (toStatus) {
      if (fromStatus !== toStatus) {
        await crm.updateEnquiryStatusForConn(conn, id, toStatus);
      }
      statusHistoryId = await crm.insertStatusHistoryForConn(conn, {
        enquiryId:            id,
        fromStatus,
        toStatus,
        // field_scope defaults to 'status' -- explicit for clarity.
        fieldScope:           'status',
        note:                 note || null,
        changedByAdminId:     adminId || null,
        calendarActivityId:   appointment ? appointment.appointment_id : null,
        googleEventId:        appointment ? (appointment.google_event_id || null) : null,
      });
      // If an appointment was created, denorm back the status_history_id
      // onto the calendar_activity row so the appointment history panel
      // can chain forward to the history row if needed.
      if (appointment && appointment.appointment_id) {
        await conn.query(
          `UPDATE crm_calendar_activities SET status_history_id = ? WHERE id = ?`,
          [statusHistoryId, appointment.appointment_id],
        );
      }
    } else if (appointment && appointment.appointment_id) {
      // T-2026-169 Phase A: the new FE modal can attach a follow-up
      // appointment even when only the taxonomy fields change (no
      // legacy status transition). In that case the calendar_activity
      // row must still be linked to SOMETHING for the FE panel. We
      // link it to whichever taxonomy history row we create below --
      // fallback: leave status_history_id NULL (existing behaviour
      // for appointments created outside a status change).
    }

    // ------------------------------------------------------------------
    // T-2026-169 Phase A: new-taxonomy per-field updates + history.
    // Each supplied field triggers:
    //   (a) an UPDATE on the corresponding column via
    //       updateEnquiryLeadTaxonomyForConn (single UPDATE for all
    //       three; sentinel 'CLEAR' resets Lead Rating to NULL).
    //   (b) an immutable crm_status_history row with field_scope set
    //       to 'lead_stage' | 'lead_status' | 'lead_rating' so the
    //       History panel can render a per-field timeline.
    // ------------------------------------------------------------------
    const wantsTaxonomyUpdate = Boolean(toLeadStage) || Boolean(toLeadStatus) || normalizedLeadRating !== undefined;
    if (wantsTaxonomyUpdate) {
      await crm.updateEnquiryLeadTaxonomyForConn(conn, id, {
        leadStageCode:  toLeadStage  || null,
        leadStatusCode: toLeadStatus || null,
        leadRatingCode: normalizedLeadRating !== undefined ? normalizedLeadRating : null,
      });

      // Per-field history rows. Only insert when the value actually
      // changed vs the pre-tx existing row (idempotent no-ops don't
      // pollute the timeline).
      if (toLeadStage && existing.lead_stage_code !== toLeadStage) {
        leadTaxonomyHistoryIds.lead_stage = await crm.insertStatusHistoryForConn(conn, {
          enquiryId:        id,
          fromStatus:       existing.lead_stage_code || null,
          toStatus:         toLeadStage,
          fieldScope:       'lead_stage',
          note:             note || null,
          changedByAdminId: adminId || null,
          calendarActivityId: (statusHistoryId == null && appointment) ? appointment.appointment_id : null,
          googleEventId:      (statusHistoryId == null && appointment) ? (appointment.google_event_id || null) : null,
        });
      }
      if (toLeadStatus && existing.lead_status_code !== toLeadStatus) {
        leadTaxonomyHistoryIds.lead_status = await crm.insertStatusHistoryForConn(conn, {
          enquiryId:        id,
          fromStatus:       existing.lead_status_code || null,
          toStatus:         toLeadStatus,
          fieldScope:       'lead_status',
          note:             note || null,
          changedByAdminId: adminId || null,
          calendarActivityId: null,
          googleEventId:      null,
        });
      }
      if (normalizedLeadRating !== undefined) {
        const newVal = normalizedLeadRating === 'CLEAR' ? null : normalizedLeadRating;
        const oldVal = existing.lead_rating_code || null;
        if (newVal !== oldVal) {
          leadTaxonomyHistoryIds.lead_rating = await crm.insertStatusHistoryForConn(conn, {
            enquiryId:        id,
            fromStatus:       oldVal,
            // Empty/CLEAR gets recorded as '__cleared__' sentinel so the
            // NOT NULL to_status column is satisfied and the history
            // panel can render "cleared" verbatim. The three lead-taxonomy
            // masters do NOT contain this sentinel; the panel treats it
            // specially.
            toStatus:         newVal || '__cleared__',
            fieldScope:       'lead_rating',
            note:             note || null,
            changedByAdminId: adminId || null,
            calendarActivityId: null,
            googleEventId:      null,
          });
        }
      }

      // If the caller attached an appointment but did NOT supply
      // toStatus, link the calendar_activity row to the first taxonomy
      // history row we wrote so the appointment panel can still trace
      // back to some history entry.
      if (appointment && appointment.appointment_id && statusHistoryId == null) {
        const firstTaxonomyId = leadTaxonomyHistoryIds.lead_stage
          || leadTaxonomyHistoryIds.lead_status
          || leadTaxonomyHistoryIds.lead_rating;
        if (firstTaxonomyId) {
          await conn.query(
            `UPDATE crm_calendar_activities SET status_history_id = ? WHERE id = ?`,
            [firstTaxonomyId, appointment.appointment_id],
          );
        }
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  // T-2026-166: POST-COMMIT auto-cancel of any active future appointment
  // when the new status is CLOSED_WON or CLOSED_LOST. This runs OUTSIDE
  // the status-change transaction on purpose: the status transition is
  // authoritative and must not be rolled back if the appointment cancel
  // (or its downstream GCal events.delete) fails. Reuses the existing
  // appointmentSlots.cancelAppointment path so we inherit for free:
  //   - crm_appointment_history row with action='cancelled' + note
  //   - cancelled_by_admin_id recorded
  //   - booking_status='cancelled' + cancelled_at timestamp
  //   - GCal events.delete (best-effort, idempotent on 404/410)
  //   - cancellation email to lead (matches T-165 semantics)
  //
  // Only fires when we DID NOT just create an appointment in this same
  // request (the operator could conceivably close AND schedule in one
  // shot; that would be a UX oddity but we defer to the caller's intent
  // -- the just-created appointment stays, we only sweep prior ones).
  // The appts.getActiveAppointmentForEnquiry returns the MOST RECENT
  // active row, so if createAppointment above just inserted one, that's
  // what we'd fetch back and cancel -- which would defeat the caller.
  // Guard by matching appointment_id.
  let autoCancelledAppointment = undefined;
  if (CLOSED_STATUS_CODES.has(toStatus)) {
    try {
      const active = await appts.getActiveAppointmentForEnquiry(id);
      const justCreatedId = appointment ? appointment.appointment_id : null;
      if (active && active.id !== justCreatedId) {
        try {
          const cancelRes = await appointmentSlots.cancelAppointment({
            appointmentId: active.id,
            adminId:       adminId || null,
            actionNote:    `auto: enquiry status changed to ${toStatus.toUpperCase()}`,
          });
          autoCancelledAppointment = {
            appointment_id:  active.id,
            google_event_id: active.google_event_id || null,
            scheduled_at:    active.scheduled_at || null,
            ok:              true,
            gcal_sync_status: cancelRes.gcal_sync_status || null,
            gcal_reason:      cancelRes.gcal_reason || null,
          };
        } catch (cancelErr) {
          // Benign race: another admin already cancelled between our
          // read and our cancel call. Treat as success.
          if (cancelErr && cancelErr.code === 'ALREADY_CANCELLED') {
            autoCancelledAppointment = {
              appointment_id:  active.id,
              google_event_id: active.google_event_id || null,
              scheduled_at:    active.scheduled_at || null,
              ok:              true,
              reason:          'ALREADY_CANCELLED',
            };
          } else {
            // Real failure (e.g. GCal transient error, DB blip). Do NOT
            // re-throw -- the status change already committed and is
            // authoritative per spec. Log with enquiry_code only (no
            // PII: no lead name/mobile/email).
            // eslint-disable-next-line no-console
            console.warn(
              `[crm.enquiries] T-166 auto-cancel FAILED for enquiry_id=${id} appointment_id=${active.id}:`,
              (cancelErr && cancelErr.message) || 'unknown',
            );
            autoCancelledAppointment = {
              appointment_id:  active.id,
              google_event_id: active.google_event_id || null,
              scheduled_at:    active.scheduled_at || null,
              ok:              false,
              reason:          (cancelErr && cancelErr.code) || 'AUTO_CANCEL_FAILED',
            };
          }
        }
      }
    } catch (lookupErr) {
      // Even the lookup failed -- log and continue. Status change is
      // still authoritative and the response must succeed.
      // eslint-disable-next-line no-console
      console.warn(
        `[crm.enquiries] T-166 auto-cancel lookup FAILED for enquiry_id=${id}:`,
        (lookupErr && lookupErr.message) || 'unknown',
      );
    }
  }

  const response = {
    status: 'OK',
    enquiry_id: id,
    to_status: toStatus || null,
    calendar_activity_id: appointment ? appointment.appointment_id : null,
    appointment,  // T-2026-165: full appointment payload when present
  };
  // T-2026-166: additive field. Only present when a CLOSED transition
  // actually triggered a cancel attempt (present regardless of
  // success/failure so the FE can render the outcome toast). Non-CLOSED
  // transitions omit the key entirely -> byte-identical to pre-T-166
  // responses.
  if (autoCancelledAppointment !== undefined) {
    response.auto_cancelled_appointment = autoCancelledAppointment;
  }
  // T-2026-169 Phase A: additive fields carrying the new taxonomy that
  // just landed. Present ONLY when the caller supplied the corresponding
  // field (undefined omission preserves pre-T-169 response shape). FE
  // uses these to update its local row optimistically without a
  // list-refresh round-trip.
  if (toLeadStage !== undefined && toLeadStage !== null) {
    response.to_lead_stage = toLeadStage;
    response.lead_stage_history_id = leadTaxonomyHistoryIds.lead_stage;
  }
  if (toLeadStatus !== undefined && toLeadStatus !== null) {
    response.to_lead_status = toLeadStatus;
    response.lead_status_history_id = leadTaxonomyHistoryIds.lead_status;
  }
  if (normalizedLeadRating !== undefined) {
    response.to_lead_rating = normalizedLeadRating === 'CLEAR' ? null : normalizedLeadRating;
    response.lead_rating_history_id = leadTaxonomyHistoryIds.lead_rating;
  }
  return response;
}

module.exports = {
  list,
  getById,
  changeStatus,
  enquiryDto,
};
