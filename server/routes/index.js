const express = require('express');
const health = require('./health');
const auth = require('./auth');
const admin = require('./admin');
const seller = require('./seller');
const publicRoutes = require('./public');
const cron = require('./cron');

const router = express.Router();

router.use('/health', health);
router.use('/auth', auth);
router.use('/admin', admin);
router.use('/seller', seller);
router.use('/public', publicRoutes);
router.use('/cron', cron);

module.exports = router;
