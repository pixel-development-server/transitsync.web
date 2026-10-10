import fs from 'node:fs';
import config from '../config/env.js';
import { openDatabase } from './driver.js';

let instance = null;

/**
 * Process-wide SQLite handle. SQLite is single-writer, and every route in this
 * service is short synchronous work, so one shared connection is both correct and
 * dramatically faster than a pool.
 */
export function getDb() {
  if (instance) return instance;

  const location = process.env.DB_FILE || config.paths.dbFile;
  if (location !== ':memory:') {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
  }

  instance = openDatabase(location);
  return instance;
}

/** Used by the test harness to spin up an isolated in-memory database. */
export function setDb(db) {
  instance = db;
  return instance;
}

export function closeDb() {
  if (instance) {
    instance.close();
    instance = null;
  }
}

export default getDb;
