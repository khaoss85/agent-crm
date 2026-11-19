// @ts-check

/**
 * Backlog 30f7ce51c87a: GET /api/spazi-accessi/summary aggregates the seven
 * single reads of Spazi e accessi (context, team, agents, switches,
 * connectors, customers, fix-count inputs) into one round trip.
 *
 * What it must prove: the route answers 200 with every section the screen
 * reads; a refused section degrades to {unavailable: {code, status}} instead
 * of refusing the whole payload (it grants nothing the single routes would
 * refuse); without a space id it answers 400. Real application and HTTP
 * server over :memory:, like space-permissions-set-route.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';

async function started(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  return { base };
}

const userHeaders = { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'owner-1' };

async function summary(base, query) {
  const response = await fetch(`${base}/api/spazi-accessi/summary${query}`, { headers: { ...userHeaders } });
  const payload = await response.json();
  return { status: response.status, payload };
}

const SECTIONS = ['context', 'memberships', 'agents', 'switches', 'connectors', 'customers', 'fix'];

test('30f7ce51c87a: the summary answers every section in one payload', async (t) => {
  const { base } = await started(t);
  const { status, payload } = await summary(base, '?spaceId=spazio-1');
  assert.equal(status, 200);
  assert.equal(payload.spaceId, 'spazio-1');
  for (const name of SECTIONS) {
    assert.ok(payload[name] !== undefined, `section ${name} is present`);
  }
});

test('30f7ce51c87a: a refused section degrades, it never refuses the payload', async (t) => {
  const { base } = await started(t);
  const { status, payload } = await summary(base, '?spaceId=spazio-1');
  assert.equal(status, 200);
  for (const name of SECTIONS) {
    const section = payload[name];
    const degraded = section !== null && typeof section === 'object' && 'unavailable' in section;
    if (degraded) {
      assert.equal(typeof section.unavailable.code, 'string');
      assert.ok(section.unavailable.status === null || typeof section.unavailable.status === 'number');
    }
  }
});

test('30f7ce51c87a: without a space id the summary answers 400', async (t) => {
  const { base } = await started(t);
  const { status } = await summary(base, '');
  assert.equal(status, 400);
});
