import { db, closeDb as closePool } from '../../db.js';

/**
 * Compatibility bridge to the database facade in `server/db.js`.
 *
 * Every route and service resolves its handle through `getDb()`, which returns
 * the process-wide async facade (`all` / `get` / `run` / `transaction`). Every
 * statement it exposes returns a Promise and must be awaited.
 */
export function getDb() {
  return db;
}

/** Test hook kept for source compatibility; the MySQL pool is process-wide. */
export function setDb() {
  return db;
}

export function closeDb() {
  return closePool();
}

export default getDb;
