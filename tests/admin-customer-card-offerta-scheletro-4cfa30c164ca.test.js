// @ts-check

/**
 * Backlog 4cfa30c164ca (verifica Mac 13/11 20:49Z, pilota 925e6dd con
 * agent-crm ae930cf, punto 1): lo scheletro della scheda cliente mostra il
 * riquadro «OFFERTA» che poi sparisce a dati caricati e fa saltare la
 * colonna destra.
 *
 * Repro del NON PASSA del verificatore (17/11, testa 85976a6): mentre il
 * profilo è in attesa, paint dipinge lo scheletro
 * `bo-scheda-card-offer` con titolo «Offerta»; a profilo arrivato, con
 * zero offerte, `offer()` torna false e la sezione sparisce — il riquadro
 * era un fantasma. Come i custom fields (backlog:434cc39a), la sezione che
 * può nascondersi da sola non ha scheletro: niente in attesa, niente a
 * lettura vuota.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
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

const EMPTY_PROFILE = {
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
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/** Card e timeline subito, profilo trattenuto: la strada dello scheletro fantasma. */
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
  const client = {
    gates,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return {};
      if (path.startsWith('/api/customer-hub/card/')) return gate('card').promise;
      if (path.startsWith('/api/customer-hub/timeline/')) return gate('timeline').promise;
      if (path.startsWith('/api/customer-data/profile/')) return gate('profile').promise;
      if (path.startsWith('/api/customer-data/enriched/')) return { customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c-ada' }, linked: false, optedOut: null, items: [] };
      if (path.startsWith('/api/customer-data/fields')) return path.includes('/values') ? { values: [] } : { definitions: [] };
      if (path === '/api/schema') return { pipelines: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/spine/context') return { actor: { id: 'u-me' } };
      if (path.startsWith('/api/call-intelligence/calls/')) return { items: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
  return client;
}

const offerBoxes = (mount) => mount.findAll('section').filter((node) => (
  (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-card-offer')
));

test('4cfa30c164ca: nessun riquadro «Offerta» mentre il profilo è in attesa, nessuno a profilo vuoto', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush();
  assert.ok(mount.textContent.includes('Ada Rossi'), 'il nome dipinge prima del profilo');
  assert.equal(offerBoxes(mount).length, 0, 'nessun riquadro Offerta in attesa del profilo (mai un fantasma)');
  client.gates.get('profile').release.resolve(EMPTY_PROFILE);
  await shown;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 0, 'nessun riquadro Offerta per chi non ha offerte');
});

test('4cfa30c164ca: con un\u2019offerta vera la riga dipinge a profilo arrivato', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE);
  await flush();
  client.gates.get('profile').release.resolve({
    ...EMPTY_PROFILE,
    opportunities: {
      available: true, count: 1, countIsComplete: true, truncated: false,
      items: [{ id: 'o1', status: 'proposal', stage: 'proposal', name: 'Pacchetto sede' }],
    },
  });
  await shown;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 1, 'l\u2019offerta vera dipinge il suo riquadro');
  assert.ok(offerBoxes(mount)[0].textContent.includes('Pacchetto sede'), 'il riquadro nomina l\u2019offerta');
});
