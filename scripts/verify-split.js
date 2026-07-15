#!/usr/bin/env node
/**
 * Post-migration verification. Confirms the inventory/enquiry split is
 * consistent: rows in the right tables, property_files re-pointed correctly,
 * no orphans. Also runs a tiny Add / View / Edit / Delete cycle against
 * both tables using clearly-tagged test rows (auto-cleaned at the end).
 *
 * Read-mostly. The CRUD probe inserts and then hard-deletes its own rows
 * — real data is untouched. Bail out immediately on any inconsistency.
 */

require('dotenv').config();

const mysql = require('mysql2/promise');

const INVENTORY_PREDICATE = /(lease\s+out|rent\s+out|joint\s+venture|let\s+out)/i;

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
  });

  const results = [];
  const record = (label, ok, extra = '') => {
    results.push({ label, ok, extra });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`);
  };

  try {
    console.log('\n── 1. Row counts ─────────────────────────────────────────');
    const [[{ invActive }]] = await conn.query(
      `SELECT COUNT(*) AS invActive FROM inventory_properties WHERE deleted_at IS NULL`,
    );
    const [[{ invTotal }]] = await conn.query(
      `SELECT COUNT(*) AS invTotal FROM inventory_properties`,
    );
    const [[{ enqActive }]] = await conn.query(
      `SELECT COUNT(*) AS enqActive FROM enquiry_properties WHERE deleted_at IS NULL`,
    );
    const [[{ enqTotal }]] = await conn.query(
      `SELECT COUNT(*) AS enqTotal FROM enquiry_properties`,
    );
    console.log(`  inventory_properties: ${invActive} active / ${invTotal} total`);
    console.log(`  enquiry_properties:   ${enqActive} active / ${enqTotal} total`);

    console.log('\n── 2. Category integrity ────────────────────────────────');
    const [invRows] = await conn.query(
      `SELECT id, property_code, property_type FROM inventory_properties WHERE deleted_at IS NULL`,
    );
    const invBadEnquiryLike = invRows.filter((r) => !INVENTORY_PREDICATE.test(r.property_type || ''));
    record(
      'inventory_properties contains only Inventory-category rows',
      invBadEnquiryLike.length === 0,
      invBadEnquiryLike.length ? `${invBadEnquiryLike.length} enquiry-like row(s) leaked` : `${invRows.length} row(s) checked`,
    );

    const [enqRows] = await conn.query(
      `SELECT id, property_code, property_type FROM enquiry_properties WHERE deleted_at IS NULL`,
    );
    const enqBadInventoryLike = enqRows.filter((r) => INVENTORY_PREDICATE.test(r.property_type || ''));
    record(
      'enquiry_properties contains only Enquiry-category rows',
      enqBadInventoryLike.length === 0,
      enqBadInventoryLike.length ? `${enqBadInventoryLike.length} inventory-like row(s) leaked` : `${enqRows.length} row(s) checked`,
    );

    console.log('\n── 3. property_files integrity ──────────────────────────');
    const [[{ orphanInventoryFiles }]] = await conn.query(
      `SELECT COUNT(*) AS orphanInventoryFiles
         FROM property_files f
         LEFT JOIN inventory_properties p ON p.id = f.property_id
        WHERE f.property_kind = 'inventory'
          AND p.id IS NULL`,
    );
    record(
      'no property_files rows with property_kind=inventory point at a missing inventory_properties row',
      orphanInventoryFiles === 0,
      `orphans: ${orphanInventoryFiles}`,
    );

    const [[{ orphanEnquiryFiles }]] = await conn.query(
      `SELECT COUNT(*) AS orphanEnquiryFiles
         FROM property_files f
         LEFT JOIN enquiry_properties p ON p.id = f.property_id
        WHERE f.property_kind = 'enquiry'
          AND p.id IS NULL`,
    );
    record(
      'no property_files rows with property_kind=enquiry point at a missing enquiry_properties row',
      orphanEnquiryFiles === 0,
      `orphans: ${orphanEnquiryFiles}`,
    );

    const [[{ inventoryFileCount }]] = await conn.query(
      `SELECT COUNT(*) AS inventoryFileCount FROM property_files WHERE property_kind = 'inventory'`,
    );
    const [[{ enquiryFileCount }]] = await conn.query(
      `SELECT COUNT(*) AS enquiryFileCount FROM property_files WHERE property_kind = 'enquiry'`,
    );
    console.log(`  property_files: inventory=${inventoryFileCount}, enquiry=${enquiryFileCount}`);

    console.log('\n── 4. Backup tables present ─────────────────────────────');
    const [backupTables] = await conn.query(
      `SELECT TABLE_NAME, TABLE_ROWS
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME LIKE 'inventory_properties_pre_split_%'
        ORDER BY TABLE_NAME`,
    );
    record(
      'at least one pre-split backup table exists',
      backupTables.length > 0,
      `${backupTables.length} backup table(s) found`,
    );
    for (const b of backupTables) {
      console.log(`    - ${b.TABLE_NAME}  (~${b.TABLE_ROWS} rows)`);
    }

    console.log('\n── 5. CRUD smoke test: inventory_properties ─────────────');
    await crudProbe(conn, {
      table: 'inventory_properties',
      testType: 'Flat [Resale Lease Out]', // inventory-category, so consistent with the table
      record,
    });

    console.log('\n── 6. CRUD smoke test: enquiry_properties ───────────────');
    await crudProbe(conn, {
      table: 'enquiry_properties',
      testType: 'Flat [New Purchase]', // enquiry-category
      record,
    });

    console.log('\n── Summary ──────────────────────────────────────────────');
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      console.log(`  ${results.length} check(s) passed. Migration verified.`);
    } else {
      console.log(`  ${failed.length} check(s) FAILED — investigate before proceeding.`);
      for (const f of failed) console.log(`    - ${f.label}  (${f.extra})`);
      process.exitCode = 1;
    }
  } finally {
    await conn.end();
  }
}

async function crudProbe(conn, { table, testType, record }) {
  const stamp = Date.now().toString(36);
  const propertyCode = `TEST-SMOKE-${stamp}`.slice(0, 32);
  const originalTitle = 'CRUD Smoke Test';
  const updatedTitle = 'CRUD Smoke Updated';

  // Add
  const [ins] = await conn.query(
    `INSERT INTO ${table} (property_code, title, property_type, transaction_type, location, price)
     VALUES (?, ?, ?, 'sale', 'Nashik', 1)`,
    [propertyCode, originalTitle, testType],
  );
  const newId = ins.insertId;
  record(`${table}: INSERT (Add)`, Boolean(newId), `id=${newId}`);

  // View
  const [[viewed]] = await conn.query(
    `SELECT id, title, property_type FROM ${table} WHERE id = ? LIMIT 1`,
    [newId],
  );
  record(
    `${table}: SELECT (View) returns the inserted row`,
    viewed && viewed.title === originalTitle && viewed.property_type === testType,
  );

  // Edit
  const [upd] = await conn.query(
    `UPDATE ${table} SET title = ? WHERE id = ?`,
    [updatedTitle, newId],
  );
  const [[afterEdit]] = await conn.query(
    `SELECT title FROM ${table} WHERE id = ?`,
    [newId],
  );
  record(
    `${table}: UPDATE (Edit) persists new value`,
    upd.affectedRows === 1 && afterEdit && afterEdit.title === updatedTitle,
  );

  // Delete (hard — we don't want smoke rows lingering)
  const [del] = await conn.query(`DELETE FROM ${table} WHERE id = ?`, [newId]);
  const [[postDelete]] = await conn.query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`,
    [newId],
  );
  record(
    `${table}: DELETE removes the row`,
    del.affectedRows === 1 && postDelete.n === 0,
  );
}

main().catch((err) => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
