const PROPERTY_TYPES = Object.freeze([
  'flat',
  'house',
  'villa',
  'plot',
  'commercial',
  'agricultural',
  'other',
]);

const TRANSACTION_TYPES = Object.freeze(['sale', 'rent', 'lease']);

const INVENTORY_STATUSES = Object.freeze(['available', 'sold', 'rented', 'inactive']);

const AREA_UNITS = Object.freeze(['sqft', 'sqm', 'sqyd', 'acre', 'hectare']);

// T-2026-048: HEIC/HEIF accepted alongside JPEG/PNG/WebP. HEIC is stored
// as-is; the frontend displays it via the browser's native <img> support
// (Safari today; other browsers via progressive rollout). We do not
// transcode server-side.
const ALLOWED_IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const IMAGE_MAGIC_BYTES = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP: 'RIFF' (offset 0) + 'WEBP' (offset 8)
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }] },
  // HEIC/HEIF: 'ftyp' at offset 4, brand at offset 8. Brands: heic, heix,
  // heim, heis, hevc, hevx, mif1, msf1. Match 'ftyp' + a known brand prefix.
  // We treat both HEIC and HEIF the same and store as image/heic (the more
  // widely-recognised MIME).
  { mime: 'image/heic', bytes: [0x66, 0x74, 0x79, 0x70], startOffset: 4, offsetCheck: [] },
];

// Recognised HEIF/HEIC brands at bytes[8..12]. Anything else with an ftyp box
// (e.g. 'mp4a', 'isom') is NOT an image and must be rejected.
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'heif'];

function detectImageMime(buffer) {
  for (const sig of IMAGE_MAGIC_BYTES) {
    const offset = sig.startOffset || 0;
    if (matchBytes(buffer, offset, sig.bytes) && (!sig.offsetCheck || sig.offsetCheck.every((c) => matchBytes(buffer, c.offset, c.bytes)))) {
      if (sig.mime === 'image/heic') {
        // Verify the brand at bytes[8..12] is a HEIF-family brand. This
        // avoids classifying a video 'ftypmp42' file as an image.
        if (buffer.length < 12) return null;
        const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]).toLowerCase();
        if (!HEIF_BRANDS.includes(brand)) return null;
      }
      return sig.mime;
    }
  }
  return null;
}

function matchBytes(buffer, offset, expected) {
  if (buffer.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (buffer[offset + i] !== expected[i]) return false;
  }
  return true;
}

// T-2026-048: expanded document mime allowlist. Covers office documents,
// spreadsheets, presentations, archives, plain text, and the same image
// subset already accepted as a document (PDF + JPG + PNG).
const ALLOWED_DOC_MIMES_EXTENDED = Object.freeze([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'image/jpeg',
  'image/png',
]);

// Filename-extension → MIME fallback. Used when magic-byte detection returns
// null but the extension unambiguously identifies the format (older office
// formats and text files, for example). Every extension in this map is one
// whose MIME is in ALLOWED_DOC_MIMES_EXTENDED — extension trust never
// widens the allowlist.
const DOC_EXT_TO_MIME = Object.freeze({
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
});

// Preferred extension for a stored file, keyed by detected MIME. Used when
// writing the file on disk so the extension matches the format regardless
// of the caller-provided filename.
const DOC_MIME_TO_EXT = Object.freeze({
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'image/jpeg': 'jpg',
  'image/png': 'png',
});

// Detect a document mime by magic bytes when possible, else fall back to
// the filename extension. Returns null when neither identifies a mime in
// ALLOWED_DOC_MIMES_EXTENDED.
function detectDocumentMime(buffer, originalName) {
  // 1. Magic-byte detection for the formats where the signature is stable.
  if (buffer.length >= 4) {
    // PDF: '%PDF'
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'application/pdf';
    // ZIP-based formats (docx/xlsx/pptx/zip/plain-zip): 'PK\x03\x04' or 'PK\x05\x06' or 'PK\x07\x08'.
    // OOXML files are ZIP containers; without unzipping we cannot tell doc-x from xlsx from pptx from a
    // plain zip. Trust the extension in this case (extension whitelist below).
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)) {
      const ext = extOf(originalName);
      if (ext && DOC_EXT_TO_MIME[ext]) return DOC_EXT_TO_MIME[ext];
      return 'application/zip';
    }
    // Legacy Office CFB (doc/xls/ppt): D0 CF 11 E0 A1 B1 1A E1.
    if (buffer.length >= 8
      && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0
      && buffer[4] === 0xa1 && buffer[5] === 0xb1 && buffer[6] === 0x1a && buffer[7] === 0xe1) {
      const ext = extOf(originalName);
      if (ext === 'doc') return 'application/msword';
      if (ext === 'xls') return 'application/vnd.ms-excel';
      if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
      return 'application/msword';
    }
    // RAR: 'Rar!\x1A\x07\x00' (v1.5+) or 'Rar!\x1A\x07\x01' (v5+).
    if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) {
      return 'application/x-rar-compressed';
    }
  }
  // 2. Image formats (JPG, PNG) via the image detector.
  const img = detectImageMime(buffer);
  if (img === 'image/jpeg' || img === 'image/png') return img;
  // 3. CSV / TXT — no magic bytes. Accept ONLY when the file is entirely
  //    printable ASCII/UTF-8 and the extension matches. Rejects binary
  //    files with a spoofed .txt extension.
  const ext = extOf(originalName);
  if ((ext === 'txt' || ext === 'csv') && isProbablyText(buffer)) {
    return ext === 'csv' ? 'text/csv' : 'text/plain';
  }
  return null;
}

function extOf(originalName) {
  if (!originalName || typeof originalName !== 'string') return '';
  const dot = originalName.lastIndexOf('.');
  if (dot < 0 || dot === originalName.length - 1) return '';
  return originalName.slice(dot + 1).toLowerCase();
}

function isProbablyText(buffer) {
  // Sample the first 4 KiB. Reject if any byte is a control char outside
  // the safe set (tab, newline, carriage return, ESC-family printables).
  const N = Math.min(buffer.length, 4096);
  for (let i = 0; i < N; i += 1) {
    const b = buffer[i];
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20) return false;
    if (b === 0x7f) return false;
  }
  return true;
}

module.exports = {
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  INVENTORY_STATUSES,
  AREA_UNITS,
  ALLOWED_IMAGE_MIMES,
  detectImageMime,
  ALLOWED_DOC_MIMES_EXTENDED,
  DOC_MIME_TO_EXT,
  DOC_EXT_TO_MIME,
  detectDocumentMime,
};
