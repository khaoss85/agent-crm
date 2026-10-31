import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';

/**
 * Scheda cliente composer «Scrivi» route (backlog:e9b4fc2f): the route fails
 * fast on the honest composer limit — 2000 timeline-storable characters,
 * line breaks allowed, tabs and other controls refused — with 400
 * VALIDATION_ERROR on field `text`, before anything is queued. A stub app
 * keeps this instant and deterministic: no sqlite, no provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'composer-route',
};

const CARD = { email: 'cliente@example.com', phone: { available: false, value: null }, socials: [] };
const CONNECTION_KEY = 'ch-conn:presti:email:x';

function stubApp({ timelineItems = [], queued = [] } = {}) {
  return {
    services: { contacts: { get: async () => ({ id: 'c1' }) }, companies: { get: async () => ({ id: 'c1' }) } },
    async readCustomerCard() { return CARD; },
    async readSyncState() {
      return { connectors: [{ channel: 'email', status: 'active', connectionKey: CONNECTION_KEY }] };
    },
    async readCustomerTimeline() { return { entries: { items: timelineItems } }; },
    async queueChannelSend(params) {
      queued.push(params);
      return { jobId: 'job-1', idempotencyKey: 'idem-1', attempts: 0, state: 'queued' };
    },
  };
}

async function postMessage(t, app, body) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/customer-hub/messages`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const BASE = { spaceId: 'presti', resource: 'contact', id: 'c1', channel: 'email', messageKey: 'k-route-1' };

test('e9b4fc2f: a 2001-char email is refused at the route, nothing queued', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({ queued }), {
    ...BASE, text: `Salve, ${'x'.repeat(1994)}`,
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.code, 'VALIDATION_ERROR');
  assert.equal(payload?.error?.details?.field, 'text');
  assert.match(payload?.error?.message ?? '', /cronologia/);
  assert.equal(queued.length, 0, 'the queue never saw the text, let alone the provider');
});

test('e9b4fc2f: a tabbed email is refused at the route, nothing queued', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({ queued }), {
    ...BASE, messageKey: 'k-route-2', text: 'Ciao,\tecco il preventivo.',
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.code, 'VALIDATION_ERROR');
  assert.equal(payload?.error?.details?.field, 'text');
  assert.equal(queued.length, 0);
});

test('e9b4fc2f: a blank email is refused at the route', async (t) => {
  const queued = [];
  const { status } = await postMessage(t, stubApp({ queued }), { ...BASE, messageKey: 'k-route-3', text: '   ' });
  assert.equal(status, 400);
  assert.equal(queued.length, 0);
});

test('e9b4fc2f: a 2000-char email passes the route and queues', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({ queued }), {
    ...BASE, messageKey: 'k-route-4', text: `Salve, ${'x'.repeat(1993)}`,
  });
  assert.equal(status, 201);
  assert.equal(payload?.jobId, 'job-1');
  assert.equal(queued.length, 1);
});

test('e9b4fc2f: the reply reuses the newest real thread, never a polluted row', async (t) => {
  const queued = [];
  const email = (conversationId, occurredAt) => ({ entry: 'message', channel: 'email', conversationId, occurredAt });
  const { status } = await postMessage(t, stubApp({
    queued,
    timelineItems: [
      email('email:send:gmailmsg.fake-1', '2026-10-31T10:00:00.000Z'),
      email('email:thread-NEW', '2026-10-30T10:00:00.000Z'),
      email('email:thread-OLD', '2026-10-29T10:00:00.000Z'),
      { entry: 'message', channel: 'whatsapp', conversationId: 'wa:+390200000001', occurredAt: '2026-10-31T11:00:00.000Z' },
      { entry: 'note', channel: 'email', conversationId: 'email:thread-NOTE', occurredAt: '2026-10-31T12:00:00.000Z' },
      email('email:has space', '2026-10-31T09:00:00.000Z'),
    ],
  }), { ...BASE, messageKey: 'k-route-5', text: 'Certo, domani alle 18.' });
  assert.equal(status, 201);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].message.threadId, 'thread-NEW', 'newest real thread, not the polluted or foreign rows');
  assert.equal(queued[0].timeline.conversationId, 'email:thread-NEW');
});

test('e9b4fc2f: no email thread queues a new-thread send', async (t) => {
  const queued = [];
  const { status } = await postMessage(t, stubApp({ queued }), {
    ...BASE, messageKey: 'k-route-6', text: 'Buongiorno, sono Marco.',
  });
  assert.equal(status, 201);
  assert.equal(queued.length, 1);
  assert.ok(!('threadId' in (queued[0].message ?? {})), 'no thread invented: the provider opens one');
  assert.ok(!('conversationId' in (queued[0].timeline ?? {})), 'no conversation invented: the worker logs the receipt');
});
