import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 4cd1bbb646d0 (seguito di 908f2eb9bbfb, AC «sotto 3 s» NON PASSA):
 * verifica Mac 13/11 10:46Z — aprendo la scheda da link partono ~11 letture
 * in parallelo e card/timeline aspettano in coda (da sole: card 466 ms,
 * timeline 281 ms; all'apertura: nome e cronologia visibili dopo 4-6 s).
 *
 * Repro del NON PASSA: `load()` fa partire tutte le letture insieme, così
 * le secondarie (profilo, enriched, calls, campi, schema) occupano il
 * lettore prima di card e timeline. Ora card e timeline partono per prime
 * e le altre solo quando quelle due si sono sistemate (o la pittura che ne
 * segue è scattata): il nome e la cronologia non aspettano più la coda.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c-ada' },
  name: 'Ada Rossi',
  company: { id: 'co-presti', name: 'Presti Group' },
  phone: { available: true, value: '+39 333 0000001', system: 'whatsapp', reason: null },
  email: 'ada@presti.example',
  socials: [],
  status: { value: 'contatto', reason: 'no signed business on record' },
  activePackage: {
    available: true, count: 0, countIsComplete: true, countNote: null, truncated: false,
    active: [], items: [], reason: null,
  },
  notes: { available: false, items: null, reason: 'no notes composed' },
  history: { available: false, items: [], count: 0, truncated: false, completeTimeline: false, reason: 'no history' },
  headline: {
    city: { available: false, value: null, reason: 'no city on record' },
    origin: { available: true, system: 'whatsapp', firstObservedAt: '2026-11-01T10:00:00.000Z', reason: null },
    assignee: { available: false, value: null, reason: 'no referente on record' },
  },
};

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c-ada' },
  conversations: { available: true, count: 1, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
  entries: {
    available: true,
    count: 1,
    truncated: false,
    items: [
      {
        entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
        sync: 'received', body: 'Ciao, vorrei prenotare una prova', teamAuthorId: null,
        remoteHandle: '+39 333 0000001', errorCode: null, occurredAt: '2026-11-02T09:00:00.000Z',
      },
    ],
  },
  appointments: { available: true, count: 0, truncated: false, items: [] },
  contactPoints: { available: true, count: 1, items: [] },
  readState: { available: false },
  timelineNote: 'Accordo-managed threads and bookings only.',
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c-ada' },
  canonicalIdentity: {
    linked: false,
    clusterKey: null,
    canonical: { resource: 'contact', id: 'c-ada', role: 'canonical' },
    members: [
      {
        resource: 'contact', id: 'c-ada', role: 'canonical',
        decisionId: null, decidedAt: null, reason: null, decidedBy: null,
      },
    ],
    note: 'stands for itself',
  },
  identity: {
    company: { id: 'co-presti', name: 'Presti Group' },
    contact: { id: 'c-ada', email: 'ada@presti.example', firstName: 'Ada', lastName: 'Rossi' },
  },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
  quotes: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
  orders: { available: false, reason: 'not composed', items: null, count: null },
  contracts: { available: false, reason: 'not composed', items: null, count: null },
  subscriptions: { available: false, reason: 'not composed', items: null, count: null },
  deliveryProjects: { available: false, reason: 'not composed', items: null, count: null },
  serviceCoverages: { available: false, reason: 'not composed', items: null, count: null },
  supportCases: { available: false, reason: 'not composed', items: null, count: null },
  workTasks: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
  successions: { available: false, reason: 'not composed', items: null, count: null },
  status: { value: 'contatto', reason: 'no signed business on record' },
  dataQualityIssues: [],
  duplicateCandidates: [],
  completeTimeline: false,
  timelineNote: 'This profile spans Accordo-managed records only.',
  limitations: [],
};

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A client that records when each read STARTS. Card, timeline and profile
 * stay pending until the test releases them; every other read answers at
 * once. Without a space the calls read never starts (like the list views).
 */
function recordingClient() {
  const gates = new Map();
  const gate = (name) => {
    if (!gates.has(name)) {
      let release;
      const promise = new Promise((resolve, reject) => { release = { resolve, reject }; });
      gates.set(name, { promise, release });
    }
    return gates.get(name);
  };
  const started = [];
  const client = {
    started,
    gates,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return {};
      started.push(path);
      if (path.startsWith('/api/customer-hub/card/')) return gate('card').promise;
      if (path.startsWith('/api/customer-hub/timeline/')) return gate('timeline').promise;
      if (path.startsWith('/api/customer-data/profile/')) return gate('profile').promise;
      if (path.startsWith('/api/customer-data/enriched/')) {
        return { customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c-ada' }, linked: false, optedOut: null, items: [] };
      }
      if (path.startsWith('/api/customer-data/fields')) return path.includes('/values') ? { values: [] } : { definitions: [] };
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
  return client;
}

const kindOf = (path) => {
  if (path.startsWith('/api/customer-hub/card/')) return 'card';
  if (path.startsWith('/api/customer-hub/timeline/')) return 'timeline';
  return 'later';
};

test('voce 4cd1bbb646d0: card e timeline partono per prime, le altre solo dopo', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = recordingClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(10);
  const firstWave = client.started.map(kindOf);
  assert.ok(firstWave.length > 0, 'the first reads start');
  assert.ok(firstWave.every((kind) => kind === 'card' || kind === 'timeline'),
    `only card and timeline start first, got: ${JSON.stringify(client.started)}`);
  assert.ok(firstWave.includes('card') && firstWave.includes('timeline'), 'both card and timeline start first');
  // P1 rev-agent-crm-865-10914b18: the second wave starts at the first
  // paint — the timeline alone opens the gate while the card is still out.
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush(10);
  assert.ok(client.started.some((path) => path.startsWith('/api/customer-data/profile/')),
    'the profile read starts after the first paint, without waiting for the card');
  assert.ok(mount.textContent.includes('Ciao, vorrei prenotare una prova'), 'the timeline paints while the card is still out');
  client.gates.get('card').release.resolve(CARD);
  await flush(10);
  const early = mount.textContent;
  assert.ok(early.includes('Ada Rossi'), 'the name paints as soon as card and timeline settle');
  assert.ok(early.includes('Ciao, vorrei prenotare una prova'), 'the timeline paints with the name');
  client.gates.get('profile').release.resolve(PROFILE);
  await shown;
  await flush(10);
  const full = mount.textContent;
  assert.ok(full.includes('Ada Rossi'), 'the name stays after the later reads land');
  assert.ok(!full.includes('Scheda non disponibile'), 'no failure panel when every read answers');
});

test('voce 4cd1bbb646d0 P1: a hung card never starves the timeline and the second wave', async () => {
  // The card promise never settles (TCP stall, no timeout in the client)
  // and the budget timer is disabled — only the timeline paint may open
  // the second-wave gate. On the previous head this test hung: the second
  // wave waited for both first-wave promises.
  const never = () => new Promise(() => {});
  const doc = createFakeDocument();
  const mount = createMount();
  const client = recordingClient();
  const view = createCustomerCardView({ doc, mount, client, firstWaveWait: never });
  view.renderCard('contact', 'c-ada');
  await flush(10);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush(10);
  assert.ok(client.started.some((path) => path.startsWith('/api/customer-data/profile/')),
    'the profile read starts even though the card never settles');
  assert.ok(client.started.some((path) => path === '/api/schema'),
    'the schema read starts even though the card never settles');
  assert.ok(mount.textContent.includes('Ciao, vorrei prenotare una prova'), 'the timeline paints while the card hangs');
  client.gates.get('profile').release.resolve(PROFILE);
  await flush(10);
  assert.ok(!mount.textContent.includes('Scheda non disponibile'), 'no failure panel while the card is still out');
});

test('voce 4cd1bbb646d0 P1: the budget opens the second wave when both first-wave reads stall', async () => {
  // Both card and timeline stay pending; an instant budget fires the gate
  // so the six secondary reads still start instead of waiting forever.
  const doc = createFakeDocument();
  const mount = createMount();
  const client = recordingClient();
  const view = createCustomerCardView({ doc, mount, client, firstWaveWait: () => Promise.resolve() });
  view.renderCard('contact', 'c-ada');
  await flush(20);
  assert.ok(client.started.some((path) => path.startsWith('/api/customer-data/profile/')),
    'the profile read starts on the budget even when nothing lands');
  assert.ok(client.started.some((path) => path === '/api/schema'),
    'the schema read starts on the budget even when nothing lands');
});
