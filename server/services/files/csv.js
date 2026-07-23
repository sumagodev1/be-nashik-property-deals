/**
 * Shared CSV export utility.
 *
 * Every admin module's `/export.csv` endpoint should go through this file so
 * we have ONE consistent implementation of:
 *   - UTF-8 BOM (`﻿`) so Excel and Google Sheets auto-detect UTF-8 and
 *     don't mangle non-ASCII characters (Marathi, Hindi, extended Latin, ₹).
 *   - Field escaping (quotes-around-strings, doubled internal quotes,
 *     `\r\n` line endings — RFC 4180).
 *   - The same "download filename" HTTP headers as pdf.js / excel.js.
 *
 * Added at T-2026-072 during the "backend-first exports" migration. Before
 * this, every module reinvented its own csvField / string-concat logic and
 * Inventory in particular shipped without a BOM.
 *
 * Usage:
 *
 *   const csv = buildCsv({
 *     headers: ['Property ID', 'Title', 'Owner'],
 *     rows: [
 *       ['NPD-0001', 'Sample flat, नाशिक', 'Rahul'],
 *       ...
 *     ],
 *   });
 *   sendCsvResponse(res, { filename: 'inventory-2026-07-23.csv', body: csv });
 *
 * Or from a column config + object rows (parallels excel.js API):
 *
 *   const csv = buildCsvFromColumns({
 *     columns: [{ label: 'Property ID', key: 'property_code' }, ...],
 *     rows:    [{ property_code: 'NPD-0001', ... }, ...],
 *   });
 */

const BOM = '﻿';

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : (v instanceof Date ? v.toISOString() : String(v));
  // Wrap in quotes if the field contains comma, quote, CR, or LF. Double
  // internal quotes per RFC 4180.
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsv({ headers, rows }) {
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) {
    lines.push(r.map(csvField).join(','));
  }
  return BOM + lines.join('\r\n');
}

function buildCsvFromColumns({ columns, rows }) {
  const headers = columns.map((c) => c.label || c.key);
  const dataRows = rows.map((r) => columns.map((c) => {
    if (typeof c.render === 'function') {
      try { return c.render(r); } catch { return ''; }
    }
    return r[c.key];
  }));
  return buildCsv({ headers, rows: dataRows });
}

function sendCsvResponse(res, { filename, body }) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

module.exports = { buildCsv, buildCsvFromColumns, csvField, sendCsvResponse };
