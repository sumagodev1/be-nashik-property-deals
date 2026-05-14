/**
 * Admin-only operational view over the email_outbox table. Lets an admin see
 * what's queued, manually run the worker ("Run now"), retry a single row,
 * or discard a row.
 *
 * Sub admins do NOT get access — this is system plumbing, not a regular
 * module flow.
 */

const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { HttpError } = require('../../middleware/errors');
const outboxRepo = require('../../db/queries/email_outbox');
const outbox = require('../../services/email/outbox');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(25),
  status: Joi.string().valid('pending', 'sent', 'failed').optional(),
});

const processBody = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(outbox.DEFAULT_BATCH_SIZE),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { rows, total } = await outboxRepo.listForAdmin(req.query);
    res.json({
      data: rows.map(toRow),
      page: req.query.page,
      pageSize: req.query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / req.query.pageSize)),
    });
  } catch (e) { next(e); }
});

router.get('/stats', async (req, res, next) => {
  try { res.json(await outboxRepo.counters()); } catch (e) { next(e); }
});

router.post('/process', validate(processBody), async (req, res, next) => {
  try {
    const summary = await outbox.processBatch({ limit: req.body.limit });
    res.json(summary);
  } catch (e) { next(e); }
});

router.post('/:id/retry', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await outboxRepo.findById(req.params.id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Row not found');
    await outboxRepo.requeue(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const row = await outboxRepo.findById(req.params.id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Row not found');
    await outboxRepo.deleteRow(req.params.id);
    res.status(204).end();
  } catch (e) { next(e); }
});

function toRow(r) {
  return {
    id: r.id,
    toAddress: r.to_address,
    subject: r.subject,
    status: r.status,
    attempts: Number(r.attempts || 0),
    lastError: r.last_error,
    nextAttemptAt: r.next_attempt_at,
    sentAt: r.sent_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = router;
