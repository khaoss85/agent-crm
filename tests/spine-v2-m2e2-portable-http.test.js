import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as publicApp from '../packages/app/src/index.js';
import * as publicKernel from '../packages/core/index.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createDatabase } from '../packages/core/src/database.js';
import {
  isThenable,
  refuseThenableDomainValue,
} from '../packages/core/src/async-values.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { startPortableHttpServer } from '../packages/app/src/portable-http.js';

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

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2e2c-'));
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
  return error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED';
}

function v2HttpPackage(overrides = {}) {
  return pkg('probe-http', 2, {
    actions: [{
      module: 'opportunity',
      name: 'probe-tag',
      actionContract: 2,
      execute: async (ctx) => ({ id: ctx.record.id, tagged: true }),
    }],
    operations: [{
      name: 'probe-ping',
      operationContract: 2,
      appMethod: 'syncCatalog',
      create: () => async ({ provider } = {}) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true, provider: provider ?? null, slow: true };
      },
    }],
    capabilities: [{
      name: 'probe-cap',
      version: 1,
      capabilityContract: 2,
      create: async () => ({
        capabilityContract: 2,
        ping: async () => ({ ok: true }),
      }),
    }],
    ...overrides,
  });
}

function v2HttpSelected(overrides = {}) {
  return {
    packageContract: 2,
    packages: [v2HttpPackage(overrides)],
    actions: [],
    modules: ['opportunity'],
  };
}

const jsonHeaders = {
  'content-type': 'application/json',
  'x-actor-type': 'system',
  'x-actor-id': 'probe',
};

async function jsonRequest(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}

test('public surfaces do not grow a second factory or leak the portable HTTP starter', () => {
  assert.deepEqual(Object.keys(publicApp).sort(), ['createAccordoApp']);
  assert.equal(Object.hasOwn(publicApp, 'createAccordoAppAsync'), false);
  assert.equal(Object.hasOwn(publicApp, 'startPortableSqliteApp'), false);
  assert.equal(Object.hasOwn(publicApp, 'startPortableHttpServer'), false);
  assert.equal(Object.hasOwn(publicKernel, 'createAccordoAppAsync'), false);
  assert.equal(Object.hasOwn(publicKernel, 'startPortableHttpServer'), false);
});

test('portable HTTP source does not wrap or publish the v1 factory', () => {
  const source = readFileSync(new URL('../packages/app/src/portable-http.js', import.meta.url), 'utf8');
  assert.equal(/from ['"].*create-app/.test(source), false);
  assert.equal(/\bcreateAccordoApp(?:Async)?\s*\(/.test(source), false);
  assert.equal(/\bcreateAccordoAppAsync\b/.test(source), false);
  assert.equal(/Promise\.resolve\s*\(\s*createAccordoApp/.test(source), false);
});

test('the released factory stays synchronous, non-thenable and its HTTP envelopes stay v1', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  assert.equal(app instanceof Promise, false);
  assert.equal(typeof app.then, 'undefined');
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const port = server.address().port;
  const created = await jsonRequest(`http://127.0.0.1:${port}/api/companies`, {
    method: 'POST',
    body: { name: 'V1 Co', domain: 'v1.example' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'V1 Co');
  assert.equal(typeof created.body.then, 'undefined');
  const listed = await jsonRequest(`http://127.0.0.1:${port}/api/companies`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(app.audit.list({ entityType: 'company', entityId: created.body.id }).length, 1);
});

test('a v1 or mixed selected graph refuses before any opener, provider or listener moves', async (t) => {
  const workspace = workspaceFor(t);
  const missingParent = join(workspace.root, 'never-created', 'accordo.sqlite');
  let opened = 0;
  let provided = 0;
  let listened = 0;
  const openDatabase = () => {
    opened += 1;
    throw new Error('opener moved');
  };

  await assert.rejects(
    () => startPortableHttpServer({
      selected: { packageContract: 1, packages: [], actions: [], modules: [] },
      dbPath: missingParent,
      openDatabase,
      providers: { register() { provided += 1; } },
      listen() { listened += 1; },
    }),
    (error) => error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED' && error.status === 400,
  );
  await assert.rejects(
    () => startPortableHttpServer({
      selected: { packageContract: 2, packages: [pkg('sync', 1)], actions: [], modules: [] },
      dbPath: missingParent,
      openDatabase,
      listen() { listened += 1; },
    }),
    (error) => error?.code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED' && error.status === 400,
  );

  assert.equal(opened, 0);
  assert.equal(provided, 0);
  assert.equal(listened, 0);
  assert.equal(existsSync(join(workspace.root, 'never-created')), false);
});

test('listener spy stays at zero until portable composition and security are ready', async (t) => {
  const workspace = workspaceFor(t);
  let listenCalls = 0;
  let securityStarted = false;
  const runtime = await startPortableHttpServer({
    selected: v2Empty,
    dbPath: workspace.dbPath,
    security: {
      async start() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        securityStarted = true;
        assert.equal(listenCalls, 0, 'listen must not run before security start settles');
      },
    },
    listen() {
      listenCalls += 1;
      assert.equal(securityStarted, true, 'listen must run only after security start');
    },
  });
  t.after(() => runtime.close());
  assert.equal(securityStarted, true);
  assert.equal(listenCalls, 1);
  assert.equal(runtime.app.packageContract, 2);
  assert.deepEqual(runtime.app.storage, { adapter: 'sqlite', available: true });
});

test('hanging async security provider never begins listening', async (t) => {
  const workspace = workspaceFor(t);
  let listenCalls = 0;
  /** @type {() => void} */
  let release = () => {};
  const hang = new Promise((resolve) => { release = resolve; });
  const started = startPortableHttpServer({
    selected: v2Empty,
    dbPath: workspace.dbPath,
    security: { async start() { await hang; } },
    listen() { listenCalls += 1; },
  });
  started.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(listenCalls, 0, 'a hanging security start must not bind a listener');
  release();
  const runtime = await started;
  t.after(() => runtime.close());
  assert.equal(listenCalls, 1);
});

test('a rejecting identity verifier aborts startup, closes owned resources and never listens', async (t) => {
  const workspace = workspaceFor(t);
  let listenCalls = 0;
  const cause = new Error('VERIFIER_REJECTED');
  const rejected = Promise.reject(cause);
  rejected.catch(() => {});
  await assert.rejects(
    () => startPortableHttpServer({
      selected: v2Empty,
      dbPath: workspace.dbPath,
      identityVerifier: rejected,
      listen() { listenCalls += 1; },
    }),
    (error) => error === cause,
  );
  assert.equal(listenCalls, 0);
});

test('a rejecting package startup hook aborts startup and never listens', async (t) => {
  const workspace = workspaceFor(t);
  let listenCalls = 0;
  const cause = new Error('STARTUP_HOOK_REJECTED');
  await assert.rejects(
    () => startPortableHttpServer({
      selected: {
        packageContract: 2,
        packages: [pkg('probe-start', 2, {
          async start() {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw cause;
          },
        })],
        actions: [],
        modules: [],
      },
      dbPath: workspace.dbPath,
      listen() { listenCalls += 1; },
    }),
    (error) => error === cause,
  );
  assert.equal(listenCalls, 0);
});

test('a thenable capability response treated as a domain value is refused before listen', async (t) => {
  const workspace = workspaceFor(t);
  let listenCalls = 0;
  const iface = {
    capabilityContract: 2,
    ping: () => ({ ok: true }),
  };
  iface.then = (resolve) => resolve(iface);

  assert.equal(isThenable(iface), true);
  assert.throws(
    () => refuseThenableDomainValue(iface, 'capability interface'),
    (error) => isAsyncContract(error) && /capability interface/.test(error.message),
  );

  await assert.rejects(
    () => startPortableHttpServer({
      selected: {
        packageContract: 2,
        packages: [pkg('probe-thenable-cap', 2, {
          capabilities: [{
            name: 'thenable-cap',
            version: 1,
            capabilityContract: 2,
            create: () => iface,
          }],
        })],
        actions: [],
        modules: [],
      },
      dbPath: workspace.dbPath,
      listen() { listenCalls += 1; },
    }),
    (error) => isAsyncContract(error) && /capability/.test(error.message),
  );
  assert.equal(listenCalls, 0);
});

test('an HTTP handler that would serialize a thenable as a domain value is refused', async (t) => {
  const workspace = workspaceFor(t);
  const runtime = await startPortableHttpServer({
    selected: {
      packageContract: 2,
      packages: [pkg('probe-thenable-op', 2, {
        operations: [{
          name: 'probe-thenable-items',
          operationContract: 2,
          appMethod: 'syncCatalog',
          create: () => () => ({ items: Promise.resolve([{ ok: true }]) }),
        }],
      })],
      actions: [],
      modules: [],
    },
    dbPath: workspace.dbPath,
    port: 0,
    host: '127.0.0.1',
  });
  t.after(() => runtime.close());

  const response = await jsonRequest(`${runtime.url}/api/catalog/sync`, {
    method: 'POST',
    body: { provider: 'probe' },
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'PACKAGE_ASYNC_CONTRACT_REQUIRED');
  assert.equal(/Promise/.test(JSON.stringify(response.body)), false);
});

test('startup failure plus cleanup failure preserves the original cause', async (t) => {
  const workspace = workspaceFor(t);
  const cause = new Error('SECURITY_FAILED');
  const cleanup = new Error('CLOSE_FAILED');
  let listenCalls = 0;
  let closes = 0;

  await assert.rejects(
    () => startPortableHttpServer({
      selected: v2Empty,
      dbPath: workspace.dbPath,
      openDatabase: (options) => {
        const opened = createDatabase(options);
        return {
          storage: opened.storage,
          close() {
            closes += 1;
            opened.close();
            throw cleanup;
          },
        };
      },
      security: {
        start() { throw cause; },
      },
      listen() { listenCalls += 1; },
    }),
    (error) => error === cause && error.cleanupError === cleanup,
  );
  assert.equal(listenCalls, 0);
  assert.equal(closes, 1);
});

test('capability declaration/interface contract echoes are verified before serving traffic', async (t) => {
  const workspace = workspaceFor(t);
  let listenCalls = 0;
  await assert.rejects(
    () => startPortableHttpServer({
      selected: {
        packageContract: 2,
        packages: [pkg('probe-echo', 2, {
          capabilities: [{
            name: 'echo-cap',
            version: 1,
            capabilityContract: 2,
            create: async () => ({ capabilityContract: 1 }),
          }],
        })],
        actions: [],
        modules: [],
      },
      dbPath: workspace.dbPath,
      listen() { listenCalls += 1; },
    }),
    (error) => isAsyncContract(error) && /echo/.test(error.message) && /capabilityContract/.test(error.message),
  );
  assert.equal(listenCalls, 0);

  const runtime = await startPortableHttpServer({
    selected: v2HttpSelected(),
    dbPath: join(workspace.root, 'ok.sqlite'),
    port: 0,
    host: '127.0.0.1',
  });
  t.after(() => runtime.close());
  const health = await jsonRequest(`${runtime.url}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.packageContract, 2);
});

test('portable HTTP awaits service, action and operation execution on the portable graph', async (t) => {
  const workspace = workspaceFor(t);
  const runtime = await startPortableHttpServer({
    selected: v2HttpSelected(),
    dbPath: workspace.dbPath,
    port: 0,
    host: '127.0.0.1',
  });
  t.after(() => runtime.close());
  const { app, url } = runtime;
  const actor = { type: 'system', id: 'probe' };

  const created = await jsonRequest(`${url}/api/companies`, {
    method: 'POST',
    body: { name: 'Probe Co', domain: 'probe.example' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Probe Co');
  assert.equal(typeof created.body.then, 'undefined');
  assert.equal(app.audit.list({ entityType: 'company', entityId: created.body.id }).length, 1);

  const listed = await jsonRequest(`${url}/api/companies`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items.length, 1);
  assert.equal(Array.isArray(listed.body.items), true);

  const contact = await app.services.contacts.create({
    companyId: created.body.id,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@probe.example',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: created.body.id,
    contactId: contact.id,
    name: 'Probe deal',
    type: 'new_business',
    valueCents: 1000,
    currency: 'EUR',
    stage: 'qualification',
    owner: 'ada',
  }, { actor });

  const tagged = await jsonRequest(
    `${url}/api/modules/opportunity/records/${opportunity.id}/actions/probe-tag`,
    { method: 'POST', body: {} },
  );
  assert.equal(tagged.status, 200);
  assert.equal(tagged.body.result?.tagged ?? tagged.body.tagged, true);

  const startedAt = Date.now();
  const pinged = await jsonRequest(`${url}/api/catalog/sync`, {
    method: 'POST',
    body: { provider: 'probe' },
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(pinged.status, 200);
  assert.equal(pinged.body.ok, true);
  assert.equal(pinged.body.slow, true);
  assert.equal(typeof pinged.body.then, 'undefined');
  assert.ok(elapsed >= 15, `async operation must be awaited before the response is sent (${elapsed}ms)`);
});

test('portable HTTP close is async, idempotent and shares one settlement', async (t) => {
  const workspace = workspaceFor(t);
  const runtime = await startPortableHttpServer({
    selected: v2Empty,
    dbPath: workspace.dbPath,
    listen() {},
  });
  const first = runtime.close();
  const second = runtime.close();
  assert.equal(typeof first.then, 'function');
  assert.strictEqual(first, second);
  await first;
  await second;
});

test('a child process starts portable HTTP only after readiness, serves traffic and closes', (t) => {
  const workspace = workspaceFor(t);
  const href = new URL('../packages/app/src/portable-http.js', import.meta.url).href;
  const script = `
import { startPortableHttpServer } from ${JSON.stringify(href)};
const runtime = await startPortableHttpServer({
  selected: ${JSON.stringify(v2Empty)},
  dbPath: ${JSON.stringify(workspace.dbPath)},
  port: 0,
  host: '127.0.0.1',
});
const health = await fetch(runtime.url + '/health').then((response) => response.json());
if (health.ok !== true || health.packageContract !== 2) {
  console.error(JSON.stringify(health));
  process.exit(2);
}
const created = await fetch(runtime.url + '/api/companies', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-actor-type': 'system', 'x-actor-id': 'child' },
  body: JSON.stringify({ name: 'Child Co' }),
});
const body = await created.json();
if (created.status !== 201 || body.name !== 'Child Co') {
  console.error(JSON.stringify(body));
  process.exit(4);
}
if (runtime.app.audit.list({ entityType: 'company', entityId: body.id }).length !== 1) process.exit(5);
const first = runtime.close();
const second = runtime.close();
if (first !== second) process.exit(3);
await first;
`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
