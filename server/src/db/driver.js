import { DatabaseSync } from 'node:sqlite';

/**
 * Thin, synchronous SQLite driver.
 *
 * TransitSync targets Node >= 20 but ships without native build tooling, so we use
 * the built-in `node:sqlite` module rather than a compiled driver. The surface below
 * intentionally mirrors the small subset of the better-sqlite3 API the app uses
 * (`exec`, `prepare`, `run`, `get`, `all`, `transaction`) so swapping drivers later
 * only requires changing this file.
 *
 * Key difference handled here: `node:sqlite` returns null-prototype row objects,
 * which break `row.hasOwnProperty()` and strict prototype checks further up the
 * stack. Every row is normalised into a plain object on the way out.
 */

function normaliseRow(row) {
  return row == null ? row : Object.assign({}, row);
}

export class Statement {
  #stmt;

  constructor(stmt) {
    this.#stmt = stmt;
  }

  run(...params) {
    return this.#stmt.run(...normaliseParams(params));
  }

  get(...params) {
    return normaliseRow(this.#stmt.get(...normaliseParams(params)));
  }

  all(...params) {
    return this.#stmt.all(...normaliseParams(params)).map(normaliseRow);
  }

  pluck() {
    return {
      run: (...params) => this.#stmt.run(...normaliseParams(params)),
      get: (...params) => {
        const row = this.#stmt.get(...normaliseParams(params));
        if (row == null) return undefined;
        return Object.values(row)[0];
      },
      all: (...params) =>
        this.#stmt.all(...normaliseParams(params)).map((row) => Object.values(row)[0]),
    };
  }
}

/** node:sqlite only accepts null/number/bigint/string/Buffer — coerce the rest. */
function normaliseParams(params) {
  return params.map((param) => {
    if (param === undefined) return null;
    if (param === null || typeof param !== 'object') return param;
    if (param instanceof Date) return param.toISOString();
    if (Buffer.isBuffer(param)) return param;
    return JSON.stringify(param);
  });
}

export class Database {
  #db;
  #cache = new Map();
  #txDepth = 0;

  constructor(location) {
    this.#db = new DatabaseSync(location);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 8000');
  }

  exec(sql) {
    this.#db.exec(sql);
  }

  prepare(sql) {
    let stmt = this.#cache.get(sql);
    if (!stmt) {
      stmt = new Statement(this.#db.prepare(sql));
      this.#cache.set(sql, stmt);
    }
    return stmt;
  }

  pragma(statement) {
    return this.#db.prepare(`PRAGMA ${statement}`).all().map(normaliseRow);
  }

  /**
   * Synchronous transaction with savepoint-based nesting so services can compose
   * without every caller worrying about whether it is the outermost boundary.
   */
  transaction(fn) {
    const name = `sp_${this.#txDepth}`;
    const isOutermost = this.#txDepth === 0;
    if (isOutermost) this.exec('BEGIN');
    else this.exec(`SAVEPOINT ${name}`);
    this.#txDepth += 1;

    try {
      const result = fn();
      this.#txDepth -= 1;
      if (isOutermost) this.exec('COMMIT');
      else this.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#txDepth -= 1;
      if (isOutermost) this.exec('ROLLBACK');
      else this.exec(`ROLLBACK TO ${name}`);
      throw error;
    }
  }

  close() {
    this.#cache.clear();
    this.#db.close();
  }
}

export function openDatabase(location = ':memory:') {
  return new Database(location);
}

export default { Database, Statement, openDatabase };
