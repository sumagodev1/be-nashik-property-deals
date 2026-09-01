/**
 * DB layer for the CRM subsystem (T-2026-151 Phase 1).
 *
 * All statement text lives here. Higher layers (services/crm/*) pass a
 * connection or use `pool` directly for auto-commit reads. The
 * duplicateResolver uses beginTransaction / commit around several of
 * these calls; the "*ForConn" variants exist so callers can share a
 * single connection for FOR-UPDATE locking.
 *
 * Every query is a prepared statement (parameter binding, not string
 * concatenation) so SQL injection is not a concern.
 */

const { pool } = require('../pool');

// ------------------------------------------------------------------
// Normalizers
// ------------------------------------------------------------------
// Mobile: strip everything except digits, then keep the last 10 digits
// (India-first heuristic - matches the FE mobile validators used across
// property forms). Returns null if the input has fewer than 10 digits
// so blank/garbage inputs don't create a "" duplicate key.
function normalizeMobile(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

// Email: trim + lowercase. Returns null for blank / falsy.
function normalizeEmail(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || !s.includes('@')) return null;
  return s;
}

// ------------------------------------------------------------------
// Parents
// ------------------------------------------------------------------
async function findParentByMobileForConn(conn, normalizedMobile) {
  if (!normalizedMobile) return null;
  const [rows] = await conn.query(
    `SELECT * FROM crm_parents WHERE normalized_mobile = ? FOR UPDATE`,
    [normalizedMobile],
  );
  return rows[0] || null;
}

async function findParentByEmailForConn(conn, normalizedEmail) {
  if (!normalizedEmail) return null;
  const [rows] = await conn.query(
    `SELECT * FROM crm_parents WHERE normalized_email = ? FOR UPDATE`,
    [normalizedEmail],
  );
  return rows[0] || null;
}

async function findParentById(id) {
  const [rows] = await pool.query(`SELECT * FROM crm_parents WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function listParents({ page = 1, pageSize = 25, search = '' } = {}) {
  const offset = Math.max(0, (Number(page) - 1) * Number(pageSize));
  const limit = Math.max(1, Math.min(200, Number(pageSize)));
  const params = [];
  let where = '1=1';
  if (search) {
    where += ' AND (full_name LIKE ? OR normalized_mobile LIKE ? OR normalized_email LIKE ?)';
    const pat = `%${search}%`;
    params.push(pat, pat, pat);
  }
  const [rows] = await pool.query(
    `SELECT SQL_CALC_FOUND_ROWS * FROM crm_parents WHERE ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [[{ total }]] = await pool.query(`SELECT FOUND_ROWS() AS total`);
  return { rows, total, page: Number(page), pageSize: limit };
}

async function insertParentForConn(conn, { fullName, normalizedMobile, normalizedEmail, sourceHint }) {
  const [res] = await conn.query(
    `INSERT INTO crm_parents (full_name, normalized_mobile, normalized_email, source_hint)
     VALUES (?, ?, ?, ?)`,
    [fullName || '', normalizedMobile, normalizedEmail, sourceHint || 'unknown'],
  );
  return res.insertId;
}

async function updateParentBestNameForConn(conn, parentId, name) {
  if (!name) return;
  // Last-write-wins: only overwrite if the current value is blank OR the
  // incoming name is longer (heuristic: fuller name is likely more correct).
  await conn.query(
    `UPDATE crm_parents
        SET full_name = CASE
          WHEN full_name IS NULL OR full_name = '' THEN ?
          WHEN CHAR_LENGTH(?) > CHAR_LENGTH(full_name) THEN ?
          ELSE full_name
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [name, name, name, parentId],
  );
}

// ------------------------------------------------------------------
// Enquiry sequence (per-year monotonic counter)
// ------------------------------------------------------------------
// Returns the next ENQ-YYYY-NNNNN code. MUST be called inside the same
// transaction as the enquiry INSERT so a rollback also rolls back the
// counter bump.
async function nextEnquiryCodeForConn(conn, yearPrefix) {
  // Upsert the year row with FOR UPDATE lock.
  await conn.query(
    `INSERT INTO crm_enquiry_sequence (year_prefix, next_seq)
     VALUES (?, 1)
     ON DUPLICATE KEY UPDATE next_seq = next_seq`,
    [yearPrefix],
  );
  const [rows] = await conn.query(
    `SELECT next_seq FROM crm_enquiry_sequence WHERE year_prefix = ? FOR UPDATE`,
    [yearPrefix],
  );
  const seq = rows[0].next_seq;
  await conn.query(
    `UPDATE crm_enquiry_sequence SET next_seq = next_seq + 1 WHERE year_prefix = ?`,
    [yearPrefix],
  );
  const padded = String(seq).padStart(5, '0');
  return `ENQ-${yearPrefix}-${padded}`;
}

// ------------------------------------------------------------------
// Enquiries
// ------------------------------------------------------------------
async function insertEnquiryForConn(conn, {
  parentId, enquiryCode, sourceType, sourceId, statusCode,
}) {
  // T-2026-156: `ingestion_snapshot` column dropped by migration 104.
  // The CRM listing now JOINs live sources at read time (see
  // listEnquiries + findEnquiryByIdForDisplay below) so a per-row
  // snapshot cache is no longer maintained. Any legacy caller passing
  // ingestionSnapshot is silently ignored.
  const [res] = await conn.query(
    `INSERT INTO crm_enquiries
       (parent_id, enquiry_code, source_type, source_id, status_code)
     VALUES (?, ?, ?, ?, ?)`,
    [
      parentId,
      enquiryCode,
      // T-2026-155: no legacy 'manual' fallback. sourceType is
      // validated upstream by duplicateResolver.ingest() /
      // resolveConflict() against ALLOWED_SOURCE_TYPES = {website,npd}
      // and the DB CHECK ck_crm_enq_source_type_allowed (migration
      // 103) is the second defensive layer.
      sourceType,
      sourceId || null,
      statusCode || 'new',
    ],
  );
  return res.insertId;
}

async function findEnquiryById(id) {
  const [rows] = await pool.query(`SELECT * FROM crm_enquiries WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function findEnquiryByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `SELECT * FROM crm_enquiries WHERE id = ? FOR UPDATE`,
    [id],
  );
  return rows[0] || null;
}

// T-2026-162: lookup an existing crm_enquiries row by (source_type,
// source_id). Used by the "no-identity" branch of duplicateResolver.ingest
// so a repeated ingest of the same source row does not create a second
// placeholder parent. Returns { id, parent_id, ... } or null.
async function findEnquiryBySourceForConn(conn, sourceType, sourceId) {
  if (!sourceType || sourceId == null) return null;
  const [rows] = await conn.query(
    `SELECT * FROM crm_enquiries WHERE source_type = ? AND source_id = ? FOR UPDATE`,
    [sourceType, sourceId],
  );
  return rows[0] || null;
}

// T-2026-156: CRM listing is now a LIVE PROJECTION over the two
// canonical sources (`leads` for Website Buyer Enquiries, `enquiry_properties`
// for admin NPD Enquiry Properties). Every displayed Name / Mobile / Email
// column comes from the CURRENT source row (fetched via LEFT JOIN on
// source_id) so admin edits to the source record are visible in CRM
// immediately. The Phase-1 snapshot cache + crm_parents display fields
// are no longer read (see migration 104 for the retirement of
// `ingestion_snapshot` and the accompanying orphan cleanup).
//
// Orphan handling: any crm_enquiries row whose source_id no longer
// resolves in its declared source table is SOFT-HIDDEN from the
// listing. Migration 104 hard-deletes such rows on run, but this
// runtime WHERE guard is a second line of defense (source rows may
// be soft-deleted after ingestion, mid-day). The number of hidden
// orphans is returned in the response metadata (`orphan_hidden`)
// so the FE can surface a "N orphaned enquiries hidden" hint.
//
// Search + filter now hit the JOINed live columns:
//   * search  -> ENQ code | live source name | live source mobile | live source email
//   * status  -> crm_enquiries.status_code (unchanged)
//   * source  -> crm_enquiries.source_type (unchanged)
//   * parent  -> crm_enquiries.parent_id (unchanged)
async function listEnquiries({
  page = 1, pageSize = 25, search = '', statusCode = '', parentId = null, sourceType = '',
  // T-2026-169 Phase A: filter by any of the three new lead taxonomy fields.
  // Backward compatible -- callers that omit these get the pre-T-169 behaviour.
  leadStageCode = '', leadStatusCode = '', leadRatingCode = '',
} = {}) {
  const offset = Math.max(0, (Number(page) - 1) * Number(pageSize));
  const limit = Math.max(1, Math.min(200, Number(pageSize)));
  const clauses = ['1=1'];
  const params = [];
  if (parentId != null) { clauses.push('e.parent_id = ?'); params.push(parentId); }
  if (statusCode) { clauses.push('e.status_code = ?'); params.push(statusCode); }
  if (sourceType) { clauses.push('e.source_type = ?'); params.push(sourceType); }
  // T-2026-169 Phase A: new-taxonomy filters.
  if (leadStageCode)  { clauses.push('e.lead_stage_code = ?');  params.push(leadStageCode); }
  if (leadStatusCode) { clauses.push('e.lead_status_code = ?'); params.push(leadStatusCode); }
  if (leadRatingCode) { clauses.push('e.lead_rating_code = ?'); params.push(leadRatingCode); }
  // Orphan guard: only surface rows whose source_id resolves in the
  // matching source table. If the source has been soft-deleted after
  // ingestion, the row is hidden from the operator (they can still see
  // it via /admin/leads or the original NPD page). We prefer this over
  // showing a stale snapshot -- the user's spec is explicit: "CRM must
  // be a real-time unified VIEW of the two source modules. No mock, no
  // seed, no snapshot cache serving stale/fake data."
  clauses.push(`(
    (e.source_type = 'website' AND l.id IS NOT NULL) OR
    (e.source_type = 'npd'     AND ep.id IS NOT NULL)
  )`);

  if (search) {
    // Search hits the LIVE joined columns, not the stale parent cache.
    // Property-code search is best-effort (only applies when the row
    // is Website + has a website_property_id joined via leads.
    // wp.property_code below).
    // T-2026-162: also search the NPD contacts JSON path so an admin
    // that edits Enquiry Person Details (without the FE promoting
    // the change to owner_name / owner_contact -- one-way promotion
    // in InventoryForm.jsx line 2023) can still find the row by the
    // new value.
    clauses.push(`(
      e.enquiry_code LIKE ?
      OR l.buyer_name LIKE ? OR l.buyer_mobile LIKE ? OR l.buyer_email LIKE ?
      OR ep.owner_name LIKE ? OR ep.owner_contact LIKE ?
      OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].name')) LIKE ?
      OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].mobiles[0]')) LIKE ?
      OR JSON_UNQUOTE(JSON_EXTRACT(ep.details, '$.dynamicData.contacts[0].emails[0]')) LIKE ?
      OR ep.property_code LIKE ?
      OR wp.property_code LIKE ?
    )`);
    const pat = `%${search}%`;
    params.push(pat, pat, pat, pat, pat, pat, pat, pat, pat, pat, pat);
  }
  const where = clauses.join(' AND ');

  // Shared FROM/JOIN block. The page-of-parents query, the count and the row
  // fetch must all see exactly the same joins, because `where` above filters
  // on l / ep / wp columns — if they drifted apart the count would stop
  // agreeing with the rows.
  const FROM_JOINS = `
       FROM crm_enquiries e
       JOIN crm_parents p ON p.id = e.parent_id
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
        AND ep.deleted_at IS NULL`;

  // ── Paginate by PARENT, not by enquiry ────────────────────────────────
  //
  // The list renders one row per parent (the FE groups sub-enquiries under
  // it), but this query used to LIMIT over crm_enquiries and report
  // FOUND_ROWS() — the count of enquiries. The two never agreed: a parent
  // with 21 sub-enquiries consumed 22 of a 25-row page, so the operator saw
  // 4 rows under a footer claiming "1-25 of 56", and the Sr column jumped
  // between pages because it is derived from page * pageSize.
  //
  // Selecting the page of parent_ids first, then fetching every matching
  // enquiry for those parents, makes one page mean N customer rows.
  const [parentPage] = await pool.query(
    `SELECT e.parent_id, MAX(e.created_at) AS latest_at
       ${FROM_JOINS}
      WHERE ${where}
      GROUP BY e.parent_id
      ORDER BY latest_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const parentIds = parentPage.map((r) => r.parent_id);

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(DISTINCT e.parent_id) AS total
       ${FROM_JOINS}
      WHERE ${where}`,
    params,
  );

  // Explicit column list: never SELECT * on a joined result, both to
  // avoid column-name collisions (id!) and to make the display
  // contract explicit. The FE reads live_name / live_mobile /
  // live_email; the crm_parents fields are joined only so
  // duplicate-conflict + backfill tooling can still access them
  // without a separate round-trip -- they are NOT rendered by the
  // Phase-2 CrmList after T-2026-156.
  // Guard the empty page: `IN ()` and `FIELD()` with no arguments are both
  // SQL syntax errors, so an out-of-range page or a filter matching nothing
  // must skip this query rather than build one.
  let rows = [];
  if (parentIds.length) {
    [rows] = await pool.query(
    // SQL_CALC_FOUND_ROWS dropped: the total is now COUNT(DISTINCT parent_id)
    // above, because a page is measured in parents rather than enquiries.
    `SELECT
            e.id, e.parent_id, e.enquiry_code, e.source_type, e.source_id,
            e.status_code,
            e.lead_stage_code, e.lead_status_code, e.lead_rating_code,
            e.interested_property_ids, e.created_at, e.updated_at,
            p.full_name         AS parent_full_name,
            p.normalized_mobile AS parent_mobile,
            p.normalized_email  AS parent_email,
            -- Live source fields (one branch fires per row, other is NULL)
            l.buyer_name        AS live_website_name,
            l.buyer_mobile      AS live_website_mobile,
            l.buyer_email       AS live_website_email,
            l.website_property_id AS live_website_property_id,
            wp.property_code    AS live_website_property_code,
            -- T-2026-162: prefer the Enquiry Person Details JSON path
            -- (details.dynamicData.contacts[0].{name,mobiles[0],emails[0]})
            -- over the top-level ep.owner_name / ep.owner_contact columns.
            -- Reason: InventoryForm.jsx promotes contacts[0] to owner_*
            -- one-way (only when owner_* is blank), so on EDIT the top-
            -- level column is stale while the JSON is fresh. Coalescing
            -- JSON-first ensures the CRM display reflects the latest
            -- Enquiry Person Details save without touching the form.
            -- NULLIF('', '') collapses empty-string / literal 'null' JSON
            -- extractions so the fallback to the column still fires
            -- when the JSON path is present-but-blank.
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
            ep.title            AS live_npd_property_title
       ${FROM_JOINS}
      WHERE ${where}
        AND e.parent_id IN (${parentIds.map(() => '?').join(',')})
      ORDER BY FIELD(e.parent_id, ${parentIds.map(() => '?').join(',')}), e.created_at DESC`,
      [...params, ...parentIds, ...parentIds],
    );
  }

  // Count orphans (rows this operator's filters WOULD have matched,
  // except for the orphan guard) so the FE can surface the hint.
  const orphanClauses = ['1=1'];
  const orphanParams = [];
  if (parentId != null) { orphanClauses.push('e.parent_id = ?'); orphanParams.push(parentId); }
  if (statusCode) { orphanClauses.push('e.status_code = ?'); orphanParams.push(statusCode); }
  if (sourceType) { orphanClauses.push('e.source_type = ?'); orphanParams.push(sourceType); }
  // T-2026-169 Phase A: mirror the new taxonomy filters onto the orphan count
  // so the "N orphaned enquiries hidden" hint reflects the current filter.
  if (leadStageCode)  { orphanClauses.push('e.lead_stage_code = ?');  orphanParams.push(leadStageCode); }
  if (leadStatusCode) { orphanClauses.push('e.lead_status_code = ?'); orphanParams.push(leadStatusCode); }
  if (leadRatingCode) { orphanClauses.push('e.lead_rating_code = ?'); orphanParams.push(leadRatingCode); }
  orphanClauses.push(`(
    (e.source_type = 'website' AND l.id IS NULL) OR
    (e.source_type = 'npd'     AND ep.id IS NULL)
  )`);
  const [[{ orphan_hidden }]] = await pool.query(
    `SELECT COUNT(*) AS orphan_hidden
       FROM crm_enquiries e
       LEFT JOIN leads l
         ON e.source_type = 'website'
        AND l.id = e.source_id
        AND l.deleted_at IS NULL
       LEFT JOIN enquiry_properties ep
         ON e.source_type = 'npd'
        AND ep.id = e.source_id
        AND ep.deleted_at IS NULL
      WHERE ${orphanClauses.join(' AND ')}`,
    orphanParams,
  );
  return {
    rows,
    total,
    page: Number(page),
    pageSize: limit,
    orphan_hidden: Number(orphan_hidden) || 0,
  };
}

// T-2026-156: single-row live-source lookup for /crm/enquiries/:id.
// Same JOIN topology as listEnquiries so the detail page renders
// live source data too.
async function findEnquiryByIdForDisplay(id) {
  const [rows] = await pool.query(
    `SELECT e.id, e.parent_id, e.enquiry_code, e.source_type, e.source_id,
            e.status_code,
            e.lead_stage_code, e.lead_status_code, e.lead_rating_code,
            e.interested_property_ids, e.created_at, e.updated_at,
            p.full_name         AS parent_full_name,
            p.normalized_mobile AS parent_mobile,
            p.normalized_email  AS parent_email,
            l.buyer_name        AS live_website_name,
            l.buyer_mobile      AS live_website_mobile,
            l.buyer_email       AS live_website_email,
            l.website_property_id AS live_website_property_id,
            wp.property_code    AS live_website_property_code,
            -- T-2026-162: JSON-first live projection (see listEnquiries above).
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
            ep.title            AS live_npd_property_title
       FROM crm_enquiries e
       JOIN crm_parents p ON p.id = e.parent_id
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
      WHERE e.id = ?`,
    [id],
  );
  return rows[0] || null;
}

async function updateEnquiryStatusForConn(conn, enquiryId, newStatusCode) {
  await conn.query(
    `UPDATE crm_enquiries SET status_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [newStatusCode, enquiryId],
  );
}

// T-2026-169 Phase A: partial update helper for the three new lead-taxonomy
// columns. `null` for any of the three means "do not touch" so callers can
// update any subset independently (delegation §4: user must be able to
// update any subset). Passing `null`/omitting a column preserves the
// existing value verbatim; passing the string 'CLEAR' resets to NULL
// (only meaningful for lead_rating_code which allows NULL).
//
// T-2026-178: hardened against the "No change" sentinel (empty string)
// forwarded by the FE modals (LeadChangeDialog + AppointmentEditDialog
// under T-176). Empty string on any of the three columns is treated as
// "do not touch" (null semantics). Explicit reset of Rating to NULL
// still requires the 'CLEAR' sentinel. Also fixes a pre-T-178 param-
// list mismatch on the rating branch (missing params.push) which
// produced ER_PARSE_ERROR "near '?'" whenever a plain rating code was
// submitted. See scripts/_smoke_t178_lead_rating_sql_parse.js for the
// regression assertions covering rating-only / status-only / stage-only
// / all-no-change / combined booking+rating flows.
async function updateEnquiryLeadTaxonomyForConn(conn, enquiryId, {
  leadStageCode = null,
  leadStatusCode = null,
  leadRatingCode = null,
} = {}) {
  // Defensive normalisation. Empty string on any of the three columns is
  // treated as "no change" (null semantics). Explicit reset of Rating to
  // NULL must use the 'CLEAR' sentinel -- see below. The service layer
  // (server/services/crm/enquiries.js#changeStatus) is the semantic
  // boundary that decides whether '' means "no touch" or "clear"; by
  // T-2026-178 it collapses '' to "no touch" for all three fields so
  // the builder never sees '' in a passthrough call. This defensive
  // normalisation is belt-and-braces in case a future caller wires
  // directly to the builder.
  const normStage  = (leadStageCode  === '' ? null : leadStageCode);
  const normStatus = (leadStatusCode === '' ? null : leadStatusCode);
  const normRating = (leadRatingCode === '' ? null : leadRatingCode);

  // T-2026-196: every code write also writes the master_lookups.id it
  // resolves to. The id is the authoritative reference (migration 128); the
  // code stays as the denormalised display key that CrmList.jsx switches on
  // for chip colours and that crm_status_history records.
  //
  // Resolved by a correlated subquery inside the SAME statement rather than by
  // a prior SELECT, so id and code are written atomically and cannot drift --
  // there is no window in which a crash leaves the code updated and the id
  // stale. The subquery reads master_lookups, a different table from the one
  // being updated, so MariaDB permits it.
  //
  // deleted_at IS NULL only: resolving to a soft-deleted master row would
  // resurrect a reference the admin removed. is_active is deliberately NOT
  // filtered here -- the service layer decides what may be SELECTED; this
  // layer only records what was chosen, and re-saving a lead that already
  // sits on a since-deactivated value must not null out its reference.
  const idSubquery = (masterKey) => (
    `(SELECT m.id FROM master_lookups m
       WHERE m.master_key = '${masterKey}' AND m.code = ? AND m.deleted_at IS NULL
       LIMIT 1)`
  );

  const sets = [];
  const params = [];
  if (normStage != null) {
    sets.push('lead_stage_code = ?');
    params.push(normStage);
    sets.push(`lead_stage_id = ${idSubquery('crm_lead_stage')}`);
    params.push(normStage);
  }
  if (normStatus != null) {
    sets.push('lead_status_code = ?');
    params.push(normStatus);
    sets.push(`lead_status_id = ${idSubquery('crm_lead_status')}`);
    params.push(normStatus);
  }
  if (normRating != null) {
    // Sentinel 'CLEAR' resets to NULL (Lead Rating is the only column
    // whose UI supports explicit "unset"; Stage/Status always carry a
    // valid master code when not "no-touch").
    if (normRating === 'CLEAR') {
      sets.push('lead_rating_code = NULL');
      sets.push('lead_rating_id = NULL');
      // No param push -- both placeholders are baked into the SQL string
      // above, keeping the sets<->params alignment invariant.
    } else {
      sets.push('lead_rating_code = ?');
      params.push(normRating);
      sets.push(`lead_rating_id = ${idSubquery('crm_lead_rating')}`);
      params.push(normRating);
    }
  }
  if (!sets.length) return false;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  const sql = `UPDATE crm_enquiries SET ${sets.join(', ')} WHERE id = ?`;
  const finalParams = [...params, enquiryId];
  // T-2026-178 belt-and-braces invariant: the number of '?' placeholders
  // in the SQL must exactly match the params array length. If a future
  // edit introduces a mismatch this throws BEFORE .query() runs so the
  // regression surfaces as an actionable message, not a generic
  // ER_PARSE_ERROR "near '?'" from MariaDB.
  const qcount = (sql.match(/\?/g) || []).length;
  if (qcount !== finalParams.length) {
    throw new Error(
      `updateEnquiryLeadTaxonomyForConn: placeholder mismatch (${qcount} '?' vs ${finalParams.length} params). ` +
      `sql=${sql} params=${JSON.stringify(finalParams)}`,
    );
  }
  await conn.query(sql, finalParams);
  return true;
}

// ------------------------------------------------------------------
// Status history (immutable append-only)
// ------------------------------------------------------------------
async function insertStatusHistoryForConn(conn, {
  enquiryId, fromStatus, toStatus, note, changedByAdminId, calendarActivityId,
  googleEventId = null,
  // T-2026-169 Phase A: field_scope discriminates which field the row
  // records. Defaults to 'status' so pre-T-169 call-sites are byte-
  // identical. New taxonomy transitions pass 'lead_stage' | 'lead_status'
  // | 'lead_rating'.
  fieldScope = 'status',
}) {
  // T-2026-164: google_event_id is a denormalized copy of
  // crm_calendar_activities.google_event_id. Optional -- passes NULL
  // when the caller doesn't have a sync result yet (e.g. PENDING); the
  // retry worker later back-fills it via updateCalendarActivitySyncResult.
  const [res] = await conn.query(
    `INSERT INTO crm_status_history
       (enquiry_id, from_status, to_status, field_scope, note, changed_by_admin_id, calendar_activity_id, google_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [enquiryId, fromStatus || null, toStatus, fieldScope || 'status', note || null, changedByAdminId || null, calendarActivityId || null, googleEventId || null],
  );
  return res.insertId;
}

async function listStatusHistory(enquiryId) {
  const [rows] = await pool.query(
    `SELECT * FROM crm_status_history WHERE enquiry_id = ? ORDER BY created_at ASC, id ASC`,
    [enquiryId],
  );
  return rows;
}

// ------------------------------------------------------------------
// Calendar activities
// ------------------------------------------------------------------
async function insertCalendarActivityForConn(conn, {
  enquiryId, scheduledAt, timezone, reminderA, reminderB,
  contextNote, googleEventId, syncStatus, syncLastError, createdByAdminId,
}) {
  const [res] = await conn.query(
    `INSERT INTO crm_calendar_activities
       (enquiry_id, scheduled_at, timezone, reminder_minutes_before_a, reminder_minutes_before_b,
        context_note, google_event_id, sync_status, sync_last_attempt_at, sync_last_error, created_by_admin_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      enquiryId,
      scheduledAt,
      timezone || 'Asia/Kolkata',
      Number.isInteger(reminderA) ? reminderA : 1440,
      Number.isInteger(reminderB) ? reminderB : 60,
      contextNote || null,
      googleEventId || null,
      syncStatus || 'PENDING',
      (syncStatus && syncStatus !== 'PENDING') ? new Date() : null,
      syncLastError || null,
      createdByAdminId || null,
    ],
  );
  return res.insertId;
}

async function listCalendarActivities(enquiryId) {
  const [rows] = await pool.query(
    `SELECT * FROM crm_calendar_activities WHERE enquiry_id = ? ORDER BY scheduled_at DESC, id DESC`,
    [enquiryId],
  );
  return rows;
}

// ------------------------------------------------------------------
// Duplicate conflicts
// ------------------------------------------------------------------
async function insertConflictForConn(conn, {
  parentAId, parentBId, sourceType, sourceId, payload,
}) {
  const [res] = await conn.query(
    `INSERT INTO crm_duplicate_conflicts
       (parent_a_id, parent_b_id, source_type, source_id, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
    [parentAId, parentBId, sourceType || 'unknown', sourceId || null, JSON.stringify(payload || {})],
  );
  return res.insertId;
}

async function findConflictById(id) {
  const [rows] = await pool.query(`SELECT * FROM crm_duplicate_conflicts WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function findConflictByIdForConn(conn, id) {
  const [rows] = await conn.query(
    `SELECT * FROM crm_duplicate_conflicts WHERE id = ? FOR UPDATE`,
    [id],
  );
  return rows[0] || null;
}

async function listConflicts({ unresolvedOnly = true } = {}) {
  const where = unresolvedOnly ? 'WHERE resolved_at IS NULL' : '';
  const [rows] = await pool.query(
    `SELECT c.*, pa.full_name AS parent_a_name, pb.full_name AS parent_b_name
       FROM crm_duplicate_conflicts c
       JOIN crm_parents pa ON pa.id = c.parent_a_id
       JOIN crm_parents pb ON pb.id = c.parent_b_id
       ${where}
      ORDER BY c.created_at DESC`,
  );
  return rows;
}

async function markConflictResolvedForConn(conn, {
  conflictId, attachToParentId, resolvedEnquiryId, resolvedByAdminId,
}) {
  await conn.query(
    `UPDATE crm_duplicate_conflicts
        SET resolved_attach_to_parent_id = ?,
            resolved_enquiry_id = ?,
            resolved_by_admin_id = ?,
            resolved_at = CURRENT_TIMESTAMP
      WHERE id = ? AND resolved_at IS NULL`,
    [attachToParentId, resolvedEnquiryId || null, resolvedByAdminId || null, conflictId],
  );
}

// ------------------------------------------------------------------
// Property allocation lookups
// ------------------------------------------------------------------
/**
 * List the enquiries that currently reference a given property CODE in their
 * `interested_property_ids` allocation list.
 *
 * Used by the removeProperty guard on all three property surfaces
 * (inventory / enquiry / website) to refuse a delete while the property is
 * still allocated to a lead.
 *
 * TAKES A CODE, NOT A ROW ID. It previously took a numeric id and opened
 * with `Number(propertyId); if (!Number.isInteger(id)) return []`. Left
 * unchanged after the column moved to codes, that gate would return [] for
 * every call and the delete guard would fail OPEN -- silently permitting
 * deletion of an allocated property, the exact thing it exists to prevent.
 *
 * `interested_property_ids` is a longtext holding a JSON array. JSON_CONTAINS
 * RAISES on malformed text, hence the JSON_VALID guard. NULL rows make it
 * return NULL, falsy in WHERE, so they are excluded for free.
 *
 * The candidate is bound as JSON.stringify(code) -- i.e. the double-quoted
 * form '"AKL-BNG-26-0XCQYR5"'. A bare unquoted code is not valid JSON text
 * and makes JSON_CONTAINS return NULL rather than raising, which would be a
 * silent no-match. This binding was already correct for strings.
 */
async function listEnquiriesReferencingPropertyCode(propertyCode) {
  const code = String(propertyCode == null ? '' : propertyCode).trim();
  if (!code) return [];
  const [rows] = await pool.query(
    `SELECT id, enquiry_code, status_code, lead_stage_code
       FROM crm_enquiries
      WHERE interested_property_ids IS NOT NULL
        AND JSON_VALID(interested_property_ids)
        AND JSON_CONTAINS(interested_property_ids, ?)
      ORDER BY id`,
    [JSON.stringify(code)],
  );
  return rows;
}

module.exports = {
  // normalizers
  normalizeMobile,
  normalizeEmail,
  // parents
  findParentByMobileForConn,
  findParentByEmailForConn,
  findParentById,
  listParents,
  insertParentForConn,
  updateParentBestNameForConn,
  // enquiries
  nextEnquiryCodeForConn,
  insertEnquiryForConn,
  findEnquiryById,
  findEnquiryByIdForConn,
  findEnquiryBySourceForConn,
  findEnquiryByIdForDisplay,
  listEnquiries,
  updateEnquiryStatusForConn,
  // T-2026-169 Phase A: partial-update helper for the three new lead-taxonomy fields.
  updateEnquiryLeadTaxonomyForConn,
  // history
  insertStatusHistoryForConn,
  listStatusHistory,
  // calendar
  insertCalendarActivityForConn,
  listCalendarActivities,
  // conflicts
  insertConflictForConn,
  findConflictById,
  findConflictByIdForConn,
  listConflicts,
  markConflictResolvedForConn,
  // property allocations
  listEnquiriesReferencingPropertyCode,
};
