/**
 * Tiny helper around PDFKit for table-style exports.
 *
 * Usage:
 *   const buffer = await buildTablePdf({
 *     title: 'Leads',
 *     subtitle: 'All non-deleted enquiries',
 *     columns: [
 *       { label: 'Date',     key: 'date',  weight: 2 },
 *       { label: 'Status',   key: 'status', weight: 1, align: 'center' },
 *       { label: 'Buyer',    key: 'buyer', weight: 3 },
 *       ...
 *     ],
 *     rows: [
 *       { date: '15/05/2026 09:36', status: 'New', buyer: 'Keshav', ... },
 *       ...
 *     ],
 *   });
 *
 * `weight` is a relative number — wider columns get a bigger share of the
 * usable page width. If omitted, defaults to 1.
 */

const PDFDocument = require('pdfkit');

const NAVY = '#255593';
const GOLD = '#daa13b';
const GRAY_900 = '#0c1119';
const GRAY_700 = '#29323e';
const GRAY_500 = '#5d6878';
const GRAY_300 = '#c0c8d2';
const GRAY_100 = '#eaeef2';
const GRAY_50 = '#f5f7f9';

const ZEBRA = '#fbfcfd';

function buildTablePdf({
  title = 'Export',
  subtitle = '',
  columns,
  rows,
  brandName = 'Nasik Property Deals',
  pageSize = 'A4',
  landscape = true,
}) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('buildTablePdf: columns array is required');
  }
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: pageSize,
      layout: landscape ? 'landscape' : 'portrait',
      margin: 36,
      bufferPages: true,
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawHeader(doc, { title, subtitle, brandName });
    drawTable(doc, { columns, rows });
    drawFooter(doc, { brandName });

    doc.end();
  });
}

function drawHeader(doc, { title, subtitle, brandName }) {
  // Brand bar
  doc.rect(36, 36, doc.page.width - 72, 30).fill(NAVY);
  doc
    .fillColor('white')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(brandName, 48, 45, { align: 'left' });
  doc
    .fillColor('white')
    .font('Helvetica')
    .fontSize(9)
    .text(formatNow(), 48, 47, {
      width: doc.page.width - 96,
      align: 'right',
    });

  // Title
  doc.fillColor(GRAY_900).font('Helvetica-Bold').fontSize(18).text(title, 36, 82);
  if (subtitle) {
    doc.fillColor(GRAY_500).font('Helvetica').fontSize(10).text(subtitle, 36, 106);
  }
  doc.moveTo(36, 126).lineTo(76, 126).lineWidth(2).strokeColor(GOLD).stroke();
  doc.y = 140;
}

function drawTable(doc, { columns, rows }) {
  const startX = 36;
  const usable = doc.page.width - 72;
  const widths = allocateWidths(columns, usable);

  drawHeaderRow(doc, { columns, widths, startX });

  for (let i = 0; i < rows.length; i += 1) {
    if (doc.y + 24 > doc.page.height - 56) {
      doc.addPage();
      drawHeaderRow(doc, { columns, widths, startX });
    }
    drawDataRow(doc, { columns, widths, startX, row: rows[i], stripe: i % 2 === 1 });
  }
}

function drawHeaderRow(doc, { columns, widths, startX }) {
  const rowY = doc.y;
  const rowHeight = 26;
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  doc.rect(startX, rowY, totalWidth, rowHeight).fill(GRAY_50);

  let x = startX;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_700);
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i];
    doc.text(String(col.label || col.key || ''), x + 6, rowY + 9, {
      width: widths[i] - 12,
      ellipsis: true,
      align: col.headerAlign || 'left',
    });
    x += widths[i];
  }

  doc
    .moveTo(startX, rowY + rowHeight)
    .lineTo(startX + totalWidth, rowY + rowHeight)
    .lineWidth(0.5)
    .strokeColor(GRAY_300)
    .stroke();

  doc.y = rowY + rowHeight + 2;
}

function drawDataRow(doc, { columns, widths, startX, row, stripe }) {
  const rowY = doc.y;
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  // Compute the row height by measuring the tallest wrapped cell.
  // Single-line columns (noWrap) don't contribute to row growth.
  doc.font('Helvetica').fontSize(9);
  let rowHeight = 18;
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i];
    if (col.noWrap) continue;
    const text = stringify(row[col.key]);
    const h = doc.heightOfString(text, { width: widths[i] - 12 });
    if (h + 10 > rowHeight) rowHeight = Math.min(h + 10, 70);
  }

  if (stripe) {
    doc.rect(startX, rowY, totalWidth, rowHeight).fill(ZEBRA);
  }

  let x = startX;
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i];
    const text = stringify(row[col.key]);
    doc
      .fillColor(GRAY_900)
      .font('Helvetica')
      .fontSize(9)
      .text(text, x + 6, rowY + 6, {
        width: widths[i] - 12,
        ellipsis: true,
        lineBreak: col.noWrap ? false : true,
        height: rowHeight - 8,
        align: col.align || 'left',
      });
    x += widths[i];
  }

  doc
    .moveTo(startX, rowY + rowHeight)
    .lineTo(startX + totalWidth, rowY + rowHeight)
    .lineWidth(0.3)
    .strokeColor(GRAY_100)
    .stroke();

  doc.y = rowY + rowHeight + 1;
}

function drawFooter(doc, { brandName }) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    const y = doc.page.height - 30;
    doc
      .fillColor(GRAY_500)
      .font('Helvetica')
      .fontSize(8)
      .text(`${brandName} · Confidential`, 36, y, {
        width: doc.page.width - 72,
        align: 'left',
      });
    doc.text(`Page ${i + 1} of ${range.count}`, 36, y, {
      width: doc.page.width - 72,
      align: 'right',
    });
  }
}

// Allocate column widths by relative `weight`. Columns without weight get 1.
function allocateWidths(columns, usable) {
  const weights = columns.map((c) => Math.max(0.2, Number(c.weight) || 1));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.floor((w / total) * usable));
}

function stringify(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toLocaleString('en-IN');
  return String(value);
}

function formatNow() {
  return new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sendPdfResponse(res, { filename, buffer }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

module.exports = { buildTablePdf, sendPdfResponse };
