// @ts-check

/**
 * Backlog 4cfa30c164ca — OWNER_ANSWER del supervisore (18/11 16:1xZ, prova
 * del Mac sul live bd3ed7f con agent-crm#1014): NON PASSA. Su un cliente
 * senza offerte (Ada Rossi) gli scheletri «OFFERTA» e «PROSSIMO
 * APPUNTAMENTO» compaiono e poi spariscono dopo 1-2,5 s, sempre, anche a
 * ricarica vera: #1014 non cambia niente a schermo perché lo scheletro
 * resta mentre il profilo carica.
 *
 * Repro del NON PASSA (VERIFIER_BACK, secondo ritorno): a prima visita, con
 * la card arrivata e il profilo ancora in volo, la scheda disegna lo
 * scheletro Offerta; con la cronologia arrivata e i servizi ancora in volo,
 * disegna lo scheletro Prossimo appuntamento. Entrambi spariscono a lettura
 * arrivata quando il cliente non ha né offerte né appuntamenti.
 *
 * Contratto della cura (dalla ANSWER): lo scheletro non si disegna finché
 * non si sa se c'è un'offerta / un appuntamento; si disegna solo se la
 * lettura precedente (stesso cliente) ne aveva una — mai a prima visita.
 * «Modifica» dei Dettagli resta a larghezza naturale come gli altri
 * pulsanti secondari, mai stirato a 269 px come il titolo.
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

const TIMELINE_WITH_APPT = {
  ...TIMELINE_EMPTY,
  appointments: {
    available: true,
    count: 1,
    truncated: false,
    items: [
      {
        id: 'a1', status: 'booked', serviceKey: 'pt-single', teamMemberId: 'coach-guido',
        startsAt: '2099-10-23T18:00:00.000Z', endsAt: '2099-10-23T19:00:00.000Z',
      },
    ],
  },
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

const PROFILE_WITH_OFFER = {
  ...PROFILE_EMPTY,
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'proposal', stage: 'proposal', name: 'Pacchetto sede' }],
  },
};

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/**
 * Card, cronologia, profilo, schema e listino trattenuti a cancelli
 * manuali: la strada del fantasma del supervisore.
 */
function deferredClient({ timeline = TIMELINE_EMPTY } = {}) {
  const gates = new Map();
  const gate = (name) => {
    if (!gates.has(name)) {
      let release;
      const promise = new Promise((resolve) => { release = { resolve }; });
      gates.set(name, { promise, release });
    }
    return gates.get(name);
  };
  const client = {
    gates,
    resetGate(name) { gates.delete(name); },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return { status: 'done', proposals: [] };
      if (path.startsWith('/api/customer-hub/card/')) return gate('card').promise;
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
  const answers = { timeline };
  const originalRequest = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if (path.startsWith('/api/customer-hub/timeline/') && (options?.method ?? 'GET') === 'GET') {
      await gate('timeline').promise;
      return answers.timeline;
    }
    return originalRequest(path, options);
  };
  return client;
}

const offerBoxes = (mount) => mount.findAll('section').filter((node) => (
  (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-card-offer')
));
const apptBoxes = (mount) => mount.findAll('section').filter((node) => (
  (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-card-appt')
));

test('4cfa30c164ca: prima visita Ada Rossi, profilo in volo: nessuno scheletro Offerta né Appuntamento', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(5);
  assert.ok(mount.textContent.includes('Ada Rossi'), 'il nome dipinge prima del profilo');
  assert.equal(offerBoxes(mount).length, 0, 'nessuno scheletro Offerta mentre il profilo è in volo (prima visita)');
  assert.equal(apptBoxes(mount).length, 0, 'nessuno scheletro Appuntamento mentre i servizi sono in volo (prima visita)');
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await shown;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 0, 'nessun riquadro Offerta per chi non ha offerte');
  assert.equal(apptBoxes(mount).length, 0, 'nessun riquadro Appuntamento per chi non ha appuntamenti');
});

test('4cfa30c164ca: con offerta e appuntamento futuri, i riquadri arrivano senza fantasma preliminare', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient({ timeline: TIMELINE_WITH_APPT });
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  await flush(5);
  assert.equal(offerBoxes(mount).length, 0, 'nessuna Offerta disegnata prima di sapere che esiste');
  assert.equal(apptBoxes(mount).length, 0, 'nessun Appuntamento disegnato prima di sapere che esiste');
  client.gates.get('timeline').release.resolve(TIMELINE_WITH_APPT);
  client.gates.get('profile').release.resolve(PROFILE_WITH_OFFER);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await shown;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 1, 'l’offerta vera dipinge il suo riquadro');
  assert.ok(offerBoxes(mount)[0].textContent.includes('Pacchetto sede'), 'il riquadro nomina l’offerta');
  assert.equal(apptBoxes(mount).length, 1, 'l’appuntamento vero dipinge il suo riquadro');
});

test('4cfa30c164ca: tornando sullo stesso cliente con offerta, il segnaposto resta mentre rilegge', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient({ timeline: TIMELINE_WITH_APPT });
  const view = createCustomerCardView({ doc, mount, client });
  const first = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_WITH_APPT);
  await flush(5);
  client.gates.get('profile').release.resolve(PROFILE_WITH_OFFER);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await first;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 1, 'al primo giro l’offerta c’è');
  // Torna sulla stessa scheda (il router pulisce il mount): la lettura
  // precedente aveva offerta e appuntamento, quindi il segnaposto resta.
  view.invalidate();
  for (const name of ['card', 'timeline', 'profile', 'schema', 'services']) client.resetGate(name);
  const second = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  await flush(5);
  assert.equal(offerBoxes(mount).length, 1, 'il segnaposto Offerta resta perché la lettura precedente ne aveva una');
  assert.ok(offerBoxes(mount)[0].getAttribute('data-loading') === 'true', 'il segnaposto è uno scheletro, non un riquadro');
  assert.equal(apptBoxes(mount).length, 1, 'il segnaposto Appuntamento resta perché la lettura precedente ne aveva uno');
  client.gates.get('timeline').release.resolve(TIMELINE_WITH_APPT);
  client.gates.get('profile').release.resolve(PROFILE_WITH_OFFER);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await second;
  await flush(3);
  assert.ok(offerBoxes(mount)[0].textContent.includes('Pacchetto sede'), 'a rilettura finita l’offerta c’è ancora');
});

test('4cfa30c164ca: tornando su Ada Rossi senza offerte, nessun fantasma mentre rilegge', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const first = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(5);
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await first;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 0, 'al primo giro nessuna Offerta');
  view.invalidate();
  for (const name of ['card', 'timeline', 'profile', 'schema', 'services']) client.resetGate(name);
  const second = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(5);
  assert.equal(offerBoxes(mount).length, 0, 'nessun fantasma Offerta: la lettura precedente non ne aveva');
  assert.equal(apptBoxes(mount).length, 0, 'nessun fantasma Appuntamento: la lettura precedente non ne aveva');
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await second;
  await flush(3);
  assert.equal(offerBoxes(mount).length, 0, 'a rilettura finita nessuna Offerta');
  assert.equal(apptBoxes(mount).length, 0, 'a rilettura finita nessun Appuntamento');
});

test('4cfa30c164ca: il «Modifica» dei Dettagli resta a larghezza naturale come gli altri pulsanti', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = deferredClient();
  const view = createCustomerCardView({ doc, mount, client });
  const shown = view.renderCard('contact', 'c-ada');
  await flush(3);
  client.gates.get('card').release.resolve(CARD);
  client.gates.get('timeline').release.resolve(TIMELINE_EMPTY);
  await flush(5);
  client.gates.get('profile').release.resolve(PROFILE_EMPTY);
  client.gates.get('schema').release.resolve({ pipelines: [] });
  client.gates.get('services').release.resolve({ services: [] });
  await shown;
  await flush(3);
  const edit = mount.findAll('button')
    .find((node) => node.getAttribute('data-action') === 'edit-details');
  assert.ok(edit, 'il pulsante «Modifica» dei Dettagli esiste');
  assert.ok(
    (edit.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-details-edit'),
    'il «Modifica» porta la classe che lo tiene a larghezza naturale, mai stirato come il titolo',
  );
});
