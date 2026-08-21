#!/usr/bin/env node
/**
 * Seed demo photos onto the seeded website listings that have none.
 *
 * WHY
 * ---
 * Website properties #24-#35 were seeded without any images. The public site
 * falls back to one bundled placeholder when `images` is empty, so every one of
 * those listings rendered the same picture. This gives each a photo that suits
 * its property type.
 *
 * LICENSING
 * ---------
 * Every image is served from the Unsplash CDN and used under the Unsplash
 * License, which permits commercial use with no attribution and no permission
 * required. See https://unsplash.com/license.
 *
 * THESE ARE NOT PHOTOGRAPHS OF THE ACTUAL PROPERTIES. They are stock imagery
 * standing in for demo rows. Do NOT point this script at a listing a real
 * seller posted — a buyer would read the photo as the property itself.
 *
 * SAFETY
 * ------
 *   * Only the property IDs listed in TARGETS are touched.
 *   * A property that already has images is skipped, so re-running is a no-op
 *     and a real upload can never be overwritten.
 *   * Nothing is deleted. Files and rows are written through the same
 *     persistImages() service the upload API uses, so the per-file size check,
 *     MIME sniffing, image cap, storage quota and sort ordering all still apply.
 *
 * USAGE
 *   node scripts/seed-demo-property-images.js           # apply
 *   node scripts/seed-demo-property-images.js --dry-run # report only
 */

require('dotenv').config();

const https = require('https');
const { persistImages } = require('../server/services/files/imageUpload');
const propertyFiles = require('../server/db/queries/property_files');
const { pool } = require('../server/db/pool');

const DRY_RUN = process.argv.includes('--dry-run');
const PROPERTY_KIND = 'website';

// Unsplash CDN base URLs. Rendered at a sane listing size rather than full
// resolution: ~1600px wide JPEG lands well under the per-file limit.
const RENDER = '?auto=format&fit=crop&w=1600&q=80&fm=jpg';

const TARGETS = [
  { id: 24, label: 'Shop in CIDCO commercial complex',   photo: 'photo-1764795850238-7a024db5e3ee', alt: 'Modern retail store interior' },
  { id: 25, label: 'Office space in Satpur MIDC',        photo: 'photo-1631193816258-28b44b21e78b', alt: 'Open plan office with rows of desks' },
  { id: 26, label: 'Commercial showroom Ambad Link Rd',  photo: 'photo-1759050486852-fdfe2fdc7bea', alt: 'Modern showroom with arched ceiling' },
  { id: 27, label: 'Industrial land in Sinnar MIDC',     photo: 'photo-1421878615130-7c5243914117', alt: 'Open land with power transmission tower' },
  { id: 28, label: 'NA land near Trimbak Road',          photo: 'photo-1651769005074-2ef5c6f74276', alt: 'Large open field' },
  { id: 29, label: 'Agricultural land in Niphad',        photo: 'photo-1598890283065-5577e2c31661', alt: 'Ploughed field under blue sky' },
  { id: 30, label: 'Grape farm with borewell Dindori',   photo: 'photo-1563514227147-6d2ff665a6a0', alt: 'Rows of grapevines in a vineyard' },
  { id: 31, label: 'Boys hostel near KTHM College',      photo: 'photo-1709805619372-40de3f158e83', alt: 'Dormitory room with bunk beds' },
  { id: 32, label: 'Girls PG in Indira Nagar',           photo: 'photo-1781415980730-bfcf192e38bc', alt: 'Clean room with neatly made beds' },
  { id: 33, label: 'Bungalow plot with old structure',   photo: 'photo-1632097934242-b0395012f7eb', alt: 'Old structure with door and window' },
  { id: 35, label: 'Banquet hall in Nashik Road',        photo: 'photo-1759477274116-e3cb02d2b9d8', alt: 'Empty banquet hall with round tables' },
];

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'npd-demo-image-seed' } }, (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft === 0) return reject(new Error('too many redirects'));
          return resolve(download(headers.location, redirectsLeft - 1));
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

(async () => {
  console.log(DRY_RUN ? '\n  DRY RUN — nothing will be written\n' : '\n  Seeding demo images\n');

  let seeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of TARGETS) {
    const existing = await propertyFiles.listForProperty(null, PROPERTY_KIND, t.id);
    if (existing.length > 0) {
      console.log(`  skip   #${t.id}  ${t.label} — already has ${existing.length} image(s)`);
      skipped += 1;
      continue;
    }

    try {
      const buffer = await download(`https://images.unsplash.com/${t.photo}${RENDER}`);
      const originalname = `${t.alt.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.jpg`;

      if (DRY_RUN) {
        console.log(`  would  #${t.id}  ${t.label} — ${originalname} (${Math.round(buffer.length / 1024)} KB)`);
        seeded += 1;
        continue;
      }

      await persistImages({
        propertyKind: PROPERTY_KIND,
        propertyId: t.id,
        files: [{ buffer, originalname, size: buffer.length }],
      });
      console.log(`  ok     #${t.id}  ${t.label} — ${originalname} (${Math.round(buffer.length / 1024)} KB)`);
      seeded += 1;
    } catch (err) {
      console.log(`  FAIL   #${t.id}  ${t.label} — ${err.message}`);
      failed += 1;
    }
  }

  console.log(`\n  ${DRY_RUN ? 'would seed' : 'seeded'}: ${seeded}   skipped: ${skipped}   failed: ${failed}\n`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('  THREW: ' + (err.sqlMessage || err.message));
  process.exit(1);
});
