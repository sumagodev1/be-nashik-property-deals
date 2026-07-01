const { HttpError } = require('../../middleware/errors');
const leadsRepo = require('../../db/queries/leads');
const subAdminsRepo = require('../../db/queries/sub_admins');
const notificationsRepo = require('../../db/queries/notifications');
const wpRepo = require('../../db/queries/website_properties');
const excel = require('../files/excel');
const pdf = require('../files/pdf');
const { trySendMail } = require('../email/transporter');
const { renderEmail, sectionTitle, kvRow, kvTable, infoCard, quoteBlock, BRAND } = require('../email/emailTemplate');
const audit = require('./audit');
const { MODULES } = require('../../constants/modules');

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

// Defines which transitions are legal in the lead pipeline. Closed lanes
// are terminal — once a lead is won or lost you can't bump it back up.
// "new" is the entry state; anything else can move forward to any later
// pipeline stage but not regress to "new".
const LEAD_TERMINAL_STATUSES = new Set(['closed_won', 'closed_lost']);

async function updateStatus(id, status, req = null) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  if (LEAD_TERMINAL_STATUSES.has(row.status) && row.status !== status) {
    throw new HttpError(
      409,
      'LEAD_STATUS_LOCKED',
      'This lead is closed and cannot be reopened. Create a new lead instead.',
    );
  }
  if (row.status !== 'new' && status === 'new') {
    throw new HttpError(
      409,
      'LEAD_STATUS_LOCKED',
      'A lead that has moved past "New" cannot be reset.',
    );
  }
  await leadsRepo.updateStatus(id, status);

  if (req) {
    void audit.record(req, {
      action: 'lead.status.changed',
      entityType: 'lead',
      entityId: id,
      summary: `Lead #${id} status: ${row.status} → ${status}`,
      metadata: {
        from: row.status,
        to: status,
        // `entityLabel` is the canonical "human name" for this entity in
        // the audit UI's Entity column. For leads we pick the buyer name;
        // the column renders this in place of the raw `#id`.
        entityLabel: row.buyer_name,
        entitySubLabel: row.buyer_mobile,
        buyerName: row.buyer_name,
        buyerMobile: row.buyer_mobile,
        propertyCode: row.property_code,
      },
    });
  }

  // closed_won side effects — the deal is done, so (a) take the property
  // off the public site and (b) close every other open lead on the same
  // property as "lost" so the pipeline doesn't keep showing dead buyers.
  // General enquiries (no website_property_id) skip both.
  if (status === 'closed_won' && row.status !== 'closed_won' && row.website_property_id) {
    const closedCount = await leadsRepo.closeSiblingsAsLost(row.website_property_id, id);
    await wpRepo.setActive(row.website_property_id, false);
    if (req) {
      void audit.record(req, {
        action: 'property.deactivated.sold',
        entityType: 'website_property',
        entityId: row.website_property_id,
        summary: `Property ${row.property_code || `#${row.website_property_id}`} taken off market (lead #${id} closed won)`,
        metadata: {
          reason: 'closed_won',
          triggeringLeadId: id,
          siblingLeadsClosed: closedCount,
          entityLabel: row.property_code,
        },
      });
    }
  }

  // Notify the seller when a lead first moves to "contacted" — closes the
  // loop so the seller knows the admin team is actively engaging the buyer.
  // Skipped for general enquiries (no property → no seller). Same fire-and-
  // forget pattern as lead notifications: trySendMail enqueues on failure,
  // never throws back to the caller.
  if (row.status !== 'contacted' && status === 'contacted') {
    void notifySellerLeadContacted(id).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[lead-contacted] seller notification failed:', err.message);
    });
  }

  return getLead(id);
}

async function notifySellerLeadContacted(leadId) {
  const seller = await leadsRepo.findSellerForLead(leadId);
  if (!seller || !seller.seller_email) return;
  const lead = await leadsRepo.findById(leadId);
  const enquiryWhen = lead?.created_at ? new Date(lead.created_at).toLocaleString('en-IN') : '—';
  const subject = `[Update] We've contacted a buyer for your listing ${seller.property_code}`;
  const text = [
    `Hi ${seller.seller_name},`,
    '',
    `Good news — our team has just reached out to a buyer who enquired about your listing.`,
    '',
    `Property: ${seller.property_code} — ${seller.property_title}`,
    `Enquiry received on: ${enquiryWhen}`,
    '',
    `We'll let you know if the conversation progresses to a site visit.`,
    '',
    `— Nashik Property Deals team`,
  ].join('\n');
  const html = renderEmail({
    preheader: `We've contacted a buyer for ${seller.property_code}`,
    title: `Hi ${seller.seller_name}, a buyer enquiry is being handled`,
    intro: 'Good news — our team has just reached out to a buyer who enquired about your listing. We\'ll let you know if the conversation progresses to a site visit.',
    bodyHtml: `
      ${infoCard({
        eyebrow: 'Your listing',
        title: seller.property_code,
        subtitle: seller.property_title,
        accent: BRAND.brand,
      })}
      ${sectionTitle('Enquiry details')}
      ${kvTable(
        kvRow('Received on', enquiryWhen) +
        kvRow('Status', 'Contacted by admin team')
      )}
    `,
    accentColor: BRAND.primary,
    footerNote: `You're receiving this because you own listing ${seller.property_code}.`,
  });
  await trySendMail({ to: seller.seller_email, subject, text, html });
}

async function updateAssignment(id, assignedSubAdminId, req = null) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  let assignable = null;
  if (assignedSubAdminId) {
    // Verify the target sub-admin exists, is active, and has lead access.
    assignable = await subAdminsRepo.listAssignableForLeads();
    if (!assignable.some((sa) => sa.id === Number(assignedSubAdminId))) {
      throw new HttpError(
        400,
        'INVALID_ASSIGNEE',
        'Selected user is not an active sub-admin with lead access.',
      );
    }
  }
  await leadsRepo.updateAssignment(id, assignedSubAdminId);

  // Resolve names once — reused by audit log AND the assignee notification.
  // findById accepts an inactive / soft-deleted sub admin too, so a
  // reassignment that moved a lead away from a now-deleted person still
  // shows the right name in the audit log.
  const fromName = row.assigned_sub_admin_id
    ? (await subAdminsRepo.findById(row.assigned_sub_admin_id))?.full_name || null
    : null;
  const newAssignee = assignedSubAdminId
    ? ((assignable && assignable.find((sa) => sa.id === Number(assignedSubAdminId))) ||
       (await subAdminsRepo.findById(assignedSubAdminId)) ||
       null)
    : null;
  const toName = newAssignee?.full_name || newAssignee?.name || null;
  const toEmail = newAssignee?.email || null;

  if (req) {
    void audit.record(req, {
      action: 'lead.assigned',
      entityType: 'lead',
      entityId: id,
      summary: `Lead #${id} reassigned`,
      metadata: {
        from: row.assigned_sub_admin_id,
        to: assignedSubAdminId,
        fromName,
        toName,
        entityLabel: row.buyer_name,
        entitySubLabel: row.buyer_mobile,
        buyerName: row.buyer_name,
        buyerMobile: row.buyer_mobile,
      },
    });
  }

  // Notify the new assignee — only on an actual reassignment (not when
  // unassigning, and not when re-saving the same assignee). Fire-and-forget
  // so a notification hiccup never blocks the assignment itself.
  if (
    assignedSubAdminId &&
    Number(assignedSubAdminId) !== Number(row.assigned_sub_admin_id)
  ) {
    void notifyAssignee({
      leadId: id,
      lead: row,
      assigneeId: Number(assignedSubAdminId),
      assigneeName: toName,
      assigneeEmail: toEmail,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[lead-assigned] notify failed:', err.message);
    });
  }

  return getLead(id);
}

/**
 * Tell the new assignee they were just handed a lead — both via an
 * in-system notification (bell icon) AND an email. Best-effort; never
 * throws back to the caller.
 */
async function notifyAssignee({ leadId, lead, assigneeId, assigneeName, assigneeEmail }) {
  const buyer = lead?.buyer_name || 'a buyer';
  const propertyTag = lead?.property_code
    ? `${lead.property_code} — ${lead.property_title || ''}`.trim()
    : 'General enquiry';
  const title = `New lead assigned to you: ${buyer}`;
  const body = `${buyer} (${lead?.buyer_mobile || '—'}) is now your lead. Property: ${propertyTag}.`;

  try {
    await notificationsRepo.create({
      kind: 'lead.assigned',
      title,
      body,
      relatedKind: 'lead',
      relatedId: leadId,
      moduleKey: MODULES.LEAD_MANAGEMENT,
      // Privately targeted — only this sub-admin sees it in their bell.
      targetActorType: 'sub_admin',
      targetActorId: assigneeId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[lead-assigned] notification insert failed:', err.message);
  }

  if (assigneeEmail) {
    const leadUrl = `${process.env.ADMIN_PANEL_URL || process.env.PUBLIC_BASE_URL || ''}/admin/leads/${leadId}`;
    const buyerMobile = lead?.buyer_mobile || '—';
    void trySendMail({
      to: assigneeEmail,
      subject: `[Lead assigned] ${buyer}`,
      text: [
        `Hi ${assigneeName || 'there'},`,
        '',
        `A new lead has been assigned to you.`,
        '',
        `Buyer:  ${buyer}`,
        `Mobile: ${buyerMobile}`,
        lead?.buyer_email ? `Email:  ${lead.buyer_email}` : '',
        `Property: ${propertyTag}`,
        lead?.message ? `\nMessage:\n${lead.message}` : '',
        '',
        `Open it: ${leadUrl}`,
      ].filter(Boolean).join('\n'),
      html: renderEmail({
        preheader: `${buyer} (${buyerMobile}) is your lead now`,
        title: `Hi ${assigneeName || 'there'}, a new lead is on your queue`,
        intro: 'You\'ve been assigned this lead. The buyer is waiting — reach out while interest is fresh.',
        bodyHtml: `
          ${infoCard({
            eyebrow: 'Buyer',
            title: buyer,
            subtitle: buyerMobile,
            accent: BRAND.brand,
          })}
          ${sectionTitle('Lead details')}
          ${kvTable(
            kvRow('Mobile', buyerMobile, { mono: true, link: `tel:${buyerMobile}` }) +
            (lead?.buyer_email ? kvRow('Email', lead.buyer_email, { link: `mailto:${lead.buyer_email}` }) : '') +
            kvRow('Property', propertyTag)
          )}
          ${lead?.message ? `${sectionTitle('Buyer\'s message')}${quoteBlock(lead.message)}` : ''}
        `,
        ctaHref: leadUrl,
        ctaLabel: 'Open this lead',
        accentColor: BRAND.primary,
        footerNote: 'You\'re receiving this because this lead was just assigned to you.',
      }),
    });
  }
}

async function listAssignees() {
  const rows = await subAdminsRepo.listAssignableForLeads();
  return rows.map((r) => ({ id: r.id, name: r.full_name, email: r.email }));
}

async function updateNotes(id, notes) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  await leadsRepo.updateNotes(id, notes);
  return getLead(id);
}

async function removeLead(id, req = null) {
  const row = await leadsRepo.findById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Lead not found');
  await leadsRepo.softDelete(id);
  if (req) {
    void audit.record(req, {
      action: 'lead.deleted',
      entityType: 'lead',
      entityId: id,
      summary: `Deleted lead from ${row.buyer_name}`,
      metadata: {
        entityLabel: row.buyer_name,
        entitySubLabel: row.buyer_mobile,
        propertyCode: row.property_code || null,
      },
    });
  }
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
    closedReason: row.closed_reason || null,
    notes: row.notes,
    assignedToAdminId: row.assigned_sub_admin_id || null,
    assignedToAdminName: row.assigned_admin_name || null,
    assignedToAdminEmail: row.assigned_admin_email || null,
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
  updateAssignment,
  listAssignees,
  updateNotes,
  removeLead,
  exportCsv,
  exportXlsx,
  exportPdf,
};
