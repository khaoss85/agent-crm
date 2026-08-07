import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

test('HTTP API and Admin use the same application state', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });

  const root = await fetch(baseUrl);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /Accordo/);

  const demoResponse = await fetch(`${baseUrl}/api/demo/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(demoResponse.status, 200);

  const opportunities = await fetch(`${baseUrl}/api/opportunities`).then((response) => response.json());
  assert.equal(opportunities.items.length, 2);
  assert.equal(opportunities.items.filter((item) => item.stage === 'approval_pending').length, 1);

  const approvals = await fetch(`${baseUrl}/api/approvals?status=pending`).then((response) => response.json());
  assert.equal(approvals.items.length, 1);

  const approveResponse = await fetch(`${baseUrl}/api/approvals/${approvals.items[0].id}/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actor-id': 'vp-sales',
      'x-actor-type': 'user',
    },
    body: '{}',
  });
  assert.equal(approveResponse.status, 200);
  assert.equal(app.services.approvals.get(approvals.items[0].id).decidedBy, 'vp-sales');
});
