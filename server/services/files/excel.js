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

function sendXlsxResponse(res, { filename, buffer }) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

module.exports = { buildWorkbook, sendXlsxResponse };
