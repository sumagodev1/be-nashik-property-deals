#!/usr/bin/env node
/**
 * Seeds 22 demo website properties spread across every active property
 * type, with realistic Nashik locations + prices. All inserted as
 * approved + active so they show up on the public site immediately.
 *
 * Idempotent-ish: skips any property whose property_code already exists
 * in the table, so re-running won't duplicate. Re-running with the same
 * inserter is safe.
 *
 * Usage:  node scripts/seed_website_properties.js
 */

require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomSuffix(len = 6) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i += 1) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

const TYPE_CODE = {
  flat: 'APT',
  villa: 'VIL',
  plot: 'PLT',
  shop: 'SHP',
  commercial: 'COM',
  land: 'LND',
  agricultural: 'AGR',
  hostel: 'HST',
  paying_guest: 'PG',
  other: 'OTH',
};

// 22 properties, balanced across every active type.
// Format intentionally tabular so it's easy to scan/edit later.
const PROPS = [
  // ── Flats / Apartments (5) ─────────────────────────────────────────────
  { type: 'flat',         bhk: '2bhk',      txn: 'sale',  title: '2 BHK in Panchavati near temple',     loc: 'Panchavati, Nashik, Maharashtra 422003, India',                                lat: 19.99731, lng: 73.79129, area: 950,   areaUnit: 'sqft', price: 4500000, featured: 1 },
  { type: 'flat',         bhk: '3bhk',      txn: 'sale',  title: '3 BHK premium on Gangapur Road',      loc: 'Gangapur Road, Nashik, Maharashtra 422013, India',                              lat: 20.00100, lng: 73.74600, area: 1450,  areaUnit: 'sqft', price: 9500000, featured: 1 },
  { type: 'flat',         bhk: '1bhk',      txn: 'rent',  title: '1 BHK in College Road',               loc: 'College Road, Nashik, Maharashtra 422005, India',                               lat: 20.00350, lng: 73.78600, area: 580,   areaUnit: 'sqft', price: 12000,   featured: 0 },
  { type: 'flat',         bhk: '2bhk',      txn: 'rent',  title: 'Spacious 2 BHK in Indira Nagar',      loc: 'Indira Nagar, Nashik, Maharashtra 422009, India',                               lat: 19.99020, lng: 73.78400, area: 880,   areaUnit: 'sqft', price: 22000,   featured: 0 },
  { type: 'flat',         bhk: '4bhk',      txn: 'sale',  title: '4 BHK duplex near Anandvalli',        loc: 'Anandvalli, Nashik, Maharashtra 422013, India',                                 lat: 20.00280, lng: 73.72540, area: 2100,  areaUnit: 'sqft', price: 18500000, featured: 1 },

  // ── Villas (2) ──────────────────────────────────────────────────────────
  { type: 'villa',        bhk: '4bhk',      txn: 'sale',  title: 'Independent villa in Mahatma Nagar',  loc: 'Mahatma Nagar, Nashik, Maharashtra 422007, India',                              lat: 19.99820, lng: 73.76910, area: 2800,  areaUnit: 'sqft', price: 25000000, featured: 1 },
  { type: 'villa',        bhk: '3bhk',      txn: 'rent',  title: 'Furnished villa for rent — Tidke',    loc: 'Tidke Colony, Nashik, Maharashtra 422002, India',                               lat: 20.00450, lng: 73.79050, area: 2400,  areaUnit: 'sqft', price: 65000,   featured: 0 },

  // ── Plots (2) ───────────────────────────────────────────────────────────
  { type: 'plot',         bhk: null,        txn: 'sale',  title: 'NA plot in Adgaon — 2400 sq ft',      loc: 'Adgaon, Nashik, Maharashtra 422003, India',                                     lat: 20.04200, lng: 73.81000, area: 2400,  areaUnit: 'sqft', price: 7500000, featured: 0 },
  { type: 'plot',         bhk: null,        txn: 'sale',  title: 'Corner plot in Pathardi Phata',       loc: 'Pathardi Phata, Nashik, Maharashtra 422010, India',                             lat: 19.96050, lng: 73.78680, area: 3000,  areaUnit: 'sqft', price: 9200000, featured: 0 },

  // ── Shops (2) ───────────────────────────────────────────────────────────
  { type: 'shop',         bhk: null,        txn: 'rent',  title: 'Ground-floor shop on M.G. Road',      loc: 'M.G. Road, Nashik, Maharashtra 422001, India',                                  lat: 19.99560, lng: 73.79320, area: 350,   areaUnit: 'sqft', price: 28000,   featured: 1 },
  { type: 'shop',         bhk: null,        txn: 'sale',  title: 'Shop in CIDCO commercial complex',    loc: 'CIDCO, Nashik, Maharashtra 422009, India',                                      lat: 19.96820, lng: 73.74940, area: 480,   areaUnit: 'sqft', price: 5800000, featured: 0 },

  // ── Commercial (2) ─────────────────────────────────────────────────────
  { type: 'commercial',   bhk: null,        txn: 'lease', title: 'Office space in Satpur MIDC',         loc: 'Satpur MIDC, Nashik, Maharashtra 422007, India',                                lat: 20.01500, lng: 73.71200, area: 1800,  areaUnit: 'sqft', price: 75000,   featured: 0 },
  { type: 'commercial',   bhk: null,        txn: 'sale',  title: 'Commercial showroom — Ambad Link Rd', loc: 'Ambad Link Road, Nashik, Maharashtra 422010, India',                            lat: 19.98800, lng: 73.71800, area: 2500,  areaUnit: 'sqft', price: 22000000, featured: 1 },

  // ── Land (2) ────────────────────────────────────────────────────────────
  { type: 'land',         bhk: null,        txn: 'sale',  title: 'Industrial land in Sinnar MIDC',      loc: 'Sinnar MIDC, Nashik, Maharashtra 422103, India',                                lat: 19.84520, lng: 74.00120, area: 1.5,   areaUnit: 'acre', price: 15000000, featured: 0 },
  { type: 'land',         bhk: null,        txn: 'sale',  title: 'NA land near Trimbak Road',           loc: 'Trimbak Road, Nashik, Maharashtra 422213, India',                               lat: 19.94100, lng: 73.69500, area: 0.75,  areaUnit: 'acre', price: 8500000, featured: 0 },

  // ── Agricultural (2) ───────────────────────────────────────────────────
  { type: 'agricultural', bhk: null,        txn: 'sale',  title: 'Agricultural land in Niphad',         loc: 'Niphad, Nashik District, Maharashtra 422303, India',                            lat: 20.07700, lng: 74.10800, area: 5,     areaUnit: 'acre', price: 11000000, featured: 0 },
  { type: 'agricultural', bhk: null,        txn: 'sale',  title: 'Grape farm with borewell — Dindori',  loc: 'Dindori, Nashik District, Maharashtra 422202, India',                           lat: 20.20400, lng: 73.83600, area: 3.5,   areaUnit: 'acre', price: 17500000, featured: 1 },

  // ── Hostel / PG (2) ────────────────────────────────────────────────────
  { type: 'hostel',       bhk: null,        txn: 'rent',  title: 'Boys hostel near KTHM College',       loc: 'Gangapur Road, near KTHM College, Nashik, Maharashtra 422005, India',           lat: 20.00050, lng: 73.75900, area: 4500,  areaUnit: 'sqft', price: 7500,    featured: 0 },
  { type: 'paying_guest', bhk: null,        txn: 'rent',  title: 'Girls PG in Indira Nagar — meals',    loc: 'Indira Nagar, Nashik, Maharashtra 422009, India',                               lat: 19.99100, lng: 73.78500, area: 250,   areaUnit: 'sqft', price: 6500,    featured: 0 },

  // ── Other (3) ──────────────────────────────────────────────────────────
  { type: 'other',        bhk: null,        txn: 'sale',  title: 'Bungalow plot with old structure',    loc: 'Deolali Camp, Nashik, Maharashtra 422401, India',                               lat: 19.95400, lng: 73.83600, area: 1800,  areaUnit: 'sqft', price: 6800000, featured: 0 },
  { type: 'other',        bhk: null,        txn: 'lease', title: 'Warehouse for lease — Ambad',         loc: 'Ambad MIDC, Nashik, Maharashtra 422010, India',                                 lat: 19.99000, lng: 73.71500, area: 5000,  areaUnit: 'sqft', price: 90000,   featured: 0 },
  { type: 'other',        bhk: null,        txn: 'rent',  title: 'Banquet hall in Nashik Road',         loc: 'Nashik Road, Nashik, Maharashtra 422101, India',                                lat: 19.94680, lng: 73.83100, area: 3200,  areaUnit: 'sqft', price: 18000,   featured: 0 },
];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    // Pool of active verified sellers — we'll round-robin so the listings
    // spread across owners (matches a healthy real-world distribution).
    const [sellers] = await conn.query(
      `SELECT id FROM sellers WHERE deleted_at IS NULL AND is_active = 1 AND is_verified = 1 ORDER BY id`,
    );
    if (sellers.length === 0) {
      console.error('No active verified sellers found — cannot seed.');
      process.exit(1);
    }

    const yy = String(new Date().getFullYear()).slice(-2);
    let inserted = 0;
    let skipped = 0;

    for (let i = 0; i < PROPS.length; i += 1) {
      const p = PROPS[i];
      const seller = sellers[i % sellers.length];
      const prefix = TYPE_CODE[p.type] || 'OTH';

      // Unique-code retry loop. Collisions are astronomically unlikely
      // (32^6 ≈ 1B combos) but we keep the same retry pattern as the
      // production code path so the script behaves the same.
      let propertyCode = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = `NSK-${prefix}-${yy}-${randomSuffix()}`;
        const [exists] = await conn.query(
          `SELECT 1 FROM website_properties WHERE property_code = ? LIMIT 1`,
          [candidate],
        );
        if (exists.length === 0) { propertyCode = candidate; break; }
      }
      if (!propertyCode) {
        console.warn(`Could not allocate a unique code for "${p.title}", skipping.`);
        skipped += 1;
        continue;
      }

      const description = `${p.title}. Prime ${p.loc.split(',')[0]} location, well-connected, ready to occupy. Contact via Nashik Property Deals to schedule a site visit.`;

      await conn.query(
        `INSERT INTO website_properties
          (property_code, seller_id, title, description, property_type, transaction_type,
           location, latitude, longitude, area_value, area_unit, bhk, price,
           approval_status, is_active, is_featured, approved_at, approved_by_admin_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1, ?, NOW(), 1)`,
        [
          propertyCode, seller.id, p.title, description, p.type, p.txn,
          p.loc, p.lat, p.lng, p.area, p.areaUnit, p.bhk, p.price,
          p.featured ? 1 : 0,
        ],
      );
      inserted += 1;
      console.log(`[+] ${propertyCode}  ${p.type.padEnd(13)} ${p.txn.padEnd(6)} ${p.title}`);
    }

    console.log('');
    console.log(`Done. Inserted ${inserted}, skipped ${skipped}.`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
