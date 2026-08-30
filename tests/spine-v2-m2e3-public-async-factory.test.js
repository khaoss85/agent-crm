import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';

import * as publicApp from '../packages/app/src/index.js';
import * as publicKernel from '../packages/core/index.js';
import { createAccordoApp, createAccordoAppAsync } from '../packages/app/src/index.js';
import { createPartnerScorecardPackage } from '../examples/custom-packages/partner-scorecard/src/index.js';

const FACADE_KEYS = Object.freeze([
  'actions',
  'audit',
  'close',
  'config',
  'domains',
  'events',
  'health',
  'metrics',
  'modules',
  'notifications',
  'now',
  'operations',
  'packageContract',
  'pipelines',
  'providers',
  'runAction',
  'schema',
  'services',
  'storage',
  'workflows',
]);

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

const FORBIDDEN_KEYS = new Set([
  'database',
  'raw',
  'controlPlaneDatabase',
  'tenantBinding',
  'dbPath',
  'dataPlanePath',
  'controlPlanePath',
  'password',
  'secret',
  'token',
  'connectionString',
  'connectionUrl',
  'databaseUrl',
]);

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2e3-'));
  return {
    root,
    dbPath: join(root, 'data', 'accordo.sqlite'),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function workspaceFor(t) {
  const workspace = tempRoot();
  t.after(() => workspace.dispose());
  return workspace;
}

function isAsyncContract(error) {
  return error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED' && error.status === 400;
}

function compactKey(key) {
  return String(key).replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function isRawDriver(value) {
  return value instanceof DatabaseSync;
}

function isStorageHandle(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && value.contract === 1
    && value.sync
    && typeof value.sync === 'object'
    && typeof value.transaction === 'function',
  );
}

function isDatabaseHandle(value) {
  if (!value || typeof value !== 'object') return false;
  if (isRawDriver(value)) return true;
  try {
    if (Object.hasOwn(value, 'raw') && isRawDriver(value.raw)) return true;
  } catch {
    // Own-name inspection is enough.
  }
  try {
    if (Object.hasOwn(value, 'storage') && isStorageHandle(value.storage)) return true;
  } catch {
    return false;
  }
  return false;
}

function isBindingPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === ':memory:') return true;
  if (/\.sqlite3?$/i.test(value)) return true;
  if (/^postgres(ql)?:\/\//i.test(value)) return true;
  return false;
}

function isCredentialString(value) {
  return typeof value === 'string' && /postgres(ql)?:\/\/[^/\s:]+:[^@\s]+@/i.test(value);
}

function findStorageLeaks(root) {
  const leaks = [];
  const seen = new WeakSet();

  const visit = (value, path, keyName) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (isBindingPath(value)) leaks.push(`${path} binding-path`);
      if (isCredentialString(value)) leaks.push(`${path} credential`);
      return;
    }
    if (typeof value === 'function') return;
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (isRawDriver(value)) leaks.push(`${path} raw-driver`);
    if (isStorageHandle(value)) leaks.push(`${path} storage-handle`);
    if (isDatabaseHandle(value)) leaks.push(`${path} database-handle`);
    if (keyName && FORBIDDEN_KEYS.has(compactKey(keyName))) {
      leaks.push(`${path} forbidden-key`);
    }

    if (value instanceof Map) {
      for (const [key, entry] of value.entries()) {
        visit(key, `${path}.MapKey`, key);
        visit(entry, `${path}.Map(${String(key)})`, key);
      }
      return;
    }
    if (value instanceof Set) {
      let index = 0;
      for (const entry of value.values()) {
        visit(entry, `${path}.Set(${index})`);
        index += 1;
      }
      return;
    }

    let cursor = value;
    let depth = 0;
    while (cursor && cursor !== Object.prototype && cursor !== Function.prototype && depth < 32) {
      inspectOwn(cursor, path);
      if (types.isProxy(cursor)) break;
      cursor = Object.getPrototypeOf(cursor);
      depth += 1;
    }
  };

  const inspectOwn = (object, path) => {
    let names;
    try {
      names = [
        ...Object.getOwnPropertyNames(object),
        ...Object.getOwnPropertySymbols(object),
      ];
    } catch {
      return;
    }
    for (const key of names) {
      if (key === 'constructor') continue;
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(object, key);
      } catch {
        continue;
      }
      if (!descriptor) continue;
      const name = String(key);
      const childPath = `${path}.${name}`;
      if (FORBIDDEN_KEYS.has(compactKey(key))) {
        leaks.push(`${childPath} forbidden-key`);
      }
      if (Object.hasOwn(descriptor, 'value')) {
        const child = descriptor.value;
        if (typeof child === 'function') continue;
        visit(child, childPath, key);
      }
    }
  };

  visit(root, '$');
  return leaks;
}

async function asyncAppFor(t, options = {}) {
  const workspace = workspaceFor(t);
  const app = await createAccordoAppAsync({
    dbPath: options.dbPath ?? workspace.dbPath,
    selected: options.selected,
    clock: options.clock,
  });
  t.after(() => app.close());
  return { app, workspace };
}

test('public surfaces export both factories and do not leak portable internals', () => {
  assert.deepEqual(Object.keys(publicApp).sort(), ['createAccordoApp', 'createAccordoAppAsync']);
  assert.equal(typeof publicApp.createAccordoApp, 'function');
  assert.equal(typeof publicApp.createAccordoAppAsync, 'function');
  assert.equal(publicApp.createAccordoApp.constructor.name, 'Function');
  assert.equal(publicApp.createAccordoAppAsync.constructor.name, 'AsyncFunction');
  assert.equal(Object.hasOwn(publicApp, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicApp, 'startPortableHttpServer'), false);
  assert.equal(Object.hasOwn(publicApp, 'preflightSelectedGraph'), false);
  assert.equal(Object.hasOwn(publicApp, 'startSqliteLifecycle'), false);
  assert.equal(Object.hasOwn(publicKernel, 'createAccordoAppAsync'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableHttpServer'), false);
});

test('the async factory source does not wrap the v1 factory or select generated v1 registries', () => {
  const source = readFileSync(new URL('../packages/app/src/create-app-async.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*create-app\.js['"]/.test(source), false);
  assert.equal(/\bcreateAccordoApp\s*\(/.test(source), false);
  assert.equal(/Promise\.resolve\s*\(/.test(source), false);
  assert.equal(/redactOrWrap/.test(source), false);
  assert.equal(/generatedDomains/.test(source), false);
  assert.equal(/generatedActions/.test(source), false);
  assert.equal(/domains\/generated/.test(source), false);
  assert.equal(/actions\/generated/.test(source), false);
  assert.match(source, /packageContract:\s*2/);
  assert.match(source, /packages:\s*Object\.freeze\(\[\]\)/);
});

test('the v1 factory source stays a synchronous non-thenable function', () => {
  const source = readFileSync(new URL('../packages/app/src/create-app.js', import.meta.url), 'utf8');
  assert.match(source, /^export function createAccordoApp/m);
  assert.equal(/export async function createAccordoApp/.test(source), false);
  assert.equal(/Promise\.resolve\s*\(\s*createAccordoApp/.test(source), false);
});

test('createAccordoApp remains synchronous, non-thenable and immediately readable', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.equal(typeof app.then, 'undefined');
    assert.equal(typeof app.services.companies.list, 'function');
    assert.deepEqual(app.services.companies.list(), []);
    assert.equal(app.database.storage.contract, 1);
    assert.equal(typeof app.close.then, 'undefined');
  } finally {
    app.close();
  }
});

test('v1 sync and v2 async paths are distinct applications, not a wrapped object', async (t) => {
  const pending = createAccordoAppAsync({ dbPath: ':memory:' });
  assert.equal(pending instanceof Promise, true);
  assert.equal(typeof pending.then, 'function');
  const asyncApp = await pending;
  t.after(() => asyncApp.close());
  const syncApp = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => syncApp.close());

  assert.notEqual(asyncApp, syncApp);
  assert.equal(asyncApp instanceof Promise, false);
  assert.equal(typeof asyncApp.then, 'undefined');
  assert.equal(asyncApp.packageContract, 2);
  assert.deepEqual(asyncApp.storage, { adapter: 'sqlite', available: true });
  assert.equal('database' in asyncApp, false);
  assert.equal('database' in syncApp, true);
  assert.equal(typeof asyncApp.close.then, 'undefined');
  assert.equal(typeof asyncApp.close, 'function');
  const closed = asyncApp.close();
  assert.equal(typeof closed.then, 'function');
});

test('the default async factory composes kernel CRM over an explicit empty contract-2 graph', async (t) => {
  const { app } = await asyncAppFor(t);
  assert.equal(Object.isFrozen(app), true);
  assert.deepEqual(Object.keys(app).sort(), [...FACADE_KEYS]);
  assert.equal(app.packageContract, 2);
  assert.deepEqual(app.domains.names(), []);
  assert.equal(app.domains.has('lead-intelligence'), false);
  assert.equal(app.modules.get('company').name, 'company');
  assert.equal(app.modules.get('contact').name, 'contact');
  assert.equal(app.modules.get('opportunity').name, 'opportunity');
  assert.equal(app.modules.get('approval').name, 'approval');

  const actor = { type: 'system', id: 'm2e3' };
  const company = await app.services.companies.create(
    { name: 'Async Co', domain: 'async.example' },
    { actor },
  );
  assert.equal(app.services.companies.get(company.id).name, 'Async Co');
  assert.equal(app.services.companies.list().length, 1);
  assert.equal(app.audit.list({ entityType: 'company', entityId: company.id }).length, 1);

  const contact = await app.services.contacts.create({
    companyId: company.id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@async.example',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Async deal',
    type: 'new_business',
    valueCents: 1000,
    currency: 'EUR',
    stage: 'qualification',
    owner: 'ada',
  }, { actor });
  assert.equal(app.services.opportunities.get(opportunity.id).name, 'Async deal');
});

test('a v1 or mixed selected graph refuses before any sqlite path is created', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');

  await assert.rejects(
    () => createAccordoAppAsync({
      selected: { packageContract: 1, packages: [], actions: [], modules: [] },
      dbPath: missingParent,
    }),
    isAsyncContract,
  );
  await assert.rejects(
    () => createAccordoAppAsync({
      selected: { packageContract: 2, packages: [pkg('sync', 1)], actions: [], modules: [] },
      dbPath: missingParent,
    }),
    isAsyncContract,
  );
  await assert.rejects(
    () => createAccordoAppAsync({
      selected: {
        packageContract: 2,
        packages: [pkg('async', 2), pkg('sync', 1)],
        actions: [],
        modules: [],
      },
      dbPath: missingParent,
    }),
    isAsyncContract,
  );

  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('legacy custom package remains sync-compatible and portable-fail-closed', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');
  const custom = createPartnerScorecardPackage();
  assert.equal(custom.packageContract, 1);

  const syncApp = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => syncApp.close());
  assert.equal(syncApp instanceof Promise, false);
  assert.deepEqual(syncApp.services.companies.list(), []);

  await assert.rejects(
    () => createAccordoAppAsync({
      selected: {
        packageContract: 2,
        packages: [custom],
        actions: [],
        modules: [],
      },
      dbPath: missingParent,
    }),
    isAsyncContract,
  );
  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('PostgreSQL-shaped options refuse before any path is created and never echo credentials', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');
  const user = 'm2e3-user';
  const token = 'unavailable';
  const sentinel = `postgresql://${user}:${token}@localhost:5432/accordo`;

  const cases = [
    { adapter: 'postgresql', dbPath: missingParent },
    { adapter: 'postgres', dbPath: missingParent },
    { adapter: sentinel, dbPath: missingParent },
    { dbPath: sentinel },
    { connectionString: sentinel, dbPath: missingParent },
    { connection: { host: 'localhost', user, password: token }, dbPath: missingParent },
  ];

  for (const options of cases) {
    await assert.rejects(
      () => createAccordoAppAsync(options),
      (error) => {
        assert.equal(error.code, 'PORTABLE_POSTGRESQL_BINDING_REQUIRED');
        assert.equal(error.status, 400);
        assert.equal(error.details?.adapter, 'postgresql');
        const blob = `${error.message}\n${JSON.stringify(error.details)}`;
        assert.equal(blob.includes(token), false, blob);
        assert.equal(blob.includes(user), false, blob);
        assert.equal(blob.includes(sentinel), false, blob);
        return true;
      },
    );
  }

  await assert.rejects(
    () => createAccordoAppAsync({ spine: { mode: 'local-development' }, dbPath: missingParent }),
    (error) => error.code === 'PORTABLE_OPTION_UNSUPPORTED' && error.details?.option === 'spine',
  );

  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('the public async app exposes no nested storage handle, driver, binding path or credential', async (t) => {
  const { app } = await asyncAppFor(t);
  const actor = { type: 'system', id: 'm2e3' };
  const company = await app.services.companies.create({ name: 'Leak Co' }, { actor });
  assert.equal(company.name, 'Leak Co');
  const leaks = findStorageLeaks(app);
  assert.deepEqual(leaks, [], leaks.join('\n'));
  assert.equal(app.services.companies.database, undefined);
  assert.equal(app.audit.database, undefined);
  assert.equal(app.workflows.database, undefined);
});

test('successful public close is async, idempotent and shares one settlement', async (t) => {
  const { app } = await asyncAppFor(t);
  const first = app.close();
  const second = app.close();
  assert.equal(typeof first.then, 'function');
  assert.strictEqual(first, second);
  await first;
  await second;
});

test('a child process composes through the public async factory, writes, reads audit and closes', (t) => {
  const workspace = workspaceFor(t);
  const factoryHref = new URL('../packages/app/src/index.js', import.meta.url).href;
  const script = `
import { createAccordoApp, createAccordoAppAsync } from ${JSON.stringify(factoryHref)};
const sync = createAccordoApp({ dbPath: ':memory:' });
if (sync instanceof Promise || typeof sync.then === 'function') process.exit(7);
sync.close();
const app = await createAccordoAppAsync({ dbPath: ${JSON.stringify(workspace.dbPath)} });
if (app.packageContract !== 2) process.exit(8);
if (app.domains.names().length !== 0) process.exit(9);
const company = await app.services.companies.create(
  { name: 'Child Co' },
  { actor: { type: 'system', id: 'child' } },
);
const listed = app.services.companies.list();
if (listed.length !== 1 || listed[0].name !== 'Child Co') process.exit(2);
const audit = app.audit.list({ entityType: 'company', entityId: company.id });
if (audit.length !== 1) process.exit(4);
if (app.storage.adapter !== 'sqlite' || app.storage.available !== true) process.exit(5);
if ('database' in app || app.services.companies.database) process.exit(6);
const first = app.close();
const second = app.close();
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
