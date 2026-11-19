// @ts-check

/**
 * Backlog c61b882bbf2a — prova del Mac 18/11 ~15:50Z sul live: mentre lo
 * spazio si riavviava la scheda di Ada Rossi è rimasta sui riquadri
 * scheletro per più di 60 s senza nessun messaggio.
 *
 * Repro del NON PASSA: a prima visita, con card e cronologia arrivate e il
 * profilo ancora in volo oltre la soglia, la scheda teneva solo scheletri
 * muti («Azioni rapide», «Identità collegate», «Dettagli», «✦ Recap»).
 *
 * Contratto della cura: oltre PROFILE_SLOW_MS con il profilo ancora in
 * volo la scheda mostra un messaggio in italiano con un nuovo tentativo al
 * posto degli scheletri muti del profilo; il messaggio sparisce quando i
 * dati arrivano (la pittura finale non lo conosce).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView, PROFILE_SLOW_MS } from '../apps/admin/public/admin-customer-card.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

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
    available: true, count: 0, countIsComplete: true, truncated: false,
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

const TIMELINE_EMPTY = {
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

const PROFILE_EMPTY = {
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

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/**
 * Card, cronologia e profilo trattenuti a cancelli manuali; l'orologio del
 * profilo lento è un cancello manuale: la soglia scatta quando il test lo
 * dice, mai in tempo reale.
 */
function deferredClient() {
  const gates = new Map();
  const gate = (name) => {
    if (!gates.has(name)) {
      let release;
      const promise = new Promise((resolve) => { release = { resolve }; });
      gates.set(name, { promise, release });
    }
    return gates.get(name);
  };
  const counts = { card: 0 };
  const seenSlowMs = [];
  let slowCalls = 0;
  let fireSlow;
  const slowArmed = new Promise((resolve) => { fireSlow = resolve; });
  const client = {
    gates,
    counts,
    seenSlowMs,
    fireSlow: () => fireSlow(),
    resetGate(name) { gates.delete(name); },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return { status: 'done', proposals: [] };
      if (path.startsWith('/api/customer-hub/card/')) {
        counts.card += 1;
        return gate('card').promise;
      }
      if (path.startsWith('/api/customer-hub/timeline/')) return gate('timeline').promise;
      if (path.startsWith('/api/customer-data/profile/')) return gate('profile').promise;
      if (path === '/api/schema') return gate('schema').promise;
      if (path === '/api/appointments/services') return gate('services').promise;
      if (path.startsWith('/api/customer-data/enriched/')) return { customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c-ada' }, linked: false, optedOut: null, items: [] };
      if (path.startsWith('/api/customer-data/fields')) return path.includes('/values') ? { values: [] } : { definitions: [] };
      if (path.startsWith('/api/call-intelligence/calls/')) return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/spine/context') return { actor: { id: 'u-me' } };
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw new Error(`unexpected request ${path}`);
    },
  };
  const viewDeps = {
    profileSlowWait: (ms) => {
      seenSlowMs.push(ms);
      slowCalls += 1;
      // Solo il primo giro aspetta il cancello del test; le riletture
      // (Riprova) non devono restare appese al test.
      if (slowCalls === 1) return slowArmed;
      return new Promise(() => {});
    },
  };
  return { client, viewDeps };
}

const sectionsTitled = (mount, title) => mount.findAll('section')
  .filter((node) => (node.textContent ?? '').includes(title));
const slowNotices = (mount) => mount.findAll('section')
  .filter((node) => ((node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-card-profile-slow')));
const skeletonTitled = (mount, title) => sectionsTitled(mount, title)
  .filter((node) => node.getAttribute('data-loading') === 'true');
const retryButton = (mount) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === 'scheda-retry') ?? null;

test('c61b882bbf2a: profilo oltre la soglia, messaggio in italiano con nuovo tentativo al posto degli scheletri muti', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const { client, viewDeps } = deferredClient();
  const view = createCustomerCardView({ doc, mount, client, ...viewDeps });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(6);
  assert.ok(mount.textContent.includes('Ada Rossi'), 'il nome dipinge prima del profilo');
  assert.equal(skeletonTitled(mount, 'Identità collegate').length, 1, 'prima della soglia lo scheletro parla ancora');
  assert.equal(slowNotices(mount).length, 0, 'prima della soglia nessun messaggio');
  assert.deepEqual(client.seenSlowMs, [PROFILE_SLOW_MS], 'l’orologio parte sulla soglia dichiarata');
  client.fireSlow();
  await flush(6);
  assert.equal(slowNotices(mount).length, 1, 'oltre la soglia un solo messaggio parla del profilo');
  assert.ok(slowNotices(mount)[0].textContent.includes('impiegando più del previsto'), 'il messaggio è in italiano');
  const retry = retryButton(mount);
  assert.ok(retry, 'il messaggio offre un nuovo tentativo');
  assert.equal(skeletonTitled(mount, 'Identità collegate').length, 0, 'niente scheletro muto per le identità');
  assert.equal(skeletonTitled(mount, 'Dettagli').length, 0, 'niente scheletro muto per i dettagli');
  assert.equal(skeletonTitled(mount, 'Azioni rapide').length, 0, 'niente scheletro muto per le azioni');
  assert.equal(skeletonTitled(mount, '✦ Recap').length, 0, 'niente scheletro muto per il recap');
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await shown;
  await flush(3);
  assert.equal(slowNotices(mount).length, 0, 'quando i dati arrivano il messaggio sparisce');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'edit-details'), 'i Dettagli veri prendono il posto del messaggio');
});

test('c61b882bbf2a: il nuovo tentativo rilegge la scheda e il messaggio sparisce coi dati', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const { client, viewDeps } = deferredClient();
  const view = createCustomerCardView({ doc, mount, client, ...viewDeps });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(6);
  client.fireSlow();
  await flush(6);
  assert.equal(slowNotices(mount).length, 1, 'oltre la soglia il messaggio c’è');
  assert.equal(client.counts.card, 1, 'un solo giro di lettura prima del tentativo');
  const retry = retryButton(mount);
  assert.ok(retry, 'il messaggio offre il nuovo tentativo');
  retry.dispatch('click');
  await flush(6);
  assert.equal(client.counts.card, 2, 'il nuovo tentativo rilegge la scheda');
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await shown;
  await flush(6);
  assert.equal(slowNotices(mount).length, 0, 'a rilettura finita il messaggio sparisce');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'edit-details'), 'i Dettagli veri prendono il posto del messaggio');
});

test('c61b882bbf2a: profilo veloce, nessun messaggio e la soglia scattata non dipinge niente', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const { client, viewDeps } = deferredClient();
  const view = createCustomerCardView({ doc, mount, client, ...viewDeps });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(3);
  assert.equal(slowNotices(mount).length, 0, 'prima della soglia nessun messaggio');
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await shown;
  await flush(3);
  client.fireSlow();
  await flush(6);
  assert.equal(slowNotices(mount).length, 0, 'a profilo arrivato la soglia non dipinge niente');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'edit-details'), 'i Dettagli veri restano');
});
