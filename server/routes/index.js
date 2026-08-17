const express = require('express');
const health = require('./health');
const auth = require('./auth');
const admin = require('./admin');
const seller = require('./seller');
const publicRoutes = require('./public');
const cron = require('./cron');
// T-2026-164: Google Calendar OAuth (Strategy B) live-mode routes.
// Mounted at /api/google-calendar (NOT under /admin/crm) because the
// callback endpoint is invoked directly by Google's browser redirect
// and must NOT sit behind the admin bearer-token middleware. See
// server/routes/google-calendar.js for the endpoint list.
const googleCalendar = require('./google-calendar');

const router = express.Router();

router.use('/health', health);
router.use('/auth', auth);
router.use('/admin', admin);
router.use('/seller', seller);
router.use('/public', publicRoutes);
router.use('/cron', cron);
router.use('/google-calendar', googleCalendar);

module.exports = router;
