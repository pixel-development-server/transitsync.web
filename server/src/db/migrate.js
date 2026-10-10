import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from '../config/env.js';
import { getDb, closeDb } from './connection.js';
import { PERMISSION_INDEX, ROLE_DEFAULTS } from './permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

/** Cheap content fingerprint so an edited migration is reported, not silently skipped. */
function checksum(contents) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < contents.length; i += 1) {
    hash ^= contents.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, checksum: checksum(sql) };
    });
}

/**
 * Drop every user table. Used by `npm run reset` and the test suite.
 * `foreign_keys` is disabled for the duration so drops happen in dependency order.
 */
export function dropAllTables(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all();
  for (const row of rows) {
    db.exec(`DROP TABLE IF EXISTS "${row.name}"`);
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('VACUUM');
}

export function runMigrations(db, { fresh = false, log = () => {} } = {}) {
  if (fresh) {
    log('Dropping existing tables ...');
    dropAllTables(db);
  }

  db.exec(TRACKING_TABLE);

  const applied = new Map(
    db.prepare('SELECT filename, checksum FROM schema_migrations').all().map((r) => [r.filename, r.checksum]),
  );
  const migrations = listMigrations();
  const results = [];

  for (const migration of migrations) {
    if (applied.has(migration.filename)) {
      if (applied.get(migration.filename) !== migration.checksum) {
        log(`  ! ${migration.filename} changed after being applied — skipping (already in your database)`);
      }
      results.push({ filename: migration.filename, applied: false, skipped: true });
      continue;
    }

    log(`  -> ${migration.filename}`);
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)').run(
        migration.filename,
        migration.checksum,
      );
    });
    results.push({ filename: migration.filename, applied: true });
  }

  syncPermissionCatalogue(db);
  return results;
}

/**
 * Keep the `permissions` catalogue in lockstep with `src/db/permissions.js`.
 * Called on every migration so new modules appear without a new SQL file.
 */
export function syncPermissionCatalogue(db) {
  const upsert = db.prepare(
    `INSERT INTO permissions (key, module, module_label, action, label)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       module = excluded.module,
       module_label = excluded.module_label,
       action = excluded.action,
       label = excluded.label`,
  );
  db.transaction(() => {
    for (const permission of PERMISSION_INDEX) {
      upsert.run(permission.key, permission.module, permission.module_label, permission.action, permission.label);
    }
  });

  const permissionIds = new Map(
    db.prepare('SELECT id, key FROM permissions').all().map((row) => [row.key, row.id]),
  );

  const upsertRole = db.prepare(
    `INSERT INTO roles (key, name, description, level, is_system)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       level = excluded.level`,
  );

  for (const [key, definition] of Object.entries(ROLE_DEFAULTS)) {
    db.transaction(() => {
      upsertRole.run(key, definition.label, definition.description, definition.level);
      const role = db.prepare('SELECT id FROM roles WHERE key = ?').get(key);
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id);
      const grant = db.prepare(
        'INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
      );
      for (const permissionKey of definition.permissions) {
        const permissionId = permissionIds.get(permissionKey);
        if (permissionId) grant.run(role.id, permissionId);
      }
    });
  }
}

/** Convenience: every permission key currently present in the database. */
export function loadPermissionMap(db) {
  const rows = db.prepare('SELECT id, key FROM permissions').all();
  return new Map(rows.map((row) => [row.key, row.id]));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const fresh = process.argv.includes('--fresh');
  const db = getDb();
  const log = (message) => process.stdout.write(`${message}\n`);

  log(`\nTransitSync migrations -> ${process.env.DB_FILE || config.paths.dbFile}\n`);
  try {
    const results = runMigrations(db, { fresh, log });
    const applied = results.filter((r) => r.applied).length;
    log(`\n  Done. ${applied} migration(s) applied, ${results.length} tracked.\n`);
    if (applied === 0 && !fresh) {
      log('  Run `npm run seed` to bootstrap the System Administrator and demo data.\n');
    }
  } catch (error) {
    process.stderr.write(`\n  Migration failed: ${error.message}\n\n`);
    process.exitCode = 1;
  } finally {
    closeDb();
  }
}
