// @ts-check

/**
 * BO-F0-06 Spazi e accessi (backlog:5872e92b): the flip route end to end.
 *
 * POST /api/space-permissions/set-permission flips one AI switch of one
 * space through the composed operation: a human user creates the override
 * row on the first flip and patches it after; anonymous, agent and unknown
 * inputs are refused with the action's own codes, and no refusal writes a
 * row. Real application and HTTP server over :memory:, like api.test.js.
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
  return base;
}

async function flip(base, body, actor) {
  const headers = { 'content-type': 'application/json' };
  if (actor) {
    headers['x-actor-type'] = actor.type;
    headers['x-actor-id'] = actor.id;
  }
  const response = await fetch(`${base}/api/space-permissions/set-permission`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function overrides(base, spaceId) {
  const response = await fetch(
    `${base}/api/modules/space-permission-override/records?filter.spaceId=${encodeURIComponent(spaceId)}`,
  );
  assert.equal(response.status, 200);
  return (await response.json()).items;
}

test('a human flips a switch: first flip creates, second patches', async (t) => {
  const base = await started(t);
  const user = { type: 'user', id: 'owner-1' };
  const first = await flip(base, { spaceId: 'spazio-1', permission: 'drafts', enabled: 'off' }, user);
  assert.equal(first.status, 200);
  assert.equal(first.payload.created, true);
  assert.equal(first.payload.enabled, false);
  let rows = await overrides(base, 'spazio-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].updatedBy, 'user:owner-1');

  const second = await flip(base, { spaceId: 'spazio-1', permission: 'drafts', enabled: 'on' }, user);
  assert.equal(second.status, 200);
  assert.equal(second.payload.created, false);
  rows = await overrides(base, 'spazio-1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
});

test('anonymous, agent and bad inputs are refused and write nothing', async (t) => {
  const base = await started(t);
  const anonymous = await flip(base, { spaceId: 'spazio-1', permission: 'drafts', enabled: 'off' }, null);
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.payload?.error?.code, 'SPACE_ACTOR_REQUIRED');

  const agent = await flip(
    base,
    { spaceId: 'spazio-1', permission: 'drafts', enabled: 'on' },
    { type: 'agent', id: 'agent-9' },
  );
  assert.equal(agent.status, 403);
  assert.equal(agent.payload?.error?.code, 'HUMAN_APPROVAL_REQUIRED');

  const unknown = await flip(
    base,
    { spaceId: 'spazio-1', permission: 'nope', enabled: 'on' },
    { type: 'user', id: 'owner-1' },
  );
  assert.equal(unknown.status, 400);
  assert.equal(unknown.payload?.error?.code, 'SPACE_PERMISSION_UNKNOWN');

  const rows = await overrides(base, 'spazio-1');
  assert.equal(rows.length, 0, 'no refusal writes a row');
});
