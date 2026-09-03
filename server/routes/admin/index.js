const express = require('express');
const subAdmins = require('./sub-admins');
const inventoryProperties = require('./inventory-properties');
const enquiryProperties = require('./enquiry-properties');
const websiteProperties = require('./website-properties');
const leads = require('./leads');
const users = require('./users');
const dashboard = require('./dashboard');
const cms = require('./cms');
const emailOutbox = require('./email-outbox');
const notifications = require('./notifications');
const constants = require('./constants');
const masters = require('./masters');
const keyPins = require('./key-pins');
const emailSettings = require('./email-settings');
const auditLog = require('./audit-log');
const landRecords = require('./land-records');
const businessAssociates = require('./business-associates');
const phoneBook = require('./phone-book');
const documents = require('./documents');
const ownerSearch = require('./owner-search');
// T-2026-112: Agreement Tracking & Reminder System — admin surface that
// lists Rent Out / Lease Out records with an agreement window, computes
// remaining/overdue days on the server, and powers the topbar
// notification badge + dashboard summary card. T-2026-174 promoted it
// to its own AGREEMENT_REMINDERS module key (was previously bundled
// under INVENTORY_MANAGEMENT).
const agreementReminders = require('./agreement-reminders');
// T-2026-151: CRM Module -- new admin surface replacing the old Leads
// menu. Endpoints under /admin/crm/*. See routes/admin/crm.js for the
// endpoint list.
const crm = require('./crm');
// Read-only aggregation for the CRM-backed report sections. Gated on
// MODULES.REPORTS to match the FE /admin/reports guard -- see the file header.
const reports = require('./reports');
const { MODULE_KEYS } = require('../../constants/modules');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use('/sub-admins', subAdmins);
router.use('/inventory-properties', inventoryProperties);
router.use('/enquiry-properties', enquiryProperties);
router.use('/website-properties', websiteProperties);
router.use('/leads', leads);
router.use('/users', users);
router.use('/dashboard', dashboard);
router.use('/cms', cms);
router.use('/email-outbox', emailOutbox);
router.use('/notifications', notifications);
router.use('/constants', constants);
router.use('/masters', masters);
router.use('/key-pins', keyPins);
router.use('/email-settings', emailSettings);
router.use('/audit-log', auditLog);
router.use('/land-records', landRecords);
router.use('/business-associates', businessAssociates);
router.use('/phone-book', phoneBook);
router.use('/documents', documents);
router.use('/owner-search', ownerSearch);
router.use('/agreement-reminders', agreementReminders);
router.use('/crm', crm);
router.use('/reports', reports);

router.get('/modules', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ modules: MODULE_KEYS });
});

module.exports = router;
