const BE = __dirname + '/';
require(BE + 'node_modules/dotenv').config({ path: BE + '.env' });
const mysql = require(BE + 'node_modules/mysql2/promise');
const { resolvePropertyTypeIdCode, generatePropertyCode } = require(BE + 'server/services/properties/propertyCode');

(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME,
  });

  // Columns that must be supplied: NOT NULL, no default, not auto-increment.
  const [cols] = await c.query(
    `SELECT COLUMN_NAME n, DATA_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME='website_properties'
        AND IS_NULLABLE='NO' AND COLUMN_DEFAULT IS NULL AND EXTRA NOT LIKE '%auto_increment%'`,
    [process.env.DB_NAME]);

  const filler = (t) => {
    if (/int|decimal|double|float/.test(t)) return 0;
    if (/date|time/.test(t)) return '2026-01-01';
    if (/json/.test(t)) return '{}';
    return 'probe';
  };

  const before = (await c.query('SELECT COUNT(*) n FROM website_properties'))[0][0].n;
  console.log('  rows before: ' + before);
  console.log('');

  const CASES = [
    ['plot',     await resolvePropertyTypeIdCode('plot')],
    ['bungalow', await resolvePropertyTypeIdCode('bungalow')],
    ['land',     await resolvePropertyTypeIdCode('land')],
  ];

  for (const [type, idc] of CASES) {
    const code = generatePropertyCode('NSK', idc);
    const names = cols.map(x => x.n);
    const vals = cols.map(x => (x.n === 'property_code' ? code : filler(x.t)));
    await c.query('START TRANSACTION');
    let res;
    try {
      await c.query(
        `INSERT INTO website_properties (${names.map(n => '`' + n + '`').join(',')})
         VALUES (${names.map(() => '?').join(',')})`, vals);
      res = 'INSERT OK';
    } catch (e) {
      res = 'FAILED -> ' + e.code + ': ' + e.message.slice(0, 60);
    }
    await c.query('ROLLBACK');
    console.log('  ' + type.padEnd(18) + code.padEnd(22) + '(' + code.length + ' chars)  ' + res);
  }

  // And the clamp's absolute worst case.
  const worst = generatePropertyCode('AAAAAAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB');
  await c.query('START TRANSACTION');
  let wres;
  try {
    const names = cols.map(x => x.n);
    const vals = cols.map(x => (x.n === 'property_code' ? worst : filler(x.t)));
    await c.query(
      `INSERT INTO website_properties (${names.map(n => '`' + n + '`').join(',')})
       VALUES (${names.map(() => '?').join(',')})`, vals);
    wres = 'INSERT OK';
  } catch (e) { wres = 'FAILED -> ' + e.code; }
  await c.query('ROLLBACK');
  console.log('  ' + 'worst case'.padEnd(18) + worst.padEnd(22) + '(' + worst.length + ' chars)  ' + wres);

  const after = (await c.query('SELECT COUNT(*) n FROM website_properties'))[0][0].n;
  console.log('');
  console.log('  rows after:  ' + after + (before === after ? '   (all probes rolled back, nothing left behind)' : '   ROWS LEAKED'));
  await c.end();
})().catch(e => { console.error('  ' + e.message); process.exit(1); });
