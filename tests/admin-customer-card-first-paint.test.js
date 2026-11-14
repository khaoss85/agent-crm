import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createKnownNames } from '../apps/admin/public/admin-known-names.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 908f2eb9bbfb (secondo ritorno, AC-3): la scheda dipinge nome e
 * cronologia appena arrivano, senza aspettare il profilo.
 *
 * Repro del NON PASSA osservato in produzione: aprendo la scheda dal link
 * diretto, `load()` aspettava TUTTE le letture (card, timeline, profile,
 * enriched, calls, fields, schema) prima di dipingere qualsiasi cosa, così
 * la pagina restava bianca per l'intera lettura del profilo (5-6 s). Ora la
 * prima pittura (nome + cronologia) scatta appena card e timeline si
 * sistemano; le sezioni del profilo si aggiungono quando arrivano.
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
  externalIdentities: [
    {
      system: 'whatsapp', externalId: '+39 333 0000001',
      subject: { resource: 'contact', id: 'c-ada' },
      firstObservedAt: '2026-11-01T10:00:00.000Z', lastObservedAt: '2026-11-02T09:00:00.000Z',
    },
  ],
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
 * A client whose card/timeline/profile reads stay pending until the test
 * releases them; every other read answers at once. Writes are recorded.
 */
function deferredClient() {
  const gates = new Map();
  const gate = (name) => {
    if (!gates.has(name)) {
      let release;
      const promise = new Promise((resolve, reject) => { release = { resolve, reject }; });
      gates.set(name, { promise, release });
    }
    return gates.get(name);
  };
  const writes = [];
  const reads = [];
  const client = {
    writes,
    gates,
    reads,
    /** A fresh set of held reads, for a second opening. */
    reset() { gates.clear(); reads.length = 0; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') {
        writes.push({ path, method: options.method });
        return {};
      }
      reads.push(path);
      if (path.startsWith('/api/customer-hub/card/')) return gate('card').promise;
      if (path.startsWith('/api/customer-hub/timeline/')) return gate('timeline').promise;
      if (path.startsWith('/api/customer-data/profile/')) return gate('profile').promise;
      if (path.startsWith('/api/customer-data/enriched/')) return { customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c-ada' }, linked: false, optedOut: null, items: [] };
      if (path.startsWith('/api/customer-data/fields')) return path.includes('/values') ? { values: [] } : { definitions: [] };
      if (path === '/api/schema') return { pipelines: [] };
      // backlog:947260f9f036: the offer's trail and the team roster can be
      // held like the three reads above.
      if (path.startsWith('/api/audit')) return gate('audit').promise;
      if (path === '/api/spine/memberships') return gate('roster').promise;
      if (path === '/api/spine/context') return { actor: { id: 'u-me' } };
      throw new Error(`unexpected request ${path}`);
    },
  };
  return client;
}

test('voce 908f2eb9bbfb: first paint shows the name and the timeline while the profile is still pending', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  assert.ok(!mount.textContent.includes('Ada Rossi'), 'nothing paints before card and timeline settle');
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush();
  const early = mount.textContent;
  assert.ok(early.includes('Ada Rossi'), 'the name paints as soon as card and timeline settle');
  assert.ok(early.includes('Ciao, vorrei prenotare una prova'), 'the timeline paints with the name, without the profile');
  assert.ok(!early.includes('Scheda non disponibile'), 'no failure panel while the profile is still pending');
  client.gates.get('profile').release.resolve(PROFILE);
  await shown;
  await flush(3);
  const full = mount.textContent;
  assert.ok(full.includes('Ada Rossi'), 'the name stays after the profile lands');
  assert.ok(full.includes('via WhatsApp'), 'the profile sections fill in when the profile lands');
});

test('voce 908f2eb9bbfb: a late profile failure leaves the painted name and timeline, error only on Dettagli', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush();
  assert.ok(mount.textContent.includes('Ada Rossi'), 'the name paints before the profile settles');
  const failure = Object.assign(new Error('pool esaurito'), { status: 503 });
  client.gates.get('profile').release.reject(failure);
  await shown;
  await flush(3);
  const text = mount.textContent;
  assert.ok(text.includes('Ada Rossi'), 'the name stays when the profile fails late');
  assert.ok(text.includes('Ciao, vorrei prenotare una prova'), 'the timeline stays when the profile fails late');
  assert.ok(!text.includes('Scheda non disponibile'), 'a late profile failure never fails the whole scheda');
  assert.ok(text.includes('Riprova più tardi'), 'the failed section names the retry');
});

// backlog:947260f9f036 (pilota 13/11): the scheda opened from the offer's
// «Per <cliente>» showed only «Carico Clienti…» on a blank page for
// 2,8-5,7 s — the scheda had been on screen before (scheda → offerta →
// scheda), so the view took the second opening for a re-read of a scheda
// still shown, while the router had already cleared it.
const busySections = (mount) => mount.findAll('div').filter((node) => node.getAttribute('data-loading') === 'true');

test('947260f9f036: back on the same customer after another screen, the scheda shows its skeleton at once', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const first = view.renderCard('contact', 'c-ada');
  assert.ok(busySections(mount).length > 0, 'the first opening paints the skeleton');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  // Voce 4cd1bbb646d0: the profile is a second-wave read.
  await flush(3);
  client.gates.get('profile').release.resolve(PROFILE);
  await first;
  await flush(3);
  assert.ok(mount.textContent.includes('Ada Rossi'));

  // The router leaves for the offer page: the scheda is invalidated and the
  // shared mount cleared, then «Per Ada Rossi» comes back to the same scheda.
  view.invalidate();
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const loading = doc.createElement('div');
  loading.textContent = 'Carico Clienti…';
  mount.appendChild(loading);
  client.reset();
  const again = view.renderCard('contact', 'c-ada');
  assert.ok(busySections(mount).length > 0, 'the skeleton is on screen at once, as from the Clienti list');
  assert.ok(!mount.textContent.includes('Carico Clienti…'), 'never the lone loading line on a blank page');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  // Voce 4cd1bbb646d0: the profile is a second-wave read.
  await flush(3);
  client.gates.get('profile').release.resolve(PROFILE);
  await again;
  await flush(3);
  assert.ok(mount.textContent.includes('Ada Rossi'));
  assert.equal(busySections(mount).length, 0, 'the skeleton leaves when the reads land');
});

const OFFER_PROFILE = {
  ...PROFILE,
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'proposal', name: 'Pacchetto sede', owner: 'maria', createdAt: '2026-11-01T08:00:00.000Z' }],
  },
};
const MOVE = {
  id: 'a2', action: 'opportunity.stage_changed', actorType: 'user', actorId: 'maria',
  createdAt: '2026-11-03T10:00:00.000Z', data: { from: 'qualification', to: 'proposal' },
};

/** The cronologia «Tutti» rows on screen, as text. */
const timelineRows = (mount) => {
  const list = mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-timeline');
  return { list, text: list ? list.textContent : '' };
};
const stateHistory = (mount) => mount.findAll('p')
  .filter((node) => ['bo-scheda-offer-history', 'bo-muted'].includes(node.getAttribute('class') ?? ''))
  .map((node) => node.textContent);

for (const order of [['roster', 'audit'], ['audit', 'roster']]) {
  test(`947260f9f036: the cronologia is whole on every opening — ${order.join(' then ')}`, async () => {
    const doc = createFakeDocument();
    const mount = createMount();
    const client = deferredClient();
    const view = createCustomerCardView({ doc, mount, client });
    const shown = view.renderCard('contact', 'c-ada');
    await flush(3);
    client.gates.get('card').release.resolve(CARD);
    client.gates.get('timeline').release.resolve(TIMELINE);
    // Voce 4cd1bbb646d0: the profile is a second-wave read.
    await flush(3);
    client.gates.get('profile').release.resolve(OFFER_PROFILE);
    await shown;
    await flush();
    // The trail and the roster leave together, never one after the other.
    assert.ok(client.reads.some((path) => path.startsWith('/api/audit')), 'the trail is asked before the roster answers');
    assert.ok(client.reads.includes('/api/spine/memberships'));
    // While the stage moves are still reading, «Tutti» says so: never two
    // events that become three a moment later.
    const waiting = timelineRows(mount);
    assert.equal(waiting.list.getAttribute('aria-busy'), 'true', 'the cronologia is marked as still reading');
    assert.ok(waiting.list.findAll('p').some((node) => node.getAttribute('data-loading') === 'true'), 'a grey row where the moves arrive');
    for (const name of order) {
      client.gates.get(name).release.resolve(name === 'audit' ? { items: [MOVE] } : { items: [] });
      await flush();
    }
    const done = timelineRows(mount);
    assert.equal(done.list.getAttribute('aria-busy'), 'false');
    assert.ok(done.text.includes('Ciao, vorrei prenotare una prova'), 'the message');
    assert.ok(done.text.includes('Pacchetto sede'), 'the offer creation');
    assert.ok(/Pacchetto sede: da .+ a .+/.test(done.text), 'and the stage move: three events');
    const history = stateHistory(mount);
    assert.ok(!history.includes('Caricamento…'), '«Storia stati» never stays on «Caricamento…»');
    assert.ok(history.some((text) => /^da .+ a .+ · da /.test(text)), '«Storia stati» names the move');
  });
}

// backlog:f2d39e473e3a (pilota 13/11): «Tutti i contatti» filled in pieces
// over 4-5,6 s — the notes, then «Offerta creata», then «Cambio di stato».
// The offers come with the profile (second wave), their moves with the
// trail after it: until both are in, the messages show with one marked row,
// then the offer's creation and its moves arrive together, in one step.
test('f2d39e473e3a: the offers and their moves join the cronologia together, after one marked row', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush(3);
  // The timeline is in, the profile is not: the messages show, marked.
  const early = timelineRows(mount);
  assert.ok(early.text.includes('Ciao, vorrei prenotare una prova'), 'the message shows at once');
  assert.equal(early.list.getAttribute('aria-busy'), 'true', 'the cronologia says it is still reading');
  assert.ok(early.text.includes('Carico offerte e cambi di stato…'), 'one marked row says what is coming');
  // The profile lands with the offer; its trail is still reading.
  client.gates.get('profile').release.resolve(OFFER_PROFILE);
  await shown;
  await flush();
  const middle = timelineRows(mount);
  assert.ok(!/Pacchetto sede/.test(middle.text), 'the offer creation waits for its moves: never two steps');
  assert.ok(middle.text.includes('Carico offerte e cambi di stato…'));
  client.gates.get('roster').release.resolve({ items: [] });
  client.gates.get('audit').release.resolve({ items: [MOVE] });
  await flush();
  const done = timelineRows(mount);
  assert.equal(done.list.getAttribute('aria-busy'), 'false');
  assert.ok(!done.text.includes('Carico offerte'), 'the marked row leaves');
  assert.ok(done.text.includes('Pacchetto sede'), 'the offer creation');
  assert.ok(/Pacchetto sede: da .+ a .+/.test(done.text), 'and its move, in the same step');
});

test('f2d39e473e3a: a customer without offers loses the marked row when the profile lands, nothing else moves', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush(3);
  const before = timelineRows(mount).list.findAll('div').length;
  client.gates.get('profile').release.resolve(PROFILE);
  await shown;
  await flush();
  const after = timelineRows(mount);
  assert.equal(after.list.getAttribute('aria-busy'), 'false');
  assert.ok(!after.text.includes('Carico offerte'));
  assert.equal(after.list.findAll('div').length, before, 'the same rows, without the marked one');
  assert.ok(!client.reads.some((path) => path.startsWith('/api/audit')), 'no trail to read');
});

// backlog:a762c28a646c (verifica 14/11 00:46Z): the scheda's name waited for
// customer-hub/card (1,3-3,6 s) although the list or the offer had just
// shown it. A known name paints at once, in the title and the crumb.
test('a762c28a646c: a name another view showed paints at once in the scheda and the crumb; the card read confirms it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const names = createKnownNames({ space: () => null });
  names.remember('contact', 'c-ada', 'Ada Rossi');
  const titles = [];
  const view = createCustomerCardView({ doc, mount, client, knownNames: names, onCustomerTitle: (name) => titles.push(name) });
  const started = Date.now();
  const shown = view.renderCard('contact', 'c-ada');
  const name = mount.findAll('h1').find((node) => node.getAttribute('class') === 'bo-scheda-name');
  assert.equal(name?.textContent, 'Ada Rossi', 'the name is on screen in the same tick, before any read');
  assert.ok(Date.now() - started < 300, 'well within 300 ms');
  assert.deepEqual(titles, ['Ada Rossi'], 'the crumb names the customer at once');
  const head = mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-head');
  assert.equal(head.getAttribute('aria-busy'), 'true', 'the rest of the header is still reading');
  await flush(3);
  client.gates.get('card').release.resolve({ ...CARD, name: 'Ada Rossi Bianchi' });
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush(3);
  client.gates.get('profile').release.resolve(PROFILE);
  await shown;
  await flush(3);
  assert.ok(mount.textContent.includes('Ada Rossi Bianchi'), 'the card read corrects a name that changed');
  assert.deepEqual(titles, ['Ada Rossi', 'Ada Rossi Bianchi']);
  assert.equal(names.get('contact', 'c-ada'), 'Ada Rossi Bianchi', 'and the store keeps the name read');
});

test('a762c28a646c: without a known name the header stays grey until the card lands', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({ doc, mount, client: deferredClient(), knownNames: createKnownNames({ space: () => null }) });
  void view.renderCard('contact', 'c-ada');
  assert.equal(mount.findAll('h1').length, 0, 'no name it has not read');
  assert.ok(mount.findAll('span').some((node) => node.getAttribute('data-skeleton') === 'true'));
});
