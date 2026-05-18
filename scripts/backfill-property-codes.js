#!/usr/bin/env node
/**
 * One-shot backfill: rewrite every existing inventory_properties and
 * website_properties row's property_code to the production format
 *
 *   NSK-<TYPE>-YY-XXXXXX
 *
 * Matches the generator in server/services/properties/propertyCode.js so
 * old rows (e.g. INV-000001, WEB-000001, DRAFT-000001) line up with new
 * ones created after the code-format change.
 *
 * Idempotent: rows that already match the new format are skipped.
 * The YY component uses the row's created_at year (not today's date) so
 * older listings carry their real vintage in the ID.
 *
 * Usage:
 *   cd Backend
 *   node scripts/backfill-property-codes.js              # both tables
 *   node scripts/backfill-property-codes.js --inventory  # one table only
 *   node scripts/backfill-property-codes.js --website
 *   node scripts/backfill-property-codes.js --dry-run    # show what would change
 */

require('dotenv').config();

const mysql = require('mysql2/promise');
const {
  generatePropertyCode,
} = require('../server/services/properties/propertyCode');

const NEW_FORMAT_RE = /^NSK-[A-Z]{3}-\d{2}-[A-Z0-9]{6}$/;

async function main() {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has('--dry-run');
  const doInventory = !args.has('--website') || args.has('--inventory');
  const doWebsite = !args.has('--inventory') || args.has('--website');

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
  });

  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  console.log('');

  try {
    if (doInventory) {
      await backfillTable(conn, {
        table: 'inventory_properties',
        dryRun,
      });
    }
    if (doWebsite) {
      await backfillTable(conn, {
        table: 'website_properties',
        dryRun,
      });
    }
  } finally {
    await conn.end();
  }
}

async function backfillTable(conn, { table, dryRun }) {
  console.log(`── ${table} ─────────────────────────────`);
  const [rows] = await conn.query(
    `SELECT id, property_code, property_type, created_at FROM ${table} WHERE deleted_at IS NULL`,
  );

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    if (NEW_FORMAT_RE.test(row.property_code)) {
      skipped += 1;
      continue;
    }

    const createdAt = row.created_at ? new Date(row.created_at) : new Date();
    const newCode = await generateUniqueFor(conn, table, row.property_type, createdAt);
    console.log(`  ${row.id}: ${row.property_code} → ${newCode}`);
    if (!dryRun) {
      await conn.query(
        `UPDATE ${table} SET property_code = ? WHERE id = ?`,
        [newCode, row.id],
      );
    }
    updated += 1;
  }

  console.log(`  updated: ${updated}, already-new: ${skipped}, total: ${rows.length}`);
  console.log('');
}

async function generateUniqueFor(conn, table, propertyType, createdAt) {
  // Generator already has crypto-strong randomness, but the new code must
  // not clash with another row in the SAME table — including rows we just
  // assigned in this run. Retry on the rare collision.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = generatePropertyCode(propertyType, createdAt);
    const [[hit]] = await conn.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE property_code = ?`,
      [candidate],
    );
    if (hit.n === 0) return candidate;
  }
  throw new Error(`Could not find a unique code after 10 attempts (table=${table})`);
}

main().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
