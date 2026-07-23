/**
 * Shared branding snapshot for backend-generated PDF exports.
 *
 * Reads the CMS settings once per export request and maps the storage-shape
 * keys (contact_number, contact_email, site_tagline, office_address, …) to
 * the shape the shared PDF renderer expects (see server/services/files/pdf.js).
 * If the CMS fetch fails the built-in defaults are returned so exports still
 * render — a missing tagline should never break a PDF.
 *
 * Added at T-2026-072 to remove the client-side branding snapshot the
 * frontend used to build.
 */

const cms = require('../admin/cms');

const DEFAULTS = Object.freeze({
  name: 'Nasik Property Deals',
  tagline: 'Premium Real Estate Management System',
  phone: '',
  altPhone: '',
  email: '',
  address: '',
  website: 'www.nasikpropertydeals.com',
  gst: '',
});

async function getBrandingSnapshot() {
  try {
    const s = await cms.readSettings();
    return {
      name:     DEFAULTS.name,
      tagline:  s.site_tagline     || DEFAULTS.tagline,
      phone:    s.contact_number   || DEFAULTS.phone,
      altPhone: s.alternate_contact || DEFAULTS.altPhone,
      email:    s.contact_email    || DEFAULTS.email,
      address:  s.office_address   || DEFAULTS.address,
      website:  DEFAULTS.website,
      gst:      s.company_gst      || DEFAULTS.gst,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function getBrandingDefaults() {
  return { ...DEFAULTS };
}

module.exports = { getBrandingSnapshot, getBrandingDefaults };
