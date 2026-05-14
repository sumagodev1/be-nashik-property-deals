const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const {
  PROPERTY_TYPES,
  TRANSACTION_TYPES,
  INVENTORY_STATUSES,
  AREA_UNITS,
} = require('../../constants/property');
const { APPROVAL_STATUSES } = require('../../constants/website');

const router = express.Router();

router.use(requireAuth);

router.get('/property', requireRole('admin', 'sub_admin'), (req, res) => {
  res.json({
    propertyTypes: PROPERTY_TYPES,
    transactionTypes: TRANSACTION_TYPES,
    inventoryStatuses: INVENTORY_STATUSES,
    approvalStatuses: APPROVAL_STATUSES,
    areaUnits: AREA_UNITS,
  });
});

module.exports = router;
