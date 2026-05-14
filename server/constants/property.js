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

const ALLOWED_IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

const IMAGE_MAGIC_BYTES = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP: 'RIFF' (offset 0) + 'WEBP' (offset 8)
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offsetCheck: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }] },
];

function detectImageMime(buffer) {
  for (const sig of IMAGE_MAGIC_BYTES) {
    if (matchBytes(buffer, 0, sig.bytes) && (!sig.offsetCheck || sig.offsetCheck.every((c) => matchBytes(buffer, c.offset, c.bytes)))) {
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

module.exports = {
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  INVENTORY_STATUSES,
  AREA_UNITS,
  ALLOWED_IMAGE_MIMES,
  detectImageMime,
};
