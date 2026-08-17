-- ============================================================
-- 105 - CRM: Backfill crm_parents + crm_enquiries + crm_status_history
--       from historical `leads` (Website) + `enquiry_properties` (NPD)
--       rows that existed BEFORE the CRM ingestion hooks were installed.
-- ============================================================
-- T-2026-159 (corrective for T-2026-151 Phase 1 + T-2026-156).
--
-- Problem this migration solves:
--   T-2026-156 rewrote the CRM listing as a LIVE JOIN over the two
--   canonical source tables (leads, enquiry_properties), BUT the JOIN
--   is still gated by a row in `crm_enquiries` -- the SQL is
--   `FROM crm_enquiries e LEFT JOIN leads l ...`. So the "LIVE"
--   projection only surfaces source rows that also have a
--   crm_enquiries overlay row created by the ingestion hooks
--   (services/public/leads.js#verify for Website,
--   services/enquiry/management.js#ingestIntoCrm for NPD).
--
--   Those hooks only fire on NEW source rows. Historical rows
--   pre-dating T-2026-151, plus rows created during the T-2026-156
--   fixup when the wrong hook was writing (Website Property vs
--   Website Buyer Lead), never got an overlay row. Migration 104's
--   orphan cleanup then hard-deleted the few malformed overlays,
--   leaving crm_enquiries + crm_parents at ZERO rows while `leads`
--   has 13 undeleted rows and `enquiry_properties` has 3 undeleted
--   rows. Net effect: /admin/crm renders "No CRM enquiries yet."
--   even though both source modules are populated.
--
-- Fix:
--   Backfill crm_parents + crm_enquiries + crm_status_history from
--   the two canonical sources at migrate time. Uses the SAME
--   normalization rules the runtime duplicateResolver applies:
--     * normalized_mobile = digits only; NULL if < 10 digits; else
--       RIGHT(digits,10)  [mirrors crm.normalizeMobile()]
--     * normalized_email  = TRIM + LOWER; NULL if empty or missing
--       '@'  [mirrors crm.normalizeEmail()]
--
--   Parent identity strategy (backfill only):
--     * MOBILE-FIRST. Each distinct normalized_mobile => one parent.
--     * If a lead has no mobile but has an email, it gets an
--       email-only parent (mobile NULL). This mirrors runtime
--       resolver Case B for the (rare) email-only ingest path.
--     * We DO NOT set normalized_email on mobile-keyed parents in
--       the initial INSERT, because two rows sharing an email but
--       with different mobiles would collide on the ux_parent_norm_email
--       UNIQUE index and INSERT IGNORE would silently drop one of
--       them, leaving that lead orphaned. Instead, step 3 backfills
--       the email into mobile-keyed parents only when it is
--       UNAMBIGUOUSLY owned by that mobile (i.e., no other mobile
--       shares that same email).
--
--     This is the pragmatic backfill policy. In the runtime resolver,
--     the same "different mobiles, same email" collision triggers
--     Case E (DUPLICATE_CONFLICT) for admin resolution -- but the
--     backfill can't stage historical conflicts sensibly, so we
--     preserve every source row's visibility in the CRM listing at
--     the cost of leaving the email display slot blank on a handful
--     of mobile-keyed parents until admin edits the underlying source.
--
-- Non-destructive:
--   * INSERT IGNORE against the unique parent indexes -- if a
--     parent already exists (from a runtime ingest or a previous
--     run of this migration), the existing parent is kept.
--   * INSERT ... NOT EXISTS on (source_type, source_id) for
--     crm_enquiries -- a second run inserts nothing (idempotent
--     per source row identity).
--   * Zero UPDATE on either source table. Zero DROP anywhere.
--
-- Idempotency guarantees:
--   Second run: every step is INSERT IGNORE or INSERT ... WHERE
--   NOT EXISTS or UPDATE with a guard clause. Re-running yields
--   zero new rows and never regresses the sequence.
--
-- Collation:
--   crm_parents.normalized_mobile / normalized_email are
--   utf8mb4_unicode_ci (from migration 101). Expression results
--   (RIGHT(REGEXP_REPLACE(...))) default to utf8mb4_general_ci
--   on this driver, which trips "Illegal mix of collations" on
--   JOIN predicates. We explicitly COLLATE utf8mb4_unicode_ci on
--   the computed side wherever it JOINs against the parent column.
--
-- Sources referenced (both untouched by this migration):
--   * `leads` (migration 001) -- columns used: id, buyer_name,
--     buyer_mobile, buyer_email, deleted_at, created_at.
--   * `enquiry_properties` (migration 048) -- columns used: id,
--     owner_name, owner_contact, deleted_at, created_at.
-- ============================================================

-- Force the connection collation to match crm_parents (unicode_ci,
-- from migration 101). Without this, RIGHT(REGEXP_REPLACE(...)) and
-- other expression results default to the driver's utf8mb4_general_ci
-- and every JOIN against crm_parents.normalized_* trips "Illegal mix
-- of collations". T-2026-159 originally tried per-comparison COLLATE
-- clauses but the coverage requirements (every derived subquery, every
-- temp table, every UPDATE JOIN) is fragile -- setting SESSION scope
-- is the durable fix.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET SESSION collation_connection = utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- 1) Backfill crm_parents: mobile-keyed parents from every non-deleted
--    source row that has a normalized_mobile >= 10 digits.
--    normalized_email is left NULL on these -- step 3 fills it in
--    later ONLY when unambiguous.
-- ------------------------------------------------------------------
INSERT IGNORE INTO crm_parents (full_name, normalized_mobile, normalized_email, source_hint, created_at, updated_at)
SELECT
    MAX(CASE WHEN COALESCE(TRIM(t.name), '') = '' THEN NULL ELSE t.name END) AS full_name,
    t.norm_mobile,
    NULL AS normalized_email,
    CASE WHEN SUM(t.is_website) > 0 THEN 'website' ELSE 'npd' END AS source_hint,
    MIN(t.created_at),
    MIN(t.created_at)
  FROM (
    -- WEBSITE branch
    SELECT
      l.buyer_name AS name,
      CASE
        WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(l.buyer_mobile, ''), '[^0-9]', '')) >= 10
          THEN RIGHT(REGEXP_REPLACE(l.buyer_mobile, '[^0-9]', ''), 10)
        ELSE NULL
      END AS norm_mobile,
      1 AS is_website,
      l.created_at
      FROM leads l
     WHERE l.deleted_at IS NULL

    UNION ALL

    -- NPD branch
    SELECT
      ep.owner_name AS name,
      CASE
        WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(ep.owner_contact, ''), '[^0-9]', '')) >= 10
          THEN RIGHT(REGEXP_REPLACE(ep.owner_contact, '[^0-9]', ''), 10)
        ELSE NULL
      END AS norm_mobile,
      0 AS is_website,
      ep.created_at
      FROM enquiry_properties ep
     WHERE ep.deleted_at IS NULL
  ) t
 WHERE t.norm_mobile IS NOT NULL
 GROUP BY t.norm_mobile;

-- ------------------------------------------------------------------
-- 2) Backfill crm_parents: email-only parents. Rows with a valid email
--    but no mobile (< 10 digits) get their own parent. INSERT IGNORE
--    guards the ux_parent_norm_email UNIQUE index.
-- ------------------------------------------------------------------
INSERT IGNORE INTO crm_parents (full_name, normalized_mobile, normalized_email, source_hint, created_at, updated_at)
SELECT
    MAX(CASE WHEN COALESCE(TRIM(t.name), '') = '' THEN NULL ELSE t.name END) AS full_name,
    NULL AS normalized_mobile,
    t.norm_email,
    CASE WHEN SUM(t.is_website) > 0 THEN 'website' ELSE 'npd' END AS source_hint,
    MIN(t.created_at),
    MIN(t.created_at)
  FROM (
    SELECT
      l.buyer_name AS name,
      CASE
        WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(l.buyer_mobile, ''), '[^0-9]', '')) >= 10
          THEN RIGHT(REGEXP_REPLACE(l.buyer_mobile, '[^0-9]', ''), 10)
        ELSE NULL
      END AS norm_mobile,
      CASE
        WHEN LOWER(TRIM(COALESCE(l.buyer_email, ''))) = '' THEN NULL
        WHEN LOWER(TRIM(l.buyer_email)) NOT LIKE '%@%' THEN NULL
        ELSE LOWER(TRIM(l.buyer_email))
      END AS norm_email,
      1 AS is_website,
      l.created_at
      FROM leads l
     WHERE l.deleted_at IS NULL
  ) t
 WHERE t.norm_mobile IS NULL AND t.norm_email IS NOT NULL
 GROUP BY t.norm_email;

-- ------------------------------------------------------------------
-- 3) Fill normalized_email on mobile-keyed parents ONLY when the
--    mobile unambiguously owns exactly one email across all source
--    rows AND that email is not already claimed by any other parent.
--    If the same email is shared by two different mobiles (which
--    would trigger runtime resolver Case E DUPLICATE_CONFLICT), we
--    leave the parent's email slot NULL rather than pick a winner --
--    admin can resolve later by editing the source lead.
--
--    Implementation note: we deliberately keep this UPDATE simple.
--    Complex nested aggregate subqueries tripped MariaDB 10.4's
--    collation-inference on the joined-derived-column path. Instead
--    we materialize the safe set into a temp table, then UPDATE from
--    it via a straightforward JOIN.
-- ------------------------------------------------------------------
CREATE TEMPORARY TABLE IF NOT EXISTS _t159_lead_pairs (
  norm_mobile VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  norm_email  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  KEY idx_mobile (norm_mobile),
  KEY idx_email  (norm_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Idempotent: TRUNCATE lets a re-run recompute from current source data.
TRUNCATE TABLE _t159_lead_pairs;

INSERT INTO _t159_lead_pairs (norm_mobile, norm_email)
SELECT
  CASE
    WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(l.buyer_mobile, ''), '[^0-9]', '')) >= 10
      THEN RIGHT(REGEXP_REPLACE(l.buyer_mobile, '[^0-9]', ''), 10)
    ELSE NULL
  END,
  CASE
    WHEN LOWER(TRIM(COALESCE(l.buyer_email, ''))) = '' THEN NULL
    WHEN LOWER(TRIM(l.buyer_email)) NOT LIKE '%@%' THEN NULL
    ELSE LOWER(TRIM(l.buyer_email))
  END
  FROM leads l
 WHERE l.deleted_at IS NULL;

-- Safe fills: mobile has exactly one email AND that email has exactly
-- one mobile across the whole source set.
UPDATE crm_parents p
  JOIN (
    SELECT
      lp.norm_mobile,
      MIN(lp.norm_email) AS norm_email
      FROM _t159_lead_pairs lp
     WHERE lp.norm_mobile IS NOT NULL AND lp.norm_email IS NOT NULL
     GROUP BY lp.norm_mobile
     HAVING COUNT(DISTINCT lp.norm_email) = 1
        AND (
          SELECT COUNT(DISTINCT lp2.norm_mobile)
            FROM _t159_lead_pairs lp2
           WHERE lp2.norm_email = MIN(lp.norm_email)
             AND lp2.norm_mobile IS NOT NULL
        ) = 1
  ) safe ON safe.norm_mobile = p.normalized_mobile
   SET p.normalized_email = safe.norm_email,
       p.updated_at = CURRENT_TIMESTAMP
 WHERE p.normalized_email IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM crm_parents p2
          WHERE p2.normalized_email = safe.norm_email
            AND p2.id <> p.id
       );

DROP TEMPORARY TABLE IF EXISTS _t159_lead_pairs;

-- ------------------------------------------------------------------
-- 4) Reserve the ENQ-YYYY-NNNNN range. We assign the codes in the
--    subsequent INSERT ... SELECT via a user-variable row counter.
-- ------------------------------------------------------------------
SET @row_num := 0;
SET @year_prefix := DATE_FORMAT(CURRENT_TIMESTAMP, '%Y');

-- Ensure a sequence row exists for the current year.
INSERT IGNORE INTO crm_enquiry_sequence (year_prefix, next_seq) VALUES (@year_prefix, 1);

-- Capture the starting sequence number BEFORE reservation.
SELECT next_seq INTO @start_seq FROM crm_enquiry_sequence WHERE year_prefix = @year_prefix;

-- ------------------------------------------------------------------
-- 5) Backfill crm_enquiries from `leads`. JOIN parent by mobile
--    first; if no mobile, fall back to email.
--    Idempotent guard: NOT EXISTS on (source_type='website', source_id).
-- ------------------------------------------------------------------
INSERT INTO crm_enquiries (parent_id, enquiry_code, source_type, source_id, status_code, created_at, updated_at)
SELECT
    COALESCE(pm.id, pe.id) AS parent_id,
    CONCAT('ENQ-', @year_prefix, '-', LPAD(@start_seq + (@row_num := @row_num + 1) - 1, 5, '0')) AS enquiry_code,
    'website' AS source_type,
    l.id AS source_id,
    'new' AS status_code,
    l.created_at,
    l.created_at
  FROM leads l
  LEFT JOIN crm_parents pm
    ON pm.normalized_mobile = (CASE
         WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(l.buyer_mobile, ''), '[^0-9]', '')) >= 10
           THEN RIGHT(REGEXP_REPLACE(l.buyer_mobile, '[^0-9]', ''), 10)
         ELSE NULL
       END) COLLATE utf8mb4_unicode_ci
  LEFT JOIN crm_parents pe
    ON pm.id IS NULL
   AND pe.normalized_email = (CASE
         WHEN LOWER(TRIM(COALESCE(l.buyer_email, ''))) = '' THEN NULL
         WHEN LOWER(TRIM(l.buyer_email)) NOT LIKE '%@%' THEN NULL
         ELSE LOWER(TRIM(l.buyer_email))
       END) COLLATE utf8mb4_unicode_ci
 WHERE l.deleted_at IS NULL
   AND COALESCE(pm.id, pe.id) IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM crm_enquiries e
          WHERE e.source_type = 'website' AND e.source_id = l.id
       )
 ORDER BY l.created_at, l.id;

-- ------------------------------------------------------------------
-- 6) Backfill crm_enquiries from `enquiry_properties`. NPD has no
--    direct email column so we join by mobile only.
-- ------------------------------------------------------------------
INSERT INTO crm_enquiries (parent_id, enquiry_code, source_type, source_id, status_code, created_at, updated_at)
SELECT
    p.id AS parent_id,
    CONCAT('ENQ-', @year_prefix, '-', LPAD(@start_seq + (@row_num := @row_num + 1) - 1, 5, '0')) AS enquiry_code,
    'npd' AS source_type,
    ep.id AS source_id,
    'new' AS status_code,
    ep.created_at,
    ep.created_at
  FROM enquiry_properties ep
  LEFT JOIN crm_parents p
    ON p.normalized_mobile = (CASE
         WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(ep.owner_contact, ''), '[^0-9]', '')) >= 10
           THEN RIGHT(REGEXP_REPLACE(ep.owner_contact, '[^0-9]', ''), 10)
         ELSE NULL
       END) COLLATE utf8mb4_unicode_ci
 WHERE ep.deleted_at IS NULL
   AND p.id IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM crm_enquiries e
          WHERE e.source_type = 'npd' AND e.source_id = ep.id
       )
 ORDER BY ep.created_at, ep.id;

-- ------------------------------------------------------------------
-- 7) Advance the sequence past the reserved range. GREATEST guards
--    against a concurrent runtime call that bumped the counter higher.
-- ------------------------------------------------------------------
UPDATE crm_enquiry_sequence
   SET next_seq = GREATEST(next_seq, @start_seq + @row_num)
 WHERE year_prefix = @year_prefix;

-- ------------------------------------------------------------------
-- 8) Seed the initial crm_status_history row (from=NULL -> to=<code>).
--    Note tags the backfill for audit distinction from live ingests.
-- ------------------------------------------------------------------
INSERT INTO crm_status_history (enquiry_id, from_status, to_status, note, changed_by_admin_id, calendar_activity_id, created_at)
SELECT
    e.id,
    NULL,
    e.status_code,
    'Backfilled from migration 105 (T-2026-159)',
    NULL,
    NULL,
    e.created_at
  FROM crm_enquiries e
 WHERE NOT EXISTS (
         SELECT 1 FROM crm_status_history h
          WHERE h.enquiry_id = e.id AND h.from_status IS NULL
       );

-- ------------------------------------------------------------------
-- 9) Best-name refresh on mobile-keyed parents whose name is blank
--    or shorter than an available name from a sibling source row.
--    Mirrors runtime updateParentBestNameForConn ("longer wins").
-- ------------------------------------------------------------------
UPDATE crm_parents p
  JOIN (
    SELECT
      t.norm_mobile,
      SUBSTRING_INDEX(
        GROUP_CONCAT(NULLIF(TRIM(t.name), '')
          ORDER BY CHAR_LENGTH(t.name) DESC SEPARATOR '|~|'), '|~|', 1
      ) AS best_name
      FROM (
        SELECT
          l.buyer_name AS name,
          CASE
            WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(l.buyer_mobile, ''), '[^0-9]', '')) >= 10
              THEN RIGHT(REGEXP_REPLACE(l.buyer_mobile, '[^0-9]', ''), 10)
            ELSE NULL
          END AS norm_mobile
          FROM leads l
         WHERE l.deleted_at IS NULL AND COALESCE(TRIM(l.buyer_name), '') <> ''
        UNION ALL
        SELECT
          ep.owner_name AS name,
          CASE
            WHEN CHAR_LENGTH(REGEXP_REPLACE(COALESCE(ep.owner_contact, ''), '[^0-9]', '')) >= 10
              THEN RIGHT(REGEXP_REPLACE(ep.owner_contact, '[^0-9]', ''), 10)
            ELSE NULL
          END AS norm_mobile
          FROM enquiry_properties ep
         WHERE ep.deleted_at IS NULL AND COALESCE(TRIM(ep.owner_name), '') <> ''
      ) t
     WHERE t.norm_mobile IS NOT NULL
     GROUP BY t.norm_mobile
  ) best
  ON best.norm_mobile COLLATE utf8mb4_unicode_ci = p.normalized_mobile
   SET p.full_name = best.best_name,
       p.updated_at = CURRENT_TIMESTAMP
 WHERE best.best_name IS NOT NULL
   AND (p.full_name IS NULL OR p.full_name = ''
        OR CHAR_LENGTH(best.best_name) > CHAR_LENGTH(p.full_name));

-- Verification (run manually if needed):
--   SELECT COUNT(*) AS parents FROM crm_parents;
--   SELECT source_type, COUNT(*) AS n FROM crm_enquiries GROUP BY source_type;
--   -- Expect: (undeleted leads with mobile-or-email) + (undeleted
--   -- enquiry_properties with mobile) crm_enquiries rows.
