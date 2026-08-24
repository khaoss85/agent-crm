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

function closed(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) refuse(`Unsupported ${label} field`, { field: unknown[0] });
}

function values(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) refuse(`${label} requires values`);
  const bound = entries.map((entry) => {
    closed(entry, ['column', 'value'], `${label} value`);
    return { column: identifier(entry.column, `${label} column`), value: entry.value };
  });
  if (new Set(bound.map((entry) => entry.column)).size !== bound.length) refuse(`${label} columns must be unique`);
  return bound;
}

function predicates(where = []) {
  if (!Array.isArray(where)) refuse('Storage where must be an array');
  const params = [];
  const sql = where.map((entry) => {
    closed(entry, ['column', 'op', 'value', 'values'], 'storage predicate');
    if (entry.op === 'eq') {
      closed(entry, ['column', 'op', 'value'], 'equality predicate');
      if (!Object.hasOwn(entry, 'value')) refuse('Equality predicate requires value');
      const column = identifier(entry.column, 'predicate column');
      params.push(entry.value); return `${column} = ?`;
    }
    if (entry.op === 'is-null') {
      closed(entry, ['column', 'op'], 'null predicate');
      return `${identifier(entry.column, 'predicate column')} IS NULL`;
    }
    if (entry.op === 'in' && Array.isArray(entry.values) && entry.values.length > 0) {
      closed(entry, ['column', 'op', 'values'], 'membership predicate');
      const column = identifier(entry.column, 'predicate column');
      params.push(...entry.values);
      return `${column} IN (${entry.values.map(() => '?').join(', ')})`;
    }
    refuse('Unsupported storage predicate operator', { op: entry.op });
  });
  return { sql: sql.length ? ` WHERE ${sql.join(' AND ')}` : '', params };
}

/** Render the closed M1 statement vocabulary for the SQLite adapter. */
export function renderSqliteStatement(statement) {
  if (!statement || typeof statement !== 'object' || typeof statement.kind !== 'string') {
    refuse('Storage statement must be a structured object');
  }
  const table = identifier(statement.table, 'table');
  if (statement.kind === 'insert') {
    closed(statement, ['kind', 'table', 'values'], 'insert statement');
    const bound = values(statement.values, 'Insert');
    const columns = bound.map((entry) => entry.column);
    return {
      sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      params: bound.map((entry) => entry.value),
    };
  }
  if (statement.kind === 'select' || statement.kind === 'count') {
    closed(statement, statement.kind === 'count'
      ? ['kind', 'table', 'where']
      : ['kind', 'table', 'columns', 'where', 'orderBy', 'limit'], `${statement.kind} statement`);
    const where = predicates(statement.where);
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
        closed(entry, ['column', 'direction'], 'storage order');
        const direction = entry.direction ?? 'asc';
        if (direction !== 'asc' && direction !== 'desc') refuse('Unsupported storage order direction');
        return `${identifier(entry.column, 'order column')} ${direction.toUpperCase()}`;
      });
      if (order.length) sql += ` ORDER BY ${order.join(', ')}`;
    }
    const params = [...where.params];
    if (statement.kind === 'select' && statement.limit !== undefined) {
      if (!Number.isInteger(statement.limit) || statement.limit < 1) refuse('Storage limit must be a positive integer');
      sql += ' LIMIT ?'; params.push(statement.limit);
    }
    return { sql, params };
  }
  if (statement.kind === 'update') {
    closed(statement, ['kind', 'table', 'values', 'where'], 'update statement');
    const bound = values(statement.values, 'Update');
    const where = predicates(statement.where);
    if (!where.sql) refuse('Update requires a predicate');
    const assignments = bound.map((entry) => `${entry.column} = ?`);
    return {
      sql: `UPDATE ${table} SET ${assignments.join(', ')}${where.sql}`,
      params: [...bound.map((entry) => entry.value), ...where.params],
    };
  }
  refuse('Unsupported storage statement kind', { kind: statement.kind });
}

/** SQLite-only M1 adapter. Raw driver access never leaves this closure. */
export function createSqliteStorage(raw, transaction, transactionAsync) {
  const prepared = (statement) => {
    const rendered = renderSqliteStatement(statement);
    return { prepared: raw.prepare(rendered.sql), params: rendered.params };
  };
  const sync = Object.freeze({
    execute(statement) {
      requireMethodKind('execute', statement, WRITE_KINDS);
      const query = prepared(statement); return query.prepared.run(...query.params);
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
    async execute(statement) { return sync.execute(statement); },
    async maybeOne(statement) { return sync.maybeOne(statement); },
    async many(statement) { return sync.many(statement); },
    async transaction(fn) { return transactionAsync(() => fn(sync)); },
  });
}
