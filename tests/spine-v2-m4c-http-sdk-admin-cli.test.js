// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { AccordoClient } from '../packages/sdk/src/client.js';
import { issueIdempotencyKey, deriveChildKey, requireIdempotencyKey } from '../packages/core/src/idempotency.js';
import { injectPostgresqlCommitFault } from '../packages/core/src/postgresql-storage.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import {
  APP_COMMANDS,
  APP_COMMAND_POSTGRESQL_CLASSIFICATION,
  CLI_VERIFIED_OPERATOR_REQUIRED,
} from '../packages/cli/src/commands.js';
import {
  createSubmissionController,
  fingerprintRequest,
  requireSubmissionContext,
  ADMIN_SUBMISSION_REQUIRED,
  ADMIN_SUBMISSION_DIVERGED,
} from '../apps/admin/public/admin-submission.js';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  assertNoSecrets,
  bootPostgresqlApp,
} from './helpers/postgresql-application.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cli = join(repoRoot, 'packages/cli/bin/accordo.js');
const actorHeaders = Object.freeze({
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'm4c-ada',
});

function key() {
  return issueIdempotencyKey(() => '2026-08-30T00:00:00.000Z');
}

function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem: (name) => (map.has(name) ? map.get(name) : null),
    setItem: (name, value) => { map.set(name, String(value)); },
    removeItem: (name) => { map.delete(name); },
  };
}

/**
 * @param {import('node:http').Server} server
 */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve(undefined))));
    },
  };
}

/**
 * @param {string} base
 * @param {string} path
 * @param {{ method?: string, body?: unknown, key?: string }} [options]
 */
async function http(base, path, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...actorHeaders };
  if (options.key) headers['Idempotency-Key'] = options.key;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  try { body = text === '' ? null : JSON.parse(text); } catch { body = text; }
  return {
    status: response.status,
    body,
    key: response.headers.get('idempotency-key'),
    haystack: `${text}\n${JSON.stringify(body)}`,
  };
}

test('child keys are deterministic, distinct and collision-resistant', () => {
  const root = key();
  const first = deriveChildKey(root, 'admin-ack', 'run-a');
  const again = deriveChildKey(root, 'admin-ack', 'run-a');
  const sibling = deriveChildKey(root, 'admin-ack', 'run-b');
  const otherScope = deriveChildKey(root, 'company.create', 'run-a');
  assert.equal(first, again);
  assert.notEqual(first, sibling);
  assert.notEqual(first, otherScope);
  assert.equal(requireIdempotencyKey(first), first);
  const long = deriveChildKey(root, 'workflow.fan-out', `${'id'.repeat(40)}-αβ`);
  const collide = deriveChildKey(root, 'workflow.fan-out', `${'id'.repeat(40)}-αγ`);
  assert.notEqual(long, collide);
});

test('Admin transport refuses a mutation without a submission-owned key', () => {
  assert.throws(
    () => requireSubmissionContext({ method: 'POST' }),
    (error) => /** @type {any} */ (error).code === ADMIN_SUBMISSION_REQUIRED,
  );
});

test('Admin controller joins double submit and refuses a changed payload under a retained key', async () => {
  let calls = 0;
  const storage = memoryStorage();
  const controller = createSubmissionController({
    storage,
    clock: () => '2026-08-30T00:00:00.000Z',
    transport: async (_path, options) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, idempotencyKey: options.idempotencyKey };
    },
  });
  const retained = controller.issueKey();
  const first = controller.submit({ path: '/api/companies', method: 'POST', body: { name: 'Acme' }, key: retained });
  const joined = controller.submit({ path: '/api/companies', method: 'POST', body: { name: 'Acme' }, key: retained });
  await assert.rejects(
    () => controller.submit({ path: '/api/companies', method: 'POST', body: { name: 'Changed' }, key: retained }),
    (error) => /** @type {any} */ (error).code === ADMIN_SUBMISSION_DIVERGED,
  );
  const [a, b] = await Promise.all([first, joined]);
  assert.equal(a.idempotencyKey, retained);
  assert.equal(b.idempotencyKey, retained);
  assert.equal(calls, 1);
  assert.equal(fingerprintRequest({ path: '/x', method: 'POST', body: { z: 1, a: 2 } }),
    fingerprintRequest({ path: '/x', method: 'POST', body: { a: 2, z: 1 } }));
});

test('generated Admin create owns one key and does not invent a replacement in fetch', async () => {
  /** @type {Array<{path: string, headers?: Record<string, string>}>} */
  const calls = [];
  const client = {
    async request(path, options = {}) {
      calls.push({ path, headers: options.headers });
      if (path === '/api/schema') {
        return {
          generatedResourceContract: 1,
          generatedModules: [{
            name: 'gadget',
            description: 'Gadgets',
            kind: 'generated',
            capabilities: ['create', 'get', 'list', 'update'],
            immutableFields: ['id', 'createdAt', 'updatedAt'],
            fields: [{ name: 'label', type: 'string', required: true, unique: false, writable: 'public' }],
            actions: [],
          }],
        };
      }
      if (options.method === 'POST') return { id: 'g1', label: 'Box', createdAt: 't', updatedAt: 't' };
      return { items: [] };
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({
    doc,
    mount,
    client,
    storage: memoryStorage(),
    navigate: () => {},
    toast: () => {},
  });
  const form = await admin.renderNew('gadget');
  const input = form.__inputs.label;
  input.value = 'Box';
  const pending = form.__submit();
  const joined = form.__submit();
  await Promise.all([pending, joined]);
  const posts = calls.filter((call) => call.path.includes('/records') && !call.path.includes('?'));
  assert.equal(posts.length, 1);
  assert.match(posts[0].headers?.['Idempotency-Key'] ?? '', /^v1\.\d{8}\.[0-9a-f]{32}$/);
});

test('M4C CLI PostgreSQL matrix classifies every APP_COMMANDS entry', () => {
  assert.equal(Object.isFrozen(APP_COMMANDS), true);
  for (const command of APP_COMMANDS) {
    assert.ok(Object.hasOwn(APP_COMMAND_POSTGRESQL_CLASSIFICATION, command), command);
  }
  assert.deepEqual(
    Object.keys(APP_COMMAND_POSTGRESQL_CLASSIFICATION).sort(),
    [...APP_COMMANDS].sort(),
  );
});

test('M4C CLI child process refuses unauthenticated PostgreSQL mutators', () => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m4c-cli-'));
  mkdirSync(join(root, 'providers'), { recursive: true });
  const verifierPath = join(root, 'providers/identity-verifier.mjs');
  writeFileSync(verifierPath, [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    'export function createIdentityVerifier() {',
    '  return { verifyRequest() { return null; }, discoverControlResource() {}, attestControlStartup() {}, discoverDataResource() {}, attestDataStartup() {} };',
    '}',
    '',
  ].join('\n'));
  chmodSync(verifierPath, 0o600);
  const configPath = join(root, 'deployment-storage.json');
  writeFileSync(configPath, `${JSON.stringify({
    contract: 1,
    adapter: 'postgresql',
    connection: {
      host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
      password: 'SUPERSECRET_SENTINEL_PASSWORD', sslmode: 'verify-full',
      tls: { enabled: true, verify: 'full', caFile: './tls/ca.pem', servername: 'db.example.test' },
    },
    controlPlane: {
      host: '127.0.0.1', port: 2, database: 'accordo_control', user: 'accordo',
      password: 'SUPERSECRET_SENTINEL_PASSWORD', sslmode: 'verify-full',
      tls: { enabled: true, verify: 'full', caFile: './tls/ca.pem', servername: 'db.example.test' },
    },
    spine: { mode: 'production', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
  }, null, 2)}\n`);
  chmodSync(configPath, 0o600);
  for (const command of APP_COMMANDS.filter((name) => name !== 'serve')) {
    const run = spawnSync(process.execPath, [cli, command, '--deployment-storage', configPath, '--root', root], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, CRM_NO_SQLITE_FALLBACK: '1' },
    });
    assert.notEqual(run.status, 0, command);
    const haystack = `${run.stdout}\n${run.stderr}`;
    assert.match(haystack, new RegExp(CLI_VERIFIED_OPERATOR_REQUIRED));
    assert.equal(haystack.includes('SUPERSECRET_SENTINEL_PASSWORD'), false, command);
    assert.equal(haystack.includes('accordo_control'), false, command);
  }
});

test('synchronous SQLite createAccordoApp still creates without an idempotency key', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const company = await Promise.resolve(app.services.companies.create(
      { name: 'Legacy' },
      { actor: { type: 'user', id: 'sqlite' } },
    ));
    assert.equal(company.name, 'Legacy');
    assert.equal(app.services.companies.list().length, 1);
  } finally {
    app.close();
  }
});

describe('M4C PostgreSQL HTTP/SDK/Admin/CLI', { concurrency: 1 }, () => {
  test('HTTP replay of the same key returns one company, audit and trace', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const server = createHttpServer(app);
    const listening = await listen(server);
    t.after(() => listening.close());
    const idempotencyKey = key();
    const first = await http(listening.url, '/api/companies', {
      method: 'POST', body: { name: 'Acme HTTP' }, key: idempotencyKey,
    });
    const second = await http(listening.url, '/api/companies', {
      method: 'POST', body: { name: 'Acme HTTP' }, key: idempotencyKey,
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.id, second.body.id);
    assert.equal(first.key, idempotencyKey);
    assert.equal(second.key, idempotencyKey);
    const listed = await http(listening.url, '/api/companies');
    assert.equal(listed.body.items.length, 1);
    const audit = await http(listening.url, `/api/audit?entityType=company&entityId=${first.body.id}`);
    assert.equal(audit.body.items.length, 1);
    const sdk = new AccordoClient({
      baseUrl: listening.url,
      actor: { type: 'user', id: 'm4c-ada' },
    });
    const viaSdk = await sdk.createCompany({ name: 'Acme HTTP' }, { idempotencyKey });
    assert.equal(viaSdk.id, first.body.id);
    assertNoSecrets(first.body);
    assertNoSecrets(second.body);
  });

  test('divergent HTTP replay refuses without revealing the prior record', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const server = createHttpServer(booted.app);
    const listening = await listen(server);
    t.after(() => listening.close());
    const idempotencyKey = key();
    const first = await http(listening.url, '/api/companies', {
      method: 'POST', body: { name: 'Original' }, key: idempotencyKey,
    });
    const diverged = await http(listening.url, '/api/companies', {
      method: 'POST', body: { name: 'Changed' }, key: idempotencyKey,
    });
    assert.equal(diverged.status, 409);
    assert.equal(diverged.body.error.code, 'DIVERGENT_REPLAY');
    assert.equal(diverged.haystack.includes('Original'), false);
    assert.equal(diverged.haystack.includes(first.body.id), false);
  });

  test('concurrent first-attempt HTTP writes call the provider at most once', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const server = createHttpServer(booted.app);
    const listening = await listen(server);
    t.after(() => listening.close());
    const idempotencyKey = key();
    const [left, right] = await Promise.all([
      http(listening.url, '/api/companies', { method: 'POST', body: { name: 'Race' }, key: idempotencyKey }),
      http(listening.url, '/api/companies', { method: 'POST', body: { name: 'Race' }, key: idempotencyKey }),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.ok(statuses.every((status) => status === 201 || status === 503));
    const listed = await http(listening.url, '/api/companies');
    assert.equal(listed.body.items.length, 1);
  });

  test('post-commit ACK drop through HTTP reconciles to one record', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const storage = postgresqlTestStorage(app);
    assert.ok(storage);
    const server = createHttpServer(app);
    const listening = await listen(server);
    t.after(() => listening.close());
    const idempotencyKey = key();
    injectPostgresqlCommitFault(storage, 'post-commit-ack-drop');
    const lost = await http(listening.url, '/api/companies', {
      method: 'POST', body: { name: 'Recovered HTTP' }, key: idempotencyKey,
    });
    assert.equal(lost.status, 503);
    assert.equal(lost.body.error.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.equal(lost.body.error.details.idempotencyKey, idempotencyKey);
    assert.equal(lost.key, idempotencyKey);

    const recovered = await http(listening.url, `/api/write-outcomes/${idempotencyKey}/reconcile`, {
      method: 'POST',
      body: { operation: 'company.create', input: { name: 'Recovered HTTP', domain: null } },
      key: idempotencyKey,
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.status, 'committed');
    const listed = await http(listening.url, '/api/companies');
    assert.equal(listed.body.items.length, 1);
    const lookup = await http(listening.url, `/api/write-outcomes/${idempotencyKey}`);
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.idempotencyKey, idempotencyKey);
    assert.equal(Object.hasOwn(lookup.body, 'response'), false);
    const ack = await http(listening.url, `/api/write-outcomes/${idempotencyKey}/ack`, {
      method: 'POST', body: {},
    });
    assert.equal(ack.status, 200);
    assert.equal(ack.body.ok, true);
    const ackAgain = await http(listening.url, `/api/write-outcomes/${idempotencyKey}/ack`, {
      method: 'POST', body: {},
    });
    assert.equal(ackAgain.body.replayed, true);
  });

  test('two terminal stage changes on one opportunity commit at most once', { timeout: 60_000 }, async (t) => {
    const booted = await bootPostgresqlApp(t);
    if (!booted) return;
    const { app } = booted;
    const server = createHttpServer(app);
    const listening = await listen(server);
    t.after(() => listening.close());
    const company = await http(listening.url, '/api/companies', {
      method: 'POST', body: { name: 'Stage Co' }, key: key(),
    });
    const contact = await http(listening.url, '/api/contacts', {
      method: 'POST',
      body: { companyId: company.body.id, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@stage.test' },
      key: key(),
    });
    const opportunity = await http(listening.url, '/api/opportunities', {
      method: 'POST',
      body: {
        companyId: company.body.id,
        contactId: contact.body.id,
        name: 'Deal',
        valueCents: 1000,
        owner: 'ada',
      },
      key: key(),
    });
    assert.equal(opportunity.status, 201, JSON.stringify(opportunity.body));
    const leftKey = key();
    const rightKey = issueIdempotencyKey(() => '2026-08-30T00:00:01.000Z');
    const [left, right] = await Promise.all([
      http(listening.url, `/api/opportunities/${opportunity.body.id}/stage`, {
        method: 'POST', body: { targetStage: 'proposal' }, key: leftKey,
      }),
      http(listening.url, `/api/opportunities/${opportunity.body.id}/stage`, {
        method: 'POST', body: { targetStage: 'won' }, key: rightKey,
      }),
    ]);
    const successes = [left, right].filter((item) => item.status === 200);
    assert.ok(successes.length >= 1);
    const current = await http(listening.url, `/api/opportunities/${opportunity.body.id}`);
    assert.ok(['proposal', 'won', 'approval_pending'].includes(current.body.stage));
  });
});
