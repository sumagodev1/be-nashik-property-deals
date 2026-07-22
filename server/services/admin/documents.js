/**
 * Service layer for the Document Directory module.
 *
 * Responsibilities:
 *   - Generate the human-facing Document ID (DOC-YY-<7 alnum>).
 *   - Persist uploaded files to uploads/private/documents/ and record
 *     metadata in the documents table.
 *   - Stream files back to the caller for View / Download.
 *   - Send a document as an email attachment on demand (runtime-only;
 *     nothing about the share is persisted).
 *   - Soft-delete the DB row and unlink the physical file.
 *
 * All file access flows through the backend, so the storage path is
 * never exposed to the client.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { HttpError } = require('../../middleware/errors');
const repo = require('../../db/queries/documents');
const emailer = require('../email/transporter');

const PRIVATE_DIR = process.env.UPLOAD_PRIVATE_DIR || 'uploads/private';
const SUBDIR = 'documents';
const DOC_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const DOC_ID_LEN = 7;
const DOC_ID_MAX_RETRIES = 8;

function appRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

function documentsDirAbsolute() {
  return path.join(appRoot(), PRIVATE_DIR, SUBDIR);
}

function absolutePathFor(storagePath) {
  // storagePath is stored as `documents/<uuid>.<ext>` (relative to
  // PRIVATE_DIR) so callers never see the absolute filesystem layout.
  return path.join(appRoot(), PRIVATE_DIR, storagePath);
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function extractExtension(originalName) {
  if (!originalName || typeof originalName !== 'string') return '';
  const dot = originalName.lastIndexOf('.');
  if (dot < 0 || dot === originalName.length - 1) return '';
  return originalName.slice(dot + 1).toLowerCase().slice(0, 32);
}

function randomAlnum(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += DOC_ID_ALPHABET[bytes[i] % DOC_ID_ALPHABET.length];
  }
  return out;
}

async function generateUniqueDocumentId() {
  const yy = String(new Date().getUTCFullYear()).slice(-2);
  for (let i = 0; i < DOC_ID_MAX_RETRIES; i += 1) {
    const candidate = `DOC-${yy}-${randomAlnum(DOC_ID_LEN)}`;
    // eslint-disable-next-line no-await-in-loop
    const taken = await repo.existsByDocumentId(candidate);
    if (!taken) return candidate;
  }
  throw new HttpError(500, 'INTERNAL_ERROR', 'Could not generate a unique document ID. Please try again.');
}

function rowToDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    documentName: row.document_name,
    description: row.description,
    category: row.category,
    tags: row.tags,
    originalFilename: row.original_filename,
    extension: row.extension,
    mimeType: row.mime_type,
    fileSize: Number(row.file_size) || 0,
    status: row.status,
    // storage_path / stored_filename are deliberately NOT surfaced to the
    // client — access is only via backend view / download endpoints.
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function list(query = {}) {
  const result = await repo.list(query);
  return {
    data: result.data.map(rowToDto),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
    totalPages: Math.max(1, Math.ceil(result.total / result.pageSize)),
  };
}

async function getOne(id) {
  const row = await repo.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  return rowToDto(row);
}

/**
 * Persist a newly uploaded file to disk + DB.
 *   file: { originalname, buffer, size, mimetype }
 *   meta: { documentName, description, category, tags }
 */
async function upload({ file, meta, uploadedBy }) {
  if (!file || !file.buffer || !file.originalname) {
    throw new HttpError(400, 'NO_FILE', 'A file is required to upload a document.');
  }
  const documentName = String(meta?.documentName || '').trim();
  if (!documentName) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Document Name is required.');
  }

  const extension = extractExtension(file.originalname);
  const dir = documentsDirAbsolute();
  ensureDirSync(dir);

  const storedFilename = `${crypto.randomUUID()}${extension ? `.${extension}` : ''}`;
  const fullPath = path.join(dir, storedFilename);
  await fsp.writeFile(fullPath, file.buffer);

  try {
    const documentId = await generateUniqueDocumentId();
    const row = await repo.create({
      documentId,
      documentName,
      description: meta?.description ? String(meta.description).trim() : null,
      category: meta?.category ? String(meta.category).trim() : null,
      tags: meta?.tags ? String(meta.tags).trim() : null,
      originalFilename: file.originalname.slice(0, 500),
      storedFilename,
      extension,
      mimeType: file.mimetype || null,
      fileSize: file.size,
      // Path stored relative to PRIVATE_DIR — never leaks absolute paths.
      storagePath: `${SUBDIR}/${storedFilename}`,
      uploadedBy: uploadedBy || null,
      status: 'active',
    });
    return rowToDto(row);
  } catch (err) {
    // Roll back the physical write if the DB insert failed.
    await fsp.unlink(fullPath).catch(() => {});
    throw err;
  }
}

async function updateMetadata(id, payload) {
  const existing = await repo.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  const documentName = payload?.documentName != null
    ? String(payload.documentName).trim()
    : null;
  if (documentName === '') {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Document Name cannot be empty.');
  }
  const row = await repo.updateMetadata(id, {
    documentName,
    description: payload?.description != null ? String(payload.description) : null,
    category: payload?.category != null ? String(payload.category) : null,
    tags: payload?.tags != null ? String(payload.tags) : null,
    status: payload?.status || null,
  });
  return rowToDto(row);
}

async function remove(id) {
  const existing = await repo.getById(id);
  if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  await repo.softDelete(id);
  // Best-effort unlink — soft-delete already succeeded, so we don't fail
  // the caller if the physical file was already gone.
  const abs = absolutePathFor(existing.storage_path);
  await fsp.unlink(abs).catch(() => {});
}

/**
 * Stream a stored document to the caller. `disposition` controls the
 * Content-Disposition header — 'inline' asks the browser to preview,
 * 'attachment' forces a download preserving the original filename.
 */
async function streamDocument(id, res, { disposition = 'inline' } = {}) {
  const row = await repo.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  const abs = absolutePathFor(row.storage_path);
  try {
    await fsp.access(abs, fs.constants.R_OK);
  } catch {
    throw new HttpError(404, 'FILE_MISSING', 'The stored file for this document is no longer available on disk.');
  }
  const contentType = row.mime_type || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${encodeURIComponent(row.original_filename)}"`,
  );
  res.setHeader('Cache-Control', 'private, max-age=0, no-cache');
  res.setHeader('Content-Length', row.file_size);
  const stream = fs.createReadStream(abs);
  stream.on('error', () => {
    if (!res.headersSent) res.status(404);
    res.end();
  });
  stream.pipe(res);
}

const SHARE_EMAIL_HTML = `<div style="font-family: Arial, sans-serif; color:#111; font-size:14px; line-height:1.6;">
  <p>Hello,</p>
  <p>Greetings from Nasik Property Deals.</p>
  <p>Thank you for visiting Nasik Property Deals.</p>
  <p>Please find the attached document shared with you.</p>
  <p>If you have any questions, feel free to contact us.</p>
  <p style="margin-top:24px;">Regards,<br/>Nasik Property Deals Team</p>
</div>`;

const SHARE_EMAIL_TEXT = [
  'Hello,',
  '',
  'Greetings from Nasik Property Deals.',
  '',
  'Thank you for visiting Nasik Property Deals.',
  '',
  'Please find the attached document shared with you.',
  '',
  'If you have any questions, feel free to contact us.',
  '',
  'Regards,',
  'Nasik Property Deals Team',
].join('\n');

const DEFAULT_SHARE_SUBJECT = 'Document Shared - Nasik Property Deals';

/**
 * Runtime-only email share. Nothing about the recipient / attempt is
 * persisted anywhere per spec — success or SMTP failure both leave the
 * documents table untouched. SMTP errors are translated into readable
 * HttpErrors so the frontend can surface a specific message.
 */
async function shareByEmail(id, { recipientEmail, subject, message }) {
  const row = await repo.getById(id);
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');

  const to = String(recipientEmail || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'A valid Recipient Email is required.');
  }

  const abs = absolutePathFor(row.storage_path);
  try {
    await fsp.access(abs, fs.constants.R_OK);
  } catch {
    throw new HttpError(404, 'FILE_MISSING', 'The stored file for this document is no longer available on disk.');
  }

  const finalSubject = subject && String(subject).trim()
    ? String(subject).trim()
    : DEFAULT_SHARE_SUBJECT;

  // Optional custom user message is prepended above the standard body.
  const userMessage = message && String(message).trim() ? String(message).trim() : '';
  const htmlBody = userMessage
    ? `<p style="font-family: Arial, sans-serif; color:#111; font-size:14px; white-space:pre-wrap;">${userMessage
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</p>${SHARE_EMAIL_HTML}`
    : SHARE_EMAIL_HTML;
  const textBody = userMessage
    ? `${userMessage}\n\n${SHARE_EMAIL_TEXT}`
    : SHARE_EMAIL_TEXT;

  const transporter = emailer.getTransporter();
  const from = (function buildFrom() {
    if (process.env.SMTP_FROM) return process.env.SMTP_FROM;
    const name = process.env.SMTP_FROM_NAME;
    const email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
    if (email && name) return `"${name}" <${email}>`;
    if (email) return email;
    return 'no-reply@example.com';
  }());

  try {
    await transporter.sendMail({
      from,
      to,
      subject: finalSubject,
      text: textBody,
      html: htmlBody,
      attachments: [
        {
          filename: row.original_filename,
          path: abs,
          contentType: row.mime_type || 'application/octet-stream',
        },
      ],
    });
  } catch (err) {
    const code = err.code || err.responseCode;
    const rawMessage = err.message || 'Unknown SMTP error';
    if (code === 'EAUTH' || code === 535) {
      throw new HttpError(502, 'SMTP_AUTH_FAILED', 'SMTP authentication failed. Please check the mail credentials and try again.');
    }
    if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ETIMEDOUT' || code === 'EDNS') {
      throw new HttpError(502, 'SMTP_UNAVAILABLE', 'SMTP unavailable. Could not reach the mail server.');
    }
    throw new HttpError(502, 'EMAIL_SEND_FAILED', `Failed to send email: ${rawMessage}`);
  }
}

module.exports = {
  list,
  getOne,
  upload,
  updateMetadata,
  remove,
  streamDocument,
  shareByEmail,
};
