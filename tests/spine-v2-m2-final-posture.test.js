// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccordoApp, createAccordoAppAsync } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { startPortableHttpServer } from '../packages/app/src/portable-http.js';
import { createDatabase } from '../packages/core/src/database.js';
import { loadDeploymentStorage } from '../packages/core/src/deployment-storage.js';
import { createMcpServer } from '../packages/mcp/src/index.js';
import {
  createProductionPromptRegistry,
  createProductionResourceRegistry,
  createProductionToolRegistry,
} from '../packages/mcp/src/production-surface.js';
import { AccordoClient } from '../packages/sdk/src/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cli = join(repoRoot, 'packages/cli/bin/accordo.js');

const LEAK_TOKEN = 'LEAK-SENTINEL';
const POSTGRES_URL = 'postgresql://m2-user:s3cret-unavailable@localhost:5432/accordo';
const SENTINEL_PASSWORD = 's3cret-unavailable';
const SENTINEL_USER = 'm2-user';

const HEALTH_SHAPE = Object.freeze({
  ok: true,
  ready: true,
  storage: Object.freeze({ adapter: 'sqlite', available: true }),
});

const v2Empty = Object.freeze({
  packageContract: 2,
  packages: Object.freeze([]),
  actions: Object.freeze([]),
  modules: Object.freeze([]),
});

const VALID_VERIFIER = [
  'export const identityVerifierContract = 2;',
  "export const identityVerifierTrust = 'local-development';",
  'export function createIdentityVerifier() {',
  '  return {',
  '    verifyRequest() { return null; },',
  '    discoverControlResource() {},',
  '    attestControlStartup() {},',
  '    discoverDataResource() {},',
  '    attestDataStartup() {},',
  '  };',
  '}',
  '',
].join('\n');

function workspaceFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2-final-posture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    dbPath: join(root, `${LEAK_TOKEN}-accordo.sqlite`),
  };
}

function haystackOf(value) {
  const chunks = [];
  const seen = new WeakSet();

  const visit = (node) => {
    if (node === null || node === undefined) return;
    const type = typeof node;
    if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
      chunks.push(String(node));
      return;
    }
    if (type === 'function') {
      chunks.push(Function.prototype.toString.call(node));
      return;
    }
    if (type !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof Error) {
      chunks.push(node.name, node.message, node.stack ?? '');
      visit(/** @type {any} */ (node).code);
      visit(/** @type {any} */ (node).details);
      visit(node.cause);
    }
    try {
      chunks.push(JSON.stringify(node));
    } catch {
      chunks.push('[unserializable]');
    }
    let names = [];
    try {
      names = [...Object.getOwnPropertyNames(node), ...Object.getOwnPropertySymbols(node)];
    } catch {
      return;
    }
    for (const key of names) {
      chunks.push(String(key));
      try {
        visit(/** @type {any} */ (node)[key]);
      } catch {
        // getters that throw are not locators we can print
      }
    }
  };

  visit(value);
  return chunks.join('\n');
}

function assertBounded(value, extras = []) {
  const haystack = haystackOf(value);
  for (const token of [
    LEAK_TOKEN,
    POSTGRES_URL,
    SENTINEL_PASSWORD,
    SENTINEL_USER,
    'identity-verifier.mjs',
    ...extras,
  ]) {
    assert.equal(haystack.includes(token), false, `public surface leaked ${token}: ${haystack.slice(0, 500)}`);
  }
}

function assertHealthContract(body) {
  assert.deepEqual(body, HEALTH_SHAPE);
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'ready', 'storage']);
  assert.deepEqual(Object.keys(body.storage).sort(), ['adapter', 'available']);
  assert.equal(Object.hasOwn(body, 'counts'), false);
  assert.equal(Object.hasOwn(body, 'packageContract'), false);
  assert.equal(Object.hasOwn(body, 'database'), false);
}

async function jsonRequest(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-actor-type': 'system',
      'x-actor-id': 'posture',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, text };
}

async function listenApp(t, app) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await Promise.resolve(app.close());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

function spawnEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CRM_DB_PATH;
  if (!Object.hasOwn(extra, 'ACCORDO_DEPLOYMENT_STORAGE')) delete env.ACCORDO_DEPLOYMENT_STORAGE;
  if (!Object.hasOwn(extra, 'ACCORDO_MODE')) delete env.ACCORDO_MODE;
  return env;
}

function runCli(args, { cwd = repoRoot, env = spawnEnv(), timeout = 30_000 } = {}) {
  return spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    cwd, encoding: 'utf8', timeout, env,
  });
}

function writeTrusted(filePath, contents, mode = 0o600) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  chmodSync(filePath, mode);
  return filePath;
}

function sqliteEnvelope(root) {
  return {
    contract: 1,
    adapter: 'sqlite',
    connection: { path: join(root, `${LEAK_TOKEN}-tenant.sqlite`) },
    controlPlane: { path: join(root, `${LEAK_TOKEN}-control.sqlite`) },
    spine: { mode: 'local-development', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
  };
}

function postgresEnvelope() {
  return {
    contract: 1,
    adapter: 'postgresql',
    connection: {
      host: '127.0.0.1',
      port: 5432,
      database: 'accordo',
      user: SENTINEL_USER,
      password: SENTINEL_PASSWORD,
      sslmode: 'verify-full',
      tls: {
        enabled: true,
        verify: 'full',
        caFile: './tls/deployment-ca.pem',
        servername: 'db.example.test',
      },
    },
    controlPlane: {
      host: '127.0.0.1',
      port: 5432,
      database: 'accordo_control',
      user: SENTINEL_USER,
      password: SENTINEL_PASSWORD,
      sslmode: 'verify-full',
      tls: {
        enabled: true,
        verify: 'full',
        caFile: './tls/deployment-ca.pem',
        servername: 'db.example.test',
      },
    },
    spine: { mode: 'production', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
  };
}

function documentScratch(t) {
  const workspace = workspaceFor(t);
  writeTrusted(join(workspace.root, 'providers/identity-verifier.mjs'), VALID_VERIFIER);
  const configPath = writeTrusted(
    join(workspace.root, 'deployment-storage.json'),
    `${JSON.stringify(sqliteEnvelope(workspace.root), null, 2)}\n`,
  );
  return { ...workspace, configPath };
}

function instrumentPrepare(raw) {
  if (!raw || typeof raw.prepare !== 'function') {
    return { get count() { return 0; }, reset() {}, sql: () => [] };
  }
  const original = raw.prepare.bind(raw);
  let count = 0;
  /** @type {string[]} */
  const sql = [];
  raw.prepare = (...args) => {
    count += 1;
    sql.push(String(args[0] ?? ''));
    return original(...args);
  };
  return {
    get count() { return count; },
    reset() { count = 0; sql.length = 0; },
    sql: () => [...sql],
  };
}

function instrumentTenantServices(app) {
  /** @type {string[]} */
  const calls = [];
  const trap = (label, target, method) => {
    if (!target || typeof target[method] !== 'function') return;
    target[method] = () => {
      calls.push(`${label}.${method}`);
      throw new Error(`${label}.${method} must not run during /health`);
    };
  };
  for (const name of ['companies', 'contacts', 'opportunities', 'approvals']) {
    for (const method of ['list', 'create', 'get']) trap(name, app.services[name], method);
  }
  trap('workflows', app.workflows, 'listRuns');
  trap('audit', app.audit, 'list');
  return calls;
}

test('document-selected doctor output has storage {adapter,available} and no path or credential', (t) => {
  const { root, configPath } = documentScratch(t);
  const run = runCli(['doctor', '--deployment-storage', configPath, '--root', root]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.storage, { adapter: 'sqlite', available: true });
  assert.deepEqual(Object.keys(receipt.storage).sort(), ['adapter', 'available']);
  assert.equal(Object.hasOwn(receipt, 'database'), false);
  assertBounded({ stdout: run.stdout, stderr: run.stderr, receipt }, [
    join(root, `${LEAK_TOKEN}-tenant.sqlite`),
    configPath,
  ]);
});

test('v1 accordo doctor --db still exposes the database path on its characterized CLI surface', (t) => {
  const workspace = workspaceFor(t);
  const run = runCli(['doctor', '--db', workspace.dbPath]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.database, workspace.dbPath);
  assert.equal(receipt.database.includes(LEAK_TOKEN), true);
  assert.ok(receipt.counts);
  assert.equal(Object.hasOwn(receipt, 'storage'), false);
});

test('document-selected serve output is bounded and HTTP health/schema stay locator-free', { timeout: 20_000 }, async (t) => {
  const { root, configPath } = documentScratch(t);
  const dbPath = join(root, `${LEAK_TOKEN}-tenant.sqlite`);
  const child = spawn(process.execPath, [
    '--no-warnings', cli, 'serve',
    '--deployment-storage', configPath,
    '--root', root,
    '--port', '0',
  ], {
    cwd: repoRoot, env: spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
    });
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`serve did not start: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', () => {
      if (!stdout.includes('Accordo running at')) return;
      if (!stdout.includes('"adapter":"sqlite"')) return;
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.once('exit', (code) => reject(new Error(`serve exited early (${code}): ${stderr}`)));
  });

  assert.equal(stdout.includes('Database:'), false, stdout);
  assert.equal(stdout.includes(dbPath), false, stdout);
  assertBounded({ stdout, stderr }, [configPath, dbPath]);
  const advertised = stdout.match(/Accordo running at (http:\/\/[^\s]+)/)?.[1];
  assert.ok(advertised, stdout);

  const health = await jsonRequest(`${advertised}/health`);
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assertBounded(health.body, [dbPath, advertised.replace('http://', '')]);

  const schema = await jsonRequest(`${advertised}/api/schema`);
  assert.equal(schema.status, 200);
  assert.deepEqual(schema.body.storage, { adapter: 'sqlite', available: true });
  assert.equal(Object.hasOwn(schema.body, 'database'), false);
  assertBounded(schema.body, [dbPath]);
});

test('portable async application facade health is bounded before HTTP startup', async (t) => {
  const workspace = workspaceFor(t);
  const before = await createAccordoAppAsync({ dbPath: workspace.dbPath });
  t.after(() => before.close());
  assert.deepEqual(before.storage, { adapter: 'sqlite', available: true });
  assertHealthContract(before.health());
  assertBounded(before.health(), [workspace.dbPath]);
  assertBounded({
    keys: Object.keys(before),
    storage: before.storage,
    health: before.health(),
  }, [workspace.dbPath]);
  assert.equal('database' in before, false);
});

test('portable HTTP /health is bounded after startup and carries no packageContract or counts', async (t) => {
  const workspace = workspaceFor(t);
  const runtime = await startPortableHttpServer({
    selected: v2Empty,
    dbPath: workspace.dbPath,
    port: 0,
    host: '127.0.0.1',
  });
  t.after(() => runtime.close());
  assertHealthContract(runtime.app.health());
  const health = await jsonRequest(`${runtime.url}/health`);
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assertBounded(health.body, [workspace.dbPath, runtime.url]);
  assert.equal(Object.hasOwn(health.body, 'packageContract'), false);
  assert.equal(health.body.counts, undefined);
});

test('/api/schema under portable and v1 HTTP includes storage and no locator', async (t) => {
  const workspace = workspaceFor(t);
  const v1 = createAccordoApp({ dbPath: workspace.dbPath });
  const v1Http = await listenApp(t, v1);
  const v1Schema = await jsonRequest(`${v1Http.url}/api/schema`);
  assert.equal(v1Schema.status, 200);
  assert.deepEqual(v1Schema.body.storage, { adapter: 'sqlite', available: true });
  assert.deepEqual(Object.keys(v1Schema.body.storage).sort(), ['adapter', 'available']);
  assert.equal(Object.hasOwn(v1Schema.body, 'database'), false);
  assertBounded(v1Schema.body, [workspace.dbPath]);

  const portable = await startPortableHttpServer({
    selected: v2Empty,
    dbPath: join(workspace.root, 'portable.sqlite'),
    port: 0,
    host: '127.0.0.1',
  });
  t.after(() => portable.close());
  const portableSchema = await jsonRequest(`${portable.url}/api/schema`);
  assert.equal(portableSchema.status, 200);
  assert.deepEqual(portableSchema.body.storage, { adapter: 'sqlite', available: true });
  assertBounded(portableSchema.body, [workspace.dbPath, join(workspace.root, 'portable.sqlite')]);
});

test('malformed and unavailable storage errors never echo locators or credentials', async (t) => {
  const workspace = workspaceFor(t);

  await assert.rejects(
    () => createAccordoAppAsync({
      adapter: 'postgresql',
      url: POSTGRES_URL,
      dbPath: POSTGRES_URL,
    }),
    (error) => {
      assert.equal(error.code, 'STORAGE_ADAPTER_UNAVAILABLE');
      assert.deepEqual(error.details, { adapter: 'postgresql' });
      assertBounded(error, [POSTGRES_URL, workspace.root]);
      return true;
    },
  );

  writeTrusted(join(workspace.root, 'providers/identity-verifier.mjs'), VALID_VERIFIER);
  const postgresPath = writeTrusted(
    join(workspace.root, 'pg.json'),
    `${JSON.stringify(postgresEnvelope(), null, 2)}\n`,
  );
  assert.throws(
    () => loadDeploymentStorage({ configPath: postgresPath }),
    (error) => {
      assert.equal(error.code, 'DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED');
      assert.equal(error.details?.adapter, 'postgresql');
      assertBounded(error, [postgresPath, SENTINEL_PASSWORD, POSTGRES_URL, '127.0.0.1']);
      return true;
    },
  );

  const malformedPath = writeTrusted(join(workspace.root, 'bad.json'), '{"adapter":"sqlite"}\n');
  assert.throws(
    () => loadDeploymentStorage({ configPath: malformedPath }),
    (error) => {
      assertBounded(error, [malformedPath, workspace.root, LEAK_TOKEN]);
      return true;
    },
  );

  const run = runCli(['doctor', '--deployment-storage', postgresPath, '--root', workspace.root]);
  assert.notEqual(run.status, 0);
  assertBounded({ stdout: run.stdout, stderr: run.stderr }, [
    postgresPath, SENTINEL_PASSWORD, SENTINEL_USER, '127.0.0.1', 'db.example.test',
  ]);
});

test('GET /health succeeds while every tenant service is instrumented to throw if called', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  const calls = instrumentTenantServices(app);
  const { url } = await listenApp(t, app);
  const health = await jsonRequest(`${url}/health`);
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assert.deepEqual(calls, []);
});

test('GET /health performs zero business-table queries', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  const actor = { type: 'system', id: 'seed' };
  await app.services.companies.create({ name: 'Counted Co', domain: 'counted.example' }, { actor });
  // storage.sync is frozen at construction, so wrapping it is a TypeError.
  // Instrument the driver after listen so startup prepares are not counted as health.
  const { url } = await listenApp(t, app);
  const queries = instrumentPrepare(app.database.raw);
  const health = await jsonRequest(`${url}/health`);
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assert.equal(queries.count, 0, `health issued ${queries.count} prepared statements: ${queries.sql().join(' | ')}`);
  assert.equal(Object.hasOwn(health.body, 'counts'), false);

  let portableQueries = 0;
  const portable = await startPortableHttpServer({
    selected: v2Empty,
    dbPath: join(workspace.root, 'portable-health.sqlite'),
    port: 0,
    host: '127.0.0.1',
    openDatabase: (options) => {
      const database = createDatabase(options);
      const original = database.raw.prepare.bind(database.raw);
      database.raw.prepare = (...args) => {
        portableQueries += 1;
        return original(...args);
      };
      return database;
    },
  });
  t.after(() => portable.close());
  portableQueries = 0;
  const portableHealth = await jsonRequest(`${portable.url}/health`);
  assert.equal(portableHealth.status, 200);
  assertHealthContract(portableHealth.body);
  assert.equal(portableQueries, 0, `portable health issued ${portableQueries} prepared statements`);
});

test('GET /health with a local-development spine and Admin user headers does not read or write tenant state', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({
    spine: {
      mode: 'local-development',
      tenant: { id: 'alpha', storageRoot: workspace.root, provision: { name: 'Alpha' } },
    },
  });
  const { url } = await listenApp(t, app);
  const org = app.spine.boundOrganization;
  const before = app.spine.memberships.listFor({ organizationId: org.id, limit: 50 });
  const dataQueries = instrumentPrepare(app.database.raw);
  const controlQueries = instrumentPrepare(app.controlPlaneDatabase.raw);
  const health = await jsonRequest(`${url}/health`, {
    headers: { 'x-actor-type': 'user', 'x-actor-id': 'admin-demo' },
  });
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assert.equal(
    dataQueries.count,
    0,
    `data-plane health queries: ${dataQueries.sql().join(' | ')}`,
  );
  assert.equal(
    controlQueries.count,
    0,
    `control-plane health queries: ${controlQueries.sql().join(' | ')}`,
  );
  const after = app.spine.memberships.listFor({ organizationId: org.id, limit: 50 });
  assert.deepEqual(
    after.map((row) => row.subject),
    before.map((row) => row.subject),
    'GET /health must not bootstrap memberships',
  );
  assert.equal(after.some((row) => row.subject === 'admin-demo'), false);
});

test('health output contains no locator or credential in the nested walk', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  const { url } = await listenApp(t, app);
  const health = await jsonRequest(`${url}/health`);
  assertHealthContract(health.body);
  assertBounded(health, [workspace.dbPath, url.replace('http://', '')]);
});

test('health stays bounded before and after portable startup', async (t) => {
  const workspace = workspaceFor(t);
  const app = await createAccordoAppAsync({ dbPath: workspace.dbPath });
  t.after(() => app.close());
  assertHealthContract(app.health());
  assertBounded(app.health(), [workspace.dbPath]);

  const runtime = await startPortableHttpServer({
    selected: v2Empty,
    dbPath: join(workspace.root, 'after.sqlite'),
    port: 0,
    host: '127.0.0.1',
  });
  t.after(() => runtime.close());
  assertHealthContract(runtime.app.health());
  const health = await jsonRequest(`${runtime.url}/health`);
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assertBounded(health.body, [workspace.dbPath, join(workspace.root, 'after.sqlite')]);
});

test('GET /api/admin/metrics is unavailable without authorization when a spine is composed', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({
    spine: {
      mode: 'production',
      identityVerifier: ({ headers }) => {
        const subject = headers['x-verified-subject'];
        if (typeof subject !== 'string' || subject === '') throw new Error('unverified');
        return {
          kind: 'verified-user',
          subject,
          issuer: 'https://issuer.test',
          method: 'oidc-id-token',
          organizationId: headers['x-verified-org'],
        };
      },
      tenant: { id: 'alpha', storageRoot: workspace.root, provision: { name: 'Alpha' } },
    },
  });
  const { url } = await listenApp(t, app);
  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });

  const anon = await jsonRequest(`${url}/api/admin/metrics`, { headers: {} });
  assert.equal(anon.status, 401);

  const missingIdentity = await fetch(`${url}/api/admin/metrics`);
  assert.equal(missingIdentity.status, 401);

  const stranger = await jsonRequest(`${url}/api/admin/metrics`, {
    headers: { 'x-verified-subject': 'vic', 'x-verified-org': org.id },
  });
  assert.equal(stranger.status, 403);

  const authorized = await jsonRequest(`${url}/api/admin/metrics`, {
    headers: { 'x-verified-subject': 'alice', 'x-verified-org': org.id },
  });
  assert.equal(authorized.status, 200);
  assert.equal(typeof authorized.body.counts.companies, 'number');
  assert.equal(typeof authorized.body.counts.pendingApprovals, 'number');
  assert.equal(Object.hasOwn(authorized.body, 'database'), false);

  const health = await jsonRequest(`${url}/health`);
  assert.equal(health.status, 200);
  assertHealthContract(health.body);
  assert.equal(Object.hasOwn(health.body, 'counts'), false);
});

test('Admin-equivalent HTTP still lists companies and metrics together under records.read', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  const actor = { type: 'user', id: 'admin-demo' };
  await app.services.companies.create({ name: 'Metric Co', domain: 'metric.example' }, { actor });
  const { url } = await listenApp(t, app);

  const [companies, metrics, health] = await Promise.all([
    jsonRequest(`${url}/api/companies`),
    jsonRequest(`${url}/api/admin/metrics`),
    jsonRequest(`${url}/health`),
  ]);
  assert.equal(companies.status, 200);
  assert.equal(companies.body.items.length, 1);
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.counts.companies, 1);
  assert.equal(metrics.body.counts.contacts, 0);
  assertHealthContract(health.body);
  assert.equal(Object.hasOwn(health.body, 'counts'), false);

  const client = new AccordoClient({
    baseUrl: url,
    actor: { type: 'user', id: 'sdk' },
    fetchImpl: fetch,
  });
  const viaSdk = await client.metrics();
  assert.equal(viaSdk.counts.companies, 1);
  const viaHealth = await client.health();
  assertHealthContract(viaHealth);
});

test('metrics permission failure does not prevent other dashboard fetches', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({
    spine: {
      mode: 'production',
      identityVerifier: ({ headers }) => {
        const subject = headers['x-verified-subject'];
        if (typeof subject !== 'string' || subject === '') throw new Error('unverified');
        return {
          kind: 'verified-user',
          subject,
          issuer: 'https://issuer.test',
          method: 'oidc-id-token',
          organizationId: headers['x-verified-org'],
        };
      },
      tenant: { id: 'alpha', storageRoot: workspace.root, provision: { name: 'Alpha' } },
    },
  });
  const { url } = await listenApp(t, app);
  const org = app.spine.boundOrganization;
  app.spine.memberships.bootstrapOwner({ organizationId: org.id, subject: 'alice' });
  const actor = { type: 'user', id: 'alice' };
  await app.services.companies.create({ name: 'Dash Co', domain: 'dash.example' }, { actor });

  const metricsPromise = jsonRequest(`${url}/api/admin/metrics`);
  const companiesPromise = jsonRequest(`${url}/api/companies`, {
    headers: { 'x-verified-subject': 'alice', 'x-verified-org': org.id },
  });
  const opportunitiesPromise = jsonRequest(`${url}/api/opportunities`, {
    headers: { 'x-verified-subject': 'alice', 'x-verified-org': org.id },
  });
  const [metrics, companies, opportunities] = await Promise.all([
    metricsPromise, companiesPromise, opportunitiesPromise,
  ]);
  assert.equal(metrics.status, 401);
  assert.equal(companies.status, 200);
  assert.equal(companies.body.items.length, 1);
  assert.equal(opportunities.status, 200);

  const source = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/admin\/metrics/);
  assert.match(source, /renderMetricsUnavailable/);
  assert.equal(source.includes("api('/health')") && source.includes('health.counts'), false);
  assert.equal(/renderMetrics\(\s*health\.counts\s*\)/.test(source), false);
});

test('in-process v1 doctor still discloses the database path and counts', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  t.after(() => app.close());
  const doctor = app.doctor();
  assert.equal(doctor.database, workspace.dbPath);
  assert.equal(typeof doctor.counts.companies, 'number');
  assertHealthContract(app.health());
  assert.notDeepEqual(app.health(), doctor);
});

test('production MCP static tools and resources do not leak locators', () => {
  const tools = createProductionToolRegistry();
  const resources = createProductionResourceRegistry({ rootDir: repoRoot });
  const prompts = createProductionPromptRegistry();
  assertBounded({
    tools: tools.list(),
    resources: resources.list(),
    prompts: prompts.list(),
  });
});

test('local MCP --db crm_doctor may keep the v1 database path; document-selected projects storage', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  t.after(() => app.close());

  const dbMcp = createMcpServer({ app });
  const dbDoctor = await dbMcp.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'crm_doctor', arguments: {} },
  });
  assert.equal(dbDoctor.result.isError, false);
  assert.equal(dbDoctor.result.structuredContent.database, workspace.dbPath);

  const documentMcp = createMcpServer({
    app,
    publicStorage: { adapter: 'sqlite', available: true },
  });
  const projected = await documentMcp.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'crm_doctor', arguments: {} },
  });
  assert.equal(projected.result.isError, false);
  assert.deepEqual(projected.result.structuredContent.storage, { adapter: 'sqlite', available: true });
  assert.equal(Object.hasOwn(projected.result.structuredContent, 'database'), false);
  assertBounded(projected.result, [workspace.dbPath]);
});

test('source-only app inspect does not open a database or leak a locator', (t) => {
  const workspace = workspaceFor(t);
  const run = runCli(['app', 'inspect', '--json', '--root', repoRoot]);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(typeof report.valid, 'boolean');
  assert.equal(existsSync(workspace.dbPath), false);
  assertBounded({ stdout: run.stdout, stderr: run.stderr, report }, [workspace.dbPath]);
});

test('SDK health() is unchanged and metrics() hits the admin route', () => {
  const source = readFileSync(new URL('../packages/sdk/src/client.js', import.meta.url), 'utf8');
  assert.match(source, /health\(\) \{ return this\.request\('\/health'\); \}/);
  assert.match(source, /metrics\(\) \{ return this\.request\('\/api\/admin\/metrics'\); \}/);
});


test('metrics counts use kind count and do not call list limit 500', async (t) => {
  const workspace = workspaceFor(t);
  const app = createAccordoApp({ dbPath: workspace.dbPath });
  t.after(() => app.close());
  const actor = { type: 'system', id: 'metrics' };
  const company = await app.services.companies.create({ name: 'N Co', domain: 'n.example' }, { actor });
  await app.services.contacts.create({
    companyId: company.id, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@n.example',
  }, { actor });
  const counts = app.metrics();
  assert.equal(counts.companies, 1);
  assert.equal(counts.contacts, 1);
  assert.equal(counts.opportunities, 0);
  for (const relative of ['../packages/app/src/create-app.js', '../packages/app/src/portable-app.js']) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    const block = source.match(/function countAdminMetrics[\s\S]*?\n\}/)?.[0];
    assert.ok(block, `${relative} is missing countAdminMetrics`);
    assert.match(block, /kind: 'count'/);
    assert.equal(block.includes('.list('), false, `${relative} metrics still lists rows`);
    assert.match(source, /metrics\(\) \{\s*return countAdminMetrics/);
  }
});
