import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { AgentCrmClient } from '../packages/sdk/src/index.js';
import {
  isExposableGeneratedModule,
  validateGeneratedModuleDefinition,
} from '../packages/core/src/generated-module-contract.js';

/**
 * Contract tests for the generic generated-module surface against a core-only
 * app (empty generated registry): the boundary must hide everything.
 */
test('generated-module API boundary on a core-only app', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  const schema = await fetch(`${baseUrl}/api/schema`).then((response) => response.json());
  assert.deepEqual(schema.generatedModules, []);
  assert.ok(Array.isArray(schema.modules) && schema.modules.some((module) => module.name === 'company'));

  // Core handwritten modules are not exposed through the generic surface.
  for (const path of ['/api/modules/company', '/api/modules/company/records', '/api/modules/opportunity']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
    const body = await response.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(body).includes('SELECT'), 'SQL leaked in error');
  }

  // Unknown and malformed module names are safe 404s, including encoded tricks.
  for (const path of [
    '/api/modules/nope',
    '/api/modules/%2E%2E',
    '/api/modules/comp%2Fany',
    '/api/modules/nope/records/abc',
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
  }

  // Unsupported HTTP methods on the resource family are not mutations.
  const del = await fetch(`${baseUrl}/api/modules/company/records/x`, { method: 'DELETE' });
  assert.equal(del.status, 404);
  const put = await fetch(`${baseUrl}/api/modules/company/records/x`, { method: 'PUT' });
  assert.equal(put.status, 404);

  // Invalid JSON keeps the existing 400 contract on the new routes.
  const badJson = await fetch(`${baseUrl}/api/modules/nope/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, 'INVALID_JSON');

  // Core endpoints are untouched by the new surface.
  const companies = await fetch(`${baseUrl}/api/companies`).then((response) => response.json());
  assert.deepEqual(companies, { items: [] });

  // Prototype-pollution and hostile module names never resolve: the registry
  // is Map-backed and the contract validator fails closed.
  for (const name of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf', 'COMPANY', '%5F%5Fproto%5F%5F']) {
    const response = await fetch(`${baseUrl}/api/modules/${name}`);
    assert.equal(response.status, 404, name);
  }

  // Malformed, double-encoded and null-byte segments are safe 404s, never crashes.
  for (const path of [
    '/api/modules/%zz',
    '/api/modules/%E0%A4%A',
    '/api/modules/%252Fetc',
    '/api/modules/nul%00l',
    '/api/modules/partner%5C..%5C',
    '/api/modules//records',
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
  }

  // HEAD and OPTIONS are not routed and cause no mutation.
  for (const method of ['HEAD', 'OPTIONS']) {
    const response = await fetch(`${baseUrl}/api/modules/company/records`, { method });
    assert.equal(response.status, 404, method);
  }
  assert.equal(app.audit.list({ limit: 500 }).length, 0);
});

test('a forged or malformed registry-style entry fails closed everywhere', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  // Simulate a hand-edited entry: kind claims generated but the contract is
  // not satisfied (no capability functions, no fields metadata).
  app.modules.register({
    name: 'forged',
    version: '0.1.0',
    description: 'hand-edited',
    kind: 'generated',
    capabilities: ['create', 'get', 'list', 'update'],
    entities: [],
    service: {},
  });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  const schema = await fetch(`${baseUrl}/api/schema`).then((response) => response.json());
  assert.deepEqual(schema.generatedModules, [], 'forged module poisoned the schema');
  assert.equal(schema.generatedResourceContract, 1);
  assert.equal((await fetch(`${baseUrl}/api/modules/forged`)).status, 404);
  assert.equal(
    (await fetch(`${baseUrl}/api/modules/forged/records`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).status,
    404,
  );
  assert.equal(app.audit.list({ limit: 500 }).length, 0);
});

test('the generated-module contract validator rejects malformed definitions', () => {
  const valid = {
    name: 'partner',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['create', 'get', 'list', 'update'],
    fields: [{ name: 'name', type: 'string', required: true, unique: false }],
    service: { create() {}, get() {}, list() {}, update() {} },
  };
  assert.ok(isExposableGeneratedModule(valid));
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, kind: 'core' }), /kind must be exactly/);
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, capabilities: ['create', 'create'] }), /duplicate capability/);
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, capabilities: ['delete'] }), /unsupported capability/);
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, service: { create() {} } }), /has no service function/);
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, name: '__proto__' }), /name must match/);
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, manifestVersion: 'x' }), /manifestVersion/);
  assert.throws(() => validateGeneratedModuleDefinition({ ...valid, fields: [{ name: 'x' }] }), /malformed field metadata/);
});

test('SDK survives non-JSON, empty and error responses without masking them', async () => {
  const stub = (status, body, ok = status < 400) => async () => ({
    ok,
    status,
    text: async () => body,
  });
  const clientFor = (impl) => new AgentCrmClient({ baseUrl: 'http://stub', fetchImpl: impl });

  // Non-JSON error body: server status and snippet preserved, no parse error.
  await assert.rejects(
    () => clientFor(stub(502, '<html>Bad Gateway</html>', false)).schema(),
    (error) => error.status === 502 && error.code === 'UNKNOWN' && /Bad Gateway/.test(error.message),
  );
  // Empty error body.
  await assert.rejects(
    () => clientFor(stub(500, '', false)).schema(),
    (error) => error.status === 500 && error.code === 'UNKNOWN',
  );
  // Success status with invalid JSON fails clearly.
  await assert.rejects(
    () => clientFor(stub(200, '{broken')).schema(),
    (error) => error.code === 'INVALID_RESPONSE',
  );
  // Network failure stays distinguishable (no status property).
  await assert.rejects(
    () => clientFor(async () => { throw new TypeError('fetch failed'); }).schema(),
    (error) => error instanceof TypeError && error.status === undefined,
  );
  // Frozen actor: mutating the original object does not change the client.
  const actor = { type: 'agent', id: 'a1' };
  const client = new AgentCrmClient({ baseUrl: 'http://stub', actor, fetchImpl: stub(200, '{}') });
  actor.id = 'evil';
  assert.equal(client.actor.id, 'a1');
  assert.throws(() => { client.module('partner').extra = 1; }, TypeError);
  assert.throws(() => client.module(''), /non-empty module name/);
});
