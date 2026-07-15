#!/usr/bin/env node
/**
 * One-shot data migration: split existing inventory_properties rows into
 * two tables based on the 22/57 form-category classification that the
 * frontend split establishes.
 *
 *   Inventory-category forms (22)  → STAY in inventory_properties
 *     Any label containing "Lease Out", "Rent Out", "Joint Venture", or
 *     "Let Out" (Hostel).
 *
 *   Enquiry-category forms (57)    → MOVE to enquiry_properties
 *     Everything else — Purchase, Sale, Lease In, Rent In, Rate Finder,
 *     Paying Guest, Let In, TDR, Bank Auction, Hospital, Industrial Plot,
 *     Pre-Leased, Project Registration, SEZ.
 *
 * Notes:
 *  - Rows are matched by content of their `property_type` label; spacing /
 *    bracket variance in the label doesn't affect classification.
 *  - `property_files` rows attached to moved properties are re-pointed:
 *    property_kind flips from 'inventory' → 'enquiry' and property_id is
 *    updated to the new enquiry_properties.id.
 *  - The DB row IDs are NOT preserved across the move — MySQL assigns new
 *    auto-increment IDs in enquiry_properties. Any external references to
 *    the old inventory_properties.id will point at (soft-deleted) history
 *    after the move. Property codes (NSK-…) are preserved and remain the
 *    stable human identifier.
 *  - Runs default in DRY-RUN mode. Pass --apply to actually move rows.
 *  - The pre-move backup table (inventory_properties_pre_split_<ts>) is
 *    left in place after --apply so a rollback is trivial. Drop it once
 *    you're satisfied.
 *
 * Usage:
 *   cd Backend
 *   node scripts/migrate-inventory-to-enquiry.js              # dry run (default)
 *   node scripts/migrate-inventory-to-enquiry.js --apply      # perform the move
 *   node scripts/migrate-inventory-to-enquiry.js --apply --yes  # skip confirmation
 *   node scripts/migrate-inventory-to-enquiry.js --list-unknowns
 *                                                             # dump rows whose
 *                                                             # property_type
 *                                                             # doesn't match any
 *                                                             # of the 79 forms
 */

require('dotenv').config();

const mysql = require('mysql2/promise');
const readline = require('readline');

// ── Classification predicate (see comment at top for the rule) ──────────
// Case-insensitive substring match against the four inventory keywords.
// "Let Out" also matches the Hostel form ("Hostel Let Out") — Hostel is
// the only form using the "Let" verb, so no conflict with "Let In" etc.
const INVENTORY_PREDICATE = /(lease\s+out|rent\s+out|joint\s+venture|let\s+out)/i;

// The 79 known form labels (as stored in property_type after " Registration
// Form" is stripped by the frontend before submit). Used ONLY for the
// unknown-flagging summary — the actual classification uses the predicate
// above, which is spacing-insensitive.
const KNOWN_LABEL_FRAGMENTS = [
  // Bungalow (12)
  'Bunglow', 'Bunglow ',
  // Commercial Space (12)
  'Commercial Space',
  // Flat (13)
  'Flat',
  // Hospital / Hostel / Industrial / Land / Plot / Shop / TDR / SEZ / etc.
  'Hospital', 'Hostel', 'Industrial Plot', 'Land', 'Plot', 'Shop', 'TDR',
  'SEZ', 'Pre-Leased', 'Project', 'Bank Auction',
];

function categorize(label) {
  const text = String(label || '').trim();
  if (!text) return { category: 'unknown', reason: 'empty property_type' };
  const looksKnown = KNOWN_LABEL_FRAGMENTS.some((frag) =>
    text.toLowerCase().includes(frag.toLowerCase()),
  );
  if (!looksKnown) {
    return { category: 'unknown', reason: 'property_type not in known 79-form vocabulary' };
  }
  if (INVENTORY_PREDICATE.test(text)) return { category: 'inventory' };
  return { category: 'enquiry' };
}

// ── CLI arg parsing ──────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const SKIP_CONFIRM = args.has('--yes');
const LIST_UNKNOWNS = args.has('--list-unknowns');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
    multipleStatements: false,
  });

  console.log('');
  console.log(`Mode: ${APPLY ? 'APPLY  (rows will be moved)' : 'DRY RUN  (no changes)'}`);
  console.log('');

  try {
    // ── Fetch every candidate row (soft-deleted rows excluded). ──────────
    const [rows] = await conn.query(
      `SELECT id, property_code, property_type, title, created_at
         FROM inventory_properties
        WHERE deleted_at IS NULL`,
    );

    const byCategory = { inventory: [], enquiry: [], unknown: [] };
    const byLabel = new Map();

    for (const r of rows) {
      const { category, reason } = categorize(r.property_type);
      byCategory[category].push({ ...r, _reason: reason });
      const key = `${category.padEnd(9)}  ${r.property_type || '(blank)'}`;
      byLabel.set(key, (byLabel.get(key) || 0) + 1);
    }

    // ── Summary output ───────────────────────────────────────────────────
    console.log(`Total rows in inventory_properties (not deleted): ${rows.length}`);
    console.log(`  → stay as Inventory:  ${byCategory.inventory.length}`);
    console.log(`  → move to Enquiry:    ${byCategory.enquiry.length}`);
    console.log(`  → unknown / skipped:  ${byCategory.unknown.length}`);
    console.log('');

    console.log('Breakdown by property_type label:');
    const sortedLabels = [...byLabel.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [key, count] of sortedLabels) {
      console.log(`  ${String(count).padStart(4)}   ${key}`);
    }
    console.log('');

    if (LIST_UNKNOWNS) {
      console.log('Unknown rows (would not be moved):');
      if (byCategory.unknown.length === 0) {
        console.log('  (none — every row matched a known category)');
      } else {
        for (const u of byCategory.unknown) {
          console.log(`  id=${u.id}  code=${u.property_code}  type="${u.property_type}"  title="${u.title}"  — ${u._reason}`);
        }
      }
      console.log('');
    }

    if (byCategory.enquiry.length === 0) {
      console.log('Nothing to move. Exiting.');
      return;
    }

    if (!APPLY) {
      console.log('DRY RUN complete. Re-run with --apply to move the rows.');
      console.log('For a list of the rows whose type didn\'t match, add --list-unknowns.');
      return;
    }

    // ── APPLY path ───────────────────────────────────────────────────────
    if (!SKIP_CONFIRM) {
      const ok = await promptYesNo(
        `About to move ${byCategory.enquiry.length} row(s) from inventory_properties → enquiry_properties.\n` +
        `A backup of inventory_properties will be created first.\n` +
        `Continue? [y/N] `,
      );
      if (!ok) {
        console.log('Aborted.');
        return;
      }
    }

    // 1. Backup inventory_properties (outside the transaction — DDL implicit-commits).
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '_');
    const backupTable = `inventory_properties_pre_split_${stamp}`;
    console.log(`Creating backup table: ${backupTable}`);
    await conn.query(`CREATE TABLE \`${backupTable}\` LIKE inventory_properties`);
    await conn.query(`INSERT INTO \`${backupTable}\` SELECT * FROM inventory_properties`);
    const [[{ backupRows }]] = await conn.query(
      `SELECT COUNT(*) AS backupRows FROM \`${backupTable}\``,
    );
    console.log(`Backup contains ${backupRows} row(s).`);
    console.log('');

    // 2. Move rows one at a time in a transaction so property_files can be
    //    re-pointed to the new enquiry IDs. Per-row is slower than a bulk
    //    INSERT ... SELECT, but it's the cleanest way to build the
    //    old-id → new-id mapping needed for property_files updates.
    console.log('Moving rows…');
    await conn.beginTransaction();
    try {
      const idMap = new Map(); // old inventory id → new enquiry id
      for (const row of byCategory.enquiry) {
        const [ins] = await conn.query(
          `INSERT INTO enquiry_properties (
              property_code, registration_date, title, description, property_type,
              transaction_type, transaction_variant, location, district, taluka, shivar,
              latitude, longitude, pincode,
              area_value, area_unit, bhk, price, status, status_note, status_changed_at, status_changed_by,
              is_draft, owner_name, owner_contact, agent_name, agent_contact, details,
              created_by_admin_id, created_at, updated_at, deleted_at
            )
            SELECT property_code, registration_date, title, description, property_type,
                   transaction_type, transaction_variant, location, district, taluka, shivar,
                   latitude, longitude, pincode,
                   area_value, area_unit, bhk, price, status, status_note, status_changed_at, status_changed_by,
                   is_draft, owner_name, owner_contact, agent_name, agent_contact, details,
                   created_by_admin_id, created_at, updated_at, deleted_at
              FROM inventory_properties
             WHERE id = ?`,
          [row.id],
        );
        const newId = ins.insertId;
        idMap.set(row.id, newId);
        // Re-point any images / documents from 'inventory' → 'enquiry'.
        await conn.query(
          `UPDATE property_files
              SET property_kind = 'enquiry', property_id = ?
            WHERE property_kind = 'inventory' AND property_id = ?`,
          [newId, row.id],
        );
      }
      // Hard-delete the moved rows from inventory_properties. Safe because
      // (a) the backup table still holds them, (b) property_files rows now
      // point at enquiry IDs, (c) the transaction rolls back on any error.
      const idsToDelete = [...idMap.keys()];
      if (idsToDelete.length > 0) {
        await conn.query(
          `DELETE FROM inventory_properties WHERE id IN (?)`,
          [idsToDelete],
        );
      }
      await conn.commit();
      console.log(`Moved ${idMap.size} row(s).`);
      console.log('');
      console.log('Post-migration counts:');
      const [[{ invRemaining }]] = await conn.query(
        `SELECT COUNT(*) AS invRemaining FROM inventory_properties WHERE deleted_at IS NULL`,
      );
      const [[{ enqTotal }]] = await conn.query(
        `SELECT COUNT(*) AS enqTotal FROM enquiry_properties WHERE deleted_at IS NULL`,
      );
      console.log(`  inventory_properties (not deleted): ${invRemaining}`);
      console.log(`  enquiry_properties  (not deleted): ${enqTotal}`);
      console.log('');
      console.log(`Rollback plan (if needed):`);
      console.log(`  INSERT INTO inventory_properties SELECT * FROM \`${backupTable}\`;`);
      console.log(`  UPDATE property_files SET property_kind = 'inventory' WHERE property_kind = 'enquiry';`);
      console.log(`  -- then correct property_id back to the original inventory IDs by joining on property_code`);
      console.log(`  DELETE FROM enquiry_properties WHERE id IN (${[...idMap.values()].join(', ') || 'NULL'});`);
      console.log('');
      console.log('Done.');
    } catch (err) {
      await conn.rollback();
      console.error('Transaction rolled back due to error:', err.message);
      console.error(`Backup table \`${backupTable}\` was created before the transaction and remains in the DB.`);
      throw err;
    }
  } finally {
    await conn.end();
  }
}

function promptYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
