#!/usr/bin/env node
/**
 * One-shot data copy: the archived SQLite snapshot (server/data/archive/)
 * → the live MariaDB schema.
 *
 *   node scripts/copy-sqlite-to-mysql.js [--dry-run] [--truncate] [--allow-orphans]
 *
 * What it guarantees
 * ------------------
 * 1. **NPT shift.** Every value that is exactly a bare
 *    `YYYY-MM-DD HH:MM:SS[.fff]` stamp is rewritten +5:45 (UTC wall clock →
 *    Nepal wall clock), matching the `+05:45` session the app now runs at.
 *    DATE-only values (`YYYY-MM-DD` — calendar dates like pass windows and
 *    `visitor_counts.day`) and `HH:MM` timetable strings are left untouched,
 *    and so are JSON blobs / free text that merely *contain* dates, because
 *    only whole-value matches are rewritten. 2. **FK order.** Insert order is a
 *    topological sort of the *live* MySQL foreign keys (read from
 *    `information_schema`), so referential integrity is validated by MySQL
 *    itself during the load — checks stay ON unless `--allow-orphans`.
 * 3. **Atomicity.** The whole load runs in one transaction on one connection;
 *    any failure rolls back to the pre-copy state.
 * 4. **Verification.** Row counts are compared table by table after commit,
 *    and sample timestamps are printed so the +5:45 shift is visible.
 *
 * `schema_migrations` is deliberately NOT copied: that table belongs to the
 * MySQL flow (`runMigrations` records its own `schema.sql` checksum on boot).
 *
 * The self-referencing `users.created_by` FK forces row-by-row inserts for
 * `users` (id order: a creator always exists before the account it created).
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closeDb } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = path.resolve(__dirname, '..', 'data', 'archive', 'transitsync.sqlite');

/** Whole-value bare stamps only — the sole shape this migrator rewrites. */
const BARE_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
const BATCH_ROWS = 100;
const SKIP_TABLES = new Set(['schema_migrations']);

const flags = new Set(process.argv.slice(2));
const DRY_RUN = flags.has('--dry-run');
const TRUNCATE = flags.has('--truncate');
const ALLOW_ORPHANS = flags.has('--allow-orphans');

const log = (message) => process.stdout.write(`${message}\n`);
const fail = (message) => {
  process.stderr.write(`\n  COPY FAILED: ${message}\n\n`);
  process.exitCode = 1;
};

/** SQLite UTC wall clock → MySQL NPT wall clock. Non-stamps pass through. */
function shiftStamp(value) {
  if (typeof value !== 'string' || !BARE_STAMP.test(value)) return value;
  const instant = Date.parse(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(instant)) {
    throw new Error(`unparseable timestamp "${value}"`);
  }
  return new Date(instant + NPT_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 19);
}

/** Kahn topological sort over child→parent FK edges; parents load first. */
function topoSort(tables, parentsOf) {
  const remaining = new Set(tables);
  const order = [];
  while (remaining.size) {
    const ready = [...remaining]
      .filter((t) => ![...parentsOf.get(t)].some((p) => remaining.has(p) && p !== t))
      .sort();
    if (!ready.length) {
      throw new Error(`FK cycle among: ${[...remaining].join(', ')}`);
    }
    for (const table of ready) {
      remaining.delete(table);
      order.push(table);
    }
  }
  return order;
}

async function main() {
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });

  // --- inventory -----------------------------------------------------------
  const sqliteTables = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
    .filter((name) => !SKIP_TABLES.has(name));

  const [fkRows] = await pool.query(
    `SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  const parentsOf = new Map(sqliteTables.map((t) => [t, new Set()]));
  const selfReferencing = new Set();
  for (const row of fkRows) {
    if (!parentsOf.has(row.child)) continue;
    if (row.parent === row.child) {
      selfReferencing.add(row.child);
      continue;
    }
    if (parentsOf.has(row.parent)) parentsOf.get(row.child).add(row.parent);
  }

  const order = topoSort(sqliteTables, parentsOf);
  log(`\nSQLite -> MySQL  (${path.relative(process.cwd(), SQLITE_PATH)})`);
  log(`Load order: ${order.join(' -> ')}\n`);

  // --- emptiness gate ------------------------------------------------------
  const counts = new Map();
  for (const table of order) {
    const sourceRow = sqlite.prepare(`SELECT COUNT(*) AS n FROM \`${table}\``).get();
    const source = Number(sourceRow?.n ?? 0);
    counts.set(table, { source, target: 0 });
    const [[targetRow]] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
    counts.get(table).target = Number(targetRow.n);
  }

  const occupied = [...order].filter((t) => counts.get(t).target > 0);
  if (occupied.length && !TRUNCATE && !DRY_RUN) {
    fail(
      `target tables already hold rows: ${occupied.join(', ')}. ` +
        'Re-run with --truncate to replace them (wipes the target), or --dry-run to inspect.',
    );
    sqlite.close();
    await closeDb();
    return;
  }

  const sourceTotal = [...counts.values()].reduce((sum, c) => sum + c.source, 0);
  if (DRY_RUN) {
    log('table                     sqlite   mysql');
    for (const table of order) {
      const c = counts.get(table);
      log(`${table.padEnd(25)} ${String(c.source).padStart(6)}   ${String(c.target).padStart(6)}`);
    }
    log(`\n[dry-run] ${sourceTotal} source rows total; no rows written.\n`);
    sqlite.close();
    await closeDb();
    return;
  }

  // --- load ----------------------------------------------------------------
  const conn = await pool.getConnection();
  const summary = [];
  try {
    await conn.beginTransaction();

    if (TRUNCATE && occupied.length) {
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const table of [...order].reverse()) {
        if (counts.get(table).target > 0) await conn.query(`TRUNCATE TABLE \`${table}\``);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
    if (ALLOW_ORPHANS) {
      log('  ! FK checks disabled for this load (--allow-orphans)');
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    }

    let totalRows = 0;
    let totalShifted = 0;

    for (const table of order) {
      // Column intersection — an unmatched SQLite column would silently drop data.
      const sqliteColumns = sqlite
        .prepare(`SELECT name FROM pragma_table_info('${table}')`)
        .all()
        .map((row) => row.name);
      const [mysqlColumns] = await pool.query(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [table],
      );
      const mysqlNames = new Set(mysqlColumns.map((c) => c.name));
      const missing = sqliteColumns.filter((c) => !mysqlNames.has(c));
      if (missing.length) {
        throw new Error(
          `${table}: SQLite column(s) ${missing.join(', ')} have no MySQL counterpart — ` +
            'the DDL would drop data; resolve the schema drift first.',
        );
      }
      const columns = sqliteColumns.filter((c) => mysqlNames.has(c));
      if (!columns.length) continue;

      const rows = sqlite
        .prepare(
          `SELECT * FROM \`${table}\`${
            sqliteColumns.includes('id') ? ' ORDER BY id' : ''
          }`,
        )
        .all();
      if (!rows.length) continue;

      const colList = columns.map((c) => `\`${c}\``).join(', ');
      const placeholders = `(${columns.map(() => '?').join(', ')})`;
      let shifted = 0;

      const bindRow = (row) => {
        const values = columns.map((column) => {
          const original = row[column];
          let value;
          try {
            value = shiftStamp(original);
          } catch (error) {
            throw new Error(`${table}.${column}: ${error.message}`);
          }
          if (typeof value === 'string' && value !== original) shifted += 1;
          return value;
        });
        return values;
      };

      // Row-by-row for self-referencing tables so a creator row always exists
      // before the account that names it; everything else batches.
      if (selfReferencing.has(table)) {
        for (const row of rows) {
          await conn.execute(`INSERT INTO \`${table}\` (${colList}) VALUES ${placeholders}`, bindRow(row));
        }
      } else {
        for (let i = 0; i < rows.length; i += BATCH_ROWS) {
          const slice = rows.slice(i, i + BATCH_ROWS);
          const values = slice.map(bindRow);
          const sql = `INSERT INTO \`${table}\` (${colList}) VALUES ${values
            .map(() => placeholders)
            .join(', ')}`;
          try {
            await conn.execute(sql, values.flat());
          } catch (error) {
            // Narrow the failing row before rolling back so the report is actionable.
            for (let r = 0; r < slice.length; r += 1) {
              try {
                await conn.execute(
                  `INSERT INTO \`${table}\` (${colList}) VALUES ${placeholders}`,
                  values[r],
                );
              } catch (rowError) {
                const sample = JSON.stringify(slice[r]).slice(0, 400);
                throw new Error(`${table} row ${i + r + 1}: ${rowError.message} | ${sample}`);
              }
            }
            throw error;
          }
        }
      }

      summary.push({ table, rows: rows.length, shifted });
      totalRows += rows.length;
      totalShifted += shifted;
      log(`  ${table.padEnd(25)} ${String(rows.length).padStart(7)} rows  (${shifted} stamps shifted)`);
    }

    await conn.commit();
    log(`\n  Inserted ${totalRows} rows, shifted ${totalShifted} timestamps +5:45.\n`);

    // --- verification ------------------------------------------------------
    let mismatches = 0;
    for (const table of order) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      const expected = counts.get(table).source;
      const actual = Number(n);
      if (actual !== expected) {
        mismatches += 1;
        log(`  MISMATCH ${table}: sqlite=${expected} mysql=${actual}`);
      }
    }
    if (mismatches) {
      throw new Error(`${mismatches} table(s) failed the row-count verification`);
    }
    log('  Row counts verified: all tables match SQLite.');

    // Visible proof of the shift, read straight back from both engines.
    const srcScan = sqlite.prepare('SELECT MIN(scan_time) AS lo, MAX(scan_time) AS hi FROM scan_events').get();
    const [[dstScan]] = await conn.query('SELECT MIN(scan_time) AS lo, MAX(scan_time) AS hi FROM scan_events');
    log(`  scan_time  sqlite: ${srcScan.lo} .. ${srcScan.hi}`);
    log(`  scan_time  mysql : ${dstScan.lo} .. ${dstScan.hi}   (expect +5:45)`);

    if (ALLOW_ORPHANS) await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    await conn.commit();
  } catch (error) {
    try {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      await conn.rollback();
    } catch {
      /* connection may already be unusable; the release still restores the pool */
    }
    fail(error.message);
  } finally {
    conn.release();
    sqlite.close();
    await closeDb();
  }
}

await main();
