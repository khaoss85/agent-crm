import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';

/**
 * Scheda composer WhatsApp window (backlog:97cba17c, VALIDAZIONE A4): the
 * route knows Meta's 24-hour rule before anything is queued. Outside the
 * window a free text refuses fast in Italian with
 * CHANNEL_TEMPLATE_REQUIRED and nothing is queued; an approved template
 * still queues. The queue's own approval stays the authority — the route
 * only shapes the request and translates the refusal.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'composer-route',
};

const PHONE = '+390200000001';
const WA_KEY = 'ch-conn:presti:whatsapp:x';

function stubApp({ timelineItems = [], queued = [], approve = () => true } = {}) {
  return {
    services: { contacts: { get: async () => ({ id: 'c1' }) }, companies: { get: async () => ({ id: 'c1' }) } },
    async readCustomerCard() {
      return { email: 'cliente@example.com', phone: { available: true, value: PHONE }, socials: [] };
    },
    async readSyncState() {
      return { connectors: [{ channel: 'whatsapp', status: 'active', connectionKey: WA_KEY }] };
    },
    async readCustomerTimeline() { return { entries: { items: timelineItems } }; },
    async queueChannelSend(params) {
      const message = params?.message ?? {};
      if (message.template !== undefined) {
        if (!approve(message.template)) {
          const error = new Error(`template "${message.template?.name}" is not an approved template of this adapter`);
          error.code = 'CHANNEL_MESSAGE_MALFORMED';
          error.status = 422;
          throw error;
        }
      }
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

const BASE = { spaceId: 'presti', resource: 'contact', id: 'c1', channel: 'whatsapp', connectionKey: WA_KEY };
const inbound = (occurredAt) => ({
  entry: 'message', channel: 'whatsapp', direction: 'inbound', conversationId: 'wa:+390200000001', occurredAt,
});
const recentIso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

test('97cba17c: WhatsApp free text with no inbound refuses in Italian, nothing queued', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({ queued }), {
    ...BASE, messageKey: 'k-wa-1', text: 'Ciao, sono Marco.',
  });
  assert.equal(status, 422);
  assert.equal(payload?.error?.code, 'CHANNEL_TEMPLATE_REQUIRED');
  assert.match(payload?.error?.message ?? '', /modello approvato/);
  assert.equal(queued.length, 0);
});

test('97cba17c: WhatsApp free text past 24 hours refuses in Italian, nothing queued', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({
    queued,
    timelineItems: [inbound(recentIso(25 * 3600_000))],
  }), { ...BASE, messageKey: 'k-wa-2', text: 'Ciao, sono Marco.' });
  assert.equal(status, 422);
  assert.equal(payload?.error?.code, 'CHANNEL_TEMPLATE_REQUIRED');
  assert.match(payload?.error?.message ?? '', /24 ore/);
  assert.equal(queued.length, 0);
});

test('97cba17c: WhatsApp free text inside 24 hours queues', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({
    queued,
    timelineItems: [inbound(recentIso(3600_000))],
  }), { ...BASE, messageKey: 'k-wa-3', text: 'Ciao, sono Marco.' });
  assert.equal(status, 201);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].message.text, 'Ciao, sono Marco.');
  assert.equal(payload?.template, undefined);
});

test('97cba17c: an approved template queues past 24 hours and names itself', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({
    queued,
    timelineItems: [inbound(recentIso(25 * 3600_000))],
  }), {
    ...BASE,
    messageKey: 'k-wa-4',
    template: { name: 'promemoria_visita', language: 'it', variables: ['giovedì'] },
  });
  assert.equal(status, 201);
  assert.equal(queued.length, 1);
  assert.deepEqual(queued[0].message.template, { name: 'promemoria_visita', language: 'it', variables: ['giovedì'] });
  assert.equal(payload?.template, 'promemoria_visita');
});

test('97cba17c: template plus free text refuses the mix, nothing queued', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({
    queued,
    timelineItems: [inbound(recentIso(3600_000))],
  }), {
    ...BASE, messageKey: 'k-wa-5', text: 'Ciao.', template: { name: 'promemoria_visita' },
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.details?.field, 'text');
  assert.equal(queued.length, 0);
});

test('97cba17c: a malformed template refuses on field template', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({ queued }), {
    ...BASE, messageKey: 'k-wa-6', template: { name: '' },
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.details?.field, 'template');
  assert.equal(queued.length, 0);
});

test('97cba17c: a template on email refuses, only WhatsApp sends one', async (t) => {
  const queued = [];
  const app = stubApp({ queued });
  app.readSyncState = async () => ({
    connectors: [{ channel: 'email', status: 'active', connectionKey: 'ch-conn:presti:email:x' }],
  });
  const { status, payload } = await postMessage(t, app, {
    spaceId: 'presti', resource: 'contact', id: 'c1', channel: 'email', messageKey: 'k-wa-7',
    text: '', template: { name: 'promemoria_visita' },
  });
  assert.equal(status, 400);
  assert.equal(payload?.error?.details?.field, 'template');
  assert.equal(queued.length, 0);
});

test('97cba17c: a template the queue does not approve refuses in Italian', async (t) => {
  const queued = [];
  const { status, payload } = await postMessage(t, stubApp({
    queued,
    timelineItems: [inbound(recentIso(25 * 3600_000))],
    approve: () => false,
  }), { ...BASE, messageKey: 'k-wa-8', template: { name: 'sconto_finto' } });
  assert.equal(status, 422);
  assert.match(payload?.error?.message ?? '', /modello approvato/);
  assert.equal(queued.length, 0);
});
