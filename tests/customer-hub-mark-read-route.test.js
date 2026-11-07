import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';
import { NotFoundError } from '../packages/core/src/errors.js';

/**
 * «Da leggere» HTTP wiring (backlog:9e003582).
 *
 * The domain (unreadCount, da-leggere view, read flags, markCustomerRead)
 * already rides main; what the verifier found missing was the wire: no
 * per-customer POST mark-read route, and the list/timeline routes never
 * passing the session actor down, so every row answered read-state nulls.
 *
 * What this must prove: POST /api/customer-hub/mark-read delegates to the
 * composed markCustomerRead operation with the SESSION actor (a body actor
 * is stripped, never trusted) and answers 200; a mark on a ghost record
 * refuses with the record's own 404 and never reaches the operation; without
 * the interactions package composed the honest 404 names the operation; a
 * non contact/company resource refuses 400. The list and timeline GET routes
 * pass the session actor through, so unreadCount and read flags answer for
 * the signed-in member.
 *
 * A stub app keeps this instant and deterministic: no sqlite, no provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'scheda-route',
};

function stubApp({ marks = [], listed = [], timelines = [], withMarkRead = true } = {}) {
  return {
    services: {
      contacts: { get: async (id) => { if (id !== 'c1') throw new NotFoundError('contact', String(id)); return { id: 'c1' }; } },
      companies: { get: async (id) => { throw new NotFoundError('company', String(id)); } },
    },
    async listCustomers(params) {
      listed.push({ ...params });
      return { items: [] };
    },
    async readCustomerTimeline(params) {
      timelines.push({ ...params });
      return { entries: [] };
    },
    ...(withMarkRead ? {
      async markCustomerRead(params) {
        marks.push({ ...params });
        return { subject: { resource: params.resource, id: params.id }, memberId: params.actor?.id, upTo: params.upTo, conversations: [], touched: 1 };
      },
    } : {}),
  };
}

async function request(t, app, method, path, body) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const MARK_BASE = { resource: 'contact', id: 'c1', upTo: '2026-09-15T10:02:00.000Z' };

test('9e003582: POST mark-read delegates with the session actor and answers 200', async (t) => {
  const marks = [];
  const { status, payload } = await request(t, stubApp({ marks }), 'POST', '/api/customer-hub/mark-read', MARK_BASE);
  assert.equal(status, 200);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].resource, 'contact');
  assert.equal(marks[0].id, 'c1');
  assert.equal(marks[0].upTo, '2026-09-15T10:02:00.000Z');
  assert.equal(marks[0].actor?.type, 'user', 'the human actor travels to the operation');
  assert.equal(marks[0].actor?.id, 'scheda-route');
  assert.equal(payload?.touched, 1);
});

test('9e003582: a body actor is stripped, the session actor marks', async (t) => {
  const marks = [];
  const { status } = await request(t, stubApp({ marks }), 'POST', '/api/customer-hub/mark-read', {
    ...MARK_BASE, actor: { type: 'user', id: 'someone-else' },
  });
  assert.equal(status, 200);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].actor?.id, 'scheda-route',
    'authorship is server-derived from the session, never a caller claim');
});

test('9e003582: a mark on a ghost record refuses 404 and never reaches the operation', async (t) => {
  const marks = [];
  const { status } = await request(t, stubApp({ marks }), 'POST', '/api/customer-hub/mark-read', {
    ...MARK_BASE, id: 'c-ghost',
  });
  assert.equal(status, 404);
  assert.equal(marks.length, 0, 'no watermark is written for a record that does not exist');
});

test('9e003582: without the operation composed the honest 404 names it', async (t) => {
  const { status, payload } = await request(t, stubApp({ withMarkRead: false }), 'POST', '/api/customer-hub/mark-read', MARK_BASE);
  assert.equal(status, 404);
  assert.match(String(payload?.error?.message ?? ''), /customer mark-read/);
});

test('9e003582: a non contact/company resource refuses 400', async (t) => {
  const marks = [];
  const { status, payload } = await request(t, stubApp({ marks }), 'POST', '/api/customer-hub/mark-read', {
    ...MARK_BASE, resource: 'lead',
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.code, 'VALIDATION_ERROR');
  assert.equal(marks.length, 0);
});

test('9e003582: the customer list passes the session actor for unreadCount', async (t) => {
  const listed = [];
  const { status } = await request(t, stubApp({ listed }), 'GET', '/api/customer-data/customers?vista=da-leggere');
  assert.equal(status, 200);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].vista, 'da-leggere');
  assert.equal(listed[0].actor?.type, 'user', 'the list counts unread for the signed-in member');
  assert.equal(listed[0].actor?.id, 'scheda-route');
});

test('9e003582: the timeline passes the session actor for read flags', async (t) => {
  const timelines = [];
  const { status } = await request(t, stubApp({ timelines }), 'GET', '/api/customer-hub/timeline/contact/c1');
  assert.equal(status, 200);
  assert.equal(timelines.length, 1);
  assert.equal(timelines[0].resource, 'contact');
  assert.equal(timelines[0].id, 'c1');
  assert.equal(timelines[0].actor?.id, 'scheda-route', 'the flags answer for the signed-in member, never a named one');
});
