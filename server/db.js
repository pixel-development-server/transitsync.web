/**
 * TransitSync MySQL data access layer.
 *
 * Every query in the service funnels through the pool created here. The module
 * exports:
 *
 *   pool       — the raw mysql2/promise pool (use `await pool.execute(...)` when
 *                you need the literal MySQL API, e.g. inside routes that want to
 *                see the [rows, fields] shape themselves);
 *   db         — a thin async facade (`all` / `get` / `run` / `exec`) that keeps
 *                route code readable (`run()` still resolves to
 *                `{ changes, lastInsertRowid }`);
 *   adminPool  — a dedicated multi-statement pool used ONLY by the schema
 *                applier / supervisor pre-flight (the app pool never allows
 *                multi-statement SQL);
 *   ping()     — connectivity probe used by the startup supervisor;
 *   closeDb()  — graceful shutdown.
 *
 * Timestamps: the MySQL server and every session opened from this pool run at
 * Nepal Standard Time (`+05:45`), so `NOW()` inside SQL and timestamps written
 * by the application agree — all persisted instants are NPT wall time.
 * `dateStrings: true` makes the server return DATETIME/TIMESTAMP columns as
 * plain `YYYY-MM-DD HH:MM:SS` strings, so every comparison, formatter and test
 * that treats timestamps as strings stays straightforward.
 *
 * Transactions: the historical code style is a *closure* — statements inside
 * `db.transaction(() => { db.prepare(...) })` reference the module-level `db`,
 * not a `tx` parameter. To keep every one of those call sites both correct and
 * readable, the active transaction's connection is published through an
 * AsyncLocalStorage: `db.all/get/run/prepare` resolve the connection as
 * `explicit tx handle -> ALS transaction connection -> pool`. Nested
 * `db.transaction()` calls become SAVEPOINTs.
 */
import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import config from './src/config/env.js';

const NPT_OFFSET = '+05:45';

/** Active transaction connection for the current async context (or null). */
const txScope = new AsyncLocalStorage();

function poolSettings(extra = {}) {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    charset: 'utf8mb4',
    // Sessions speak Nepal Standard Time; NOW() and column defaults are NPT.
    timezone: NPT_OFFSET,
    // Return DATE/DATETIME/TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' strings — the
    // exact shape the app stored in SQLite TEXT columns and parsed in JS.
    dateStrings: true,
    connectionLimit: config.db.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    ...extra,
  };
}

export const pool = mysql.createPool(poolSettings());

/**
 * Schema/maintenance pool. `multipleStatements` is deliberately confined to
 * this handle: it lets `server/sql/schema.sql` be applied as one script, and it
 * is never reachable from request handlers.
 */
export const adminPool = mysql.createPool(poolSettings({ multipleStatements: true }));

/**
 * Create the configured database if it is missing. Opens a schemaless
 * connection (the pools themselves target `config.db.database` and would fail
 * to connect if it did not exist). Used by the test harness, which points
 * `DB_NAME` at a throwaway per-process schema.
 */
export async function ensureDatabase({ drop = false } = {}) {
  const name = config.db.database;
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  const bootstrap = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    charset: 'utf8mb4',
    connectTimeout: 10_000,
  });
  try {
    if (drop) await bootstrap.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await bootstrap.query(
      `CREATE DATABASE IF NOT EXISTS \`${name}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    );
  } finally {
    await bootstrap.end();
  }
}

/**
 * A few JS/SQL corner cases are normalised here: `undefined` is rejected by
 * the server, booleans are not bound, and Date objects need the session zone.
 * Normalising at this layer spreds every call site from having to remember the
 * differences.
 */
function normaliseParams(params) {
  if (params === undefined) return [];
  const list = Array.isArray(params) ? params : [params];
  return list.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

/**
 * Route a statement through the server-side prepared protocol (`execute`) by
 * default, but fall back to the text protocol (`query`) when the SQL binds a
 * `LIMIT ?` / `OFFSET ?` placeholder. mysql2 encodes JS numbers as DOUBLE for
 * the binary protocol and MySQL rejects a DOUBLE marker in LIMIT/OFFSET
 * (ER_WRONG_ARGUMENTS, 1210); the text protocol interpolates the integer
 * literally, which MySQL accepts. Validated integer params are the only ones
 * bound to those positions, so the fallback is safe.
 */
function send(connection, sql, bound) {
  if (/\bLIMIT\s*\?|\bOFFSET\s*\?/i.test(sql)) return connection.query(sql, bound);
  return connection.execute(sql, bound);
}

/**
 * Async facade over the pool. Small, readable data-access surface shared by
 * every route and service:
 *
 *   await db.all(sql, ...params)  → rows[]
 *   await db.get(sql, ...params)  → row | undefined
 *   await db.run(sql, ...params)  → { changes, lastInsertRowid }
 *   await db.exec(sql)            → executes multi-statement DDL (adminPool)
 *   await db.transaction(async () => { ... })  → commit/rollback wrapper
 *
 * Inside a transaction callback the module-level `db` transparently runs on
 * the transaction connection (via AsyncLocalStorage), so legacy closure-style
 * transaction bodies stay atomic.
 */
class Db {
  constructor(connection = null) {
    this.connection = connection;
  }

  /** Explicit tx handle wins, then the async-context transaction, then pool. */
  resolveConnection() {
    return this.connection ?? txScope.getStore()?.connection ?? null;
  }

  async all(sql, ...params) {
    const bound = normaliseParams(params);
    const connection = this.resolveConnection();
    const [rows] = connection
      ? await send(connection, sql, bound)
      : await send(pool, sql, bound);
    return rows;
  }

  async get(sql, ...params) {
    const rows = await this.all(sql, ...params);
    return rows[0];
  }

  async run(sql, ...params) {
    const bound = normaliseParams(params);
    const connection = this.resolveConnection();
    const [result] = connection
      ? await send(connection, sql, bound)
      : await send(pool, sql, bound);
    return {
      changes: result.affectedRows ?? 0,
      lastInsertRowid: result.insertId ?? 0,
    };
  }

  /** DDL / multi-statement script (schema apply only — never from handlers). */
  async exec(sql) {
    const connection = this.resolveConnection();
    if (connection) {
      await connection.query(sql);
      return;
    }
    await adminPool.query(sql);
  }

  /**
   * Mechanical-compat shim. Returns statement methods (`all` / `get` / `run`)
   * that mirror the old better-sqlite3 shape but return Promises, so a call
   * site converts by adding `await` (and its function becoming `async`) without
   * restructuring the query text or parameter list.
   *
   *   db.prepare('SELECT ... WHERE id = ?').get(id)
   *     → await db.prepare('SELECT ... WHERE id = ?').get(id)
   */
  prepare(sql) {
    return {
      all: (...params) => this.all(sql, ...params),
      get: (...params) => this.get(sql, ...params),
      run: (...params) => this.run(sql, ...params),
    };
  }

  /**
   * Run `fn` inside a transaction. `fn` may be async; it receives this facade
   * as its first argument, and — because the transaction's connection is also
   * published through AsyncLocalStorage — statements issued through the
   * module-level `db` inside the callback run on the same connection. Both
   * historical styles therefore stay atomic:
   *
   *   await db.transaction(async (tx) => { await tx.run(...) })
   *   await db.transaction(async ()    => { await db.run(...)  })
   *
   * Nested `transaction()` calls open a SAVEPOINT (matching the old driver's
   * behaviour). Any throw rolls back (or rolls back to the savepoint) and
   * rethrows.
   */
  async transaction(fn) {
    const active = this.resolveConnection();
    if (active) {
      // Nested transaction → SAVEPOINT on the existing connection.
      const name = `ts_sp_${Math.random().toString(36).slice(2, 10)}`;
      await active.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn(this);
        await active.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        try {
          await active.query(`ROLLBACK TO ${name}`);
          await active.query(`RELEASE SAVEPOINT ${name}`);
        } catch {
          /* savepoint rollback failure must not mask the original error */
        }
        throw error;
      }
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await txScope.run({ connection }, () => fn(this));
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        /* rollback failure must not mask the original error */
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}

export const db = new Db();

/** Connectivity probe for the startup supervisor. */
export async function ping() {
  const [[row]] = await pool.query(
    'SELECT NOW() AS now, @@session.time_zone AS time_zone, DATABASE() AS database_name',
  );
  return row;
}

export function closeDb() {
  return Promise.allSettled([pool.end(), adminPool.end()]);
}

export default db;
