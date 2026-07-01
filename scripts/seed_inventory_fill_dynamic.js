#!/usr/bin/env node
/**
 * Backfills every seeded inventory row's `details.dynamicData` with
 * dummy values so opening the form via /admin/inventory/:id/edit shows
 * populated fields instead of a blank form.
 *
 * Reads the resolved form-config JSON produced by
 * `extract_form_fields.mjs` (run that first), then for each row whose
 * (property_type, transaction_variant, title) matches a form, generates
 * a value per field type:
 *
 *   text / textarea       → placeholder phrase
 *   number                → 100 (respecting min if set)
 *   date                  → today (YYYY-MM-DD)
 *   radio                 → first option
 *   select    (master)    → first ACTIVE code from master_lookups
 *   multiSelect (master)  → first 2 ACTIVE codes
 *   dualMode              → { specific: <atom value>, any: '' }
 *   unitNumber            → { value: 100, unit: units[0] }
 *
 * Idempotent — only UPDATEs rows whose current dynamicData is empty.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const FORMS_JSON = path.resolve(__dirname, 'forms.json');
if (!fs.existsSync(FORMS_JSON)) {
  console.error('Missing forms.json — run: node scripts/extract_form_fields.mjs > scripts/forms.json');
  process.exit(1);
}

const FORMS = JSON.parse(fs.readFileSync(FORMS_JSON, 'utf8'));

// Sensible dummy string per field key. Falls back to the label if the key
// isn't in the dictionary — good enough for a smoke-fill.
function dummyForText(field) {
  const key = (field.key || '').toLowerCase();
  const label = field.label || 'Value';
  if (key.includes('address'))     return 'Plot 12, MG Road, Nashik 422001';
  if (key.includes('landmark'))    return 'Near D-Mart';
  if (key.includes('location'))    return 'Nashik';
  if (key.includes('project'))     return 'Sunshine Heights';
  if (key.includes('apartment') || key.includes('society')) return 'Sunshine Heights';
  if (key.includes('hospital'))    return 'Nashik Medicare';
  if (key.includes('agency'))      return 'Nashik Realty Partners';
  if (key.includes('name'))        return `${label} Demo`;
  if (key.includes('description')) return 'Demo record — sample description populated by seed.';
  if (key.includes('gut') || key.includes('surveyno')) return 'GUT-101/A';
  if (key.includes('flatno'))      return 'A-402';
  if (key.includes('phase'))       return 'Phase 1';
  if (key.includes('wing'))        return 'A';
  if (key.includes('age'))         return '5 years';
  if (key.includes('duration') || key.includes('period')) return '11 months';
  if (key.includes('clause'))      return 'Standard terms as per market norms.';
  return `${label} — demo`;
}

const NUM_DEFAULT_BY_KEY_HINT = {
  distance: 500, area: 1000, size: 1000, count: 4, rent: 25000,
  deposit: 100000, budget: 4500000, rate: 5000, subsidy: 0,
  hike: 5, employees: 20, beds: 30, rooms: 10, opd: 100,
};

function dummyForNumber(field) {
  const key = (field.key || '').toLowerCase();
  for (const hint of Object.keys(NUM_DEFAULT_BY_KEY_HINT)) {
    if (key.includes(hint)) {
      const v = NUM_DEFAULT_BY_KEY_HINT[hint];
      return Math.max(v, field.min ?? 0);
    }
  }
  return Math.max(100, field.min ?? 0);
}

async function pickMasterCode(conn, masterKey, cache, limit = 1) {
  if (!masterKey) return limit === 1 ? '' : [];
  if (cache.has(masterKey)) {
    const codes = cache.get(masterKey);
    return limit === 1 ? (codes[0] || '') : codes.slice(0, limit);
  }
  // Legacy masters (property_type, transaction_type, flat_type, status_type)
  // live in dedicated tables; everything else is master_lookups keyed by
  // (master_key, code). Try the generic table first, then the legacy ones.
  let codes = [];
  try {
    const [rows] = await conn.query(
      `SELECT code FROM master_lookups
        WHERE master_key = ? AND is_active = 1
        ORDER BY sort_order, id
        LIMIT 5`,
      [masterKey],
    );
    codes = rows.map((r) => r.code);
  } catch { /* table may not exist locally */ }
  if (codes.length === 0) {
    const table =
      masterKey === 'property_type'    ? 'master_property_types'    :
      masterKey === 'transaction_type' ? 'master_transaction_types' :
      masterKey === 'flat_type'        ? 'master_flat_types'        :
      masterKey === 'status_type'      ? 'master_status_types'      : null;
    if (table) {
      try {
        const [rows] = await conn.query(
          `SELECT code FROM ${table} WHERE is_active = 1 ORDER BY sort_order, id LIMIT 5`,
        );
        codes = rows.map((r) => r.code);
      } catch { /* noop */ }
    }
  }
  cache.set(masterKey, codes);
  return limit === 1 ? (codes[0] || '') : codes.slice(0, limit);
}

// A handful of keys are declared `select` in the form config but validated
// as `codeArray` on the server (dynamicDataValidation.js). Emit a
// single-element array for these so the fill passes backend Joi without
// having to change the form configs.
const CODE_ARRAY_KEYS = new Set([
  'defect', 'defectWillDo', 'defectWillNotDo',
  'defectWillDoCommunity', 'defectWillNotDoCommunity',
  'amenitiesResidential', 'amenitiesCommercial', 'amenitiesPlot',
  'amenitiesHostel', 'amenitiesBunglowFurniture',
  'flatIndoorAmenities', 'flatOutdoorAmenities', 'plotAmenities',
  'sezInfrastructuralFacilities', 'sezFiscalIncentives',
  'industrialPermittedIndustry',
  'allottedAreaToOwner', 'landReservation',
]);

// Keys the server validates strictly as `dualModeShape` — `{ specific, any }`
// object, no scalar alternative. Whatever field type the form config uses,
// the payload MUST be that object shape or Joi rejects with "<key> must be
// of type object". Wrap scalars in the specific slot.
const DUAL_MODE_KEYS = new Set([
  'bunglowType', 'facing', 'age', 'condition',
]);

function wrapDualIfNeeded(fieldKey, value) {
  if (!DUAL_MODE_KEYS.has(fieldKey)) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)
      && 'specific' in value && 'any' in value) {
    return value;
  }
  if (value === '' || value === null || value === undefined) {
    return { specific: '', any: '' };
  }
  return { specific: value, any: '' };
}

async function dummyFieldValue(conn, field, cache) {
  switch (field.type) {
    case 'text':
    case 'textarea':
      return dummyForText(field);
    case 'number':
      return dummyForNumber(field);
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'radio':
      return Array.isArray(field.options) && field.options.length > 0 ? field.options[0] : '';
    case 'select': {
      const code = await pickMasterCode(conn, field.masterKey, cache, 1);
      if (CODE_ARRAY_KEYS.has(field.key)) return code ? [code] : [];
      return code;
    }
    case 'multiSelect':
      return await pickMasterCode(conn, field.masterKey, cache, 2);
    case 'unitNumber': {
      const unit = Array.isArray(field.units) && field.units.length > 0 ? field.units[0] : '';
      return { value: dummyForNumber(field), unit };
    }
    case 'dualMode': {
      // Fill only the "specific" side. Some dualMode fields have a select
      // on specific and a text on any — pick a valid value for whichever
      // atom is on the specific side.
      const spec = field.specific || {};
      let specVal = '';
      if (spec.type === 'select')      specVal = await pickMasterCode(conn, spec.masterKey, cache, 1);
      else if (spec.type === 'radio')  specVal = Array.isArray(spec.options) && spec.options[0];
      else if (spec.type === 'number') specVal = 100;
      else                             specVal = dummyForText({ key: field.key, label: field.label });
      return { specific: specVal || '', any: '' };
    }
    default:
      return '';
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    const masterCache = new Map();
    let updated = 0;
    let skipped = 0;

    for (const form of FORMS) {
      // Locate the row we seeded for this form. The seed uses the form's
      // label as the title and mirrors propertyType + transactionVariant.
      const [rows] = await conn.query(
        `SELECT id, details FROM inventory_properties
          WHERE title = ? AND property_type = ?
            AND (transaction_variant <=> ?) AND deleted_at IS NULL
          LIMIT 1`,
        [form.label, form.propertyType, form.transactionVariant || null],
      );
      if (rows.length === 0) { skipped += 1; continue; }
      const row = rows[0];

      // Parse existing details JSON. Skip if the row was already filled.
      let details;
      try { details = row.details ? JSON.parse(row.details) : {}; } catch { details = {}; }
      if (details.dynamicData && Object.keys(details.dynamicData).length > 3) {
        skipped += 1;
        continue;
      }

      // Walk every field in every 'fields' section and generate a value.
      const dyn = {};
      for (const section of form.sections) {
        if (section.kind !== 'fields' || !Array.isArray(section.fields)) continue;
        for (const field of section.fields) {
          // propertyCode + registrationDate live on the top-level row, not
          // in dynamicData — skip so the form's shadow-key merge stays
          // authoritative.
          if (field.key === 'propertyCode' || field.key === 'registrationDate') continue;
          const raw = await dummyFieldValue(conn, field, masterCache);
          // Some keys (facing / condition / age / bunglowType) are strict
          // dualMode on the server regardless of the form config's field type.
          // Wrap late so the atom-type generation stays generic.
          const val = wrapDualIfNeeded(field.key, raw);
          if (val !== undefined && val !== '') dyn[field.key] = val;
        }
      }
      details.dynamicData = dyn;

      await conn.query(
        `UPDATE inventory_properties SET details = ? WHERE id = ?`,
        [JSON.stringify(details), row.id],
      );
      updated += 1;
      console.log(`[+] ${form.code.padEnd(30)}  ${Object.keys(dyn).length} fields  → id=${row.id}`);
    }

    console.log('');
    console.log(`Done. Updated ${updated}, skipped ${skipped} (no matching row / already filled).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Fill failed:', err.message);
  process.exit(1);
});
