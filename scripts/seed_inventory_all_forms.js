#!/usr/bin/env node
/**
 * Seed one demo inventory property per MD-driven form config (79 total).
 *
 * Reads the Frontend/*FormsConfig.js files as text, extracts every
 * top-level form object (`code` / `label` / `propertyType` /
 * `transactionType` / `transactionVariant`), and INSERTs a corresponding
 * row into inventory_properties.  Each row is fully valid according to
 * the backend Joi shape and can be edited from /admin/inventory/:id/edit
 * to fill in the dynamic details.
 *
 * Idempotent: skips a config whose form_config already exists in the DB.
 *
 * Usage:  node scripts/seed_inventory_all_forms.js
 */

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const CONFIG_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'Frontend',
  'src',
  'admin',
  'pages',
  'Inventory',
  'dynamic',
);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomSuffix(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

// Property-code prefix per property_type. Mirrors the same three-letter
// convention used by Frontend/src/admin/pages/Inventory/propertyCode logic
// so seeded rows blend with organically-created ones.
const TYPE_CODE = {
  bunglow: 'BNG',
  commercial: 'COM',
  flat: 'FLT',
  shop: 'SHP',
  hospital: 'HOS',
  hostel: 'HST',
  industrial_plot: 'IND',
  land: 'LND',
  paying_guest: 'PG',
  plot: 'PLT',
  project: 'PRJ',
  sez: 'SEZ',
  tdr: 'TDR',
  bank_auction: 'BNK',
  pre_leased: 'PLZ',
};

// Baseline sale-price used when the seeded row doesn't derive its own.
// Real transactions will overwrite when the admin edits.
const DEFAULT_PRICE_BY_TXN = {
  sale: 4500000,
  purchase: 4500000,
  rent_in: 25000,
  rent_out: 25000,
  lease_in: 65000,
  lease_out: 65000,
  joint_venture: 12000000,
};

// Nashik locations rotated per row so the map view isn't a single-dot party.
const LOCATIONS = [
  { name: 'Panchavati, Nashik, Maharashtra 422003, India',           lat: 19.99731, lng: 73.79129 },
  { name: 'Gangapur Road, Nashik, Maharashtra 422013, India',        lat: 20.00100, lng: 73.74600 },
  { name: 'College Road, Nashik, Maharashtra 422005, India',         lat: 20.00350, lng: 73.78600 },
  { name: 'Indira Nagar, Nashik, Maharashtra 422009, India',         lat: 19.99020, lng: 73.78400 },
  { name: 'Mahatma Nagar, Nashik, Maharashtra 422007, India',        lat: 19.99820, lng: 73.76910 },
  { name: 'Tidke Colony, Nashik, Maharashtra 422002, India',         lat: 20.00450, lng: 73.79050 },
  { name: 'Adgaon, Nashik, Maharashtra 422003, India',               lat: 20.04200, lng: 73.81000 },
  { name: 'CIDCO, Nashik, Maharashtra 422009, India',                lat: 19.96820, lng: 73.74940 },
  { name: 'Satpur MIDC, Nashik, Maharashtra 422007, India',          lat: 20.01500, lng: 73.71200 },
  { name: 'Ambad MIDC, Nashik, Maharashtra 422010, India',           lat: 19.99000, lng: 73.71500 },
  { name: 'Deolali Camp, Nashik, Maharashtra 422401, India',         lat: 19.95400, lng: 73.83600 },
  { name: 'Nashik Road, Nashik, Maharashtra 422101, India',          lat: 19.94680, lng: 73.83100 },
  { name: 'Anandvalli, Nashik, Maharashtra 422013, India',           lat: 20.00280, lng: 73.72540 },
  { name: 'Sinnar MIDC, Nashik, Maharashtra 422103, India',          lat: 19.84520, lng: 74.00120 },
  { name: 'Niphad, Nashik District, Maharashtra 422303, India',      lat: 20.07700, lng: 74.10800 },
  { name: 'Dindori, Nashik District, Maharashtra 422202, India',     lat: 20.20400, lng: 73.83600 },
];

/**
 * Regex-parse a *FormsConfig.js file as text. Each top-level form object
 * is a bare identifier bound to `const NAME = { code: '...', ... }` or an
 * object spread inside `export default [ ... ]`. Rather than trying to
 * ESM-import the config (which pulls React + Vite + browser deps), we
 * scan for the tuple keys we care about.
 *
 * Returns [{ code, propertyType, transactionType, transactionVariant, label }]
 * in file order.  Ignores commented-out or nested blocks — we anchor on
 * `code: '...',` at column 3 (two-space indent) which is where every
 * config's `code:` line sits.
 */
function extractForms(fileText) {
  // Split into candidate blocks that contain a `code:` line, then pull
  // sibling fields with per-line regex. A form object always contains
  // `code`, `propertyType`, `transactionType`, and `transactionVariant`
  // within a ~30-line window of one another.
  const codeLines = [];
  const lines = fileText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s+code:\s+'([a-z0-9-]+)'/);
    if (m) codeLines.push({ line: i, code: m[1] });
  }

  const forms = [];
  for (const { line, code } of codeLines) {
    const window = lines.slice(Math.max(0, line - 5), line + 40).join('\n');
    const pt = window.match(/propertyType:\s+'([a-z_]+)'/);
    const tt = window.match(/transactionType:\s+'([a-z_]+)'/);
    const tv = window.match(/transactionVariant:\s+'([a-z_]*)'/);
    const lb = window.match(/label:\s+'([^']+)'/);
    // A form config MUST have propertyType + transactionType. If either is
    // missing the block is probably an intermediate object literal (a
    // section, a field, etc.) that shouldn't be seeded.
    if (!pt || !tt) continue;
    forms.push({
      code,
      label: lb ? lb[1] : code,
      propertyType: pt[1],
      transactionType: tt[1],
      transactionVariant: tv ? tv[1] : '',
    });
  }
  return forms;
}

async function main() {
  // 1. Walk config dir and extract every form.
  const files = fs.readdirSync(CONFIG_DIR).filter((f) => /FormsConfig\.js$/.test(f));
  const allForms = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8');
    const forms = extractForms(text);
    console.log(`  ${file.padEnd(35)}  ${forms.length} forms`);
    allForms.push(...forms);
  }
  console.log(`\nTotal forms extracted: ${allForms.length}\n`);

  // 2. Insert one property per form.
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    const yy = String(new Date().getFullYear()).slice(-2);
    let inserted = 0;
    let skipped = 0;

    // `inventory_properties.transaction_type` is a strict ENUM(sale/rent/lease)
    // — codes like `purchase`, `rent_in`, `lease_out`, `joint_venture` won't
    // fit. Existing MD-form rows leave that column empty and store the true
    // code in `transaction_variant`. Mirror that convention.
    const NARROW_TXN_ENUM = new Set(['sale', 'rent', 'lease']);
    function narrowTransactionType(code) {
      if (NARROW_TXN_ENUM.has(code)) return code;
      // Preserve empty (matches how existing MD rows are stored).
      return '';
    }

    for (let i = 0; i < allForms.length; i += 1) {
      const f = allForms[i];
      // Idempotency: match on (property_type, transaction_variant, title)
      // since there's no `form_config` column. Same title implies the same
      // form config was seeded before.
      const [existsRows] = await conn.query(
        `SELECT id FROM inventory_properties
          WHERE title = ? AND property_type = ?
            AND (transaction_variant <=> ?) AND deleted_at IS NULL
          LIMIT 1`,
        [f.label, f.propertyType, f.transactionVariant || null],
      );
      if (existsRows.length > 0) { skipped += 1; continue; }

      // Allocate a unique property_code with retry loop.
      const prefix = TYPE_CODE[f.propertyType] || 'INV';
      let propertyCode = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `NSK-${prefix}-${yy}-${randomSuffix()}`;
        const [exists] = await conn.query(
          `SELECT 1 FROM inventory_properties WHERE property_code = ? LIMIT 1`,
          [candidate],
        );
        if (exists.length === 0) { propertyCode = candidate; break; }
      }
      if (!propertyCode) {
        console.warn(`  ! could not allocate code for ${f.code}`);
        continue;
      }

      const loc = LOCATIONS[i % LOCATIONS.length];
      const price = DEFAULT_PRICE_BY_TXN[f.transactionType] || 4500000;
      const title = f.label || `${f.propertyType} — ${f.transactionType}`;
      const description = `Demo record seeded for form config "${f.code}". Edit to fill in dynamic fields.`;
      const details = JSON.stringify({
        dynamicData: {},
      });
      // The stored property_type must match what a real submit produces so
      // resolveMdFormConfig() can map the row back to its form config on
      // edit. InventoryForm strips " Registration Form" from the picked
      // label before submit (see resolvePropertyTypeLabel) — mirror that
      // here so the resolver's canonical index recognises the value.
      const storedPropertyType = (f.label || f.propertyType).replace(/\s+Registration Form\b/g, '');

      await conn.query(
        `INSERT INTO inventory_properties
          (property_code, title, description, property_type, transaction_type, transaction_variant,
           location, latitude, longitude, area_value, area_unit, price, status,
           registration_date, details, is_draft)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', CURDATE(), ?, 0)`,
        [
          propertyCode, title, description, storedPropertyType,
          narrowTransactionType(f.transactionType), f.transactionVariant || null,
          loc.name, loc.lat, loc.lng, 1000, 'sqft', price,
          details,
        ],
      );
      inserted += 1;
      console.log(`  [+] ${propertyCode}  ${f.code}`);
    }

    console.log('');
    console.log(`Done. Inserted ${inserted}, skipped ${skipped} (already existed).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
