// @ts-check

import { AppError } from './errors.js';

export const STORAGE_CONTRACT = 1;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const WRITE_KINDS = new Set(['insert', 'update']);
const READ_KINDS = new Set(['select', 'count']);

function refuse(message, details) {
  throw new AppError(message, { code: 'STORAGE_STATEMENT_UNSUPPORTED', status: 500, details });
}

function requireMethodKind(method, statement, allowed) {
  const kind = statement && typeof statement === 'object' ? statement.kind : undefined;
  if (!allowed.has(kind)) {
    throw new AppError(`Storage ${method} cannot execute statement kind "${String(kind)}"`, {
      code: 'STORAGE_METHOD_STATEMENT_MISMATCH', status: 500, details: { method, kind },
    });
  }
}

function identifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) refuse(`Unsupported storage ${label}`, { label });
  return `"${value}"`;
}

function closed(value, allowed, label, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    refuse(`${label} must be a plain object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) refuse(`Unsupported ${label} field`, { field: unknown[0] });
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) refuse(`${label} requires own field`, { field: missing });
}

function values(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) refuse(`${label} requires values`);
  const bound = entries.map((entry) => {
    closed(entry, ['column', 'value'], `${label} value`, ['column', 'value']);
    return { column: identifier(entry.column, `${label} column`), value: entry.value };
  });
  if (new Set(bound.map((entry) => entry.column)).size !== bound.length) refuse(`${label} columns must be unique`);
  return bound;
}

function placeholders(dialect) {
  let index = 0;
  return () => (dialect === 'postgresql' ? `$${++index}` : '?');
}

function predicates(where = [], placeholder) {
  if (!Array.isArray(where)) refuse('Storage where must be an array');
  const params = [];
  const sql = where.map((entry) => {
    closed(entry, ['column', 'op', 'value', 'values'], 'storage predicate', ['column', 'op']);
    if (entry.op === 'eq') {
      closed(entry, ['column', 'op', 'value'], 'equality predicate', ['column', 'op', 'value']);
      const column = identifier(entry.column, 'predicate column');
      params.push(entry.value); return `${column} = ${placeholder()}`;
    }
    if (entry.op === 'is-null') {
      closed(entry, ['column', 'op'], 'null predicate', ['column', 'op']);
      return `${identifier(entry.column, 'predicate column')} IS NULL`;
    }
    if (entry.op === 'in' && Array.isArray(entry.values) && entry.values.length > 0) {
      closed(entry, ['column', 'op', 'values'], 'membership predicate', ['column', 'op', 'values']);
      const column = identifier(entry.column, 'predicate column');
      params.push(...entry.values);
      return `${column} IN (${entry.values.map(() => placeholder()).join(', ')})`;
    }
    refuse('Unsupported storage predicate operator', { op: entry.op });
  });
  return { sql: sql.length ? ` WHERE ${sql.join(' AND ')}` : '', params };
}

/**
 * Quote a closed storage identifier. Shared by both adapters for savepoint names
 * so PostgreSQL cannot accept a spelling SQLite would have refused.
 */
export function quoteStorageIdentifier(value, label) {
  return identifier(value, label);
}

/** Refuse a statement kind the named storage method is not allowed to run. */
export function requireStorageMethodKind(method, statement, allowed) {
  requireMethodKind(method, statement, allowed);
}

export const STORAGE_WRITE_KINDS = WRITE_KINDS;
export const STORAGE_READ_KINDS = READ_KINDS;

function renderStatement(statement, dialect, schema) {
  if (!statement || typeof statement !== 'object' || !Object.hasOwn(statement, 'kind') || typeof statement.kind !== 'string') {
    refuse('Storage statement must be a structured object');
  }
  const placeholder = placeholders(dialect);
  const table = dialect === 'postgresql' && typeof schema === 'string' && schema !== ''
    ? `${identifier(schema, 'schema')}.${identifier(statement.table, 'table')}`
    : identifier(statement.table, 'table');
  if (statement.kind === 'insert') {
    closed(statement, ['kind', 'table', 'values'], 'insert statement', ['kind', 'table', 'values']);
    const bound = values(statement.values, 'Insert');
    const columns = bound.map((entry) => entry.column);
    return {
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => placeholder()).join(', ')})`,
      params: bound.map((entry) => entry.value),
    };
  }
  if (statement.kind === 'select' || statement.kind === 'count') {
    closed(statement, statement.kind === 'count'
      ? ['kind', 'table', 'where']
      : ['kind', 'table', 'columns', 'where', 'orderBy', 'limit'], `${statement.kind} statement`,
      statement.kind === 'count' ? ['kind', 'table'] : ['kind', 'table', 'columns']);
    const where = predicates(statement.where, placeholder);
    const selection = statement.kind === 'count'
      ? 'COUNT(*) AS "n"'
      : statement.columns === '*'
        ? '*'
        : Array.isArray(statement.columns) && statement.columns.length
          ? statement.columns.map((column) => identifier(column, 'select column')).join(', ')
          : refuse('Select requires columns');
    let sql = `SELECT ${selection} FROM ${table}${where.sql}`;
    if (statement.kind === 'select' && statement.orderBy !== undefined) {
      if (!Array.isArray(statement.orderBy)) refuse('Storage orderBy must be an array');
      const order = statement.orderBy.map((entry) => {
        closed(entry, ['column', 'direction'], 'storage order', ['column']);
        const direction = entry.direction ?? 'asc';
        if (direction !== 'asc' && direction !== 'desc') refuse('Unsupported storage order direction');
        return `${identifier(entry.column, 'order column')} ${direction.toUpperCase()}`;
      });
      if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
    }
    const params = [...where.params];
    if (statement.kind === 'select' && statement.limit !== undefined) {
      if (!Number.isInteger(statement.limit) || statement.limit < 1) refuse('Storage limit must be a positive integer');
      sql += ` LIMIT ${placeholder()}`; params.push(statement.limit);
    }
    return { sql, params };
  }
  if (statement.kind === 'update') {
    closed(statement, ['kind', 'table', 'values', 'where'], 'update statement', ['kind', 'table', 'values', 'where']);
    const bound = values(statement.values, 'Update');
    const assignments = bound.map((entry) => `${entry.column} = ${placeholder()}`);
    const where = predicates(statement.where, placeholder);
    if (!where.sql) refuse('Update requires a predicate');
    return {
      sql: `UPDATE ${table} SET ${assignments.join(', ')}${where.sql}`,
      params: [...bound.map((entry) => entry.value), ...where.params],
    };
  }
  refuse('Unsupported storage statement kind', { kind: statement.kind });
}

/** Render the closed M1 statement vocabulary for the SQLite adapter. */
export function renderSqliteStatement(statement) {
  return renderStatement(statement, 'sqlite');
}

/** Render the closed M1 statement vocabulary for the PostgreSQL adapter (`$1..$n`). */
export function renderPostgresqlStatement(statement, options = {}) {
  return renderStatement(statement, 'postgresql', options.schema);
}

/**
 * SQLite-only M1 adapter. Raw driver access never leaves this closure.
 *
 * `readWitness` is the database wrapper's own view of whether an outer
 * transaction is open on this connection, published here as
 * `activeTransaction()` so a consumer that must prove transactional context
 * asks the storage seam instead of reaching past it for the driver's own
 * transaction flag (Spine v2 M2D).
 *
 * It is a **reader**. The slot it reads lives in `createDatabase`'s closure and
 * nothing on the returned object can write it, so holding `database.storage`
 * lets a package ask the question and never answer it.
 *
 * Omitted — as the repository-truth storage probes in `scripts/repo-truth.js`
 * construct it — `activeTransaction()` answers `null`. That is the fail-closed
 * direction: a handle assembled without the wrapper cannot prove a transaction,
 * and says so rather than staying silent.
 */
export function createSqliteStorage(raw, transaction, transactionAsync, readWitness) {
  const activeTransaction = typeof readWitness === 'function' ? () => readWitness() : () => null;
  const prepared = (statement) => {
    const rendered = renderSqliteStatement(statement);
    return { prepared: raw.prepare(rendered.sql), params: rendered.params };
  };
  const sync = Object.freeze({
    execute(statement) {
      requireMethodKind('execute', statement, WRITE_KINDS);
      const query = prepared(statement);
      const result = query.prepared.run(...query.params);
      return Object.freeze({ affectedRows: Number(result.changes) });
    },
    maybeOne(statement) {
      requireMethodKind('maybeOne', statement, READ_KINDS);
      const query = prepared(statement); return query.prepared.get(...query.params) ?? null;
    },
    many(statement) {
      requireMethodKind('many', statement, READ_KINDS);
      const query = prepared(statement); return query.prepared.all(...query.params);
    },
    transaction,
    savepoint(name, fn) {
      const safeName = identifier(name, 'savepoint');
      raw.exec(`SAVEPOINT ${safeName}`);
      try {
        const result = fn();
        raw.exec(`RELEASE SAVEPOINT ${safeName}`);
        return result;
      } catch (error) {
        raw.exec(`ROLLBACK TO SAVEPOINT ${safeName}`);
        raw.exec(`RELEASE SAVEPOINT ${safeName}`);
        throw error;
      }
    },
  });
  return Object.freeze({
    contract: STORAGE_CONTRACT,
    sync,
    /**
     * The opaque witness for the outer transaction currently open on this
     * handle, or `null`. Read-only, and the value is meaningless on its own:
     * only `proveCallerTransaction` can tell a genuine one from a forgery.
     */
    activeTransaction,
    async execute(statement) { return sync.execute(statement); },
    async maybeOne(statement) { return sync.maybeOne(statement); },
    async many(statement) { return sync.many(statement); },
    async transaction(fn) { return transactionAsync(() => fn(sync)); },
  });
}
