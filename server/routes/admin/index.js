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
const auditLog = require('./audit-log');
const landRecords = require('./land-records');
const businessAssociates = require('./business-associates');
const ownerSearch = require('./owner-search');
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
router.use('/audit-log', auditLog);
router.use('/land-records', landRecords);
router.use('/business-associates', businessAssociates);
router.use('/owner-search', ownerSearch);

router.get('/modules', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ modules: MODULE_KEYS });
});

module.exports = router;
