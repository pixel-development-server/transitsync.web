import express from 'express';

import config from '../config/env.js';
import { getDb } from '../db/connection.js';
import { asyncHandler, validate } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { requireAuth } from '../middleware/auth.js';
import { recordAudit, fromRequest } from '../services/audit.js';
import { assertMaintenanceSwitchable } from '../services/maintenance.js';
import { settingsPatchSchema, backupFileSchema } from '../validation/schemas.js';

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// System configuration
// ---------------------------------------------------------------------------

const DEFAULTS = [
  { key: 'institution_name', value: 'TransitSync', label: 'Institution name', group: 'general' },
  { key: 'academic_year', value: '2024/25', label: 'Academic year', group: 'general' },
  { key: 'timezone', value: 'Asia/Kathmandu', label: 'Timezone', group: 'general' },
  { key: 'capacity_warning_pct', value: '85', label: 'Capacity warning threshold (%)', group: 'operations', type: 'number' },
  { key: 'alert_retention_days', value: '90', label: 'Alert retention (days)', group: 'security', type: 'number' },
  { key: 'allow_self_service_rfid', value: 'false', label: 'Allow self-service RFID issuance', group: 'operations', type: 'boolean' },
  { key: 'maintenance_mode', value: 'false', label: 'Maintenance mode', group: 'operations', type: 'boolean' },
  { key: 'maintenance_message', value: 'Server is currently under maintenance. Please try again later.', label: 'Maintenance message', group: 'operations' },
];

async function readSettings(db) {
  const stored = new Map((await db.all('SELECT * FROM settings')).map((row) => [row.key, row]));
  return DEFAULTS.map((definition) => {
    const row = stored.get(definition.key);
    const raw = row ? row.value : definition.value;
    const type = row?.value_type ?? definition.type ?? 'string';
    return {
      key: definition.key,
      label: row?.label ?? definition.label,
      group: row?.group_name ?? definition.group,
      valueType: type,
      value: type === 'boolean' ? raw === 'true' : type === 'number' ? Number(raw) : raw,
      default: definition.type === 'boolean' ? definition.value === 'true' : definition.type === 'number' ? Number(definition.value) : definition.value,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

const KEY_TO_SETTING = {
  institutionName: 'institution_name',
  academicYear: 'academic_year',
  timezone: 'timezone',
  capacityWarningPct: 'capacity_warning_pct',
  alertRetentionDays: 'alert_retention_days',
  allowSelfServiceRfid: 'allow_self_service_rfid',
  maintenanceMode: 'maintenance_mode',
  maintenanceMessage: 'maintenance_message',
};

router.get(
  '/',
  requirePermission('settings:read'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const size = await db.get(
      `SELECT COALESCE(SUM(data_length + index_length), 0) AS size_bytes
         FROM information_schema.tables
        WHERE table_schema = DATABASE()`,
    );

    res.json({
      success: true,
      data: {
        settings: await readSettings(db),
        system: {
          nodeEnv: config.nodeEnv,
          version: '1.0.0',
          databaseSizeBytes: size.size_bytes,
          permissions: (await db.get('SELECT COUNT(*) AS n FROM permissions')).n,
          roles: (await db.get('SELECT COUNT(*) AS n FROM roles')).n,
          users: (await db.get('SELECT COUNT(*) AS n FROM users')).n,
        },
      },
    });
  }),
);

/**
 * Shared update handler. Registered for both PATCH and PUT so clients that model
 * a full-record update as PUT (and any legacy caller hitting /api/settings) work.
 */
const updateSettings = asyncHandler(async (req, res) => {
  const db = getDb();
  const changed = {};

  await db.transaction(async () => {
    for (const [field, key] of Object.entries(KEY_TO_SETTING)) {
      if (req.body[field] === undefined) continue;
      const definition = DEFAULTS.find((entry) => entry.key === key);
      const type = definition?.type ?? 'string';
      const value = type === 'boolean' ? String(Boolean(req.body[field])) : String(req.body[field]);

      // Turning maintenance ON with nobody able to turn it off would lock the
      // whole campus out, so refuse it until a Super Administrator exists.
      if (key === 'maintenance_mode') await assertMaintenanceSwitchable(db, value === 'true');

      changed[key] = value;

      await db.run(
        `INSERT INTO settings (\`key\`, value, label, group_name, value_type, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           value = VALUES(value), updated_by = VALUES(updated_by), updated_at = NOW()`,
        key, value, definition?.label ?? key, definition?.group ?? 'general', type, req.user.id,
      );

      if (key === 'institution_name') {
        await db.run("REPLACE INTO system_meta (\`key\`, value, updated_at) VALUES ('institution_name', ?, NOW())", value);
      }
    }
  });

  recordAudit(fromRequest(req, 'settings.update', { entity: 'settings', detail: changed }));
  res.json({ success: true, data: { settings: await readSettings(db), changed } });
});

router.patch('/', requirePermission('settings:edit'), validate(settingsPatchSchema), updateSettings);
router.put('/', requirePermission('settings:edit'), validate(settingsPatchSchema), updateSettings);

// ---------------------------------------------------------------------------
// Database backup — System Administrator only
// ---------------------------------------------------------------------------

/**
 * Logical dump of every base table (schema DDL + one INSERT per row) written
 * to `target`. The snapshot is assembled through the pool: `SHOW CREATE TABLE`
 * for each table, then `SELECT *` to serialise its rows.
 */
async function writeLogicalDump(db, target) {
  const fs = await import('node:fs');
  const tables = await db.all(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
  );

  const literal = (value) => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  };

  const lines = ['-- TransitSync logical database backup'];
  for (const { name } of tables) {
    const [createRow] = await db.all(`SHOW CREATE TABLE \`${name}\``);
    lines.push('', `DROP TABLE IF EXISTS \`${name}\`;`, `${createRow['Create Table']};`);

    const rows = await db.all(`SELECT * FROM \`${name}\``);
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    const columnList = columns.map((column) => `\`${column}\``).join(', ');
    for (const row of rows) {
      lines.push(
        `INSERT INTO \`${name}\` (${columnList}) VALUES (${columns.map((column) => literal(row[column])).join(', ')});`,
      );
    }
  }

  fs.writeFileSync(target, `${lines.join('\n')}\n`);
}

router.get(
  '/backups',
  requirePermission('backup:create'),
  asyncHandler(async (req, res) => {
    const fs = await import('node:fs');
    const files = fs
      .readdirSync(config.paths.backupDir)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => {
        const stats = fs.statSync(`${config.paths.backupDir}/${file}`);
        return {
          file,
          sizeBytes: stats.size,
          createdAt: stats.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    res.json({ success: true, data: { backups: files } });
  }),
);

/**
 * Consistent snapshot via a logical dump (see `writeLogicalDump`). Safe to run
 * while the server is serving traffic because it only reads from the pool.
 */
router.post(
  '/backups',
  requirePermission('backup:create'),
  asyncHandler(async (req, res) => {
    const fs = await import('node:fs');
    const db = getDb();

    const pad = (value) => String(value).padStart(2, '0');
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const file = `transitsync-${stamp}.sql`;
    const target = `${config.paths.backupDir}/${file}`;

    if (fs.existsSync(target)) fs.rmSync(target);
    await writeLogicalDump(db, target);

    const stats = fs.statSync(target);
    recordAudit(fromRequest(req, 'backup.create', { entity: 'backup', entityId: file, detail: { sizeBytes: stats.size } }));

    res.status(201).json({
      success: true,
      data: { file, sizeBytes: stats.size, createdAt: stats.mtime.toISOString() },
    });
  }),
);

router.get(
  '/backups/:file',
  requirePermission('backup:create'),
  validate(backupFileSchema, 'params'),
  asyncHandler(async (req, res) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const file = req.params.file;
    const target = path.join(config.paths.backupDir, file);

    // Defence in depth: the schema already restricts the character set.
    if (path.dirname(path.resolve(target)) !== path.resolve(config.paths.backupDir)) {
      throw badRequest('Invalid backup path.');
    }
    if (!fs.existsSync(target)) throw notFound('Backup file');

    recordAudit(fromRequest(req, 'backup.download', { entity: 'backup', entityId: file }));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
    fs.createReadStream(target).pipe(res);
  }),
);

router.delete(
  '/backups/:file',
  requirePermission('backup:create'),
  validate(backupFileSchema, 'params'),
  asyncHandler(async (req, res) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const target = path.join(config.paths.backupDir, req.params.file);
    if (!fs.existsSync(target)) throw notFound('Backup file');

    fs.rmSync(target);
    recordAudit(fromRequest(req, 'backup.delete', { entity: 'backup', entityId: req.params.file }));
    res.json({ success: true, data: { message: 'Backup deleted.' } });
  }),
);

export default router;
