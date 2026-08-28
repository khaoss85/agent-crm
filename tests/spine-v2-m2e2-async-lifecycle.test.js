import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as publicApp from '../packages/app/src/index.js';
import * as publicKernel from '../packages/core/index.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import {
  preflightSelectedGraph,
  startSqliteLifecycle,
} from '../packages/app/src/async-lifecycle.js';

const v2Empty = Object.freeze({
  packageContract: 2,
  packages: Object.freeze([]),
  actions: Object.freeze([]),
  modules: Object.freeze([]),
});

const pkg = (name, contract, overrides = {}) => ({
  packageContract: contract,
  name,
  version: 1,
  label: name,
  actions: [],
  operations: [],
  capabilities: [],
  ...overrides,
});

const action = (contract, overrides = {}) => ({
  module: 'probe-record',
  name: 'run-probe',
  actionContract: contract,
  execute: async () => ({}),
  ...overrides,
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2e2a-'));
  return {
    root,
    dbPath: join(root, 'data', 'accordo.sqlite'),
    [Symbol.dispose]() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function workspaceFor(t) {
  const workspace = tempRoot();
  t.after(() => workspace[Symbol.dispose]());
  return workspace;
}

function isAsyncContract(error) {
  return error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED' && error.status === 400;
}

test('public surfaces do not grow a second factory or leak lifecycle symbols', () => {
  assert.deepEqual(Object.keys(publicApp).sort(), ['createAccordoApp']);
  assert.equal(Object.hasOwn(publicApp, 'createAccordoAppAsync'), false);
  assert.equal(Object.hasOwn(publicApp, 'preflightSelectedGraph'), false);
  assert.equal(Object.hasOwn(publicApp, 'startSqliteLifecycle'), false);
  assert.equal(Object.hasOwn(publicApp, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicApp, 'startPortableHttpServer'), false);
  assert.equal(Object.hasOwn(publicKernel, 'createAccordoAppAsync'), false);
  assert.equal(Object.hasOwn(publicKernel, 'preflightSelectedGraph'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startSqliteLifecycle'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableHttpServer'), false);
  assert.equal(Object.hasOwn(publicKernel, 'SUPPORTED_PACKAGE_CONTRACTS'), false);
});

test('the released factory stays synchronous, non-thenable and immediately readable', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.equal(typeof app.then, 'undefined');
    assert.equal(typeof app.services.companies.list, 'function');
    assert.deepEqual(app.services.companies.list(), []);
    assert.equal(app.database.storage.contract, 1);
  } finally {
    app.close();
  }
});

test('an omitted or v1 selected contract refuses before any opener, path, provider or listener moves', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');
  let opened = 0;
  let provided = 0;
  let listened = 0;
  const openDatabase = () => {
    opened += 1;
    throw new Error('opener moved');
  };
  const providers = { register() { provided += 1; } };
  const listen = () => { listened += 1; };

  await assert.rejects(
    () => startSqliteLifecycle({
      selected: { packages: [], actions: [], modules: [] },
      dbPath: missingParent,
      openDatabase,
      providers,
      listen,
    }),
    isAsyncContract,
  );
  await assert.rejects(
    () => startSqliteLifecycle({
      selected: { packageContract: 1, packages: [pkg('sync', 1)], actions: [], modules: [] },
      dbPath: missingParent,
      openDatabase,
      providers,
      listen,
    }),
    isAsyncContract,
  );

  assert.equal(opened, 0);
  assert.equal(provided, 0);
  assert.equal(listened, 0);
  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('a mixed or uniform-v1 graph selected as v2 refuses with the existing composition identities', async (t) => {
  const workspace = workspaceFor(t);
  let opened = 0;
  const openDatabase = () => {
    opened += 1;
    throw new Error('opener moved');
  };

  await assert.rejects(
    () => startSqliteLifecycle({
      selected: { packageContract: 2, packages: [pkg('sync', 1), pkg('async', 2)], actions: [], modules: [] },
      dbPath: workspace.dbPath,
      openDatabase,
    }),
    (error) => isAsyncContract(error) && /separate application graphs/.test(error.message),
  );

  await assert.rejects(
    () => startSqliteLifecycle({
      selected: { packageContract: 2, packages: [pkg('sync', 1)], actions: [], modules: [] },
      dbPath: workspace.dbPath,
      openDatabase,
    }),
    (error) => isAsyncContract(error) && /package "sync"/.test(error.message),
  );

  assert.equal(opened, 0);
  assert.equal(existsSync(join(workspace.root, 'data')), false);
});

test('a valid v1 action on a v2 selected graph refuses before SQLite opens', async (t) => {
  const workspace = workspaceFor(t);
  let opened = 0;
  await assert.rejects(
    () => startSqliteLifecycle({
      selected: {
        packageContract: 2,
        packages: [],
        actions: [action(1)],
        modules: ['probe-record'],
      },
      dbPath: workspace.dbPath,
      openDatabase: () => {
        opened += 1;
        throw new Error('opener moved');
      },
    }),
    (error) => isAsyncContract(error) && /action "probe-record.run-probe"/.test(error.message),
  );
  assert.equal(opened, 0);
});

test('malformed top-level actions keep their existing validation identity and never open SQLite', async (t) => {
  const workspace = workspaceFor(t);
  let opened = 0;
  const missing = action(2);
  delete missing.actionContract;

  await assert.rejects(
    () => startSqliteLifecycle({
      selected: {
        packageContract: 2,
        packages: [],
        actions: [missing],
        modules: ['probe-record'],
      },
      dbPath: workspace.dbPath,
      openDatabase: () => {
        opened += 1;
        throw new Error('opener moved');
      },
    }),
    (error) => error.code === 'VALIDATION_ERROR' && /actionContract must be one of 1, 2/.test(error.message),
  );
  assert.equal(opened, 0);
});

test('preflight snapshots the selected contract once and keeps exact executable identities', () => {
  const provider = pkg('async-provider', 2);
  const declaredAction = action(2);
  let contractReads = 0;
  const selected = {
    get packageContract() {
      contractReads += 1;
      return contractReads === 1 ? 2 : 1;
    },
    packages: [provider],
    actions: [declaredAction],
    modules: ['probe-record'],
  };

  const accepted = preflightSelectedGraph(selected);
  assert.equal(contractReads, 1);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.packages), true);
  assert.equal(Object.isFrozen(accepted.actions), true);
  assert.equal(accepted.packageContract, 2);
  assert.strictEqual(accepted.packages[0], provider);
  assert.strictEqual(accepted.actions[0], declaredAction);
  assert.equal(accepted.packageFacts[0].packageContract, 2);
  assert.strictEqual(accepted.packageFacts[0].definition, provider);
});

test('a uniform v2 graph opens SQLite only after preflight and returns an internal receipt', async (t) => {
  const workspace = workspaceFor(t);
  let opened = 0;
  const provider = pkg('async-provider', 2);
  const lifecycle = await startSqliteLifecycle({
    selected: {
      packageContract: 2,
      packages: [provider],
      actions: [],
      modules: [],
    },
    dbPath: workspace.dbPath,
    assemble: ({ accepted, storage }) => {
      opened += 1;
      assert.strictEqual(accepted.packages[0], provider);
      assert.equal(storage.contract, 1);
      return { kind: 'probe-graph' };
    },
  });

  try {
    assert.equal(opened, 1);
    assert.equal(existsSync(workspace.dbPath), true);
    assert.equal(Object.isFrozen(lifecycle), true);
    assert.equal('services' in lifecycle, false);
    assert.equal('database' in lifecycle, false);
    assert.equal('raw' in lifecycle, false);
    assert.equal('runAction' in lifecycle, false);
    assert.equal(lifecycle.storage.contract, 1);
    assert.deepEqual(lifecycle.assembled, { kind: 'probe-graph' });
    const rows = await lifecycle.storage.many({
      kind: 'select',
      table: 'schema_migrations',
      columns: ['version'],
    });
    assert.ok(rows.length > 0);
  } finally {
    await lifecycle.close();
  }
});

test('post-open assembly failure closes the adapter once and preserves the startup cause', async () => {
  const cause = new Error('ASSEMBLY_FAILED');
  let closes = 0;
  const storage = Object.freeze({ contract: 1 });

  await assert.rejects(
    () => startSqliteLifecycle({
      selected: v2Empty,
      openDatabase: () => ({
        storage,
        close() { closes += 1; },
      }),
      assemble: () => { throw cause; },
    }),
    (error) => error === cause && error.cleanupError === undefined && closes === 1,
  );

  const cleanup = new Error('CLOSE_FAILED');
  await assert.rejects(
    () => startSqliteLifecycle({
      selected: v2Empty,
      openDatabase: () => ({
        storage,
        close() {
          closes += 1;
          throw cleanup;
        },
      }),
      assemble: () => { throw cause; },
    }),
    (error) => error === cause && error.cleanupError === cleanup,
  );
  assert.equal(closes, 2);
});

test('frozen, sealed and non-extensible startup errors stay the rejection when cleanup fails', async (t) => {
  const storage = Object.freeze({ contract: 1 });
  const reports = [];
  const originalError = console.error;
  console.error = (...args) => { reports.push(args.map(String).join(' ')); };
  t.after(() => { console.error = originalError; });

  const cases = [
    ['frozen', (error) => Object.freeze(error)],
    ['sealed', (error) => Object.seal(error)],
    ['non-extensible', (error) => Object.preventExtensions(error)],
  ];

  for (const [label, lock] of cases) {
    reports.length = 0;
    const cause = new Error(`ASSEMBLY_${label}`);
    lock(cause);
    const cleanup = new Error(`CLOSE_${label}`);
    await assert.rejects(
      () => startSqliteLifecycle({
        selected: v2Empty,
        openDatabase: () => ({
          storage,
          close() { throw cleanup; },
        }),
        assemble: () => { throw cause; },
      }),
      (error) => {
        assert.equal(error, cause, label);
        assert.equal(Object.hasOwn(error, 'cleanupError'), false, label);
        return true;
      },
    );
    assert.ok(
      reports.some((line) => line.includes('[accordo] sqlite lifecycle cleanup failed after startup error')
        && line.includes(`ASSEMBLY_${label}`)
        && line.includes(`CLOSE_${label}`)),
      `${label}: ${JSON.stringify(reports)}`,
    );
  }
});

test('successful close is async, idempotent and shares one settlement', async () => {
  let closes = 0;
  const storage = Object.freeze({ contract: 1 });
  const lifecycle = await startSqliteLifecycle({
    selected: v2Empty,
    openDatabase: () => ({
      storage,
      close() { closes += 1; },
    }),
  });

  const first = lifecycle.close();
  const second = lifecycle.close();
  assert.equal(typeof first.then, 'function');
  assert.strictEqual(first, second);
  await first;
  await second;
  assert.equal(closes, 1);
});

test('a child process opens SQLite, transacts through the storage seam, reads the row and closes', (t) => {
  const workspace = workspaceFor(t);
  const lifecycleHref = new URL('../packages/app/src/async-lifecycle.js', import.meta.url).href;
  const script = `
import { startSqliteLifecycle } from ${JSON.stringify(lifecycleHref)};
const lifecycle = await startSqliteLifecycle({
  selected: ${JSON.stringify(v2Empty)},
  dbPath: ${JSON.stringify(workspace.dbPath)},
});
await lifecycle.storage.transaction((sync) => {
  sync.execute({
    kind: 'insert',
    table: 'companies',
    values: [
      { column: 'id', value: 'co_probe' },
      { column: 'name', value: 'Probe Co' },
      { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
      { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
    ],
  });
});
const row = await lifecycle.storage.maybeOne({
  kind: 'select',
  table: 'companies',
  columns: ['id', 'name'],
  where: [{ column: 'id', op: 'eq', value: 'co_probe' }],
});
if (row?.name !== 'Probe Co') {
  console.error(JSON.stringify(row));
  process.exit(2);
}
const first = lifecycle.close();
const second = lifecycle.close();
if (first !== second) process.exit(3);
await first;
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(existsSync(workspace.dbPath), true);
});
