/**
 * T-2026-114 integration test: verifies parent-scoped Village duplicate rule.
 *
 * Run with:
 *   DB_NAME=nasik_property_deals2 node scripts/_test_t114_village_composite.js
 *
 * Uses the live DB. Rolls back all inserted rows at the end so re-runnable.
 */
require('dotenv').config();
const { pool } = require('../server/db/pool');
const svc = require('../server/services/masters/management');

const TEST_LABEL = 'Zzt114 Wadali Test';   // low collision probability (lookup pattern: alnum + spaces + / ( ) & , . : % + -)
const TEST_CODE_A = '__t114-wadali-test-a__';
const TEST_CODE_B = '__t114-wadali-test-b__';
const TEST_CODE_C = '__t114-wadali-test-c__';

async function assertPass(label, fn) {
  try {
    const r = await fn();
    console.log(`  PASS  ${label}`);
    return r;
  } catch (e) {
    console.log(`  FAIL  ${label} :: ${e.code || e.name} :: ${e.message}`);
    throw e;
  }
}
async function assertThrow(label, expectedCode, fn) {
  try {
    await fn();
    console.log(`  FAIL  ${label} :: expected ${expectedCode} but call succeeded`);
    throw new Error('expected throw');
  } catch (e) {
    if (e.code === expectedCode) {
      console.log(`  PASS  ${label} (rejected with ${expectedCode})`);
      return e;
    }
    console.log(`  FAIL  ${label} :: expected ${expectedCode} but got ${e.code || e.name} :: ${e.message}`);
    throw e;
  }
}

async function findExistingTaluka() {
  // Pick any two DIFFERENT talukas from master_lookups so we can create the
  // same village name under both.
  const [rows] = await pool.query(
    `SELECT code, label FROM master_lookups
      WHERE master_key = 'taluka'
        AND deleted_at IS NULL
        AND is_active = 1
      ORDER BY id ASC
      LIMIT 2`,
  );
  if (rows.length < 2) throw new Error('Need at least 2 active talukas to run the test');
  return rows;
}

async function cleanup() {
  await pool.query(
    `DELETE FROM master_lookups
      WHERE master_key = 'shivar'
        AND code IN (?, ?, ?)`,
    [TEST_CODE_A, TEST_CODE_B, TEST_CODE_C],
  );
}

async function main() {
  console.log('=== T-2026-114 Village-composite duplicate test ===');
  await cleanup();

  const [talukaA, talukaB] = await findExistingTaluka();
  console.log(`  fixtures: talukaA=${talukaA.code} (${talukaA.label}), talukaB=${talukaB.code} (${talukaB.label})`);

  const fakeReq = { user: null, ip: '127.0.0.1' };

  // CASE 1: create village under talukaA — should succeed.
  const row1 = await assertPass('1. create shivar under talukaA', () =>
    svc.create('shivar', {
      code: TEST_CODE_A,
      label: TEST_LABEL,
      parentCode: talukaA.code,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );

  // CASE 2: create SAME name under DIFFERENT taluka — should succeed under
  // the new rule (was previously LABEL_TAKEN).
  const row2 = await assertPass('2. create shivar with SAME label under DIFFERENT taluka', () =>
    svc.create('shivar', {
      code: TEST_CODE_B,
      label: TEST_LABEL,
      parentCode: talukaB.code,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );

  // CASE 3: create SAME name under the SAME taluka as case 1 — should fail
  // with LABEL_TAKEN, and the message must name the containing taluka.
  const err3 = await assertThrow('3. create DUPLICATE under same taluka -> LABEL_TAKEN', 'LABEL_TAKEN', () =>
    svc.create('shivar', {
      code: TEST_CODE_C,
      label: TEST_LABEL,
      parentCode: talukaA.code,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );
  if (!err3.message.includes(talukaA.label)) {
    console.log(`  FAIL  3b. error message did not name the taluka; got: ${err3.message}`);
    throw new Error('expected taluka name in message');
  }
  console.log(`  PASS  3b. error message names the containing taluka ("${talukaA.label}")`);

  // CASE 4: edit row1 with same label + same parent (self-save) — should succeed.
  await assertPass('4. update shivar with SAME label + SAME parent (self-save)', () =>
    svc.update('shivar', row1.id, {
      code: TEST_CODE_A,
      label: TEST_LABEL,
      parentCode: talukaA.code,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );

  // CASE 5: edit row2 -> move to talukaA (where row1 already occupies the
  // label) — should FAIL with LABEL_TAKEN.
  await assertThrow('5. move shivar to taluka where SAME label already exists -> LABEL_TAKEN', 'LABEL_TAKEN', () =>
    svc.update('shivar', row2.id, {
      code: TEST_CODE_B,
      label: TEST_LABEL,
      parentCode: talukaA.code,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );

  // CASE 6: create a globally-unique label under BOTH talukas — the global
  // rule (non-shivar keys) is unchanged. Verify a floor_level create still
  // rejects duplicate label globally (no parent scoping).
  const testFloorLabel = 'Zzt114 FloorLevel Test';
  await pool.query(`DELETE FROM master_lookups WHERE master_key = 'floor_level' AND code IN (?, ?)`, [
    '__t114-fl-a__', '__t114-fl-b__',
  ]);
  await assertPass('6a. create floor_level (non-parent-scoped) once', () =>
    svc.create('floor_level', {
      code: '__t114-fl-a__',
      label: testFloorLabel,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );
  await assertThrow('6b. create floor_level with SAME label -> LABEL_TAKEN (global)', 'LABEL_TAKEN', () =>
    svc.create('floor_level', {
      code: '__t114-fl-b__',
      label: testFloorLabel,
      sortOrder: 999,
      isActive: true,
    }, fakeReq),
  );
  await pool.query(`DELETE FROM master_lookups WHERE master_key = 'floor_level' AND code IN (?, ?)`, [
    '__t114-fl-a__', '__t114-fl-b__',
  ]);

  // CASE 7: simulate the FE "Other -> Save Village" code-suffix retry path.
  // The FE derives code from the label (codeFromLabel). When the same label
  // is added under two different talukas, the first insert takes the base
  // code, the second collides (UNIQUE(master_key, code) is global) and the
  // FE retries with a suffixed code. Verify the retry actually succeeds.
  const TEST_LABEL_2 = 'Zzt114 Suffix Test';
  const baseCode = 'zzt114-suffix-test';
  const suffixCode = 'zzt114-suffix-test-2';
  await pool.query(`DELETE FROM master_lookups WHERE master_key='shivar' AND code IN (?, ?)`, [baseCode, suffixCode]);

  await assertPass('7a. FE inline flow: create with base code under talukaA', () =>
    svc.create('shivar', {
      code: baseCode,
      label: TEST_LABEL_2,
      parentCode: talukaA.code,
      sortOrder: 0,
      isActive: true,
    }, fakeReq),
  );
  // Simulate FE's retry logic: first attempt with baseCode collides -> CODE_TAKEN;
  // second attempt with suffixCode succeeds.
  await assertThrow('7b. FE inline flow: base code collides globally -> CODE_TAKEN', 'CODE_TAKEN', () =>
    svc.create('shivar', {
      code: baseCode,
      label: TEST_LABEL_2,
      parentCode: talukaB.code,
      sortOrder: 0,
      isActive: true,
    }, fakeReq),
  );
  await assertPass('7c. FE inline flow: retry with suffixed code succeeds', () =>
    svc.create('shivar', {
      code: suffixCode,
      label: TEST_LABEL_2,
      parentCode: talukaB.code,
      sortOrder: 0,
      isActive: true,
    }, fakeReq),
  );
  await pool.query(`DELETE FROM master_lookups WHERE master_key='shivar' AND code IN (?, ?)`, [baseCode, suffixCode]);

  await cleanup();
  console.log('=== ALL CASES PASSED ===');
  await pool.end();
}

main().catch((e) => {
  console.error('TEST FAILED:', e.stack || e);
  cleanup().finally(() => pool.end()).finally(() => process.exit(1));
});
