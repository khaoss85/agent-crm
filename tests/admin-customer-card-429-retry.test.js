// @ts-check

/**
 * backlog:3a9bee845cc4 — production 13/11: a 429 rate limit left every scheda
 * riquadro on «non si è potuto leggere» with no way back, and logged the same
 * failure once per section (52 «[bo] lettura fallita … 429 UNKNOWN» lines for
 * 6 requests).
 *
 * A codeless 429 is a rate limit (TOO_MANY_REQUESTS, never UNKNOWN); one
 * failed request logs once however many sections name it; every failed
 * section offers «Riprova», which re-reads the scheda.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFailure } from '../apps/admin/public/admin-core.js';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto', reason: 'x' },
};

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: {
    available: true, count: 1, truncated: false,
    items: [{
      entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
      sync: 'received', body: 'Ciao, vorrei prenotare una prova', teamAuthorId: null,
      remoteHandle: '+393331234567', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
    }],
  },
  appointments: { available: true, count: 0, truncated: false, items: [] },
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: {
    company: { id: 'co1', name: 'Palestra Esempio' },
    contact: { id: 'c1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it', companyId: 'co1' },
  },
  externalIdentities: [],
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'qualification', stage: 'qualification', name: 'Pacchetto 10 ingressi' }],
  },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

/** The production 429 shape after the apiFailure fix: status with a named code. */
const rateLimited = () => Object.assign(new Error('Rate limited'), { status: 429, code: 'TOO_MANY_REQUESTS' });

/** Serves the scheda; `fail(true)` answers the section reads with a 429. */
function fakeClient() {
  const reads = [];
  let failing = false;
  return {
    reads,
    fail(on) { failing = on; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      reads.push(path);
      if (failing) {
        if (path.startsWith('/api/customer-hub/timeline/')) throw rateLimited();
        if (path.startsWith('/api/customer-data/profile/')) throw rateLimited();
        if (path.startsWith('/api/customer-data/enriched/')) throw rateLimited();
        if (path.startsWith('/api/call-intelligence/calls/')) throw rateLimited();
      }
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) return { extract: null };
      if (path.startsWith('/api/call-intelligence/calls/')) return { calls: [] };
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

test('apiFailure names a codeless 429 TOO_MANY_REQUESTS, and keeps the other defaults', () => {
  assert.equal(apiFailure(429, null).code, 'TOO_MANY_REQUESTS');
  assert.equal(apiFailure(429, undefined).status, 429);
  assert.equal(apiFailure(429, { error: { code: 'BO_X', message: 'x' } }).code, 'BO_X');
  assert.equal(apiFailure(502, undefined).code, 'UNKNOWN');
  assert.equal(apiFailure(502, undefined).message, 'Request failed (502)');
});

test('3a9bee845cc4: one 429 logs once per failed request, every failed section offers Riprova in Italian', async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const doc = createFakeDocument();
    const mount = createMount();
    const client = fakeClient();
    client.fail(true);
    const view = createCustomerCardView({ doc, mount, client, navigate: () => {}, spaceId: 'spazio-1' });
    await view.renderCard('contact', 'c1');
    await flush();

    const readLines = logged.filter((args) => String(args[0]).includes('[bo] lettura fallita'));
    // Four requests failed (timeline, profile, enrichment, calls): four lines,
    // however many sections name the same failures.
    assert.equal(readLines.length, 4, `one log per failed request, got ${readLines.length}: ${readLines.map((a) => String(a[0])).join(' | ')}`);
    for (const args of readLines) {
      assert.ok(String(args[0]).includes('429'), 'the log names the 429 status');
      assert.ok(!String(args[0]).includes('UNKNOWN'), 'the 429 code is recognized, never UNKNOWN');
    }

    const retries = mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'scheda-retry');
    assert.ok(retries.length > 0, 'a failed section offers Riprova');
    assert.ok(retries.every((node) => node.textContent === 'Riprova'), 'the retry reads Riprova, nothing technical');
    assert.ok(mount.textContent.includes('Riprova più tardi'), 'the sections stay Italian');
    assert.ok(!/TOO_MANY_REQUESTS|UNKNOWN|\(429\)/.test(mount.textContent), 'no code leaks onto the screen');
  } finally {
    console.error = originalError;
  }
});

test('3a9bee845cc4: Riprova re-reads the scheda and paints once the limit has passed', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = fakeClient();
  client.fail(true);
  const view = createCustomerCardView({ doc, mount, client, navigate: () => {}, spaceId: 'spazio-1' });
  await view.renderCard('contact', 'c1');
  await flush();
  assert.ok(!mount.textContent.includes('Ciao, vorrei prenotare una prova'), 'the cronologia failed under the limit');

  client.fail(false);
  const readsBefore = client.reads.length;
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'scheda-retry');
  assert.ok(retry, 'a failed section offers Riprova');
  await retry.listeners.click[0]();
  await flush();
  assert.ok(client.reads.length > readsBefore, 'Riprova reads the scheda again');
  assert.ok(mount.textContent.includes('Ciao, vorrei prenotare una prova'), 'the passed limit paints the cronologia');
  assert.equal(
    mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'scheda-retry').length,
    0,
    'no retry stays once the reads pass',
  );
});
