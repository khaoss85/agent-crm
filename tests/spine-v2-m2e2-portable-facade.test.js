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
import { createAccordoApp } from '../packages/app/src/index.js';
import { startPortableSqliteApp } from '../packages/app/src/portable-app.js';

const v2Empty = Object.freeze({
  packageContract: 2,
  packages: Object.freeze([]),
  actions: Object.freeze([]),
  modules: Object.freeze([]),
});

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

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2e2b-'));
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

function v2ProbePackage() {
  return pkg('probe-domain', 2, {
    actions: [{
      module: 'opportunity',
      name: 'probe-tag',
      actionContract: 2,
      execute: async (ctx) => ({ id: ctx.record.id, tagged: true }),
    }],
    operations: [{
      name: 'probe-ping',
      operationContract: 2,
      appMethod: 'probePing',
      create: () => async () => ({ ok: true }),
    }],
  });
}

function v2ProbeSelected() {
  return {
    packageContract: 2,
    packages: [v2ProbePackage()],
    actions: [],
    modules: ['opportunity'],
  };
}

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
    // Own-name inspection is enough; a throwing hasOwn is itself hostile.
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

/**
 * Walk own properties, prototypes, Maps/Sets and accessor *descriptors*
 * without invoking getters, methods or other user code.
 */
function findStorageLeaks(root) {
  const leaks = [];
  const seen = new WeakSet();
  const queue = [{ value: root, path: '$' }];

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
      // Accessors: record forbidden names above; never invoke get/set.
    }
  };

  visit(root, '$');
  return leaks;
}

async function portableAppFor(t, options = {}) {
  const workspace = workspaceFor(t);
  const app = await startPortableSqliteApp({
    selected: options.selected ?? v2Empty,
    dbPath: options.dbPath ?? workspace.dbPath,
    clock: options.clock,
  });
  t.after(() => app.close());
  return { app, workspace };
}

test('public surfaces do not leak the portable facade', () => {
  assert.deepEqual(Object.keys(publicApp).sort(), ['createAccordoApp', 'createAccordoAppAsync']);
  assert.equal(Object.hasOwn(publicApp, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicApp, 'startPortableHttpServer'), false);
  assert.equal(Object.hasOwn(publicApp, 'preflightSelectedGraph'), false);
  assert.equal(Object.hasOwn(publicApp, 'startSqliteLifecycle'), false);
  assert.equal(Object.hasOwn(publicKernel, 'createAccordoAppAsync'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableHttpServer'), false);
});

test('portable factory source does not wrap or import the v1 factory', () => {
  const source = readFileSync(new URL('../packages/app/src/portable-app.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*create-app/.test(source), false);
  assert.equal(/\bcreateAccordoApp(?:Async)?\s*\(/.test(source), false);
  assert.equal(/\bcreateAccordoAppAsync\b/.test(source), false);
  assert.equal(/Promise\.resolve\s*\(/.test(source), false);
  assert.equal(/redactOrWrap/.test(source), false);
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

test('the leak walker is not vacuous: the v1 app still exposes the M2F nested handles', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const leaks = findStorageLeaks(app);
    assert.ok(leaks.some((entry) => /\.database\b/.test(entry)), leaks.join('\n'));
    assert.ok(leaks.some((entry) => entry.includes('audit') && entry.includes('database')), leaks.join('\n'));
    assert.ok(leaks.some((entry) => /compan(y|ies)/.test(entry) && entry.includes('database')), leaks.join('\n'));
    assert.ok(leaks.some((entry) => entry.includes('workflows') && entry.includes('database')), leaks.join('\n'));
    assert.ok(leaks.some((entry) => /modules/.test(entry) && /database/.test(entry)), leaks.join('\n'));
  } finally {
    app.close();
  }
});

test('a v1 or mixed selected graph refuses before any opener, path, provider or listener moves', async (t) => {
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
    () => startPortableSqliteApp({
      selected: { packageContract: 1, packages: [], actions: [], modules: [] },
      dbPath: missingParent,
      openDatabase,
      providers,
      listen,
    }),
    isAsyncContract,
  );
  await assert.rejects(
    () => startPortableSqliteApp({
      selected: { packageContract: 2, packages: [pkg('sync', 1)], actions: [], modules: [] },
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

test('the portable facade is a frozen lexical allowlist with a bounded storage descriptor', async (t) => {
  const { app } = await portableAppFor(t);
  assert.equal(Object.isFrozen(app), true);
  assert.deepEqual(Object.keys(app).sort(), [...FACADE_KEYS]);
  assert.equal(Object.getPrototypeOf(app), Object.prototype);
  assert.equal(typeof app.then, 'undefined');
  assert.equal(app instanceof Promise, false);
  assert.equal(app.packageContract, 2);
  assert.deepEqual(app.storage, { adapter: 'sqlite', available: true });
  assert.equal(Object.isFrozen(app.storage), true);
  assert.deepEqual(Object.keys(app.storage).sort(), ['adapter', 'available']);
  assert.equal('database' in app, false);
  assert.equal('raw' in app, false);
  assert.equal('tenantBinding' in app, false);
  assert.equal('controlPlaneDatabase' in app, false);
  assert.equal('probePing' in app, false);
  assert.equal(typeof app.close.then, 'undefined');
  assert.equal(typeof app.close, 'function');
});

test('the portable facade exposes no nested v1 storage handle, driver, binding path or credential', async (t) => {
  const { app } = await portableAppFor(t, { selected: v2ProbeSelected() });
  const actor = { type: 'system', id: 'probe' };
  const company = await app.services.companies.create({ name: 'Probe Co', domain: 'probe.example' }, { actor });
  await app.services.contacts.create({
    companyId: company.id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@probe.example',
  }, { actor });
  const leaks = findStorageLeaks(app);
  assert.deepEqual(leaks, [], leaks.join('\n'));
  assert.equal(app.services.companies.database, undefined);
  assert.equal(app.audit.database, undefined);
  assert.equal(app.workflows.database, undefined);
  assert.equal('modules' in app.modules, false);
  assert.equal(app.modules.get('company').service.database, undefined);
});

test('a uniform v2 graph composes kernel modules, packages, actions, operations, audit, workflow and providers', async (t) => {
  const { app } = await portableAppFor(t, { selected: v2ProbeSelected() });
  const actor = { type: 'system', id: 'probe' };

  const company = await app.services.companies.create({ name: 'Probe Co', domain: 'probe.example' }, { actor });
  const contact = await app.services.contacts.create({
    companyId: company.id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@probe.example',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Probe deal',
    type: 'new_business',
    valueCents: 1000,
    currency: 'EUR',
    stage: 'qualification',
    owner: 'ada',
  }, { actor });

  assert.equal(app.services.companies.get(company.id).name, 'Probe Co');
  assert.equal(app.services.companies.list().length, 1);
  assert.equal(app.audit.list({ entityType: 'company', entityId: company.id }).length, 1);

  const tagged = await app.runAction({
    module: 'opportunity',
    action: 'probe-tag',
    recordId: opportunity.id,
    actor,
  });
  assert.deepEqual(tagged.result ?? tagged, { id: opportunity.id, tagged: true });

  const pinged = await app.operations.run('probe-ping');
  assert.deepEqual(pinged, { ok: true });
  assert.deepEqual(
    app.operations.list().map((entry) => entry.name),
    ['probe-ping'],
  );

  const workflow = await app.workflows.run(
    'request-opportunity-stage-change',
    { opportunityId: opportunity.id, targetStage: 'proposal' },
    { actor },
  );
  assert.equal(workflow.status, 'completed');
  assert.equal(app.services.opportunities.get(opportunity.id).stage, 'proposal');
  assert.equal(app.providers.list().some((entry) => entry.kind === 'notification'), true);
  assert.equal(app.domains.get('probe-domain').packageContract, 2);
  assert.equal(app.modules.get('company').name, 'company');
});

test('async persistFingerprints settles before the portable facade is returned', async (t) => {
  const workspace = workspaceFor(t);
  let persisted = false;
  const delayed = pkg('probe-persist', 2, {
    persistFingerprints: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      persisted = true;
    },
  });
  const app = await startPortableSqliteApp({
    selected: {
      packageContract: 2,
      packages: [delayed],
      actions: [],
      modules: [],
    },
    dbPath: workspace.dbPath,
  });
  t.after(() => app.close());
  assert.equal(persisted, true, 'startup must await a thenable persistFingerprints');
});

test('a rejecting persistFingerprints thenable aborts startup before a facade or listener exists', async (t) => {
  const workspace = workspaceFor(t);
  const cause = new Error('PERSIST_REJECTED');
  let listenCalls = 0;
  let facade;
  await assert.rejects(
    async () => {
      facade = await startPortableSqliteApp({
        selected: {
          packageContract: 2,
          packages: [pkg('probe-persist-reject', 2, {
            persistFingerprints: async () => {
              await new Promise((resolve) => setTimeout(resolve, 10));
              throw cause;
            },
          })],
          actions: [],
          modules: [],
        },
        dbPath: workspace.dbPath,
        listen() { listenCalls += 1; },
      });
    },
    (error) => error === cause,
  );
  assert.equal(facade, undefined, 'no portable facade is returned after a rejected persist hook');
  assert.equal(listenCalls, 0, 'no listener is installed before persist settlement');
});

test('successful portable close is async, idempotent and shares one settlement', async (t) => {
  const { app } = await portableAppFor(t);
  const first = app.close();
  const second = app.close();
  assert.equal(typeof first.then, 'function');
  assert.strictEqual(first, second);
  await first;
  await second;
});

test('a child process composes the portable graph, writes through a service, reads audit and closes', (t) => {
  const workspace = workspaceFor(t);
  const portableHref = new URL('../packages/app/src/portable-app.js', import.meta.url).href;
  const script = `
import { startPortableSqliteApp } from ${JSON.stringify(portableHref)};
const app = await startPortableSqliteApp({
  selected: ${JSON.stringify(v2Empty)},
  dbPath: ${JSON.stringify(workspace.dbPath)},
});
const company = await app.services.companies.create(
  { name: 'Probe Co' },
  { actor: { type: 'system', id: 'child' } },
);
const listed = app.services.companies.list();
if (listed.length !== 1 || listed[0].name !== 'Probe Co') {
  console.error(JSON.stringify(listed));
  process.exit(2);
}
const audit = app.audit.list({ entityType: 'company', entityId: company.id });
if (audit.length !== 1) {
  console.error(JSON.stringify(audit));
  process.exit(4);
}
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
