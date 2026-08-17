/**
 * Duplicate resolver for CRM ingestion (T-2026-151 Phase 1).
 *
 * Given an ingestion payload (from Website POST / NPD POST / manual CRM
 * add), find the existing parent (if any) OR create a new parent, and
 * insert exactly one crm_enquiries row against it.
 *
 * Spec cases:
 *   A. Mobile matches an existing parent -> reuse it (append enquiry).
 *   B. Email matches an existing parent -> reuse it (append enquiry).
 *   C. Mobile AND email both match the SAME parent -> reuse it.
 *   D. Neither matches -> create a new parent, then append enquiry.
 *   E. (spec section 75) Mobile matches Parent A, email matches Parent B,
 *      A != B -> DO NOT auto-merge. Insert a crm_duplicate_conflicts row
 *      and return { status: 'DUPLICATE_CONFLICT', ... } so the FE can
 *      surface the conflict resolution UI (Phase 2).
 *
 * Concurrency: the entire find-or-create runs inside a single
 * BEGIN/COMMIT with SELECT ... FOR UPDATE on both mobile and email
 * indexes. If two concurrent ingestions race, the second waits on the
 * FOR-UPDATE lock; when it proceeds, it re-reads the (now-committed)
 * parent inserted by the first and takes the "reuse" branch. The
 * UNIQUE indexes on normalized_mobile + normalized_email are the DB-
 * side backstop against races that somehow slip past the JS lock.
 *
 * Public API:
 *   ingest(payload, options) -> {
 *     status: 'INGESTED' | 'DUPLICATE_CONFLICT',
 *     parent_id, enquiry_id, enquiry_code, is_new_parent,
 *     // when status = 'DUPLICATE_CONFLICT':
 *     conflict_id, parent_a_id, parent_b_id,
 *   }
 *
 * Payload shape:
 *   {
 *     full_name:   string,
 *     mobile:      string  (raw, will be normalized),
 *     email:       string  (raw, will be normalized),
 *     source_type: 'website' | 'npd',    // T-2026-155: EXACTLY these two
 *     source_id:   number  (optional; row id in the source table),
 *     status_code: string  (optional; defaults to 'new'),
 *     ingestion_snapshot: object (arbitrary JSON to freeze),
 *   }
 *
 * T-2026-155 (corrective for T-2026-151 Phase 1): source_type is now
 * strictly restricted to the two ingestion channels ('website' from
 * the Website Buyer Enquiry surface, 'npd' from the admin NPD Enquiry
 * Properties form). Any other value (including the Phase-1 legacy
 * 'manual') is rejected at this validator with 400 VALIDATION_ERROR
 * before any DB write. This mirrors the DB CHECK constraint added in
 * migration 103 -- two defensive layers, both single-source-of-truth
 * to this two-value literal enum.
 *
 * Options:
 *   { adminId }  -- for status-history authorship on the initial insert.
 */

const { pool } = require('../../db/pool');
const { HttpError } = require('../../middleware/errors');
const crm = require('../../db/queries/crm');

// T-2026-155: hardcoded literal set (per user's explicit direction --
// NOT a lookup master, NOT user-editable, NOT dynamically resolved).
const ALLOWED_SOURCE_TYPES = new Set(['website', 'npd']);

async function ingest(payload, options = {}) {
  const {
    full_name: fullName,
    mobile,
    email,
    source_type: sourceType,
    source_id: sourceId,
    status_code: statusCode,
    ingestion_snapshot: ingestionSnapshot,
  } = payload || {};

  // T-2026-155: reject unknown source types before anything else.
  // Matches the DB CHECK ck_crm_enq_source_type_allowed added in
  // migration 103 so the constraint is enforced at both layers.
  if (!ALLOWED_SOURCE_TYPES.has(sourceType)) {
    throw new HttpError(
      400,
      'CRM_INGEST_BAD_SOURCE_TYPE',
      `CRM source_type must be one of: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}. Received: ${sourceType == null ? '<null>' : String(sourceType)}`,
    );
  }

  const normalizedMobile = crm.normalizeMobile(mobile);
  const normalizedEmail = crm.normalizeEmail(email);

  // T-2026-162: no-identity branch. Historically we rejected any
  // ingest that lacked BOTH a normalized mobile AND a normalized email
  // with CRM_INGEST_NO_KEY -- but that silently dropped legitimate NPD
  // Enquiry Property rows the admin created without capturing an
  // Enquiry Person Contact yet (e.g. drafts saved before the details
  // section is filled). Per delegation "every non-deleted
  // enquiry_properties row must appear in CRM ... only valid exclusion
  // is genuinely deleted", we now allow ingests that have a source_id
  // to proceed on a per-source placeholder-parent branch (below).
  //
  // The old error still fires when there is NO identity AND NO
  // source_id (which would be a genuine caller bug -- there is nothing
  // to attach the CRM row to).
  if (!normalizedMobile && !normalizedEmail && !sourceId) {
    throw new HttpError(
      400,
      'CRM_INGEST_NO_KEY',
      'CRM ingest requires at least a mobile, an email, or a source_id to identify the parent',
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // T-2026-162: no-identity branch. When we have no mobile and no
    // email but we DO have a source_id, look for an existing
    // crm_enquiries row for this exact (source_type, source_id) --
    // reuse its parent if present, otherwise create a fresh
    // placeholder parent (normalized_mobile=NULL, normalized_email=NULL;
    // MySQL treats NULLs as distinct in UNIQUE indexes so multiple
    // placeholder parents coexist). This keeps every non-deleted
    // source row visible in CRM even before the operator captures
    // any Enquiry Person Contact.
    if (!normalizedMobile && !normalizedEmail) {
      const existing = await crm.findEnquiryBySourceForConn(conn, sourceType, sourceId);
      if (existing) {
        // Repeated ingest for the same source row is a no-op (matches
        // the idempotency contract of the runtime hooks). Return the
        // existing enquiry so the caller can log a successful projection.
        await conn.commit();
        return {
          status: 'INGESTED',
          parent_id: existing.parent_id,
          enquiry_id: existing.id,
          enquiry_code: existing.enquiry_code,
          is_new_parent: false,
        };
      }
      const placeholderName = (fullName && String(fullName).trim())
        || `${sourceType === 'npd' ? 'Enquiry' : 'Lead'} #${sourceId}`;
      const placeholderParentId = await crm.insertParentForConn(conn, {
        fullName: placeholderName,
        normalizedMobile: null,
        normalizedEmail: null,
        sourceHint: sourceType,
      });
      const yearPrefix = String(new Date().getUTCFullYear());
      const enquiryCode = await crm.nextEnquiryCodeForConn(conn, yearPrefix);
      const enquiryId = await crm.insertEnquiryForConn(conn, {
        parentId: placeholderParentId,
        enquiryCode,
        sourceType,
        sourceId,
        statusCode: statusCode || 'new',
      });
      await crm.insertStatusHistoryForConn(conn, {
        enquiryId,
        fromStatus: null,
        toStatus: statusCode || 'new',
        note: 'Initial ingestion (no identity captured yet)',
        changedByAdminId: options.adminId || null,
        calendarActivityId: null,
      });
      await conn.commit();
      return {
        status: 'INGESTED',
        parent_id: placeholderParentId,
        enquiry_id: enquiryId,
        enquiry_code: enquiryCode,
        is_new_parent: true,
      };
    }

    // Case scan with FOR UPDATE.
    const parentByMobile = await crm.findParentByMobileForConn(conn, normalizedMobile);
    const parentByEmail = await crm.findParentByEmailForConn(conn, normalizedEmail);

    let parentId = null;
    let isNewParent = false;

    if (parentByMobile && parentByEmail) {
      if (parentByMobile.id === parentByEmail.id) {
        // Case C
        parentId = parentByMobile.id;
      } else {
        // Case E (spec section 75): CONFLICT
        // T-2026-155: sourceType is guaranteed by the guard above to
        // be one of {'website','npd'} so no fallback string is needed
        // here. Passing anything else would fail the DB CHECK
        // ck_crm_conflict_source_type_allowed (migration 103).
        const conflictId = await crm.insertConflictForConn(conn, {
          parentAId: parentByMobile.id,
          parentBId: parentByEmail.id,
          sourceType,
          sourceId: sourceId || null,
          payload: {
            full_name: fullName,
            mobile,
            email,
            normalized_mobile: normalizedMobile,
            normalized_email: normalizedEmail,
            status_code: statusCode || 'new',
            ingestion_snapshot: ingestionSnapshot || {},
          },
        });
        await conn.commit();
        return {
          status: 'DUPLICATE_CONFLICT',
          conflict_id: conflictId,
          parent_a_id: parentByMobile.id,
          parent_b_id: parentByEmail.id,
        };
      }
    } else if (parentByMobile) {
      // Case A
      parentId = parentByMobile.id;
    } else if (parentByEmail) {
      // Case B
      parentId = parentByEmail.id;
    } else {
      // Case D: create parent.
      try {
        parentId = await crm.insertParentForConn(conn, {
          fullName,
          normalizedMobile,
          normalizedEmail,
          sourceHint: sourceType || 'unknown',
        });
        isNewParent = true;
      } catch (err) {
        // DB-side backstop: another concurrent ingestion beat us on the
        // unique key. Re-read the parent and take the reuse branch.
        if (err && err.code === 'ER_DUP_ENTRY') {
          const retryMobile = await crm.findParentByMobileForConn(conn, normalizedMobile);
          const retryEmail = await crm.findParentByEmailForConn(conn, normalizedEmail);
          const resolved = retryMobile || retryEmail;
          if (!resolved) throw err;
          parentId = resolved.id;
        } else {
          throw err;
        }
      }
    }

    // T-2026-175: DO NOT refresh parent's full_name on reuse. The prior
    // "best-name" heuristic (longest-name wins) mutated the parent record
    // whenever a duplicate contact match reused an existing parent. That
    // silently overwrote the FIRST ingest's name whenever a later
    // sub-enquiry with a longer name was ingested, and (because the CRM
    // listing's parent-header still reads parent_full_name as a fallback
    // for identity-less placeholder rows) was surfaced in the UI as
    // "sub-enquiry adopts parent's / most-recent-longest-name identity".
    //
    // Per the user's non-negotiable: "Preserve the submitted identity of
    // every enquiry" and "Never copy the parent enquiry's name into a new
    // enquiry" -- and the symmetric rule "matching must never modify the
    // submitted name" -- we keep the parent's full_name AS-SET on the
    // FIRST ingest. Each subsequent sub-enquiry's own name lives only in
    // the live source row (leads.buyer_name / enquiry_properties.owner_name
    // / enquiry_properties.details.dynamicData.contacts[0].name) and is
    // projected per-row by enquiries.js enquiryDto(). The parent chip in
    // the CRM listing now correctly shows the ORIGINAL parent identity;
    // each sub-enquiry row correctly shows its OWN submitted name.
    //
    // Non-destructive: crm_parents.full_name from any legacy row already
    // mutated by pre-T-175 ingests is left in place; the parent header
    // simply shows whatever value that column happens to hold. New
    // ingests never trigger another mutation.
    //
    // updateParentBestNameForConn() the DB query remains exported for
    // any future admin-side tool that might legitimately want to relabel
    // a parent (e.g. an operator manually correcting a bad name via a
    // future admin UI); this call site is the only one that fired on
    // ingest, and it is now removed.

    // Enquiry code (per-year sequence).
    const yearPrefix = String(new Date().getUTCFullYear());
    const enquiryCode = await crm.nextEnquiryCodeForConn(conn, yearPrefix);

    // Insert enquiry.
    // T-2026-155: sourceType guaranteed valid by the top-of-function
    // guard. Direct pass-through -- no legacy 'manual' fallback.
    // T-2026-156: ingestionSnapshot no longer persisted. The CRM
    // listing joins live source tables at read time so a per-row
    // cache is unnecessary. The payload key is still accepted (for
    // backward-compat with any queued job that constructs the
    // payload) but silently discarded.
    const enquiryId = await crm.insertEnquiryForConn(conn, {
      parentId,
      enquiryCode,
      sourceType,
      sourceId: sourceId || null,
      statusCode: statusCode || 'new',
    });

    // Initial status history row (from=NULL -> to=<statusCode>).
    await crm.insertStatusHistoryForConn(conn, {
      enquiryId,
      fromStatus: null,
      toStatus: statusCode || 'new',
      note: 'Initial ingestion',
      changedByAdminId: options.adminId || null,
      calendarActivityId: null,
    });

    await conn.commit();

    return {
      status: 'INGESTED',
      parent_id: parentId,
      enquiry_id: enquiryId,
      enquiry_code: enquiryCode,
      is_new_parent: isNewParent,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Resolve a pending DUPLICATE_CONFLICT by attaching the staged
 * enquiry to one of the two parents. Idempotent (a second call on an
 * already-resolved conflict is a no-op).
 */
async function resolveConflict({ conflictId, attachToParentId, adminId }) {
  if (!conflictId) throw new HttpError(400, 'VALIDATION_ERROR', 'conflictId is required');
  if (!attachToParentId) throw new HttpError(400, 'VALIDATION_ERROR', 'attachToParentId is required');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const conflict = await crm.findConflictByIdForConn(conn, conflictId);
    if (!conflict) throw new HttpError(404, 'NOT_FOUND', 'Conflict not found');
    if (conflict.resolved_at) {
      await conn.commit();
      return {
        status: 'ALREADY_RESOLVED',
        conflict_id: conflictId,
        parent_id: conflict.resolved_attach_to_parent_id,
        enquiry_id: conflict.resolved_enquiry_id,
      };
    }
    const targetParent = Number(attachToParentId);
    // String-compare so a driver that returns BIGINTs as strings does not
    // break the check (crm_parents.id is BIGINT UNSIGNED per migration 101).
    const paStr = String(conflict.parent_a_id);
    const pbStr = String(conflict.parent_b_id);
    const tgtStr = String(targetParent);
    if (tgtStr !== paStr && tgtStr !== pbStr) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'attachToParentId must equal parent_a_id or parent_b_id from the conflict',
      );
    }

    const payload = typeof conflict.payload_json === 'string'
      ? JSON.parse(conflict.payload_json)
      : (conflict.payload_json || {});

    // Enquiry code + insert against the chosen parent.
    const yearPrefix = String(new Date().getUTCFullYear());
    const enquiryCode = await crm.nextEnquiryCodeForConn(conn, yearPrefix);
    // T-2026-155: conflict.source_type has been restricted at the DB
    // layer (migration 103 crm_duplicate_conflicts CHECK) to
    // ('website','npd'). Any older row in a non-migrated DB would
    // still be caught by the crm_enquiries CHECK on insert, so we
    // defensively validate here rather than defaulting to 'manual'
    // (which would immediately fail the enquiry CHECK).
    if (!ALLOWED_SOURCE_TYPES.has(conflict.source_type)) {
      throw new HttpError(
        400,
        'CRM_CONFLICT_BAD_SOURCE_TYPE',
        `Conflict source_type must be one of: ${Array.from(ALLOWED_SOURCE_TYPES).join(', ')}. Received: ${conflict.source_type == null ? '<null>' : String(conflict.source_type)}`,
      );
    }
    // T-2026-156: ingestionSnapshot dropped per migration 104.
    const enquiryId = await crm.insertEnquiryForConn(conn, {
      parentId: targetParent,
      enquiryCode,
      sourceType: conflict.source_type,
      sourceId: conflict.source_id || null,
      statusCode: payload.status_code || 'new',
    });
    // T-2026-175: same rule as the reuse branch in ingest() -- resolving
    // a duplicate conflict must NOT mutate the target parent's full_name.
    // The staged enquiry's submitted identity lives in the live source
    // row (leads.buyer_name / enquiry_properties.owner_name / JSON
    // contacts[0].name) and is projected per-row by enquiries.js
    // enquiryDto(). Overwriting the parent chip's name on conflict
    // resolution would repeat the pre-T-175 symptom (the operator
    // resolves ENQ-002 by attaching to Parent A; the parent chip would
    // suddenly rename from "Keshav" to "Paresh"). The parent identity
    // stays stable; the sub-enquiry surfaces its own name.
    await crm.insertStatusHistoryForConn(conn, {
      enquiryId,
      fromStatus: null,
      toStatus: payload.status_code || 'new',
      note: 'Ingested via duplicate-conflict resolution',
      changedByAdminId: adminId || null,
      calendarActivityId: null,
    });
    await crm.markConflictResolvedForConn(conn, {
      conflictId,
      attachToParentId: targetParent,
      resolvedEnquiryId: enquiryId,
      resolvedByAdminId: adminId || null,
    });
    await conn.commit();
    return {
      status: 'RESOLVED',
      conflict_id: conflictId,
      parent_id: targetParent,
      enquiry_id: enquiryId,
      enquiry_code: enquiryCode,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  ingest,
  resolveConflict,
};
