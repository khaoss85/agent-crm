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

test('the two migrated consumer sources have no raw-driver escape', () => {
  const company = readFileSync(new URL('../packages/modules/company/src/company-service.js', import.meta.url), 'utf8');
  const generated = readFileSync(new URL('../packages/cli/src/module-factory.js', import.meta.url), 'utf8');
  const audit = readFileSync(new URL('../packages/core/src/audit.js', import.meta.url), 'utf8');
  for (const [label, source] of [['Company', company], ['generated/package-owned service template', generated], ['shared audit dependency', audit]]) {
    assert.doesNotMatch(source, /database\.raw|\.raw\.prepare|\.raw\.exec|DatabaseSync/, `${label} must cross only the M1 storage contract`);
  }
});
