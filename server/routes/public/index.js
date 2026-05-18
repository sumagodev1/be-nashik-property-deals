const express = require('express');
const properties = require('./properties');
const leads = require('./leads');
const generalEnquiries = require('./general-enquiries');
const cms = require('./cms');
const locations = require('./locations');
const stats = require('./stats');
const masters = require('./masters');

const router = express.Router();

router.use('/properties', properties);
router.use('/leads', leads);
router.use('/general-enquiries', generalEnquiries);
router.use('/cms', cms);
router.use('/locations', locations);
router.use('/stats', stats);
router.use('/masters', masters);

module.exports = router;
