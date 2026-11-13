import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomerCardView,
  extractionSourcesFromTimeline,
} from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Scheda cliente «Arricchito dall'AI» (backlog:e5e3e886, seguito di
 * backlog:b9f6a2b58e00).
 *
 * Production 13/11: «Aggiorna» faceva solo GET /api/customer-data/enriched
 * (items:[]) e in meno di 1 s mostrava «Nessun dato nuovo» — prometteva
 * un'azione che non faceva.
 *
 * What this must prove on the painted scheda: «Aggiorna» starts one
 * extraction run — a POST the network shows on
 * /api/customer-data/enriched/:resource/:id/extract — over the linked
 * channel messages the scheda already shows; while the run is in flight
 * the section reads «Estraggo…»; when it lands the stored proposals are
 * listed beside the facts, each with the source that produced it. With the
 * AI off the button says the AI is off, never «Nessun dato nuovo» (which
 * now means the run happened and found nothing). The sources the button
 * sends are messages only, capped, with channel and handle as detail.
 */

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

const message = (id, body, channel = 'whatsapp', remoteHandle = '+393331234567') => ({
  entry: 'message', id, conversationId: 't1', channel, direction: 'inbound',
  sync: 'received', body, teamAuthorId: null,
  remoteHandle, errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
});

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: {
    available: true, count: 1, truncated: false,
    items: [message('m1', 'Ciao, vorrei prenotare una prova')],
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
    available: true, count: 0, countIsComplete: true, truncated: false, items: [],
  },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

const ENRICHED = {
  customerEnrichmentContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  linked: false,
  optedOut: null,
  items: [],
};

const PROPOSAL = {
  id: 'p1', field: 'role', value: 'Istruttore',
  source: 'channel-message', sourceDetail: 'whatsapp:+393331234567',
  observedAt: '2026-11-13T08:00:00.000Z',
};

const EXTRACT_PATH = '/api/customer-data/enriched/contact/c1/extract';

function fakeClient({ timeline = TIMELINE, enriched = ENRICHED, extract = null, failEnriched = null } = {}) {
  const reads = [];
  const writes = [];
  let gate = null;
  let open = () => {};
  return {
    reads,
    writes,
    hold() { gate = new Promise((resolve) => { open = resolve; }); },
    release() { open(); gate = null; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        writes.push({ path, method, body });
        if (path === EXTRACT_PATH) {
          if (gate !== null) await gate;
          if (typeof extract === 'function') return extract({ path, body });
          return { status: 'done', subject: { resource: 'contact', id: 'c1' }, runId: 'run-1', proposals: [PROPOSAL] };
        }
        return { ok: true };
      }
      reads.push(path);
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return timeline;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) {
        if (typeof failEnriched === 'function' && failEnriched(path)) throw Object.assign(new Error('boom'), { status: 500 });
        return enriched;
      }
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error(`unexpected request ${path}`), { status: 404 });
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(client) {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti',
    toast: (text) => { toasts.push(text); },
  });
  await view.renderCard('contact', 'c1');
  await flush();
  client.reads.length = 0;
  return { mount, view, toasts };
}

const byAction = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
const byStatus = (mount) => mount.findAll('p').find((node) => node.getAttribute('role') === 'status');

test('e5e3e886: «Aggiorna» POSTs one extraction run and lists the proposed fields with their source', async () => {
  const client = fakeClient();
  const { mount, toasts } = await open(client);
  const refresh = byAction(mount, 'refresh-enrichment');
  assert.ok(refresh, 'the ghost «Aggiorna» button exists');
  assert.equal(refresh.textContent, 'Aggiorna');
  client.hold();
  const running = refresh.listeners.click[0]();
  await flush();
  assert.ok(byStatus(mount)?.textContent.includes('Estraggo'), 'while the run is in flight the section reads «Estraggo…»');
  client.release();
  await running;
  await flush();
  assert.equal(client.writes.length, 1, 'one write leaves: the extraction run');
  assert.equal(client.writes[0].path, EXTRACT_PATH, 'the run is a POST the network shows, not another GET');
  assert.deepEqual(client.writes[0].body?.sources?.map((source) => source.kind), ['channel-message'],
    'the run starts from the linked channel messages');
  assert.ok(client.reads.some((path) => path.startsWith('/api/customer-data/enriched/contact/c1') && !path.endsWith('/extract')),
    'when the run lands the facts are re-read');
  assert.ok(toasts.some((text) => text.includes('L\u2019AI propone 1 campo')), 'the toast names the proposed field');
  assert.ok(!toasts.includes('Nessun dato nuovo'), 'a run that proposes says so, never «Nessun dato nuovo»');
  assert.ok(mount.textContent.includes('Ruolo: Istruttore'), 'the proposed field is on screen');
  assert.ok(mount.textContent.includes('fonte: messaggio'), 'the proposal cites the source that produced it');
});

test('e5e3e886: with the AI off «Aggiorna» says the AI is off, never «Nessun dato nuovo»', async () => {
  const client = fakeClient({
    extract: () => { throw Object.assign(new Error('no AI'), { code: 'ENRICHMENT_AI_UNAVAILABLE', status: 503 }); },
  });
  const { mount, toasts } = await open(client);
  await byAction(mount, 'refresh-enrichment').listeners.click[0]();
  await flush();
  assert.equal(client.writes.length, 1, 'the attempt still leaves as a run');
  assert.ok(toasts.some((text) => text.includes('L\u2019AI non \u00e8 attiva')), 'the button says the AI is off');
  assert.ok(!toasts.includes('Nessun dato nuovo'), 'an unstarted run never reads as «nothing new»');
  assert.ok(mount.textContent.includes('Nessun dato arricchito ancora'), 'the section keeps its previous rows');
});

test('e5e3e886: a run that finds nothing says «Nessun dato nuovo»', async () => {
  const client = fakeClient({
    extract: () => ({ status: 'done', subject: { resource: 'contact', id: 'c1' }, runId: 'run-2', proposals: [] }),
  });
  const { mount, toasts } = await open(client);
  await byAction(mount, 'refresh-enrichment').listeners.click[0]();
  await flush();
  assert.equal(client.writes.length, 1, 'the run happened');
  assert.ok(toasts.includes('Nessun dato nuovo'), 'only a run that happened and found nothing says it');
});

test('e5e3e886: with no messages the button sends nothing and says where the AI starts from', async () => {
  const client = fakeClient({
    timeline: { ...TIMELINE, entries: { ...TIMELINE.entries, count: 0, items: [] } },
  });
  const { mount, toasts } = await open(client);
  await byAction(mount, 'refresh-enrichment').listeners.click[0]();
  await flush();
  assert.equal(client.writes.length, 0, 'no run starts with no source to read');
  assert.ok(toasts.some((text) => text.includes('Non ci sono messaggi')), 'the button says the AI starts from messages');
});

test('e5e3e886: a run that landed but re-reads nothing keeps its rows with the retry line', async () => {
  let reReads = 0;
  const client = fakeClient({
    failEnriched: (path) => { reReads += 1; return reReads > 1; },
  });
  const { mount, toasts } = await open(client);
  await byAction(mount, 'refresh-enrichment').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('Nessun dato arricchito ancora'), 'the previous rows stay on screen');
  assert.ok(!mount.textContent.includes('L\u2019AI propone'), 'no proposal paints without its re-read facts');
  assert.ok(toasts.some((text) => text.includes('Riprova')), 'the failed re-read toasts the retry, never silence');
});

test('e5e3e886: the run sources are messages only, capped, with channel and handle as detail', () => {
  const timeline = {
    entries: {
      items: [
        message('m1', '  '),
        { entry: 'note', id: 'n1', body: 'Richiamare', teamAuthorId: 'elena' },
        { entry: 'call', id: 'c9', channel: 'phone', body: 'voicemail' },
        message('m2', 'Quanto costa il pacchetto?', 'instagram', 'guido.presti'),
        ...Array.from({ length: 20 }, (_, index) => message(`mx${index}`, `messaggio ${index}`)),
      ],
    },
  };
  const sources = extractionSourcesFromTimeline(timeline);
  assert.equal(sources.length, 10, 'at most ten sources travel');
  assert.ok(sources.every((source) => source.kind === 'channel-message'), 'notes and calls never travel');
  assert.deepEqual(sources[0], {
    kind: 'channel-message',
    text: 'Quanto costa il pacchetto?',
    detail: 'instagram:guido.presti',
  }, 'the first usable message names its channel and handle');
  assert.ok(Object.isFrozen(sources) && sources.every((source) => Object.isFrozen(source)), 'sources are frozen');
});
