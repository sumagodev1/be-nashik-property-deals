#!/usr/bin/env node
/**
 * One-time CSV importer for the Maharashtra district → taluka → village
 * hierarchy. Reads a CSV in the shape emitted by the Maharashtra 7/12
 * portal / LGD masters:
 *
 *   stateCode,stateNameEnglish,districtCode,districtNameEnglish,
 *   subdistrictCode,subdistrictNameEnglish,villageCode,villageNameEnglish,pincode
 *
 * and populates the existing `master_lookups` table under the three
 * pre-existing keys `district`, `taluka`, `shivar`. Government codes are
 * used as the row `code` so the frontend can pass them through as a stable
 * FK (per the "use IDs or official government codes" rule in the spec).
 *
 * Every INSERT is wrapped in ON DUPLICATE KEY UPDATE — running the script
 * twice is safe and only refreshes labels / parent_code / state / pincode.
 *
 * Legacy stub rows seeded by migration 026 (district=nashik|pune|mumbai
 * plus their talukas / shivars) get soft-deleted so admin dropdowns stop
 * showing duplicate "Nashik" entries. If any inventory row still points at
 * a legacy code, the soft-delete keeps the row visible for historic reads
 * but hides it from new-property dropdowns — no data loss.
 *
 * Usage:
 *   node scripts/import-locations.js /absolute/path/to/All\ Village\ data.csv
 *   node scripts/import-locations.js            # uses DEFAULT_CSV below
 *
 * Environment:
 *   Reads DB config from the same .env the migrate script uses.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');

// Default location when the caller doesn't pass an explicit path. Points at
// the CSV that ships with the frontend reference folder — the script runs
// on the developer's machine, so a repo-relative path is fine.
const DEFAULT_CSV = path.resolve(
  __dirname,
  '..', '..', '..',
  'nashik_property_fronted',
  'fe-nashik-property-deals',
  'reference of inventory forms',
  'All Village data.csv',
);

const BATCH_SIZE = 1000;

// The three master keys we populate. Kept as constants so a typo doesn't
// silently write to the wrong master.
const K_DISTRICT = 'district';
const K_TALUKA   = 'taluka';
const K_SHIVAR   = 'shivar';

// Legacy stub codes seeded by migration 026 that we hide after import so
// admins don't see duplicate districts. Matched by (master_key, code).
const LEGACY_STUB_CODES = {
  [K_DISTRICT]: ['nashik', 'pune', 'mumbai'],
  [K_TALUKA]: [
    'nashik-city', 'niphad', 'igatpuri', 'trimbak', 'sinnar', 'malegaon',
    'baglan', 'chandwad', 'dindori', 'kalwan', 'nandgaon', 'peint',
    'satana', 'surgana', 'yeola',
  ],
  [K_SHIVAR]: [
    'chandsi', 'ozar', 'pathardi', 'adgaon', 'panchavati',
  ],
};

// Parse one CSV line into an array of fields. The reference CSV has no
// quoted fields (verified with `grep -c '"'` → 0), so a plain split is
// safe. Kept as a helper so a future CSV that does quote fields can
// swap in a real parser without rewiring the loader.
function parseLine(line) {
  return line.split(',');
}

// Read the CSV once, aggregate unique rows for each of the three tiers.
async function loadCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV not found: ${csvPath}`);
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const districts = new Map(); // code → { code, label, stateCode, stateName }
  const talukas   = new Map(); // code → { code, label, parentCode }
  const villages  = new Map(); // code → { code, label, parentCode, pincode }
  // Track the first pincode we see for each taluka only as a soft fallback —
  // per-village pincodes are the authoritative value we store.

  let header = null;
  let lineNo = 0;
  let dataRows = 0;
  let skipped = 0;

  for await (const raw of rl) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;

    const cols = parseLine(line);
    if (!header) {
      header = cols.map((c) => c.trim());
      // Sanity check the header — abort early if a stray file was passed.
      const expected = [
        'stateCode', 'stateNameEnglish', 'districtCode', 'districtNameEnglish',
        'subdistrictCode', 'subdistrictNameEnglish', 'villageCode',
        'villageNameEnglish', 'pincode',
      ];
      const missing = expected.filter((k) => !header.includes(k));
      if (missing.length > 0) {
        throw new Error(`CSV header missing columns: ${missing.join(', ')}`);
      }
      continue;
    }

    if (cols.length < 9) { skipped += 1; continue; }

    // We anchor by column position rather than header order because these
    // government exports occasionally add trailing columns and we don't
    // want a shifted read.
    const stateCode        = cols[0]?.trim();
    const stateName        = cols[1]?.trim();
    const districtCode     = cols[2]?.trim();
    const districtName     = cols[3]?.trim();
    const subdistrictCode  = cols[4]?.trim();
    const subdistrictName  = cols[5]?.trim();
    const villageCode      = cols[6]?.trim();
    const villageName      = cols[7]?.trim();
    const pincodeRaw       = cols[8]?.trim();

    // Skip rows with missing keys — the script is idempotent and should
    // never crash on garbage, just log and move on.
    if (!districtCode || !districtName || !subdistrictCode || !subdistrictName
        || !villageCode || !villageName) {
      skipped += 1;
      continue;
    }

    // Pincode: keep only 6-digit numeric values (some CSVs contain "0" or "-"
    // for unmapped villages — normalise to NULL).
    const pincode = /^\d{6}$/.test(pincodeRaw) ? pincodeRaw : null;

    dataRows += 1;

    if (!districts.has(districtCode)) {
      districts.set(districtCode, {
        code: districtCode,
        label: districtName,
        stateCode: stateCode || null,
        stateName: stateName || null,
      });
    }
    if (!talukas.has(subdistrictCode)) {
      talukas.set(subdistrictCode, {
        code: subdistrictCode,
        label: subdistrictName,
        parentCode: districtCode,
      });
    }
    if (!villages.has(villageCode)) {
      villages.set(villageCode, {
        code: villageCode,
        label: villageName,
        parentCode: subdistrictCode,
        pincode,
      });
    }
  }

  return { districts, talukas, villages, dataRows, skipped };
}

// INSERT ... ON DUPLICATE KEY UPDATE is our idempotency guarantee. The
// unique key on master_lookups is (master_key, code), so re-running the
// import simply refreshes labels / parent_code / state / pincode for the
// same code — no duplicates, no orphans.
async function upsertBatch(conn, masterKey, rows) {
  if (rows.length === 0) return 0;
  const values = [];
  const placeholders = [];
  for (const r of rows) {
    placeholders.push('(?, ?, ?, ?, ?, ?, ?, 1, 0)');
    values.push(
      masterKey,
      r.code,
      r.label,
      r.parentCode ?? null,
      r.stateCode ?? null,
      r.stateName ?? null,
      r.pincode ?? null,
    );
  }
  const sql = `
    INSERT INTO master_lookups
      (master_key, code, label, parent_code, state_code, state_name, pincode, is_active, sort_order)
    VALUES ${placeholders.join(', ')}
    ON DUPLICATE KEY UPDATE
      label       = VALUES(label),
      parent_code = VALUES(parent_code),
      state_code  = VALUES(state_code),
      state_name  = VALUES(state_name),
      pincode     = COALESCE(VALUES(pincode), pincode),
      is_active   = 1,
      deleted_at  = NULL
  `;
  await conn.query(sql, values);
  return rows.length;
}

async function upsertAll(conn, masterKey, iterable) {
  const items = Array.from(iterable);
  let done = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const slice = items.slice(i, i + BATCH_SIZE);
    done += await upsertBatch(conn, masterKey, slice);
  }
  return done;
}

async function softDeleteLegacyStubs(conn) {
  const summary = {};
  for (const [masterKey, codes] of Object.entries(LEGACY_STUB_CODES)) {
    if (codes.length === 0) { summary[masterKey] = 0; continue; }
    const placeholders = codes.map(() => '?').join(', ');
    const [r] = await conn.query(
      `UPDATE master_lookups
          SET deleted_at = NOW(), is_active = 0
        WHERE master_key = ?
          AND code IN (${placeholders})
          AND deleted_at IS NULL`,
      [masterKey, ...codes],
    );
    summary[masterKey] = r.affectedRows;
  }
  return summary;
}

async function main() {
  const csvPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CSV;
  console.log(`[locations] Reading CSV: ${csvPath}`);

  const t0 = Date.now();
  const { districts, talukas, villages, dataRows, skipped } = await loadCsv(csvPath);
  const tLoad = Date.now() - t0;
  console.log(
    `[locations] Parsed ${dataRows} rows in ${tLoad}ms — ` +
    `${districts.size} districts, ${talukas.size} talukas, ${villages.size} villages ` +
    `(skipped ${skipped} malformed rows)`,
  );

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
    multipleStatements: false,
  });

  try {
    // Verify the migration has run — if the state_code column is missing
    // the import would still work but silently drop the state metadata,
    // so we surface a clean error instead.
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'master_lookups'
          AND COLUMN_NAME IN ('state_code','state_name','pincode')`,
    );
    if (cols.length < 3) {
      throw new Error(
        'master_lookups is missing state_code/state_name/pincode columns. ' +
        'Run `npm run migrate` first (migration 049).',
      );
    }

    // Districts first (no parent), then talukas (parent = districtCode),
    // then villages (parent = subdistrictCode). Ordering matters for the
    // foreign-key-like `parent_code` even though there's no DB FK — a
    // taluka insert before its district would leave the child orphaned
    // in the UI until the parent lands.
    console.log(`[locations] Upserting districts…`);
    const dCount = await upsertAll(conn, K_DISTRICT, districts.values());
    console.log(`[locations] Upserting talukas…`);
    const tCount = await upsertAll(conn, K_TALUKA, talukas.values());
    console.log(`[locations] Upserting villages…`);
    const vCount = await upsertAll(conn, K_SHIVAR, villages.values());

    console.log(`[locations] Soft-deleting legacy stub rows…`);
    const stubs = await softDeleteLegacyStubs(conn);

    const tTotal = Date.now() - t0;
    console.log('[locations] Import complete.');
    console.log(`             districts upserted: ${dCount}`);
    console.log(`             talukas upserted:   ${tCount}`);
    console.log(`             villages upserted:  ${vCount}`);
    console.log(`             legacy stubs hidden: ${JSON.stringify(stubs)}`);
    console.log(`             total time:          ${tTotal}ms`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('[locations] Import failed:', err.stack || err.message);
  process.exit(1);
});
