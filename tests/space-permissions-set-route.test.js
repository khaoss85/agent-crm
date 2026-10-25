// @ts-check

/**
 * BO-F0-06 Spazi e accessi (backlog:5872e92b): the switch routes end to end.
 *
 * POST /api/space-permissions/set-permission flips one AI switch of one
 * space through the composed operation: a human user creates the override
 * row on the first flip and patches it after; agent and bad inputs are
 * refused with the action's own codes, and no refusal writes a row.
 *
 * GET /api/space-permissions/effective is the screen's only switch read: the
 * generic records surface deliberately refuses `filter.spaceId` on the
 * override module (index-backed filters only, ADR-008 addendum 2), so the
 * screen scopes server-side here and never pages another space's rows.
 *
 * A missing header pair is NOT anonymous over HTTP in this composition: with
 * no spine composed, the server's documented rule (requestIdentity) treats
 * the legacy pair as an asserted local user, so every request below names
 * its actor explicitly. True anonymity (actor null) is refused with
 * SPACE_ACTOR_REQUIRED at the operation level, covered in
 * tests/space-permissions.test.js. Real application and HTTP server over
 * :memory:, like api.test.js.
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

const userHeaders = { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'owner-1' };

function headersFor(actor) {
  return {
    'content-type': 'application/json',
    'x-actor-type': actor.type,
    'x-actor-id': actor.id,
  };
}

async function flip(base, body, actor) {
  const response = await fetch(`${base}/api/space-permissions/set-permission`, {
    method: 'POST',
    headers: headersFor(actor),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

async function effective(base, spaceId) {
  const response = await fetch(
    `${base}/api/space-permissions/effective?spaceId=${encodeURIComponent(spaceId)}`,
    { headers: { ...userHeaders } },
  );
  const payload = await response.json();
  return { status: response.status, payload };
}

test('a human flips a switch: first flip creates, second patches, the read follows', async (t) => {
  const base = await started(t);
  const user = { type: 'user', id: 'owner-1' };
  const first = await flip(base, { spaceId: 'spazio-1', permission: 'drafts', enabled: 'off' }, user);
  assert.equal(first.status, 200);
  assert.equal(first.payload.created, true);
  assert.equal(first.payload.enabled, false);

  const read = await effective(base, 'spazio-1');
  assert.equal(read.status, 200);
  assert.equal(read.payload.spaceId, 'spazio-1');
  assert.equal(read.payload.overrides.length, 1);
  assert.equal(read.payload.resolved.drafts, false);
  assert.equal(read.payload.resolved['send-without-approval'], false, 'untouched switches keep their defaults');

  const second = await flip(base, { spaceId: 'spazio-1', permission: 'drafts', enabled: 'on' }, user);
  assert.equal(second.status, 200);
  assert.equal(second.payload.created, false);
  const reread = await effective(base, 'spazio-1');
  assert.equal(reread.payload.overrides.length, 1);
  assert.equal(reread.payload.resolved.drafts, true);
});

test('agent and bad inputs are refused and write nothing', async (t) => {
  const base = await started(t);
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

  const read = await effective(base, 'spazio-1');
  assert.equal(read.status, 200);
  assert.equal(read.payload.overrides.length, 0, 'no refusal writes a row');
  assert.equal(read.payload.resolved.drafts, true, 'defaults hold until a human flips');
});

test('the effective read refuses a shapeless space id', async (t) => {
  const base = await started(t);
  const read = await effective(base, '');
  assert.equal(read.status, 400);
});
