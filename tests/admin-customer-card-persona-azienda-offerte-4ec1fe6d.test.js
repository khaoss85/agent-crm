// @ts-check

/**
 * Backlog 4ec1fe6d (verifica Mac 13/11 17:49Z, voce tornata dal verificatore
 * il 17/11: OBSERVATION_FAILED AC-4 — «la scheda di un contatto non mostra
 * né collega l'offerta della sua azienda»).
 *
 * Repro del NON PASSA: un contatto senza offerte proprie ma con azienda
 * collegata (profilo 1e89d516cfc5: le righe dell'azienda sono strette fuori
 * dalla scheda persona, così tre contatti della stessa azienda non leggono
 * la stessa riga) dipingeva nessun riquadro Offerta: l'offerta dell'azienda
 * non si vedeva e nessun link la collegava. Rosso sul codice di prima
 * (0 riquadri Offerta), verde dopo (1 riquadro con il link alla scheda
 * dell'azienda, dove le offerte si aprono con il loro link). Restringe del
 * merge 19/11 contro 4cfa30c164ca: il link si dipinge solo se l'azienda HA
 * offerte (lettura del profilo azienda); su azienda senza offerte il
 * riquadro resta nascosto, come Ada Rossi senza fantasmi.
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

const PROFILE_NO_OWN_OFFERS = {
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
    company: { id: 'co-presti', name: 'Presti Group', domain: null, placeholder: false },
    contact: { id: 'c-ada', email: 'ada@presti.example', firstName: 'Ada', lastName: 'Rossi', companyId: 'co-presti' },
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

const COMPANY_PROFILE_WITH_OFFER = {
  customerProfileContract: 1,
  subject: { resource: 'company', id: 'co-presti' },
  identity: {
    company: { id: 'co-presti', name: 'Presti Group', domain: null, placeholder: false },
    contact: null,
  },
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'proposal', stage: 'proposal', name: 'Pacchetto sede' }],
  },
  quotes: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
};

const COMPANY_PROFILE_EMPTY = {
  ...COMPANY_PROFILE_WITH_OFFER,
  opportunities: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
};

/** Tutte le letture rispondono subito: la strada del NON PASSA. */
function directClient({ card, timeline, profile, companyProfile = profile }) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if ((options?.method ?? 'GET') !== 'GET') return {};
      if (path.startsWith('/api/customer-hub/card/')) return card;
      if (path.startsWith('/api/customer-hub/timeline/')) return timeline;
      if (path.startsWith('/api/customer-data/profile/company/')) return companyProfile;
      if (path.startsWith('/api/customer-data/profile/')) return profile;
      if (path === '/api/schema') return { pipelines: [] };
      if (path.startsWith('/api/customer-data/enriched/')) {
        return {
          customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c-ada' },
          linked: false, optedOut: null, items: [],
        };
      }
      if (path.startsWith('/api/customer-data/fields')) return path.includes('/values') ? { values: [] } : { definitions: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/spine/context') return { actor: { id: 'u-me' } };
      if (path.startsWith('/api/call-intelligence/calls/')) return { items: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

const offerBoxes = (mount) => mount.findAll('section').filter((node) => (
  (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-card-offer')
));

test('4ec1fe6d: contatto senza offerte proprie ma con azienda CHE HA offerte, la scheda collega le offerte azienda', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc,
    mount,
    client: directClient({
      card: CARD, timeline: TIMELINE, profile: PROFILE_NO_OWN_OFFERS, companyProfile: COMPANY_PROFILE_WITH_OFFER,
    }),
  });
  await view.renderCard('contact', 'c-ada');
  await flush();
  assert.equal(offerBoxes(mount).length, 1, 'un riquadro Offerta anche senza offerte proprie');
  const box = offerBoxes(mount)[0];
  assert.ok(box.textContent.includes('Presti Group'), 'il riquadro nomina l’azienda collegata');
  const links = box.findAll('a');
  assert.equal(links.length, 1, 'un solo link verso le offerte azienda');
  assert.equal(
    links[0].getAttribute('href'),
    '#/customer-card/company/co-presti',
    'il link apre la scheda dell’azienda, dove le offerte si aprono con il loro link',
  );
  assert.ok(links[0].textContent.includes('Presti Group'), 'il link dice di quale azienda sono le offerte');
});

test('4ec1fe6d: contatto con azienda SENZA offerte, nessun riquadro Offerta (compatibile 4cfa30c164ca)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc,
    mount,
    client: directClient({
      card: CARD, timeline: TIMELINE, profile: PROFILE_NO_OWN_OFFERS, companyProfile: COMPANY_PROFILE_EMPTY,
    }),
  });
  await view.renderCard('contact', 'c-ada');
  await flush();
  assert.equal(offerBoxes(mount).length, 0, 'nessun riquadro Offerta se l’azienda non ha offerte (niente fantasmi)');
});

test('4ec1fe6d: contatto senza azienda collegata, nessun riquadro Offerta (come prima)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({
    doc,
    mount,
    client: directClient({
      card: { ...CARD, company: null },
      timeline: TIMELINE,
      profile: {
        ...PROFILE_NO_OWN_OFFERS,
        identity: {
          company: null,
          contact: { id: 'c-ada', email: 'ada@presti.example', firstName: 'Ada', lastName: 'Rossi', companyId: null },
        },
      },
    }),
  });
  await view.renderCard('contact', 'c-ada');
  await flush();
  assert.equal(offerBoxes(mount).length, 0, 'nessun riquadro Offerta senza azienda collegata');
});

test('4ec1fe6d: scheda azienda senza offerte, nessun auto-collegamento (come prima)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const companyCard = { ...CARD, subject: { resource: 'company', id: 'co-presti' }, name: 'Presti Group' };
  const companyTimeline = { ...TIMELINE, subject: { resource: 'company', id: 'co-presti' } };
  const companyProfile = {
    ...PROFILE_NO_OWN_OFFERS,
    subject: { resource: 'company', id: 'co-presti' },
    identity: {
      company: { id: 'co-presti', name: 'Presti Group', domain: null, placeholder: false },
      contact: null,
    },
  };
  const view = createCustomerCardView({
    doc, mount, client: directClient({ card: companyCard, timeline: companyTimeline, profile: companyProfile }),
  });
  await view.renderCard('company', 'co-presti');
  await flush();
  assert.equal(offerBoxes(mount).length, 0, 'la scheda azienda non si auto-collega');
});
