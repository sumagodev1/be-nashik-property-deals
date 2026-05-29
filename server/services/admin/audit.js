/**
 * Convenience wrapper around `db/queries/audit_log.append` that pulls actor
 * info out of the Express `req` object so call sites stay short:
 *
 *   const audit = require('./audit');
 *   await audit.record(req, {
 *     action: 'lead.status.changed',
 *     entityType: 'lead',
 *     entityId: leadId,
 *     summary: `Lead #${leadId} → contacted`,
 *     metadata: { from: 'new', to: 'contacted' },
 *   });
 *
 * Best practice: call this *after* the mutation has been persisted, so an
 * audit-log issue can never invalidate the actual change.
 */

const repo = require('../../db/queries/audit_log');
const adminsRepo = require('../../db/queries/admins');
const subAdminsRepo = require('../../db/queries/sub_admins');

/**
 * Best-effort actor name resolution. The JWT payload only carries `sub` and
 * `role`, so we fall back to looking up the admin / sub-admin row by id when
 * the name isn't already attached to req.auth. Cached for the lifetime of
 * the process (admin names rarely change).
 */
const nameCache = new Map(); // key = `${actorType}:${actorId}` → fullName

async function resolveActorName(actorType, actorId) {
  if (!actorId) return null;
  const key = `${actorType}:${actorId}`;
  if (nameCache.has(key)) return nameCache.get(key);
  try {
    const row = actorType === 'sub_admin'
      ? await subAdminsRepo.findById(actorId)
      : await adminsRepo.findActiveById(actorId);
    const name = row?.full_name || row?.email || null;
    nameCache.set(key, name);
    return name;
  } catch {
    return null;
  }
}

async function record(req, entry) {
  const actor = req?.auth || {};
  const actorType = actor.role || 'admin';
  const actorId = Number(actor.sub) || 0;
  const actorName =
    actor.fullName ||
    actor.name ||
    actor.email ||
    (await resolveActorName(actorType, actorId));
  return repo.append({
    actorType,
    actorId,
    actorName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    summary: entry.summary,
    metadata: entry.metadata,
    ipAddress: req?.ip || null,
  });
}

function list(filters) {
  return repo.list(filters);
}

module.exports = { record, list };
