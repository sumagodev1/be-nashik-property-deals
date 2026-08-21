-- 123: set the official Nasik Property Deals contact details.
--
-- These CMS settings are the single source for the public website footer and
-- Contact page, AND for the header block on every backend-generated PDF
-- export (see server/services/files/branding.js, which maps
-- contact_number / alternate_contact / contact_email into the PDF header).
-- Updating them here therefore updates the website and the PDFs together.
--
-- Scoped to `cms_settings` ON PURPOSE: `alternate_contact` is also a column on
-- the `sellers` table, holding each seller's own second number. A blanket
-- update on that name would have overwritten real seller data.
--
-- The Email Master (`email_settings`: sender_email / admin_email / SMTP) is
-- deliberately NOT touched — per instruction the existing sending address
-- stays as it is. That is a separate table and a separate concern: this is
-- the address shown TO customers, not the mailbox mail is sent FROM.

UPDATE cms_settings
   SET setting_value = 'nasikpropertydeals2000@gmail.com'
 WHERE setting_key = 'contact_email';

UPDATE cms_settings
   SET setting_value = '9420052402'
 WHERE setting_key = 'contact_number';

-- Only one official number was supplied. The previous alternate (9666666666)
-- was placeholder data and is cleared rather than left on the live site; the
-- website and PDFs simply show a single number. Set a value here if a second
-- official number is issued.
UPDATE cms_settings
   SET setting_value = ''
 WHERE setting_key = 'alternate_contact';
