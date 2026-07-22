const express = require('express');
const properties = require('./properties');
const leads = require('./leads');
const generalEnquiries = require('./general-enquiries');
const cms = require('./cms');
const locations = require('./locations');
const stats = require('./stats');
const masters = require('./masters');
const businessAssociates = require('./business-associates');
// T-2026-058: dependency-tree endpoint that replaces the FE's
// hardcoded chooserTree.js as the source of truth once migration
// 063 has run. See routes/public/property-catalog.js.
const propertyCatalog = require('./property-catalog');

const router = express.Router();

router.use('/properties', properties);
router.use('/leads', leads);
router.use('/general-enquiries', generalEnquiries);
router.use('/cms', cms);
router.use('/locations', locations);
router.use('/stats', stats);
router.use('/masters', masters);
router.use('/business-associates', businessAssociates);
router.use('/property-catalog', propertyCatalog);

module.exports = router;
