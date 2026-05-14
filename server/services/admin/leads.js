const { HttpError } = require('../../middleware/errors');
const leadsRepo = require('../../db/queries/leads');
const excel = require('../files/excel');

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

const LEAD_HEADERS = [
  'lead_id', 'created_at', 'status', 'action_type',
  'buyer_name', 'buyer_mobile', 'buyer_email', 'message',
  'property_code', 'property_title', 'property_location',
  'notes',
];

function leadRowValues(r) {
  return [
    r.id,
    r.created_at,
    r.status,
    r.action_type,
    r.buyer_name || '',
    r.buyer_mobile || '',
    r.buyer_email || '',
    r.message || '',
    r.property_code || '',
    r.property_title || '',
    r.property_location || '',
    r.notes || '',
  ];
}

async function exportCsv(filters) {
  const rows = await leadsRepo.listForExport(filters);
  const lines = [LEAD_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(leadRowValues(r).map(csvField).join(','));
  }
  return lines.join('\r\n');
}

async function exportXlsx(filters) {
  const rows = await leadsRepo.listForExport(filters);
  return excel.buildWorkbook({
    sheetName: 'Leads',
    headers: LEAD_HEADERS,
    rows: rows.map(leadRowValues),
  });
}

function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
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
};
