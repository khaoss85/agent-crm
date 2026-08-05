import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

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
});
