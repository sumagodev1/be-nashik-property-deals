/**
 * CRM Allocations service (T-2026-151 Phase 3).
 *
 * Manages the many-to-many link between crm_enquiries and
 * inventory/enquiry property records. Storage is the JSON column
 * crm_enquiries.interested_property_ids reserved by Phase 1 (see
 * migrations/101_crm_module.sql line 131). No new table, no new
 * migration.
 *
 * Contracts:
 *
 *   listByProperty({ propertyId, unmasked }) -> Array<EnquiryCard>
 *     Reverse lookup: given a property_id, return every crm_enquiry
 *     that has this property_id in its interested_property_ids JSON
 *     array. Uses MySQL 5.7+/MariaDB 10.2+ JSON_CONTAINS. Masked by
 *     default; when unmasked=true the parent DTO name/mobile/email
 *     are returned raw. Callers with unmasked=true MUST also send a
 *     valid X-Key-Pin header (enforced upstream at the route level
 *     via middleware/keyPinHeader.js requireKeyPinHeaderWhen).
 *
 *   addToEnquiry({ enquiryId, propertyId }) -> { status, ids }
 *     Idempotent add. Reads current JSON array under FOR UPDATE lock,
 *     appends propertyId if absent, writes back. Returns 'ADDED' or
 *     'ALREADY_PRESENT' plus the resulting id array. Property id
 *     must be a positive integer; enquiry must exist.
 *
 *   removeFromEnquiry({ enquiryId, propertyId }) -> { status, ids }
 *     Idempotent remove. Symmetric to addToEnquiry. Returns 'REMOVED'
 *     or 'NOT_PRESENT'.
 *
 * Concurrency: mutations lock the crm_enquiries row FOR UPDATE inside
 * a single BEGIN/COMMIT so concurrent add + remove requests can't
 * clobber each other's JSON writes. Read paths (listByProperty) do
 * not lock.
 *
 * Property-side sanity: we DO NOT validate that the referenced
 * property_id actually exists in inventory_properties/enquiry_properties.
 * Rationale: the two are separate tables with separate id spaces, and
 * a strict FK would need six new columns (inventory_id + enquiry_id +
 * discriminator per allocation row). The FE picker only surfaces
 * saved property ids (post-save is when the button fires), and the
 * CRM list's Property IDs column tolerates a stale id (renders it
 * verbatim). If a property is later deleted, the allocation entry
 * becomes a dangling id -- acceptable given the JSON storage model
 * and Phase-1 tradeoff. A future cleanup task can sweep dangling ids.
 */

const { HttpError } = require('../../middleware/errors');
const { pool } = require('../../db/pool');
const parents = require('./parents');
const propertyCodes = require('../../db/queries/property_codes');

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
//
// STORAGE CONTRACT: crm_enquiries.interested_property_ids holds PROPERTY
// CODES (e.g. "AKL-BNG-26-0XCQYR5"), not row ids. It previously held bare
// auto-increment ids resolved against inventory_properties only, which was
// unworkable: the three property tables number their rows independently, so
// inventory #19 and enquiry #19 are unrelated properties and a stored 19
// could not say which was meant. Codes are globally unique across all three
// tables and never change after creation, so a code names exactly one
// property forever -- including after that property is soft-deleted, which
// a dead id could never do.
//
// The column is LONGTEXT + json_valid(), so storing strings needed no DDL.

/**
 * Normalize the stored JSON array into a clean code list.
 *
 * Previously toIdArray(), which coerced every element with Number() and
 * dropped non-integers -- that would silently discard every code, making
 * reads look empty, adds always re-append, and removes always report
 * NOT_PRESENT. Codes are compared as trimmed strings; trimming matters
 * because a stray space makes remove a silent no-op.
 */
function toCodeArray(raw) {
  if (raw == null) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const v of parsed) {
    // Tolerate legacy numeric entries so a row that somehow escaped the
    // migration still round-trips instead of being silently emptied.
    const s = String(v == null ? '' : v).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function assertPositiveId(name, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${name} must be a positive integer`);
  }
  return n;
}

/**
 * Validate the property side of an allocation. Shape-only -- existence is a
 * separate cross-table lookup, because "not a code" and "code names nothing"
 * are different operator errors deserving different messages.
 */
function assertPropertyCode(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'property_code is required');
  }
  if (s.length > 64) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'property_code is too long');
  }
  // NO FORMAT REGEX, deliberately. Audited all 95 live codes: lengths are
  // 16 / 17 / 18 chars, because both the district and property-type segments
  // vary in width (e.g. NSK-PG-26-GU5CFN has a 2-char type, and 80 of 95 have
  // a 6-char suffix rather than the 7 the generator doc describes). A regex
  // pinned to DDD-TTT-YY-RANDOM7 would reject the large majority of real
  // data. Existence against the three property tables is the real gate.
  //
  // The one shape we DO reject is a bare number, because that is unambiguously
  // a caller still sending the old row id -- worth a clear message rather than
  // a confusing "no property found". Audited: zero live codes are numeric, so
  // this cannot reject a genuine code.
  if (/^\d+$/.test(s)) {
    throw new HttpError(
      400,
      'VALIDATION_ERROR',
      `Lead allocation now uses the property code (e.g. AKL-BNG-26-0XCQYR5), not the row id "${s}".`,
    );
  }
  // Codes are minted uppercase and all 95 live rows are uppercase, so folding
  // input is lossless and makes a lowercase-typed code match. The columns are
  // utf8mb4_unicode_ci (case-insensitive) but JSON_CONTAINS compares JSON
  // text, which is NOT collation-aware -- so normalizing here is what actually
  // protects the JSON_CONTAINS lookups.
  return s.toUpperCase();
}

// ------------------------------------------------------------------
// listByProperty
// ------------------------------------------------------------------
async function listByProperty({ propertyId, unmasked = false } = {}) {
  // `propertyId` is the legacy param name; it now carries a property CODE.
  const pid = assertPropertyCode(propertyId);
  // T-2026-156: pull display fields from the LIVE source tables via
  // the same JOIN topology as listEnquiries. The dropped
  // `ingestion_snapshot` column previously seeded requirement / budget
  // / preferred_location; we now derive those from the live sources
  // where possible (enquiry_properties.details JSON carries budget +
  // preferences for NPD rows; the leads table has no equivalent slot
  // so Website Enquiries fall back to null for those extra fields).
  //
  // JSON_CONTAINS returns 1 when the second arg (a JSON document /
  // scalar) is contained in the first (a JSON array here). Third arg
  // is the JSON path; '$' targets the top-level document.
  //
  // CRITICAL: the candidate must be QUOTED JSON text for strings. Verified
  // on MariaDB 10.4:
  //   JSON_CONTAINS('["AKL-BNG-26-0XCQYR5"]', 'AKL-BNG-26-0XCQYR5', '$')
  //     -> NULL   (falsy in WHERE, and it raises NO error -- silent zero rows)
  //   JSON_CONTAINS('["AKL-BNG-26-0XCQYR5"]', '"AKL-BNG-26-0XCQYR5"', '$')
  //     -> 1
  // So the bound value must be JSON.stringify(code), not the bare code. The
  // old numeric form passed String(pid) because a naked digit string already
  // IS valid JSON; a bare word is not.
  //
  // We DO NOT use CAST(? AS JSON) -- MariaDB 10.4 rejects CAST-to-JSON
  // in bound-parameter position for the UPDATE path and for
  // consistency we avoid it here too. The value is a bound parameter, so
  // injection is not a concern regardless of type.
  // T-2026-163 (folds in T-2026-162 follow-up):
  // NPD live-source name/mobile/email must resolve via JSON-first
  // COALESCE, mirroring the fix in server/db/queries/crm.js#listEnquiries.
  // Prior code read ep.owner_name / ep.owner_contact directly (columns)
  // and lost every JSON-only edit made to Enquiry Person Details (the
  // FE only promotes contacts[0].{name,mobiles[0]} to the top-level
  // columns when they are blank; on EDIT the columns stay stale). The
  // JSON path resolves the LIVE value; the column fallback keeps
  // historical rows readable. Email is JSON-only for NPD
  // (enquiry_properties has no top-level email column).
  //
  // Double-NULLIF collapses empty-string and literal 'null' JSON
  // extractions so a present-but-blank JSON key correctly falls through
  // to the column.
  const [rows] = await pool.query(
    `SELECT e.id,
            e.enquiry_code,
            e.parent_id,
            e.source_type,
            e.source_id,
            e.status_code,
            e.interested_property_ids,
            e.created_at,
            e.updated_at,
            p.full_name         AS parent_full_name,
            p.normalized_mobile AS parent_mobile,
            p.normalized_email  AS parent_email,
            l.buyer_name        AS live_website_name,
            l.buyer_mobile      AS live_website_mobile,
            l.buyer_email       AS live_website_email,
            l.message           AS live_website_message,
            wp.property_code    AS live_website_property_code,
            wp.location         AS live_website_property_location,
            wp.price            AS live_website_property_price,
            COALESCE(
              NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].name')), ''), 'null'),
              ep.owner_name
            )                   AS live_npd_owner_name,
            COALESCE(
              NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].mobiles[0]')), ''), 'null'),
              ep.owner_contact
            )                   AS live_npd_owner_contact,
            NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]')), ''), 'null')
                                AS live_npd_owner_email,
            ep.property_code    AS live_npd_property_code,
            ep.title            AS live_npd_property_title,
            ep.location         AS live_npd_location,
            ep.price            AS live_npd_price,
            ep.details          AS live_npd_details
       FROM crm_enquiries e
       JOIN crm_parents  p ON p.id = e.parent_id
       LEFT JOIN leads l
         ON e.source_type = 'website'
        AND l.id = e.source_id
        AND l.deleted_at IS NULL
       LEFT JOIN website_properties wp
         ON wp.id = l.website_property_id
        AND wp.deleted_at IS NULL
       LEFT JOIN enquiry_properties ep
         ON e.source_type = 'npd'
        AND ep.id = e.source_id
        AND ep.deleted_at IS NULL
      WHERE JSON_CONTAINS(e.interested_property_ids, ?, '$')
        AND (
          (e.source_type = 'website' AND l.id IS NOT NULL) OR
          (e.source_type = 'npd'     AND ep.id IS NOT NULL)
        )
      ORDER BY e.created_at DESC`,
    [JSON.stringify(pid)],
  );

  return rows.map((r) => {
    // T-2026-156: parent DTO now sourced from LIVE fields, matching
    // enquiryDto in services/crm/enquiries.js.
    let liveName = '';
    let liveMobile = '';
    let liveEmail = '';
    let requirement = null;
    let budget = null;
    let preferred_location = null;

    if (r.source_type === 'website') {
      liveName   = r.live_website_name   || '';
      liveMobile = r.live_website_mobile || '';
      liveEmail  = r.live_website_email  || '';
      // Website Buyer Enquiry does not carry an explicit budget or
      // preferred-location field; use property-side data as fallback
      // for the "context" display (spec §41 tolerates dashes).
      requirement = r.live_website_message || null;
      budget = r.live_website_property_price != null ? String(r.live_website_property_price) : null;
      preferred_location = r.live_website_property_location || null;
    } else if (r.source_type === 'npd') {
      // T-2026-163: JSON-first COALESCE in the SELECT above resolves
      // both name+mobile from the LIVE contacts[0] JSON path first, then
      // falls back to the top-level column. Email is JSON-only for NPD
      // (enquiry_properties has no top-level email column).
      liveName   = r.live_npd_owner_name    || '';
      liveMobile = r.live_npd_owner_contact || '';
      liveEmail  = r.live_npd_owner_email   || '';
      // NPD enquiry_properties.details JSON often carries dynamic
      // fields per property form (bhk, budget slot, etc.). Best-effort
      // extraction; fallback to the row-level location/price.
      let details = null;
      try {
        details = typeof r.live_npd_details === 'string'
          ? JSON.parse(r.live_npd_details)
          : (r.live_npd_details || null);
      } catch { details = null; }
      const dyn = details && (details.dynamicData || details.dynamic_data || details.data) || details || {};
      requirement = (dyn && (dyn.requirement || dyn.enquiryType || dyn.propertyType)) || r.live_npd_property_title || null;
      budget = (dyn && (dyn.budget || dyn.budgetRange || dyn.priceRange))
        || (r.live_npd_price != null ? String(r.live_npd_price) : null);
      preferred_location = (dyn && (dyn.preferredLocation || dyn.location || dyn.city)) || r.live_npd_location || null;
    }

    const parentDto = parents.toDto({
      id:                r.parent_id,
      full_name:         liveName,
      normalized_mobile: liveMobile,
      normalized_email:  liveEmail,
      source_hint:       r.source_type,
      created_at:        null,
      updated_at:        null,
    }, { unmasked });
    return {
      id:               r.id,
      enquiry_code:     r.enquiry_code,
      parent_id:        r.parent_id,
      parent:           parentDto,
      source_type:      r.source_type,
      source_id:        r.source_id,
      status_code:      r.status_code,
      interested_property_ids: toCodeArray(r.interested_property_ids),
      requirement,
      budget,
      preferred_location,
      created_at:       r.created_at,
      updated_at:       r.updated_at,
    };
  });
}

// ------------------------------------------------------------------
// addToEnquiry
// ------------------------------------------------------------------
async function addToEnquiry({ enquiryId, propertyId } = {}) {
  const eid = assertPositiveId('enquiry_id', enquiryId);
  const pid = assertPropertyCode(propertyId);

  // Existence check runs BEFORE the transaction opens: it reads three tables
  // the transaction does not otherwise touch, and a miss should cost nothing.
  //
  // This replaces the old inventory-only `SELECT id FROM inventory_properties
  // WHERE id = ?` guard. That guard existed to stop enquiry-surface saves
  // corrupting the column with a wrong-table row id -- a problem codes remove
  // entirely, because a code is unambiguous across all three tables. So the
  // guard can now do what it could never do before: accept a property from
  // ANY surface while still rejecting anything that names no property.
  //
  // Soft-deleted properties are REJECTED for new allocations (you should not
  // be able to newly link a lead to a dead property) even though the resolver
  // itself returns them -- existing allocations of a since-deleted property
  // stay readable, which is the whole advantage of storing the code.
  const resolved = await propertyCodes.resolvePropertyCode(pid);
  if (!resolved) {
    throw new HttpError(
      404,
      'PROPERTY_CODE_NOT_FOUND',
      `No property found with code ${pid}.`,
    );
  }
  if (resolved.deleted) {
    throw new HttpError(
      409,
      'PROPERTY_DELETED',
      `Property ${pid} has been deleted and cannot be allocated to a lead.`,
    );
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, interested_property_ids FROM crm_enquiries WHERE id = ? FOR UPDATE`,
      [eid],
    );
    if (!rows[0]) {
      throw new HttpError(404, 'NOT_FOUND', 'Enquiry not found');
    }
    const current = toCodeArray(rows[0].interested_property_ids);
    if (current.includes(pid)) {
      await conn.commit();
      return { status: 'ALREADY_PRESENT', ids: current, property: resolved };
    }
    const next = current.concat(pid);
    await conn.query(
      `UPDATE crm_enquiries
          SET interested_property_ids = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [JSON.stringify(next), eid],
    );
    await conn.commit();
    return { status: 'ADDED', ids: next, property: resolved };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ------------------------------------------------------------------
// removeFromEnquiry
// ------------------------------------------------------------------
async function removeFromEnquiry({ enquiryId, propertyId } = {}) {
  const eid = assertPositiveId('enquiry_id', enquiryId);
  // Shape-check only, NO existence lookup: unlike add, remove must keep
  // working for a code whose property has since been deleted -- otherwise a
  // stale allocation could never be detached. Both sides are compared as
  // trimmed strings via toCodeArray, so whitespace drift cannot turn this
  // into a silent no-op.
  const pid = assertPropertyCode(propertyId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, interested_property_ids FROM crm_enquiries WHERE id = ? FOR UPDATE`,
      [eid],
    );
    if (!rows[0]) {
      throw new HttpError(404, 'NOT_FOUND', 'Enquiry not found');
    }
    const current = toCodeArray(rows[0].interested_property_ids);
    if (!current.includes(pid)) {
      await conn.commit();
      return { status: 'NOT_PRESENT', ids: current };
    }
    const next = current.filter((v) => v !== pid);
    await conn.query(
      `UPDATE crm_enquiries
          SET interested_property_ids = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [JSON.stringify(next), eid],
    );
    await conn.commit();
    return { status: 'REMOVED', ids: next };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  listByProperty,
  addToEnquiry,
  removeFromEnquiry,
  // Exported for tests + admin consoles.
  toCodeArray,
  assertPropertyCode,
};
