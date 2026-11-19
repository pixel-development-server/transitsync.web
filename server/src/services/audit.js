import { getDb } from '../db/connection.js';

/**
 * Append-only trail of privileged actions. Written outside the request's
 * transaction so an audit row survives even if the caller rolls back, and so a
 * failed login is recorded too.
 *
 * Fire-and-forget: returns a promise but callers deliberately do NOT await it
 * (auditing must never slow the request it describes). Rejections are swallowed
 * here so an unwrapped call can never surface as an unhandled rejection.
 *
 * Writes are serialised on one queue so insertion order matches the trail's
 * append-only reading, and `drainAuditWrites()` lets the HTTP layer hold a JSON
 * response until the rows it describes have committed — restoring
 * read-after-write visibility without awaiting at ~50 call sites.
 */
let writeQueue = Promise.resolve();

export function recordAudit(entry = {}) {
  const db = getDb();
  writeQueue = writeQueue
    .then(() =>
      db.run(
        `INSERT INTO audit_logs (user_id, actor_email, action, entity, entity_id, detail, ip, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.userId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.entity ?? null,
        entry.entityId != null ? String(entry.entityId) : null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        entry.ip ?? null,
        entry.status ?? 'success',
      ),
    )
    .catch((error) => {
      // Auditing must never break the request it is describing.
      process.stderr.write(`[audit] failed to record "${entry.action}": ${error.message}\n`);
    });
  return writeQueue;
}

/** Resolves once every audit write queued so far has committed (or failed). */
export function drainAuditWrites() {
  return writeQueue;
}

/** Build an audit entry from an Express request. */
export function fromRequest(req, action, extra = {}) {
  return {
    userId: req.user?.id ?? null,
    actorEmail: req.user?.email ?? null,
    action,
    ip: clientIp(req),
    ...extra,
  };
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

export async function listAudit(db, { limit = 50, userId = null, action = null, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (userId) {
    clauses.push('a.user_id = ?');
    params.push(userId);
  }
  if (action) {
    clauses.push('a.action LIKE ?');
    params.push(`%${action}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.all(
    `SELECT a.*, u.full_name AS user_name
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );

  const total = (await db.get(`SELECT COUNT(*) AS n FROM audit_logs a ${where}`, ...params)).n;
  return { rows, total };
}

export default { recordAudit, drainAuditWrites, fromRequest, clientIp, listAudit };
