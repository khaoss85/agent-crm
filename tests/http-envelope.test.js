import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

/**
 * Regression tests for the response-envelope bug: the dispatcher used to read
 * `result?.status ?? 200` / `result?.body ?? result`, so any DOMAIN object
 * carrying a `status` (or `body`) property hijacked the HTTP status code. A
 * lead with status "qualified" crashed GET with `Invalid status code`. Only the
 * Symbol-tagged envelope may control transport status now.
 */

function statusModule() {
  const rows = new Map();
  const service = {
    async create(input, _ctx = {}) {
      const record = {
        id: `t-${rows.size + 1}`,
        // Hostile-to-the-dispatcher property names, all legal field names:
        status: input.status ?? 'qualified',
        body: input.body ?? 'a body field',
        code: input.code ?? 'a code field',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      rows.set(record.id, record);
      return record;
    },
    get(id) {
      const row = rows.get(id);
      if (!row) { const e = new Error(`not found: ${id}`); throw Object.assign(e, { code: 'NOT_FOUND', status: 404 }); }
      return row;
    },
    list() { return [...rows.values()]; },
    async update(id, input) { return Object.assign(service.get(id), input); },
  };
  return {
    name: 'ticket',
    version: '0.1.0',
    description: 'Envelope regression fixture.',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['create', 'get', 'list', 'update'],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    fields: [
      { name: 'status', type: 'string', required: false, unique: false },
      { name: 'body', type: 'string', required: false, unique: false },
      { name: 'code', type: 'string', required: false, unique: false },
    ],
    entities: [{ name: 'ticket', fields: ['id', 'status', 'body', 'code'] }],
    service,
  };
}

async function startServer(t) {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  app.modules.register(statusModule());
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  return { app, baseUrl };
}

test('domain objects with status/body/code fields never control the HTTP status', async (t) => {
  const { baseUrl } = await startServer(t);
  const headers = { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 't' };

  // Create still uses the explicit 201 envelope even though the record itself
  // carries status/body/code fields.
  const created = await fetch(`${baseUrl}/api/modules/ticket/records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: 'qualified', body: 'ignore me', code: 'ignore me too' }),
  });
  assert.equal(created.status, 201);
  const record = await created.json();
  assert.equal(record.status, 'qualified');

  // GET returns the raw record: HTTP 200, the record's own status untouched.
  const got = await fetch(`${baseUrl}/api/modules/ticket/records/${record.id}`, { headers });
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).status, 'qualified');

  // Extreme case: a record whose status field looks like a NUMBER (e.g. "503")
  // must still be served as HTTP 200, not turned into a 503.
  const numeric = await fetch(`${baseUrl}/api/modules/ticket/records`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: '503' }),
  });
  assert.equal(numeric.status, 201);
  const numericRecord = await numeric.json();
  const gotNumeric = await fetch(`${baseUrl}/api/modules/ticket/records/${numericRecord.id}`, { headers });
  assert.equal(gotNumeric.status, 200);
  assert.equal((await gotNumeric.json()).status, '503');
});

test('workflow runs and approvals — objects with status fields — are served as 200', async (t) => {
  const { app, baseUrl } = await startServer(t);
  const headers = { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 't' };
  const seeded = await app.seedDemo();

  // A workflow run object carries status: 'completed' — must be HTTP 200.
  const run = await fetch(`${baseUrl}/api/opportunities/${seeded.standardRenewal.id}/stage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ targetStage: 'proposal' }),
  });
  assert.equal(run.status, 200);
  const runBody = await run.json();
  assert.equal(runBody.status, 'completed');

  // An approval object carries status: 'pending' — list route (wrapped) is 200.
  const approvals = await fetch(`${baseUrl}/api/approvals`, { headers });
  assert.equal(approvals.status, 200);
});
