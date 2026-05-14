/**
 * Allowlist of CMS settings the admin form can write. Keeps the bulk-upsert
 * endpoint from accepting arbitrary keys (which would let an admin scribble
 * keys that public CMS readers would faithfully echo back).
 *
 * To add a new setting:
 *   1. Add it here.
 *   2. Add it to the frontend ContactInfoForm.
 *   3. (Optional) read it on the public homepage / footer.
 */

const CMS_SETTING_KEYS = Object.freeze([
  'contact_number',
  'alternate_contact',
  'contact_email',
  'office_address',
  'social_facebook',
  'social_twitter',
  'social_instagram',
  'social_linkedin',
  'social_youtube',
  'site_tagline',
  'support_hours',
  // Static page content (About + Contact). Stored as plain text; line breaks
  // are preserved on render. No markdown parsing.
  'about_heading',
  'about_content',
  'contact_heading',
  'contact_intro',
]);

const KEY_LABELS = {
  contact_number: 'Primary contact number',
  alternate_contact: 'Alternate contact number',
  contact_email: 'Contact email',
  office_address: 'Office address',
  social_facebook: 'Facebook URL',
  social_twitter: 'X / Twitter URL',
  social_instagram: 'Instagram URL',
  social_linkedin: 'LinkedIn URL',
  social_youtube: 'YouTube URL',
  site_tagline: 'Site tagline',
  support_hours: 'Support hours',
  about_heading: 'About — page heading',
  about_content: 'About — body copy',
  contact_heading: 'Contact — page heading',
  contact_intro: 'Contact — short intro',
};

function isValidSettingKey(key) {
  return CMS_SETTING_KEYS.includes(key);
}

module.exports = { CMS_SETTING_KEYS, KEY_LABELS, isValidSettingKey };
