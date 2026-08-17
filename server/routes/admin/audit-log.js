const express = require('express');
const Joi = require('joi');

const { validate } = require('../../middleware/validate');
const {
  requireAuth,
  requireModule,
  requireModuleWriteOnMutation,
} = require('../../middleware/auth');
const audit = require('../../services/admin/audit');
const { MODULES } = require('../../constants/modules');

const router = express.Router();

// T-2026-173-B: Audit Log is now a grantable module. Administrator role
// bypasses. Sub-admins with AUDIT_LOG (read) can see the audit trail.
// The write gate is applied for future-proofing but the router currently
// has no mutating verbs (audit log is append-only, populated by the
// services layer -- never through a direct API mutation). Existing
// sub-admins have NO grant on deploy so the audit surface remains hidden
// from them until a grant is explicitly created.
router.use(
  requireAuth,
  requireModule(MODULES.AUDIT_LOG),
  requireModuleWriteOnMutation(MODULES.AUDIT_LOG),
);

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(25),
  action: Joi.string().trim().max(64).optional(),
  entityType: Joi.string().trim().max(64).optional(),
  entityId: Joi.number().integer().positive().optional(),
  actorType: Joi.string().valid('admin', 'sub_admin').optional(),
  actorId: Joi.number().integer().positive().optional(),
  search: Joi.string().trim().max(255).allow('').optional(),
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { rows, total } = await audit.list(req.query);
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorName: r.actor_name,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        summary: r.summary,
        metadata: r.metadata ? safeJson(r.metadata) : null,
        ipAddress: r.ip_address,
        createdAt: r.created_at,
      })),
      page: req.query.page,
      pageSize: req.query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / req.query.pageSize)),
    });
  } catch (e) { next(e); }
});

function safeJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = router;
