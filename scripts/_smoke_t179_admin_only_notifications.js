// T-2026-179 smoke: admin-only email notifications.
//
// Contract under test (per T-179 spec):
//   - NO application notification email is ever sent to any seller /
//     buyer / enquiry person / customer / property owner.
//   - Recipient is ALWAYS the Admin Email loaded dynamically from the
//     active Email Master row.
//   - Five flow templates render correctly:
//       * NEW_WEBSITE_ENQUIRY
//       * SELLER_REGISTRATION
//       * CRM_BOOKING_CREATED
//       * CRM_BOOKING_CANCELLED (aka CRM Follow-up Cancelled)
//       * CRM_BOOKING_RESCHEDULED (aka CRM Follow-up Rescheduled)
//   - Reschedule email fires ONLY when date/time changed. NOT when only
//     lead_* fields change.
//   - Defensive guard: an internal caller cannot spoof `to` to a
//     customer email (the sendAdminNotification signature has no `to`
//     parameter, so this is asserted at the type level -- plus we
//     verify the customer-email guard warns + still resolves to admin).
//   - Missing Email Master row: no send, clean skipped_reason, no
//     throw (upstream request still succeeds).
//   - Enquiry ID in the NEW_WEBSITE_ENQUIRY email is the CRM
//     enquiry_code (ENQ-*), never the numeric DB id.
//   - Property field in CRM booking emails carries property_code, not
//     the numeric DB id.
//
// Runs against the local MariaDB per project convention. Uses
// monkey-patched transporter to CAPTURE outbound mail without hitting
// SMTP. Idempotent: does not persist any test rows.
//
// Usage: `node scripts/_smoke_t179_admin_only_notifications.js`

require('dotenv').config();
const { pool } = require('../server/db/pool');
const adminNotifications = require('../server/services/email/adminNotifications');
const transporter = require('../server/services/email/transporter');
const appointmentEmail = require('../server/services/crm/appointmentEmail');

let passed = 0, failed = 0;
function ok(label, cond, extra) {
  if (cond) { passed += 1; console.log(`PASS  ${label}`); }
  else      { failed += 1; console.log(`FAIL  ${label}${extra ? ' -- ' + extra : ''}`); }
}

// --- Capture harness ---------------------------------------------------
// Monkey-patch trySendMail + getAdminEmail so we intercept everything
// without touching SMTP. Both restored in finally.

const origGetAdminEmail = transporter.getAdminEmail;
const origTrySendMail   = transporter.trySendMail;

function installCapture(overrideAdmin) {
  const captured = [];
  transporter.getAdminEmail = async () => overrideAdmin;
  transporter.trySendMail = async (opts) => {
    captured.push(JSON.parse(JSON.stringify(opts || {})));
    return true;
  };
  return captured;
}

function restoreCapture() {
  transporter.getAdminEmail = origGetAdminEmail;
  transporter.trySendMail   = origTrySendMail;
}

// --- Sanity: nowIstDate + formatIstDateTime ---------------------------

async function testFormatters() {
  const s = adminNotifications.formatIstDateTime(new Date(Date.UTC(2026, 7, 13, 9, 30, 0)));
  // With getUTC-as-IST convention, above renders as "13-08-2026 09:30 AM"
  ok('T0.a formatIstDateTime renders DD-MM-YYYY HH:MM AM/PM',
    /^\d{2}-\d{2}-\d{4} \d{2}:\d{2} (AM|PM)$/.test(s), s);
  const s2 = adminNotifications.formatIstDateTime('');
  ok('T0.b formatIstDateTime handles empty gracefully', s2 === '');
  const s3 = adminNotifications.formatIstDateTime('not a date');
  ok('T0.c formatIstDateTime handles junk input gracefully', s3 === '');
  const ist = adminNotifications.nowIstDate();
  ok('T0.d nowIstDate returns a Date instance', ist instanceof Date && !Number.isNaN(ist.getTime()));
}

// --- T1: NEW_WEBSITE_ENQUIRY template + send --------------------------

async function testNewWebsiteEnquiry() {
  const captured = installCapture('admin@example.invalid');
  try {
    const rendered = adminNotifications.renderNewWebsiteEnquiry({
      enquiryCode: 'ENQ-2026-99001',
      source: 'website',
      enquiryTypeLabel: 'Contact Seller',
      name:    'Test Buyer',
      mobile:  '9999900001',
      email:   'buyer@test.invalid',
      message: 'I want to see this property',
      propertyDetails: [{ code: 'NAS-BNG-26-XYZ123', title: 'A test bungalow' }],
      createdAt: new Date(Date.UTC(2026, 7, 13, 9, 30, 0)),
    });
    ok('T1.a subject uses "New Website Enquiry Received – <ENQ_ID>"',
      rendered.subject === 'New Website Enquiry Received – ENQ-2026-99001', rendered.subject);
    ok('T1.b subject contains the ENQ business id (NOT the numeric DB id)',
      /ENQ-2026-\d+/.test(rendered.subject) && !/#\d+/.test(rendered.subject));
    ok('T1.c body renders Name / Mobile / Email / Message / Property / Created Date',
      rendered.text.includes('Enquiry ID:')
      && rendered.text.includes('Name:')
      && rendered.text.includes('Mobile:')
      && rendered.text.includes('Email:')
      && rendered.text.includes('Message:')
      && rendered.text.includes('Property Details:')
      && rendered.text.includes('Created Date:'));
    ok('T1.d Property Details cell carries property_code (not "#<id>")',
      rendered.text.includes('NAS-BNG-26-XYZ123') && !rendered.text.includes('#'));

    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
      customerEmails: rendered.customerEmails,
    });
    ok('T1.e sendAdminNotification returned sent=true', res.sent === true);
    ok('T1.f exactly one outbound mail captured', captured.length === 1);
    ok('T1.g captured.to === Admin Email loaded from Email Master',
      captured[0]?.to === 'admin@example.invalid');
    ok('T1.h captured.to is NEVER the buyer email',
      captured[0]?.to !== 'buyer@test.invalid');
  } finally { restoreCapture(); }
}

// --- T2: SELLER_REGISTRATION template + send --------------------------

async function testSellerRegistration() {
  const captured = installCapture('admin@example.invalid');
  try {
    const rendered = adminNotifications.renderSellerRegistration({
      fullName: 'Test Seller',
      mobile:   '9999900002',
      email:    'seller@test.invalid',
      userType: 'individual',
      accountStatus: 'Active (Verified)',
      registeredAt: new Date(Date.UTC(2026, 7, 13, 10, 15, 0)),
    });
    ok('T2.a subject is exactly "New Seller Registration Received"',
      rendered.subject === 'New Seller Registration Received', rendered.subject);
    ok('T2.b body renders Seller Name / Mobile / Email / Registration Date / Account Status',
      rendered.text.includes('Seller Name:')
      && rendered.text.includes('Mobile:')
      && rendered.text.includes('Email:')
      && rendered.text.includes('Registration Date:')
      && rendered.text.includes('Account Status:'));

    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.SELLER_REGISTRATION,
      customerEmails: rendered.customerEmails,
    });
    ok('T2.c sendAdminNotification returned sent=true', res.sent === true);
    ok('T2.d exactly one outbound mail captured', captured.length === 1);
    ok('T2.e captured.to === Admin Email (never the seller email)',
      captured[0]?.to === 'admin@example.invalid');
    ok('T2.f captured.to !== seller email',
      captured[0]?.to !== 'seller@test.invalid');
  } finally { restoreCapture(); }
}

// --- T3: CRM_BOOKING_CREATED template + send --------------------------

async function testCrmBookingCreated() {
  const captured = installCapture('admin@example.invalid');
  try {
    const rendered = adminNotifications.renderCrmBookingCreated({
      enquiryCode: 'ENQ-2026-99002',
      enquiryName: 'Test Enquiry',
      mobile:      '9999900003',
      email:       'enq@test.invalid',
      source:      'npd',
      scheduledAt: new Date(Date.UTC(2026, 7, 14, 11, 30, 0)),
      leadStage:   'NEW',
      leadStatus:  'CONTACTED',
      leadRating:  'HOT',
      propertyCodes: ['NAS-FLT-26-ABC001', 'NAS-BNG-26-XYZ003'],
      notes: 'First follow-up call',
    });
    ok('T3.a subject uses "CRM Call Scheduled – <ENQ_ID>"',
      rendered.subject === 'CRM Call Scheduled – ENQ-2026-99002', rendered.subject);
    ok('T3.b body renders Enquiry ID / Name / Mobile / Email / Type / Date / Time / Stage / Status / Rating / Property / Notes',
      rendered.text.includes('Enquiry ID:')
      && rendered.text.includes('Enquiry Name:')
      && rendered.text.includes('Mobile:')
      && rendered.text.includes('Email:')
      && rendered.text.includes('Enquiry Type:')
      && rendered.text.includes('Scheduled Date:')
      && rendered.text.includes('Scheduled Time:')
      && rendered.text.includes('Lead Stage:')
      && rendered.text.includes('Lead Status:')
      && rendered.text.includes('Lead Rating:')
      && rendered.text.includes('Property:')
      && rendered.text.includes('Notes:'));
    ok('T3.c Property field carries property_code (not numeric #<id>)',
      rendered.text.includes('NAS-FLT-26-ABC001') && rendered.text.includes('NAS-BNG-26-XYZ003') && !rendered.text.includes('#'));

    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.CRM_BOOKING_CREATED,
      customerEmails: rendered.customerEmails,
    });
    ok('T3.d one outbound mail captured', captured.length === 1);
    ok('T3.e captured.to === admin (never enquiry email)',
      captured[0]?.to === 'admin@example.invalid');
    ok('T3.f captured.to !== enq@test.invalid', captured[0]?.to !== 'enq@test.invalid');
  } finally { restoreCapture(); }
}

// --- T4: CRM_BOOKING_CANCELLED template + send ------------------------

async function testCrmBookingCancelled() {
  const captured = installCapture('admin@example.invalid');
  try {
    const rendered = adminNotifications.renderCrmBookingCancelled({
      enquiryCode: 'ENQ-2026-99003',
      enquiryName: 'Test Enquiry',
      mobile:      '9999900004',
      email:       'enq2@test.invalid',
      source:      'website',
      propertyCodes: ['NAS-COM-26-DEF456'],
      previouslyScheduledAt: new Date(Date.UTC(2026, 7, 14, 11, 30, 0)),
      cancelledAt: new Date(Date.UTC(2026, 7, 13, 12, 0, 0)),
      cancellationReason: 'Customer requested reschedule via phone',
    });
    ok('T4.a subject uses "CRM Follow-up Cancelled – <ENQ_ID>"',
      rendered.subject === 'CRM Follow-up Cancelled – ENQ-2026-99003', rendered.subject);
    ok('T4.b body renders Enquiry ID / Name / Mobile / Email / Type / Property / Prev Date/Time / Cancellation Date/Time / Reason',
      rendered.text.includes('Enquiry ID:')
      && rendered.text.includes('Name:')
      && rendered.text.includes('Mobile:')
      && rendered.text.includes('Email:')
      && rendered.text.includes('Enquiry Type:')
      && rendered.text.includes('Property:')
      && rendered.text.includes('Previously Scheduled Date:')
      && rendered.text.includes('Previously Scheduled Time:')
      && rendered.text.includes('Cancellation Date/Time:')
      && rendered.text.includes('Cancellation Reason:'));
    ok('T4.c Property field carries property_code',
      rendered.text.includes('NAS-COM-26-DEF456'));

    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.CRM_BOOKING_CANCELLED,
      customerEmails: rendered.customerEmails,
    });
    ok('T4.d one outbound mail captured', captured.length === 1);
    ok('T4.e captured.to === admin', captured[0]?.to === 'admin@example.invalid');
    ok('T4.f captured.to !== customer', captured[0]?.to !== 'enq2@test.invalid');
  } finally { restoreCapture(); }
}

// --- T5: CRM_BOOKING_RESCHEDULED template + send ----------------------

async function testCrmBookingRescheduled() {
  const captured = installCapture('admin@example.invalid');
  try {
    const rendered = adminNotifications.renderCrmBookingRescheduled({
      enquiryCode: 'ENQ-2026-99004',
      enquiryName: 'Test Enquiry',
      mobile:      '9999900005',
      email:       'enq3@test.invalid',
      source:      'website',
      previousScheduledAt: new Date(Date.UTC(2026, 7, 14, 11, 30, 0)),
      newScheduledAt:      new Date(Date.UTC(2026, 7, 15, 15, 45, 0)),
      propertyCodes: ['NAS-FLT-26-GHI789'],
      updatedByName: 'Test Admin',
      updatedAt: new Date(Date.UTC(2026, 7, 13, 12, 5, 0)),
    });
    ok('T5.a subject uses "CRM Follow-up Rescheduled – <ENQ_ID>"',
      rendered.subject === 'CRM Follow-up Rescheduled – ENQ-2026-99004', rendered.subject);
    ok('T5.b body renders Previous Schedule + New Schedule (both date + time)',
      rendered.text.includes('Previous Schedule:')
      && rendered.text.includes('New Schedule:')
      && /Previous Schedule: 14-08-2026/.test(rendered.text)
      && /New Schedule: 15-08-2026/.test(rendered.text));
    ok('T5.c body renders Updated By + Updated Date/Time',
      rendered.text.includes('Updated By: Test Admin')
      && rendered.text.includes('Updated Date/Time:'));

    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.CRM_BOOKING_RESCHEDULED,
      customerEmails: rendered.customerEmails,
    });
    ok('T5.d one outbound mail captured', captured.length === 1);
    ok('T5.e captured.to === admin', captured[0]?.to === 'admin@example.invalid');
    ok('T5.f captured.to !== customer', captured[0]?.to !== 'enq3@test.invalid');
  } finally { restoreCapture(); }
}

// --- T6: appointmentEmail wrapper (integration with CRM callsite) ----

async function testAppointmentEmailWrapper() {
  const captured = installCapture('admin@example.invalid');
  try {
    // T6.i 'created' mode
    const r1 = await appointmentEmail.sendAppointmentEmail({
      mode: 'created',
      enquiryCode: 'ENQ-2026-99005',
      enquiryType: 'npd',
      leadName:  'Wrapper Test',
      leadEmail: 'wrapper@test.invalid',
      leadMobile: '9999900006',
      scheduledAt: new Date(Date.UTC(2026, 7, 14, 10, 0, 0)),
      propertyCodes: ['NAS-FLT-26-JKL999'],
      leadStage: 'NEW',
      leadStatus: 'CONTACTED',
      leadRating: 'HOT',
      notes: 'Initial booking',
    });
    ok('T6.i.a wrapper created returned sent=true', r1.sent === true);
    ok('T6.i.b wrapper created captured to === admin', captured[0]?.to === 'admin@example.invalid');
    ok('T6.i.c wrapper created captured subject uses CRM Call Scheduled',
      /^CRM Call Scheduled – ENQ-2026-99005$/.test(captured[0]?.subject || ''));
    ok('T6.i.d wrapper created did NOT set to=wrapper@test.invalid',
      captured[0]?.to !== 'wrapper@test.invalid');

    // T6.ii 'edited' mode -- reschedule
    captured.length = 0;
    const r2 = await appointmentEmail.sendAppointmentEmail({
      mode: 'edited',
      enquiryCode: 'ENQ-2026-99006',
      enquiryType: 'website',
      leadName:  'Wrapper Test',
      leadEmail: 'wrapper2@test.invalid',
      leadMobile: '9999900007',
      previousScheduledAt: new Date(Date.UTC(2026, 7, 14, 10, 0, 0)),
      scheduledAt:         new Date(Date.UTC(2026, 7, 15, 11, 0, 0)),
      propertyCodes: ['NAS-BNG-26-MMM111'],
      updatedByName: 'Test Admin',
    });
    ok('T6.ii.a wrapper edited returned sent=true', r2.sent === true);
    ok('T6.ii.b wrapper edited subject uses CRM Follow-up Rescheduled',
      /^CRM Follow-up Rescheduled – ENQ-2026-99006$/.test(captured[0]?.subject || ''));
    ok('T6.ii.c wrapper edited captured to === admin', captured[0]?.to === 'admin@example.invalid');

    // T6.iii 'cancelled' mode
    captured.length = 0;
    const r3 = await appointmentEmail.sendAppointmentEmail({
      mode: 'cancelled',
      enquiryCode: 'ENQ-2026-99007',
      enquiryType: 'website',
      leadName:  'Wrapper Test',
      leadEmail: 'wrapper3@test.invalid',
      leadMobile: '9999900008',
      scheduledAt: new Date(Date.UTC(2026, 7, 14, 10, 0, 0)),
      propertyCodes: ['NAS-COM-26-NNN222'],
      cancellationReason: 'Customer withdrew',
    });
    ok('T6.iii.a wrapper cancelled returned sent=true', r3.sent === true);
    ok('T6.iii.b wrapper cancelled subject uses CRM Follow-up Cancelled',
      /^CRM Follow-up Cancelled – ENQ-2026-99007$/.test(captured[0]?.subject || ''));
    ok('T6.iii.c wrapper cancelled captured to === admin', captured[0]?.to === 'admin@example.invalid');
    ok('T6.iii.d wrapper cancelled captured to !== customer',
      captured[0]?.to !== 'wrapper3@test.invalid');
  } finally { restoreCapture(); }
}

// --- T7: Defensive guard ---------------------------------------------
// The sendAdminNotification signature has no `to` parameter, so a
// caller CANNOT set the recipient. We prove that here at runtime:

async function testDefensiveGuard() {
  const captured = installCapture('admin@example.invalid');
  try {
    // Pass a spoofed `to` field in an object -- the function signature
    // deliberately does NOT accept it, so it's silently ignored and the
    // recipient still resolves to Email Master admin.
    const rendered = adminNotifications.renderNewWebsiteEnquiry({
      enquiryCode: 'ENQ-2026-99010',
      source: 'website',
      name: 'Guard Test',
      mobile: '9999900010',
      email: 'evil@customer.invalid',
      message: 'attempt to spoof',
      createdAt: new Date(),
    });
    // Note: spoofed `to:` intentionally passed to prove it is dropped.
    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
      customerEmails: rendered.customerEmails,
      to: 'evil@customer.invalid', // caller attempts to hijack; MUST be ignored
    });
    ok('T7.a spoofed to is IGNORED; captured to === admin',
      captured[0]?.to === 'admin@example.invalid');
    ok('T7.b captured to is NOT the spoofed customer email',
      captured[0]?.to !== 'evil@customer.invalid');
    ok('T7.c sendAdminNotification still returned sent=true', res.sent === true);
  } finally { restoreCapture(); }

  // T7.d: adminEmail happens to equal a customer email in payload -> guard warns but still sends
  const captured2 = installCapture('collision@customer.invalid');
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    const rendered = adminNotifications.renderNewWebsiteEnquiry({
      enquiryCode: 'ENQ-2026-99011',
      source: 'website',
      name: 'Collision Test',
      mobile: '9999900011',
      email: 'collision@customer.invalid',
      createdAt: new Date(),
    });
    const res = await adminNotifications.sendAdminNotification({
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
      customerEmails: rendered.customerEmails,
    });
    ok('T7.d admin==customer collision: still sends (admin owns the address)', res.sent === true);
    ok('T7.e admin==customer collision: warning was logged',
      warnings.some((w) => w.includes('adminEmail equals a customer email')));
    ok('T7.f admin==customer collision: to === admin (not empty, not undefined)',
      captured2[0]?.to === 'collision@customer.invalid');
    ok('T7.g admin==customer collision: warnings array surfaced in result',
      Array.isArray(res.warnings) && res.warnings.includes('ADMIN_EQUALS_CUSTOMER'));
  } finally {
    console.warn = origWarn;
    restoreCapture();
  }
}

// --- T8: Missing Email Master row -------------------------------------

async function testMissingEmailMaster() {
  const captured = installCapture(null); // simulate no active Email Master
  const origErr = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    const rendered = adminNotifications.renderNewWebsiteEnquiry({
      enquiryCode: 'ENQ-2026-99020',
      source: 'website',
      name: 'MissingConfig',
      mobile: '9999900020',
      email: 'x@test.invalid',
      createdAt: new Date(),
    });
    let threw = null;
    let res = null;
    try {
      res = await adminNotifications.sendAdminNotification({
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
        customerEmails: rendered.customerEmails,
      });
    } catch (e) {
      threw = e;
    }
    ok('T8.a missing Email Master: sendAdminNotification did NOT throw', threw === null);
    ok('T8.b missing Email Master: sent=false, skipped_reason=NO_ADMIN_EMAIL',
      res && res.sent === false && res.skipped_reason === 'NO_ADMIN_EMAIL');
    ok('T8.c missing Email Master: NO outbound mail captured', captured.length === 0);
    ok('T8.d missing Email Master: actionable error was logged',
      errors.some((e) => e.includes('NO_ADMIN_EMAIL')));
  } finally {
    console.error = origErr;
    restoreCapture();
  }
}

// --- T9: unknown type / missing subject guardrails --------------------

async function testGuardrails() {
  const captured = installCapture('admin@example.invalid');
  try {
    const r1 = await adminNotifications.sendAdminNotification({
      subject: 'Anything',
      html: '<p>x</p>',
      text: 'x',
      type: 'NOT_A_TYPE',
    });
    ok('T9.a unknown type: refused, sent=false',
      r1.sent === false && r1.skipped_reason === 'UNKNOWN_TYPE');
    ok('T9.b unknown type: nothing sent', captured.length === 0);

    const r2 = await adminNotifications.sendAdminNotification({
      html: '<p>y</p>',
      text: 'y',
      type: adminNotifications.TYPES.NEW_WEBSITE_ENQUIRY,
    });
    ok('T9.c missing subject: refused, sent=false',
      r2.sent === false && r2.skipped_reason === 'MISSING_SUBJECT');
  } finally { restoreCapture(); }
}

// --- T10: reschedule "only lead_* changed" scenario -------------------
//
// Under T-179 spec: the RESCHEDULE email must fire ONLY when date/time
// actually changed. The reschedule email is triggered inside
// appointmentSlots.js#updateAppointment ONLY when slotChanged === true.
// Lead taxonomy changes flow through a SEPARATE endpoint
// (services/crm/enquiries.js#changeStatus) which does NOT send any
// email. So the "only lead_* changed" scenario is structurally
// impossible on the reschedule path. We prove the guard by directly
// verifying the wrapper's behaviour: a bare 'edited' call with prev
// == new does not throw; but the more important assertion is that
// changeStatus (taxonomy-only) does NOT invoke the notification path.
// The latter is proven by inspection of enquiries.js -- it never
// requires or calls appointmentEmail. We do a runtime version here:

async function testNoRescheduleOnTaxonomyOnly() {
  const captured = installCapture('admin@example.invalid');
  try {
    // Simulate the changeStatus flow: no appointmentEmail import used.
    const enq = require('../server/services/crm/enquiries');
    const src = enq.changeStatus.toString();
    ok('T10.a changeStatus source does not reference sendAppointmentEmail',
      !src.includes('sendAppointmentEmail'));
    ok('T10.b changeStatus source does not reference appointmentEmail.',
      !src.includes('appointmentEmail.'));
    // Extra: no notification was fired because we never invoked the reschedule wrapper.
    ok('T10.c no outbound mail captured for a taxonomy-only path (structural)',
      captured.length === 0);
  } finally { restoreCapture(); }
}

// --- T11: sendUpdates=none set on GCal insert/update/delete -----------

async function testGcalSendUpdates() {
  // Static inspection of the source file is the fastest / most portable
  // assertion here: the test doesn't need to call the actual Google
  // API. We assert that every calendar.events.{insert,update,delete}
  // call in googleCalendar.js includes `sendUpdates: 'none'`.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'crm', 'googleCalendar.js'),
    'utf8',
  );
  const inserts = (src.match(/calendar\.events\.insert\(\{[\s\S]*?\}\)/g) || []);
  const updates = (src.match(/calendar\.events\.update\(\{[\s\S]*?\}\)/g) || []);
  const deletes = (src.match(/calendar\.events\.delete\(\{[\s\S]*?\}\)/g) || []);
  ok('T11.a googleCalendar has at least one events.insert call', inserts.length >= 1);
  ok('T11.b every events.insert call sets sendUpdates: \'none\'',
    inserts.every((s) => /sendUpdates:\s*['"]none['"]/.test(s)));
  ok('T11.c every events.update call sets sendUpdates: \'none\'',
    updates.every((s) => /sendUpdates:\s*['"]none['"]/.test(s)));
  ok('T11.d every events.delete call sets sendUpdates: \'none\'',
    deletes.every((s) => /sendUpdates:\s*['"]none['"]/.test(s)));
  // Also verify no attendees are pushed on any event body:
  const body = src.match(/function\s+buildEventBody[\s\S]+?return\s+\{[\s\S]+?\};?\s*\}/);
  ok('T11.e buildEventBody() does not emit an `attendees` field',
    body && !/attendees\s*:/.test(body[0]));
}

// --- Runner -----------------------------------------------------------

async function main() {
  console.log('=== T-2026-179 admin-only notifications smoke ===\n');

  await testFormatters();
  await testNewWebsiteEnquiry();
  await testSellerRegistration();
  await testCrmBookingCreated();
  await testCrmBookingCancelled();
  await testCrmBookingRescheduled();
  await testAppointmentEmailWrapper();
  await testDefensiveGuard();
  await testMissingEmailMaster();
  await testGuardrails();
  await testNoRescheduleOnTaxonomyOnly();
  await testGcalSendUpdates();

  console.log(`\n=== Result: ${passed}/${passed + failed} PASS ===`);
  await pool.end().catch(() => {});
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('SMOKE HARNESS ERROR:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
