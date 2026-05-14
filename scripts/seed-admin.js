#!/usr/bin/env node
/**
 * Seed the first admin user.
 *
 * Usage:
 *   node scripts/seed-admin.js                       # uses env or prompts? — no, takes flags
 *   node scripts/seed-admin.js --email a@b.com --password 'S3cret!' --name 'Admin'
 *
 * Idempotent on email — if the admin already exists, updates name + password.
 */

require('dotenv').config();

const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const val = argv[i + 1];
    if (!key || !key.startsWith('--')) {
      throw new Error(`Bad flag: ${key}`);
    }
    out[key.slice(2)] = val;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const email = args.email || process.env.SEED_ADMIN_EMAIL;
  const password = args.password || process.env.SEED_ADMIN_PASSWORD;
  const name = args.name || process.env.SEED_ADMIN_NAME || 'Administrator';

  if (!email || !password) {
    console.error('Usage: node scripts/seed-admin.js --email <email> --password <password> [--name <name>]');
    console.error('   or set SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in .env');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nashik_property_deals',
  });

  try {
    const hash = await bcrypt.hash(password, 12);

    const [existing] = await conn.query(
      'SELECT id FROM admins WHERE email = ? AND deleted_at IS NULL LIMIT 1',
      [email],
    );

    if (existing.length > 0) {
      await conn.query(
        'UPDATE admins SET password_hash = ?, full_name = ?, is_active = 1 WHERE id = ?',
        [hash, name, existing[0].id],
      );
      console.log(`Updated admin ${email} (id=${existing[0].id}).`);
    } else {
      const [result] = await conn.query(
        'INSERT INTO admins (email, password_hash, full_name, is_active) VALUES (?, ?, ?, 1)',
        [email, hash, name],
      );
      console.log(`Created admin ${email} (id=${result.insertId}).`);
    }
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
