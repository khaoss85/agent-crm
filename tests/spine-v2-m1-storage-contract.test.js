// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createDatabase } from '../packages/core/src/database.js';
import { renderSqliteStatement, STORAGE_CONTRACT } from '../packages/core/src/storage-contract.js';

test('M1 renders only its closed statement vocabulary with ordered bindings', () => {
  assert.deepEqual(renderSqliteStatement({
    kind: 'select', table: 'work_task', columns: '*',
    where: [
      { column: 'subject_id', op: 'eq', value: 'subject-1' },
      { column: 'status', op: 'in', values: ['open', 'completed'] },
      { column: 'completed_at', op: 'is-null' },
    ],
    orderBy: [{ column: 'created_at', direction: 'desc' }, { column: 'id', direction: 'asc' }],
    limit: 25,
  }), {
    sql: 'SELECT * FROM "work_task" WHERE "subject_id" = ? AND "status" IN (?, ?) AND "completed_at" IS NULL ORDER BY "created_at" DESC, "id" ASC LIMIT ?',
    params: ['subject-1', 'open', 'completed', 25],
  });
  for (const statement of [
    'SELECT * FROM companies',
    { kind: 'delete', table: 'companies' },
    { kind: 'select', table: 'companies; DROP TABLE companies', columns: '*' },
    { kind: 'select', table: 'companies', columns: '*', where: [{ column: 'id', op: 'like', value: '%' }] },
  ]) {
    assert.throws(() => renderSqliteStatement(statement), (error) => error?.code === 'STORAGE_STATEMENT_UNSUPPORTED');
  }
});

test('M1 SQLite adapter exposes async writes, synchronous compatibility reads and rollback', async () => {
  const database = createDatabase({ path: ':memory:' });
  try {
    assert.equal(database.storage.contract, STORAGE_CONTRACT);
    await database.storage.execute({
      kind: 'insert', table: 'companies', values: [
        { column: 'id', value: 'company-1' }, { column: 'name', value: 'One' },
        { column: 'domain', value: null }, { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
        { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
      ],
    });
    assert.equal(database.storage.sync.maybeOne({
      kind: 'select', table: 'companies', columns: ['name'], where: [{ column: 'id', op: 'eq', value: 'company-1' }],
    }).name, 'One');
    await assert.rejects(database.storage.transaction(async (storage) => {
      storage.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Rolled back' }],
        where: [{ column: 'id', op: 'eq', value: 'company-1' }],
      });
      throw new Error('fixture failure');
    }), /fixture failure/);
    assert.equal(database.storage.sync.maybeOne({
      kind: 'select', table: 'companies', columns: ['name'], where: [{ column: 'id', op: 'eq', value: 'company-1' }],
    }).name, 'One');
  } finally {
    database.close();
  }
});

test('M1 refuses every read/write method mismatch before SQLite executes it', async () => {
  const database = createDatabase({ path: ':memory:' });
  const mismatch = (fn) => assert.throws(fn, (error) => error?.code === 'STORAGE_METHOD_STATEMENT_MISMATCH');
  const row = (id, name) => ({
    kind: 'insert', table: 'companies', values: [
      { column: 'id', value: id }, { column: 'name', value: name }, { column: 'domain', value: null },
      { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
      { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const select = { kind: 'select', table: 'companies', columns: '*', where: [] };
  const count = { kind: 'count', table: 'companies', where: [] };
  const update = (name) => ({
    kind: 'update', table: 'companies', values: [{ column: 'name', value: name }],
    where: [{ column: 'id', op: 'eq', value: 'kept' }],
  });
  try {
    database.storage.sync.execute(row('kept', 'Kept'));

    mismatch(() => database.storage.sync.maybeOne(row('maybe-insert', 'Wrong')));
    mismatch(() => database.storage.sync.many(row('many-insert', 'Wrong')));
    mismatch(() => database.storage.sync.maybeOne(update('maybe-update')));
    mismatch(() => database.storage.sync.many(update('many-update')));
    await assert.rejects(database.storage.execute(select), (error) => error?.code === 'STORAGE_METHOD_STATEMENT_MISMATCH');
    await assert.rejects(database.storage.execute(count), (error) => error?.code === 'STORAGE_METHOD_STATEMENT_MISMATCH');

    assert.deepEqual(database.storage.sync.many(select).map(({ id, name }) => ({ id, name })), [{ id: 'kept', name: 'Kept' }]);
    assert.equal(database.storage.sync.maybeOne(count).n, 1);
    assert.deepEqual(database.storage.sync.many(count).map(({ n }) => ({ n })), [{ n: 1 }]);

    database.storage.sync.execute(update('Updated'));
    assert.equal(database.storage.sync.maybeOne({
      kind: 'select', table: 'companies', columns: ['name'],
      where: [{ column: 'id', op: 'eq', value: 'kept' }],
    }).name, 'Updated');
  } finally {
    database.close();
  }
});

test('Company dependency closure preserves missing-company refusal without partial writes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m1-company-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = createAccordoApp({ dbPath: join(root, 'app.sqlite') });
  t.after(() => app.close());
  const actor = { type: 'user', id: 'm1' };

  await assert.rejects(
    app.services.contacts.create({ companyId: 'missing', firstName: 'No', lastName: 'Write', email: 'none@example.com' }, { actor }),
    (error) => error?.code === 'NOT_FOUND' && error.message === 'Company not found: missing',
  );
  await assert.rejects(
    app.services.opportunities.create({ companyId: 'missing', name: 'No Write', valueCents: 100, owner: 'm1' }, { actor }),
    (error) => error?.code === 'NOT_FOUND' && error.message === 'Company not found: missing',
  );
  assert.equal(app.services.contacts.list().length, 0);
  assert.equal(app.services.opportunities.list().length, 0);
  assert.equal(app.audit.list({ limit: 500 }).length, 0);
});

test('Company insert and audit commit before an unrelated async transaction can roll back', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const create = app.services.companies.create(
    { name: 'Atomic Company', domain: 'atomic.example' },
    { actor: { type: 'user', id: 'm1-atomicity' } },
  );
  const unrelated = app.database.transactionAsync(async () => {
    await Promise.resolve();
    throw new Error('unrelated rollback');
  });
  await assert.rejects(unrelated, /unrelated rollback/);
  const company = await create;
  assert.equal(app.services.companies.get(company.id).name, 'Atomic Company');
  const audit = app.audit.list({ entityType: 'company', entityId: company.id });
  assert.deepEqual(audit.map(({ action, actorId }) => ({ action, actorId })), [
    { action: 'company.created', actorId: 'm1-atomicity' },
  ]);
});

test('Company creation joins an existing outer transaction through a savepoint', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  await assert.rejects(app.database.transactionAsync(async () => {
    await app.services.companies.create(
      { name: 'Rolled-back Company' },
      { actor: { type: 'user', id: 'm1-nested' } },
    );
    throw new Error('outer rollback');
  }), /outer rollback/);
  assert.equal(app.services.companies.list().length, 0);
  assert.equal(app.audit.list({ entityType: 'company' }).length, 0);

  let committed;
  await app.database.transactionAsync(async () => {
    committed = await app.services.companies.create(
      { name: 'Committed Company' },
      { actor: { type: 'user', id: 'm1-nested' } },
    );
  });
  assert.equal(app.services.companies.get(committed.id).name, 'Committed Company');
  assert.equal(app.audit.list({ entityType: 'company', entityId: committed.id }).length, 1);
});

test('the two migrated consumer sources have no raw-driver escape', () => {
  const company = readFileSync(new URL('../packages/modules/company/src/company-service.js', import.meta.url), 'utf8');
  const generated = readFileSync(new URL('../packages/cli/src/module-factory.js', import.meta.url), 'utf8');
  const audit = readFileSync(new URL('../packages/core/src/audit.js', import.meta.url), 'utf8');
  for (const [label, source] of [['Company', company], ['generated/package-owned service template', generated], ['shared audit dependency', audit]]) {
    assert.doesNotMatch(source, /database\.raw|\.raw\.prepare|\.raw\.exec|DatabaseSync/, `${label} must cross only the M1 storage contract`);
  }
});
