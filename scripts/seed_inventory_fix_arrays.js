#!/usr/bin/env node
/**
 * One-shot fixer for seeded rows produced by
 * seed_inventory_fill_dynamic.js + seed_inventory_fill_contacts.js.
 *
 * Two issues surfaced by backend validation on Save:
 *
 *   1. `allottedAreaToOwner` (and 17 other keys) are `codeArray` on the
 *      server but the form config declares them as `select` — my fill
 *      wrote a plain string. Server Joi rejects with
 *      "allottedAreaToOwner must be an array". Wrap any of these keys'
 *      string values in `[value]`.
 *
 *   2. `contacts[i].phones[j]` uses the SAME 10-digit-mobile regex as
 *      `mobiles[j]` — my seed put "0253 2591234" (landline w/ space) in
 *      phones[0]. Server rejects with "Enter a valid 10-digit mobile".
 *      Empty out phones[]; mobiles[] already carries a valid number.
 *
 * Idempotent — noop if the values are already correct shape.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

// Keys the server validates as Joi array — copied from
// Backend/server/services/inventory/dynamicDataValidation.js
// so we can promote scalar seed values to single-element arrays without
// touching the form configs (which declare some of them as `select`).
const CODE_ARRAY_KEYS = new Set([
  'defect',
  'defectWillDo',
  'defectWillNotDo',
  'defectWillDoCommunity',
  'defectWillNotDoCommunity',
  'amenitiesResidential',
  'amenitiesCommercial',
  'amenitiesPlot',
  'amenitiesHostel',
  'amenitiesBunglowFurniture',
  'flatIndoorAmenities',
  'flatOutdoorAmenities',
  'plotAmenities',
  'sezInfrastructuralFacilities',
  'sezFiscalIncentives',
  'industrialPermittedIndustry',
  'allottedAreaToOwner',
  'landReservation',
]);

// Keys the server validates as `dualModeShape` (a strict `{ specific, any }`
// object with no alternatives). If the form config declared them as `select`
// / `radio` / `text`, the fill wrote a bare scalar which the backend rejects
// with "<key> must be of type object". Wrap in the dualMode object.
const DUAL_MODE_KEYS = new Set([
  'bunglowType',
  'facing',
  'age',
  'condition',
]);

function normaliseArrayKeys(dyn) {
  let touched = false;
  for (const k of Object.keys(dyn)) {
    if (!CODE_ARRAY_KEYS.has(k)) continue;
    const v = dyn[k];
    if (Array.isArray(v)) continue;
    if (v === null || v === undefined || v === '') { dyn[k] = []; touched = true; continue; }
    dyn[k] = [v];
    touched = true;
  }
  return touched;
}

function isDualModeShape(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    && Object.prototype.hasOwnProperty.call(v, 'specific')
    && Object.prototype.hasOwnProperty.call(v, 'any');
}

function normaliseDualModeKeys(dyn) {
  let touched = false;
  for (const k of Object.keys(dyn)) {
    if (!DUAL_MODE_KEYS.has(k)) continue;
    const v = dyn[k];
    if (isDualModeShape(v)) continue;
    // Bare scalar → promote to dualMode object. Empty string / null becomes
    // an empty dualMode object (both slots empty), which passes Joi as an
    // optional-but-shape-required field.
    if (v === null || v === undefined || v === '') {
      dyn[k] = { specific: '', any: '' };
    } else {
      dyn[k] = { specific: v, any: '' };
    }
    touched = true;
  }
  return touched;
}

function normaliseContactPhones(dyn) {
  let touched = false;
  const list = Array.isArray(dyn.contacts) ? dyn.contacts : null;
  if (!list) return false;
  for (const c of list) {
    if (!c || !Array.isArray(c.phones)) continue;
    // Blank every phones slot — the backend uses the same 10-digit-mobile
    // regex on this array as on mobiles, so a landline like "0253 2591234"
    // fails validation. Real callers can fill it later if needed.
    const cleared = c.phones.map(() => '');
    if (JSON.stringify(cleared) !== JSON.stringify(c.phones)) {
      c.phones = cleared;
      touched = true;
    }
  }
  const kp = Array.isArray(dyn.keyPersons) ? dyn.keyPersons : null;
  if (kp) {
    for (const p of kp) {
      if (!p || !Array.isArray(p.phones)) continue;
      const cleared = p.phones.map(() => '');
      if (JSON.stringify(cleared) !== JSON.stringify(p.phones)) {
        p.phones = cleared;
        touched = true;
      }
    }
  }
  return touched;
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
    const [rows] = await conn.query(
      `SELECT id, property_code, details FROM inventory_properties
        WHERE description LIKE 'Demo record seeded for form config%'
          AND deleted_at IS NULL`,
    );
    let updated = 0;
    let unchanged = 0;
    for (const r of rows) {
      let details;
      try { details = r.details ? JSON.parse(r.details) : {}; } catch { details = {}; }
      const dyn = details.dynamicData || {};
      const a = normaliseArrayKeys(dyn);
      const b = normaliseContactPhones(dyn);
      const c = normaliseDualModeKeys(dyn);
      if (!a && !b && !c) { unchanged += 1; continue; }
      details.dynamicData = dyn;
      await conn.query(
        `UPDATE inventory_properties SET details = ? WHERE id = ?`,
        [JSON.stringify(details), r.id],
      );
      updated += 1;
      const notes = [
        a ? 'arrays' : null,
        b ? 'phones' : null,
        c ? 'dualMode' : null,
      ].filter(Boolean).join('+');
      console.log(`[+] ${r.property_code}  ${notes}  → id=${r.id}`);
    }
    console.log('');
    console.log(`Done. Fixed ${updated}, unchanged ${unchanged} (already correct).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => { console.error('Fix failed:', err.message); process.exit(1); });
