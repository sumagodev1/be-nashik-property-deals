/**
 * Tiny helper around SheetJS for Excel exports. We deliberately keep one
 * sheet per file and rely on the caller to shape the rows — different
 * exporters need different columns.
 */

const XLSX = require('xlsx');

/**
 * Build an .xlsx Buffer from an array of header strings + an array of row
 * arrays. Caller is responsible for stringifying / nulling its own values.
 */
function buildWorkbook({ sheetName = 'Sheet1', headers, rows }) {
  const wb = XLSX.utils.book_new();
  const aoa = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Build an .xlsx Buffer from a column config + object rows. Lets the caller
 * declare per-column cell types so things like phone numbers stay as text
 * (Excel would otherwise auto-convert them to scientific notation).
 *
 * columns: [{ label, key, type?: 's'|'n'|'b'|'d', width? }]
 * rows:    [{ [key]: value }, ...]
 */
function buildWorkbookFromColumns({ sheetName = 'Sheet1', columns, rows }) {
  const wb = XLSX.utils.book_new();
  const aoa = [columns.map((c) => c.label || c.key)];
  for (const row of rows) {
    aoa.push(columns.map((c) => {
      if (typeof c.render === 'function') {
        try {
          const rendered = c.render(row);
          return rendered === null || rendered === undefined ? '' : rendered;
        } catch { return ''; }
      }
      const v = row[c.key];
      return v === null || v === undefined ? '' : v;
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Force per-column cell types (e.g. 's' for phone/code columns so Excel
  // doesn't mangle a 10-digit string into 9.12E+09).
  for (let ci = 0; ci < columns.length; ci += 1) {
    const col = columns[ci];
    if (!col.type) continue;
    for (let ri = 1; ri <= rows.length; ri += 1) {
      const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (ws[ref]) {
        ws[ref].t = col.type;
        if (col.type === 's') ws[ref].v = String(ws[ref].v ?? '');
      }
    }
  }

  // Reasonable column widths.
  ws['!cols'] = columns.map((c) => ({ wch: c.width || 18 }));

  // T-2026-072: freeze the header row so it stays visible when scrolling
  // through large exports. Native SheetJS support via `!freeze` / '!views'.
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!views'] = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];

  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function sendXlsxResponse(res, { filename, buffer }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

module.exports = { buildWorkbook, buildWorkbookFromColumns, sendXlsxResponse };
