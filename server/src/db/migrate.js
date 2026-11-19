import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config from '../config/env.js';
import { db, adminPool, closeDb } from '../../db.js';
import { PERMISSION_INDEX, ROLE_DEFAULTS } from './permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(__dirname, '..', '..', 'sql', 'schema.sql');

/** Cheap content fingerprint so an edited schema is reported, not silently skipped. */
function checksum(contents) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < contents.length; i += 1) {
    hash ^= contents.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Drop every user table (fresh install / test reset). Runs with foreign-key
 * checks off so the drops can happen in any order, then restores them.
 */
export async function dropAllTables() {
  await adminPool.query('SET FOREIGN_KEY_CHECKS = 0');
  const [tables] = await adminPool.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?",
    [config.db.database],
  );
  for (const row of tables) {
    await adminPool.query(`DROP TABLE IF EXISTS \`${row.name}\``);
  }
  await adminPool.query('SET FOREIGN_KEY_CHECKS = 1');
}

/**
 * Apply `server/sql/schema.sql`. The DDL is idempotent (IF NOT EXISTS), so this
 * is safe to run on every boot; the `schema_migrations` row records the checksum
 * so an edited schema is surfaced rather than silently ignored.
 */
export async function runMigrations({ fresh = false, log = () => {} } = {}) {
  if (fresh) {
    log('Dropping existing tables ...');
    await dropAllTables();
  }

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const sum = checksum(sql);

  log('  -> applying sql/schema.sql');
  // The schema script sets FOREIGN_KEY_CHECKS around itself; run it as one
  // multi-statement script on the admin pool.
  await adminPool.query(sql);

  const [[existing]] = await adminPool.query(
    'SELECT checksum FROM schema_migrations WHERE filename = ?',
    ['schema.sql'],
  );
  if (existing && existing.checksum !== sum) {
    log('  ! sql/schema.sql changed since last apply — re-applied (idempotent).');
  }
  await adminPool.query(
    `INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE checksum = VALUES(checksum)`,
    ['schema.sql', sum],
  );

  await syncPermissionCatalogue();
  await syncInstitutionEmailDomains();
  return [{ filename: 'schema.sql', applied: true }];
}

/**
 * Learn institutional email domains from the campus administrators already in
 * the database. A college provisioned before Google Sign-In existed still gets
 * a usable domain mapping on the next boot; explicit rows (registered through
 * the Platform Master UI) always win because `INSERT IGNORE` never overwrites.
 */
export async function syncInstitutionEmailDomains() {
  await db.run(
    `INSERT IGNORE INTO institution_email_domains (domain, institution_id)
     SELECT DISTINCT LOWER(SUBSTRING_INDEX(u.email, '@', -1)), u.tenant_id
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.tenant_id IS NOT NULL
        AND r.\`key\` IN ('system_admin', 'admin')
        AND u.email LIKE '%@%'
        AND SUBSTRING_INDEX(u.email, '@', -1) <> ''`,
  );
}

/**
 * Keep the `permissions` catalogue in lockstep with `src/db/permissions.js`.
 * Called on every migration so new modules appear without a schema change.
 */
export async function syncPermissionCatalogue() {
  await db.transaction(async (tx) => {
    for (const permission of PERMISSION_INDEX) {
      await tx.run(
        `INSERT INTO permissions (\`key\`, module, module_label, action, label)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           module = VALUES(module),
           module_label = VALUES(module_label),
           action = VALUES(action),
           label = VALUES(label)`,
        permission.key,
        permission.module,
        permission.module_label,
        permission.action,
        permission.label,
      );
    }
  });

  const permissionIds = new Map(
    (await db.all('SELECT id, `key` FROM permissions')).map((row) => [row.key, row.id]),
  );

  for (const [key, definition] of Object.entries(ROLE_DEFAULTS)) {
    await db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO roles (\`key\`, name, description, level, is_system)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           description = VALUES(description),
           level = VALUES(level)`,
        key,
        definition.label,
        definition.description,
        definition.level,
      );
      const role = await tx.get('SELECT id FROM roles WHERE `key` = ?', key);
      await tx.run('DELETE FROM role_permissions WHERE role_id = ?', role.id);
      for (const permissionKey of definition.permissions) {
        const permissionId = permissionIds.get(permissionKey);
        if (permissionId) {
          await tx.run(
            'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
            role.id,
            permissionId,
          );
        }
      }
    });
  }
}

/** Convenience: every permission key currently present in the database. */
export async function loadPermissionMap() {
  const rows = await db.all('SELECT id, `key` FROM permissions');
  return new Map(rows.map((row) => [row.key, row.id]));
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const fresh = process.argv.includes('--fresh');
  const log = (message) => process.stdout.write(`${message}\n`);

  log(`\nTransitSync schema -> mysql://${config.db.host}:${config.db.port}/${config.db.database}\n`);
  try {
    const results = await runMigrations({ fresh, log });
    const applied = results.filter((r) => r.applied).length;
    log(`\n  Done. ${applied} schema step(s) applied.\n`);
  } catch (error) {
    process.stderr.write(`\n  Migration failed: ${error.message}\n\n`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
