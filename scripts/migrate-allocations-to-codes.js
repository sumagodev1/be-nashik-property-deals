#!/usr/bin/env node
/**
 * Convert crm_enquiries.interested_property_ids from numeric row ids to
 * property CODES.
 *
 * Migration 113 contains hardcoded UPDATEs correct for one database at one
 * moment. This script does the same job dynamically, so it is the right tool
 * for:
 *   * staging / production, whose rows differ;
 *   * catching rows created AFTER 113 was written (allocations made while the
 *     change was in flight land as numbers and 113's guarded WHEREs
 *     deliberately skip them rather than guess);
 *   * re-checking at any time -- already-converted rows are ignored.
 *
 * RESOLUTION RULE
 * ---------------
 * Numeric entries resolve against inventory_properties ONLY. That is not a
 * simplification: the pre-code writer enforced an inventory-only existence
 * check, so an inventory row is the only thing a stored number can have
 * meant. Soft-deleted inventory rows ARE resolved (a deleted property still
 * has a code, and keeping the code is the entire point -- it preserves which
 * property the lead wanted).
 *
 * Entries that are already codes are passed through untouched, so a
 * part-converted array converges instead of being mangled.
 *
 * SAFETY
 * ------
 *   * --dry-run is the DEFAULT. Nothing is written without --apply.
 *   * Every row is printed before/after.
 *   * Unresolvable numbers are reported and the row is SKIPPED entirely --
 *     never partially written, never silently dropped. Decide those by hand.
 *   * Each UPDATE is guarded on the exact pre-state it read, so a concurrent
 *     write between read and write loses the race instead of being clobbered.
 *
 * Usage:
 *   node scripts/migrate-allocations-to-codes.js            # dry run
 *   node scripts/migrate-allocations-to-codes.js --apply    # write
 */

require('dotenv').config();

const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');

function parseArray(raw) {
  if (raw == null) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const isNumericEntry = (v) => /^\d+$/.test(String(v).trim());

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
  });
  // scheduled_at etc. are IST wall-clock naive values elsewhere in this app;
  // pin UTC so nothing is silently shifted while this script is connected.
  await conn.query("SET time_zone = '+00:00'");

  try {
    const [rows] = await conn.query(
      `SELECT id, enquiry_code, interested_property_ids
         FROM crm_enquiries
        WHERE interested_property_ids IS NOT NULL
          AND JSON_VALID(interested_property_ids)
          AND JSON_LENGTH(interested_property_ids) > 0
        ORDER BY id`,
    );

    let converted = 0;
    let skipped = 0;
    let alreadyOk = 0;
    const problems = [];

    for (const row of rows) {
      const arr = parseArray(row.interested_property_ids);
      if (!arr) {
        problems.push({ id: row.id, code: row.enquiry_code, reason: 'unparseable JSON' });
        skipped += 1;
        continue;
      }

      const numeric = arr.filter(isNumericEntry);
      if (numeric.length === 0) {
        alreadyOk += 1;
        continue;
      }

      // Resolve every numeric entry, deleted rows included.
      const next = [];
      const unresolved = [];
      for (const entry of arr) {
        const s = String(entry).trim();
        if (!isNumericEntry(s)) { next.push(s); continue; }
        // eslint-disable-next-line no-await-in-loop
        const [hit] = await conn.query(
          'SELECT property_code, deleted_at FROM inventory_properties WHERE id = ?',
          [Number(s)],
        );
        if (hit[0] && hit[0].property_code) {
          next.push(hit[0].property_code);
        } else {
          unresolved.push(s);
        }
      }

      const before = JSON.stringify(arr);
      if (unresolved.length) {
        problems.push({
          id: row.id, code: row.enquiry_code, reason: `unresolvable id(s): ${unresolved.join(', ')}`,
        });
        console.log(`SKIP  ${row.enquiry_code.padEnd(18)} ${before}  -- unresolvable: ${unresolved.join(', ')}`);
        skipped += 1;
        continue;
      }

      const after = JSON.stringify(next);
      console.log(`${APPLY ? 'WRITE' : 'PLAN '} ${row.enquiry_code.padEnd(18)} ${before}  ->  ${after}`);

      if (APPLY) {
        // Guard on the exact value we read: a concurrent edit makes this a
        // no-op rather than an overwrite.
        const [res] = await conn.query(
          `UPDATE crm_enquiries
              SET interested_property_ids = ?
            WHERE id = ? AND interested_property_ids = ?`,
          [after, row.id, row.interested_property_ids],
        );
        if (res.affectedRows !== 1) {
          problems.push({ id: row.id, code: row.enquiry_code, reason: 'row changed concurrently, not written' });
          console.log(`      ^ SKIPPED: row changed under us`);
          skipped += 1;
          continue;
        }
      }
      converted += 1;
    }

    console.log('');
    console.log(`rows scanned      : ${rows.length}`);
    console.log(`already codes     : ${alreadyOk}`);
    console.log(`${APPLY ? 'converted       ' : 'would convert   '}  : ${converted}`);
    console.log(`skipped           : ${skipped}`);
    if (problems.length) {
      console.log('');
      console.log('NEEDS A HUMAN DECISION:');
      for (const p of problems) console.log(`  ${p.code} (id ${p.id}): ${p.reason}`);
    }
    if (!APPLY) {
      console.log('');
      console.log('DRY RUN - nothing written. Re-run with --apply to commit.');
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
