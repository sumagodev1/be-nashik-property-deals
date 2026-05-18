const { HttpError } = require('../../middleware/errors');
const leadsRepo = require('../../db/queries/leads');
const excel = require('../files/excel');
const pdf = require('../files/pdf');

async function listLeads(filters) {
  const { rows, total } = await leadsRepo.list(filters);
  return {
    data: rows.map(toListItem),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / filters.pageSize)),
  };
}

async function getLead(id) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  return toDetail(row);
}

async function updateStatus(id, status) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  await leadsRepo.updateStatus(id, status);
  return getLead(id);
}

async function updateNotes(id, notes) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  await leadsRepo.updateNotes(id, notes);
  return getLead(id);
}

async function removeLead(id) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  await leadsRepo.softDelete(id);
}

// Single source of truth for the Leads report (CSV / XLSX / PDF). Each column
// declares a human-readable label, a key, an extractor, plus per-format hints:
//   - excelText: force the cell to text type so Excel doesn't munch a 10-digit
//                phone number into 9.12E+09 scientific notation.
//   - pdf: width weight + alignment + no-wrap flag for the printed report.
//   - width: column width hint for XLSX (in characters).
const ACTION_LABEL = {
  contact_seller:  'Contact Seller',
  view_location:   'View Location',
  general_enquiry: 'General Enquiry',
};

function formatDateIN(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const LEAD_COLUMNS = [
  { label: 'Sr. No.',  key: 'sr',            width: 8,  pdf: { weight: 0.7, align: 'center' },
    value: (_r, i) => i + 1 },
  { label: 'Date',     key: 'date',          width: 22, pdf: { weight: 1.5 },
    value: (r) => formatDateIN(r.created_at) },
  { label: 'Status',   key: 'status',        width: 12, pdf: { weight: 0.9, align: 'center' },
    value: (r) => r.status === 'new' ? 'New' : r.status === 'contacted' ? 'Contacted' : (r.status || '') },
  { label: 'Action',   key: 'action',        width: 18, pdf: { weight: 1.2 },
    value: (r) => ACTION_LABEL[r.action_type] || r.action_type || '' },
  { label: 'Buyer',    key: 'buyer',         width: 24, pdf: { weight: 1.7 },
    value: (r) => r.buyer_name || '' },
  { label: 'Mobile',   key: 'mobile',        width: 14, excelText: true, pdf: { weight: 1.5, noWrap: true },
    value: (r) => r.buyer_mobile || '' },
  { label: 'Email',    key: 'email',         width: 28, pdf: { weight: 2.2 },
    value: (r) => r.buyer_email || '' },
  { label: 'Property', key: 'propertyCode',  width: 18, excelText: true, pdf: { weight: 1.4, noWrap: true },
    value: (r) => r.property_code || '' },
  { label: 'Title',    key: 'propertyTitle', width: 32, pdf: { weight: 2.4 },
    value: (r) => r.property_title || '' },
  { label: 'Location', key: 'location',      width: 26, pdf: { weight: 2.0 },
    value: (r) => r.property_location || '' },
  { label: 'Message',  key: 'message',       width: 40,
    value: (r) => r.message || '' },
  { label: 'Notes',    key: 'notes',         width: 30,
    value: (r) => r.notes || '' },
];

function prepareLeadReport(rawRows) {
  return rawRows.map((r, i) => {
    const out = {};
    for (const col of LEAD_COLUMNS) out[col.key] = col.value(r, i);
    return out;
  });
}

async function exportCsv(filters) {
  const rows = await leadsRepo.listForExport(filters);
  const data = prepareLeadReport(rows);
  // UTF-8 BOM helps Excel detect the encoding when the user double-clicks the
  // file. Without it, Excel falls back to system locale and Indian characters
  // can break.
  const BOM = '﻿';
  const lines = [LEAD_COLUMNS.map((c) => c.label).join(',')];
  for (const row of data) {
    lines.push(LEAD_COLUMNS.map((col) => csvCell(row[col.key], col)).join(','));
  }
  return BOM + lines.join('\r\n');
}

async function exportXlsx(filters) {
  const rows = await leadsRepo.listForExport(filters);
  const data = prepareLeadReport(rows);
  return excel.buildWorkbookFromColumns({
    sheetName: 'Leads',
    columns: LEAD_COLUMNS.map((c) => ({
      label: c.label,
      key: c.key,
      width: c.width,
      type: c.excelText ? 's' : undefined,
    })),
    rows: data,
  });
}

// PDF only shows the print-friendly columns (no Message / Notes — too verbose).
const LEAD_PDF_KEYS = ['sr', 'date', 'status', 'action', 'buyer', 'mobile', 'email', 'propertyCode', 'propertyTitle', 'location'];
const LEAD_PDF_COLUMNS = LEAD_COLUMNS
  .filter((c) => LEAD_PDF_KEYS.includes(c.key))
  .map((c) => ({ label: c.label, key: c.key, ...(c.pdf || {}) }));

async function exportPdf(filters) {
  const rows = await leadsRepo.listForExport(filters);
  const data = prepareLeadReport(rows);
  return pdf.buildTablePdf({
    title: 'Leads',
    subtitle: `${rows.length} enquiry record${rows.length === 1 ? '' : 's'}`,
    columns: LEAD_PDF_COLUMNS,
    rows: data,
  });
}

function csvCell(value, col) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // For phone / code columns, prefix with =" so Excel keeps the value as text
  // instead of converting to scientific notation. Other readers (pandas etc.)
  // can strip the wrapper trivially.
  if (col.excelText && s !== '') {
    return `="${s.replace(/"/g, '""')}"`;
  }
  // Quote if value contains a delimiter, quote, CR, or LF.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toListItem(row) {
  return {
    id: row.id,
    actionType: row.action_type,
    buyerName: row.buyer_name,
    buyerMobile: row.buyer_mobile,
    buyerEmail: row.buyer_email,
    message: row.message,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    property: {
      id: row.website_property_id,
      code: row.property_code,
      title: row.property_title,
      location: row.property_location,
    },
  };
}

function toDetail(row) {
  return toListItem(row);
}

module.exports = {
  listLeads,
  getLead,
  updateStatus,
  updateNotes,
  removeLead,
  exportCsv,
  exportXlsx,
  exportPdf,
};
