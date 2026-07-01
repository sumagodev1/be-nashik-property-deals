#!/usr/bin/env node
/**
 * Follow-up to seed_inventory_fill_dynamic.js. That script only populated
 * `kind: 'fields'` sections; contactList and keyPersons stayed empty, so
 * seeded rows displayed a wall of blank input boxes under "Owner Details"
 * and "Key Persons" on the view page.
 *
 * This one walks the same forms.json and, for every form that declares a
 * contactList or keyPersons section, ADDs a demo contact / person to the
 * row's `details.dynamicData`. Shape mirrors what DynamicPropertyForm
 * expects (see `emptyContact` / `emptyKeyPerson`):
 *
 *   contacts:      [{ name, relation, phones:[3], mobiles:[3],
 *                    emails:[3], addresses:[2] }]
 *   referenceSourceOfLead: '<text>'   (when includeReference: true)
 *   keyPersons:    [{ name, relation, phones:[3], mobiles:[3], emails:[3] }]
 *
 * Idempotent — leaves `contacts` / `keyPersons` alone if the row already
 * has at least one entry with a non-empty name.
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

// phones[] is validated with the SAME 10-digit-mobile regex as mobiles[]
// on the server (Backend/server/services/inventory/dynamicDataValidation.js),
// so we cannot put a landline like "0253 2591234" here. Leave phones empty
// and only fill mobiles with a valid 10-digit number.
function demoContact() {
  return {
    name: 'Ramesh Patil',
    relation: 'Owner',
    phones: ['', '', ''],
    mobiles: ['9822012345', '', ''],
    emails: ['ramesh.patil@example.com', '', ''],
    addresses: ['Plot 12, MG Road, Nashik 422001', ''],
  };
}

function demoKeyPerson() {
  return {
    name: 'Suresh Deshmukh',
    relation: 'Site Manager',
    phones: ['', '', ''],
    mobiles: ['9822098765', '', ''],
    emails: ['suresh.d@example.com', '', ''],
  };
}

function hasEntry(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.some((c) => c && typeof c.name === 'string' && c.name.trim() !== '');
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
    let updated = 0;
    let skipped = 0;

    for (const form of FORMS) {
      const hasContactList = (form.sections || []).some((s) => s.kind === 'contactList');
      const hasKeyPersons  = (form.sections || []).some((s) => s.kind === 'keyPersons');
      const hasReference   = (form.sections || []).some((s) => s.kind === 'contactList' && s.title);
      if (!hasContactList && !hasKeyPersons) { skipped += 1; continue; }

      const [rows] = await conn.query(
        `SELECT id, details FROM inventory_properties
          WHERE title = ? AND deleted_at IS NULL LIMIT 1`,
        [form.label],
      );
      if (rows.length === 0) { skipped += 1; continue; }

      let details;
      try { details = rows[0].details ? JSON.parse(rows[0].details) : {}; } catch { details = {}; }
      const dyn = details.dynamicData || {};

      let dirty = false;
      if (hasContactList && !hasEntry(dyn.contacts)) {
        dyn.contacts = [demoContact()];
        if (hasReference && !dyn.referenceSourceOfLead) {
          dyn.referenceSourceOfLead = 'Walk-in inquiry, referred by existing client.';
        }
        dirty = true;
      }
      if (hasKeyPersons && !hasEntry(dyn.keyPersons)) {
        dyn.keyPersons = [demoKeyPerson()];
        dirty = true;
      }

      if (!dirty) { skipped += 1; continue; }

      details.dynamicData = dyn;
      await conn.query(
        `UPDATE inventory_properties SET details = ? WHERE id = ?`,
        [JSON.stringify(details), rows[0].id],
      );
      updated += 1;
      const tags = [
        hasContactList ? 'contacts' : null,
        hasKeyPersons ? 'keyPersons' : null,
      ].filter(Boolean).join('+');
      console.log(`[+] ${form.code.padEnd(30)}  ${tags.padEnd(20)}  → id=${rows[0].id}`);
    }

    console.log('');
    console.log(`Done. Updated ${updated}, skipped ${skipped} (already filled or no contact sections).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Contact fill failed:', err.message);
  process.exit(1);
});
