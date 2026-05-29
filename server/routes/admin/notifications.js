const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { HttpError } = require('../../middleware/errors');
const notifications = require('../../db/queries/notifications');

const router = express.Router();

// Auth: any logged-in admin or sub-admin can hit notifications endpoints.
// Module-scoping is applied per-row inside the query (admins see all,
// sub-admins see only notifications matching their assigned module_keys).
router.use(requireAuth, requireRole('admin', 'sub_admin'));

const listQuery = Joi.object({
  isRead: Joi.boolean().optional(),
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0),
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

function allowedModulesFor(req) {
  // Admin sees everything (null = no module filter).
  // Sub-admin sees only notifications whose module_key is null OR in their modules.
  if (req.auth.role === 'admin') return null;
  return Array.isArray(req.auth.modules) ? req.auth.modules : [];
}

function actorFor(req) {
  // Used for per-user targeted notifications. Privately targeted rows are
  // visible only when this actor matches the row's target.
  return { type: req.auth.role, id: Number(req.auth.sub) || 0 };
}

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { rows, total } = await notifications.list({
      allowedModules: allowedModulesFor(req),
      actor: actorFor(req),
      isRead: req.query.isRead,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    res.json({ data: rows.map(toItem), total, limit: req.query.limit, offset: req.query.offset });
  } catch (e) { next(e); }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await notifications.unreadCount({
      allowedModules: allowedModulesFor(req),
      actor: actorFor(req),
    });
    res.json({ count });
  } catch (e) { next(e); }
});

router.patch('/:id/read', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const ok = await notifications.markRead(req.params.id, {
      allowedModules: allowedModulesFor(req),
      actor: actorFor(req),
    });
    // `ok = false` means the row doesn't exist OR is outside the caller's
    // module scope. 404 in both cases so we don't leak whether a notification
    // exists for a module the sub-admin can't see.
    if (!ok) throw new HttpError(404, 'NOT_FOUND', 'Notification not found');
    res.json({ ok });
  } catch (e) { next(e); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const updated = await notifications.markAllRead({
      allowedModules: allowedModulesFor(req),
      actor: actorFor(req),
    });
    res.json({ updated });
  } catch (e) { next(e); }
});

function toItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    relatedKind: row.related_kind,
    relatedId: row.related_id !== null ? Number(row.related_id) : null,
    moduleKey: row.module_key,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}

module.exports = router;
