// @ts-check

import assert from 'node:assert/strict';
import { AppError } from '../../packages/core/src/errors.js';
import { createPostgresqlDatabase } from '../../packages/core/src/postgresql-storage.js';

export const PG_TEST_URL = process.env.ACCORDO_PG_TEST_URL
  || 'postgres://postgres@127.0.0.1:5432/accordo_test';
export const PG_REQUIRED = process.env.CI === 'true' || process.env.ACCORDO_TEST_POSTGRES === '1';

export const PG_TEST_DDL = Object.freeze([
  `CREATE TABLE companies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE integer_values (
    id TEXT PRIMARY KEY,
    amount BIGINT NOT NULL
  )`,
  `CREATE TABLE flags (
    id TEXT PRIMARY KEY,
    flag BOOLEAN,
    stamped TEXT
  )`,
]);

const SAMPLE_SELECT = {
  kind: 'select', table: 'work_task', columns: '*',
  where: [
    { column: 'subject_id', op: 'eq', value: 'subject-1' },
    { column: 'status', op: 'in', values: ['open', 'completed'] },
    { column: 'completed_at', op: 'is-null' },
  ],
  orderBy: [{ column: 'created_at', direction: 'desc' }, { column: 'id', direction: 'asc' }],
  limit: 25,
};

export function assertClosedVocabulary(render, dialect) {
  const p = dialect === 'postgresql'
    ? ['$1', '$2', '$3', '$4']
    : ['?', '?', '?', '?'];
  assert.deepEqual(render(SAMPLE_SELECT), {
    sql: `SELECT * FROM "work_task" WHERE "subject_id" = ${p[0]} AND "status" IN (${p[1]}, ${p[2]}) AND "completed_at" IS NULL ORDER BY "created_at" DESC, "id" ASC LIMIT ${p[3]}`,
    params: ['subject-1', 'open', 'completed', 25],
  });
  for (const statement of [
    'SELECT * FROM companies',
    { kind: 'delete', table: 'companies' },
    { kind: 'select', table: 'companies; DROP TABLE companies', columns: '*' },
    { kind: 'select', table: 'companies', columns: '*', where: [{ column: 'id', op: 'like', value: '%' }] },
  ]) {
    assert.throws(() => render(statement), (error) => error?.code === 'STORAGE_STATEMENT_UNSUPPORTED');
  }
  const inheritedStatement = Object.create({ kind: 'insert', table: 'companies', values: [] });
  const inheritedValue = Object.assign(Object.create({ column: 'id', value: 'polluted' }), {});
  assert.throws(() => render(inheritedStatement), (error) => error?.code === 'STORAGE_STATEMENT_UNSUPPORTED');
  assert.throws(() => render({
    kind: 'insert', table: 'companies', values: [inheritedValue],
  }), (error) => error?.code === 'STORAGE_STATEMENT_UNSUPPORTED');
  assert.throws(() => render({
    kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Wrong' }],
    where: [Object.create({ column: 'domain', op: 'is-null' })],
  }), (error) => error?.code === 'STORAGE_STATEMENT_UNSUPPORTED');
}

function companyInsert(id, name) {
  return {
    kind: 'insert', table: 'companies', values: [
      { column: 'id', value: id }, { column: 'name', value: name },
      { column: 'domain', value: null }, { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
      { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

/**
 * Async Storage Contract v1 cases that both adapters must satisfy.
 * @param {{execute: Function, maybeOne: Function, many: Function, transaction: Function}} storage
 */
export async function assertAsyncStorageContract(storage) {
  assert.deepEqual(await storage.execute(companyInsert('company-1', 'One')), { affectedRows: 1 });
  assert.equal((await storage.maybeOne({
    kind: 'select', table: 'companies', columns: ['name'], where: [{ column: 'id', op: 'eq', value: 'company-1' }],
  })).name, 'One');

  await assert.rejects(storage.transaction(async (tx) => {
    await tx.execute({
      kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Rolled back' }],
      where: [{ column: 'id', op: 'eq', value: 'company-1' }],
    });
    throw new Error('fixture failure');
  }), /fixture failure/);
  assert.equal((await storage.maybeOne({
    kind: 'select', table: 'companies', columns: ['name'], where: [{ column: 'id', op: 'eq', value: 'company-1' }],
  })).name, 'One');

  const mismatch = (error) => error?.code === 'STORAGE_METHOD_STATEMENT_MISMATCH';
  const select = { kind: 'select', table: 'companies', columns: '*', where: [] };
  const count = { kind: 'count', table: 'companies', where: [] };
  const update = (name) => ({
    kind: 'update', table: 'companies', values: [{ column: 'name', value: name }],
    where: [{ column: 'id', op: 'eq', value: 'company-1' }],
  });

  await assert.rejects(storage.maybeOne(companyInsert('maybe-insert', 'Wrong')), mismatch);
  await assert.rejects(storage.many(companyInsert('many-insert', 'Wrong')), mismatch);
  await assert.rejects(storage.maybeOne(update('maybe-update')), mismatch);
  await assert.rejects(storage.many(update('many-update')), mismatch);
  await assert.rejects(storage.execute(select), mismatch);
  await assert.rejects(storage.execute(count), mismatch);

  for (const where of [
    [{ column: 'domain', op: 'is-null', value: 'kept' }],
    [{ column: 'id', op: 'eq', values: ['kept'] }],
    [{ column: 'id', op: 'in', value: 'kept', values: ['kept'] }],
  ]) {
    await assert.rejects(storage.execute({
      kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Wrong' }], where,
    }), (error) => error?.code === 'STORAGE_STATEMENT_UNSUPPORTED');
  }

  assert.deepEqual((await storage.many(select)).map(({ id, name }) => ({ id, name })), [{ id: 'company-1', name: 'One' }]);
  assert.equal((await storage.maybeOne(count)).n, 1);
  assert.deepEqual((await storage.many(count)).map(({ n }) => ({ n })), [{ n: 1 }]);
  assert.equal(typeof (await storage.maybeOne(count)).n, 'number');

  assert.deepEqual(await storage.execute(update('Updated')), { affectedRows: 1 });
  assert.equal((await storage.maybeOne({
    kind: 'select', table: 'companies', columns: ['name'],
    where: [{ column: 'id', op: 'eq', value: 'company-1' }],
  })).name, 'Updated');
}

export function secretNeedles(connection = PG_TEST_URL) {
  const needles = ['s3cret-unavailable', 's3cret-value', 'postgres://', 'postgresql://', 'pg-user'];
  needles.push(connection);
  try {
    const parsed = new URL(connection);
    needles.push(`${parsed.username}:${parsed.password}@`);
    if (parsed.password && parsed.password !== 'postgres') {
      needles.push(parsed.password);
      try { needles.push(decodeURIComponent(parsed.password)); } catch { /* ignore */ }
    }
    if (parsed.hostname && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      needles.push(parsed.hostname);
    }
    if (parsed.port) needles.push(`${parsed.hostname}:${parsed.port}`);
  } catch { /* ignore */ }
  return [...new Set(needles.filter((value) => value && String(value).length > 0))];
}

function collectStrings(value, into = [], stack = new Set()) {
  if (value === null || value === undefined) return into;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    into.push(String(value));
    return into;
  }
  if (typeof value === 'bigint') {
    into.push(value.toString());
    return into;
  }
  if (stack.has(value)) return into;
  if (typeof value === 'object') stack.add(value);
  if (value instanceof Error) {
    into.push(value.message, value.name, value.stack ?? '', String(/** @type {any} */ (value).code ?? ''));
    collectStrings(/** @type {any} */ (value).details, into, stack);
    collectStrings(value.cause, into, stack);
    return into;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, into, stack);
    return into;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      collectStrings(entry, into, stack);
    }
  }
  return into;
}

export function assertNoSecrets(value, connection = PG_TEST_URL) {
  const haystack = collectStrings(value).join('\n');
  for (const needle of secretNeedles(connection)) {
    assert.equal(
      haystack.includes(needle),
      false,
      `storage result or error leaked ${JSON.stringify(needle)}`,
    );
  }
}

export async function openPostgresqlFixture(t, options = {}) {
  try {
    const db = await createPostgresqlDatabase({
      connection: options.connection ?? PG_TEST_URL,
      ddl: options.ddl ?? PG_TEST_DDL,
      max: options.max,
      acquisitionDeadlineMs: options.acquisitionDeadlineMs,
      queryDeadlineMs: options.queryDeadlineMs,
      lockTimeoutMs: options.lockTimeoutMs,
      statementTimeoutMs: options.statementTimeoutMs,
    });
    t.after(() => db.close());
    return db;
  } catch (error) {
    if (PG_REQUIRED) {
      throw new AppError(
        'ACCORDO_PG_TEST_REQUIRED: PostgreSQL 16 is required for this suite. '
          + 'Start with: docker run --rm -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=postgres '
          + '-e POSTGRES_DB=accordo_test -p 5432:5432 postgres:16',
        { code: 'ACCORDO_PG_TEST_REQUIRED', status: 503 },
      );
    }
    t.skip('PostgreSQL 16 is not reachable locally; CI always runs this suite against postgres:16');
    return null;
  }
}
