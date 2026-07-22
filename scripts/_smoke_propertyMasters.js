// Standalone smoke test for the centralised property-classification
// validator. Not wired into any test runner - invoke via
// `node scripts/_smoke_propertyMasters.js`. Uses Node's require-cache to
// swap the real DB-backed masters module with an in-memory mock so this
// runs without a DB.
//
// Covers:
//   1. contract map is fixed (regression against the original miswiring)
//   2. per-field routing to the correct master
//   3. ID-first resolution beats a stale/inactive code
//   4. tolerant code normalisation (hyphen / space / case)
//   5. payload gets rewritten with canonical (id, code, label)
//   6. unresolvable non-empty inputs throw a per-field HttpError

const Module = require('module');

// -- In-memory master fixtures roughly matching the real seed data --------
const FIXTURES = {
  property_type: [
    { id: 4,   code: 'flat',                label: 'Flat',                is_active: true  },
    { id: 2,   code: 'bungalow',            label: 'Bungalow',            is_active: true  },
    { id: 105, code: 'paying_guest',        label: 'Paying Guest',        is_active: true  },
    { id: 999, code: 'legacy_gone',         label: 'Legacy',              is_active: false },
  ],
  transaction_type: [
    { id: 1, code: 'sale',         label: 'Sale',         is_active: true },
    { id: 6, code: 'rent_out',     label: 'Rent Out',     is_active: true },
    { id: 9, code: 'paying_guest', label: 'Paying Guest', is_active: true },
  ],
  property_variety: [
    { id: 20, code: 'new',    label: 'New',    is_active: true },
    { id: 10, code: 'resale', label: 'Resale', is_active: true },
  ],
};

function findById(masterKey, id) {
  return FIXTURES[masterKey].find((r) => r.id === Number(id)) || null;
}
function findByCode(masterKey, code) {
  return FIXTURES[masterKey].find((r) => String(r.code).toLowerCase() === String(code).toLowerCase()) || null;
}

// -- Swap the masters management module for a stub that mirrors just the
// slice propertyMasters.js consumes. ------------------------------------
const MASTER_LABELS = { property_type: 'Global / Property Type', transaction_type: 'Global / Transaction Type', property_variety: 'Global / Property Variety' };
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function normaliseMasterCode(code) {
  if (code === undefined || code === null) return '';
  return String(code).trim().toLowerCase().replace(/[\s-]+/g, '_');
}
async function resolveActiveMasterRef(masterKey, { id, code } = {}) {
  const hasId = id !== undefined && id !== null && id !== '' && Number.isInteger(Number(id)) && Number(id) > 0;
  const hasCode = code !== undefined && code !== null && code !== '';
  if (!hasId && !hasCode) return null;
  const label = MASTER_LABELS[masterKey].toLowerCase();
  if (hasId) {
    const byId = findById(masterKey, id);
    if (byId && byId.is_active) return byId;
    if (!hasCode) throw new HttpError(400, 'INVALID_MASTER_CODE', `Unknown or inactive ${label} id: ${id}`);
  }
  let byCode = findByCode(masterKey, code);
  if (!byCode || !byCode.is_active) {
    const n = normaliseMasterCode(code);
    if (n && n !== String(code)) byCode = findByCode(masterKey, n);
  }
  if (byCode && byCode.is_active) return byCode;
  throw new HttpError(400, 'INVALID_MASTER_CODE', `Unknown or inactive ${label}: "${code}"`);
}

const mastersMockPath = require.resolve('../server/services/masters/management.js');
require.cache[mastersMockPath] = {
  id: mastersMockPath,
  filename: mastersMockPath,
  loaded: true,
  exports: { resolveActiveMasterRef, normaliseMasterCode, assertActiveCode: async () => {} },
};

const { validatePropertyClassification, PROPERTY_CLASSIFICATION_MASTERS }
  = require('../server/services/masters/propertyMasters.js');

// -- Assertion helpers ----------------------------------------------------
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n  expected: ${e}\n  got:      ${a}`);
  console.log(`  ok  ${label}`);
}
async function assertThrows(fn, matcher, label) {
  try { await fn(); }
  catch (e) {
    if (!matcher.test(e.message)) throw new Error(`${label}\n  message did not match ${matcher}: ${e.message}`);
    console.log(`  ok  ${label}`);
    return;
  }
  throw new Error(`${label}\n  expected throw, none raised`);
}

// -- Cases ---------------------------------------------------------------
(async () => {
  // Contract map — kills the original miswiring at the source.
  assertEqual(
    PROPERTY_CLASSIFICATION_MASTERS,
    { propertyType: 'property_type', transactionType: 'transaction_type', transactionVariant: 'property_variety' },
    'PROPERTY_CLASSIFICATION_MASTERS map',
  );

  // 1. Correct per-field routing + payload rewrite.
  const p1 = { propertyType: 'flat', transactionType: 'sale', transactionVariant: 'new' };
  await validatePropertyClassification(p1);
  assertEqual(
    { pt: p1.propertyType, ptId: p1.propertyTypeId, ptName: p1.propertyTypeName,
      tt: p1.transactionType, ttId: p1.transactionTypeId, ttName: p1.transactionTypeName,
      tv: p1.transactionVariant, tvId: p1.propertyVarietyId, tvName: p1.propertyVarietyName },
    { pt: 'flat', ptId: 4, ptName: 'Flat',
      tt: 'sale', ttId: 1, ttName: 'Sale',
      tv: 'new',  tvId: 20, tvName: 'New' },
    'payload rewritten with canonical (code, id, label)',
  );

  // 2. ID-first: bogus code but a valid ID → resolves via ID.
  const p2 = { propertyType: 'THIS_IS_WRONG', propertyTypeId: 2 };
  await validatePropertyClassification(p2);
  assertEqual(
    { pt: p2.propertyType, ptId: p2.propertyTypeId, ptName: p2.propertyTypeName },
    { pt: 'bungalow', ptId: 2, ptName: 'Bungalow' },
    'ID beats bogus code — value healed to canonical from the ID',
  );

  // 3. Normalisation: 'Paying-Guest' / 'PAYING GUEST' / 'paying guest' → paying_guest.
  for (const spelling of ['Paying-Guest', 'PAYING GUEST', 'paying guest', 'Paying_Guest']) {
    const p = { propertyType: spelling };
    await validatePropertyClassification(p);
    assertEqual(
      p.propertyType, 'paying_guest',
      `normalised code "${spelling}" → paying_guest`,
    );
  }

  // 4. Regression: transactionVariant='new' MUST resolve against property_variety,
  //    not transaction_type (the original T-2026 bug).
  const p4 = { transactionVariant: 'new' };
  await validatePropertyClassification(p4);
  assertEqual(
    p4.transactionVariant, 'new',
    'transactionVariant "new" resolves via property_variety master',
  );
  assertEqual(p4.propertyVarietyId, 20, 'propertyVarietyId populated from resolver');

  // 5. Empty inputs → no-op.
  const p5 = { propertyType: '', transactionType: null };
  await validatePropertyClassification(p5);
  assertEqual(
    { pt: p5.propertyType, ptId: p5.propertyTypeId, tt: p5.transactionType, ttId: p5.transactionTypeId },
    { pt: '', ptId: undefined, tt: null, ttId: undefined },
    'empty inputs stay empty, no id backfill',
  );

  // 6. Unresolvable non-empty code → HttpError with per-field message.
  await assertThrows(
    () => validatePropertyClassification({ propertyType: 'no_such_property_type' }),
    /property type.*no_such_property_type/i,
    'unknown property type → per-field error',
  );
  await assertThrows(
    () => validatePropertyClassification({ transactionType: 'no_such_txn' }),
    /transaction type.*no_such_txn/i,
    'unknown transaction type → per-field error',
  );
  await assertThrows(
    () => validatePropertyClassification({ transactionVariant: 'no_such_variety' }),
    /property variety.*no_such_variety/i,
    'unknown property variety → per-field error',
  );

  // 7. Stale ID → recovers if code is also supplied.
  const p7 = { propertyType: 'flat', propertyTypeId: 999 }; // 999 is inactive Legacy
  await validatePropertyClassification(p7);
  assertEqual(
    { pt: p7.propertyType, ptId: p7.propertyTypeId },
    { pt: 'flat', ptId: 4 },
    'stale id + valid code → recovers, id and code both healed',
  );

  console.log('\nAll smoke checks passed.');
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
