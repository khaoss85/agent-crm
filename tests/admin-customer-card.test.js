import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The customer scheda (BO-F1-06): three columns over the hub projection.
 *
 * What it must prove: the view reads the card, the timeline and the profile
 * and renders quick actions, linked identities WITH the human motivation
 * from read-customer-profile, details, an honest AI-enriched section, the
 * channel timeline with direction and sync state per passage, and the right
 * column (AI summary, next steps, offer, next appointment). A hub the
 * server does not compose renders an honest error, never a blank page.
 * Hostile server text stays text.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+39 333 1234567', system: 'whatsapp', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [{ system: 'instagram', handle: 'guido.presti' }],
  status: { value: 'contatto', reason: 'no signed business in the composed packages' },
  activePackage: {
    available: true, count: 1, countIsComplete: true, countNote: null, truncated: false,
    active: [{ id: 'sub1', name: '10 ingressi', status: 'active' }],
    items: [{ id: 'sub1', name: '10 ingressi', status: 'active' }],
    reason: null,
  },
  notes: { available: false, items: null, reason: 'this application composes no notes record' },
  history: { available: false, items: [], count: 0, truncated: false, completeTimeline: false, reason: 'no history' },
};

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 2, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
  entries: {
    available: true,
    count: 4,
    truncated: false,
    items: [
      {
        entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
        sync: 'received', body: 'Ciao, vorrei prenotare una prova', teamAuthorId: null,
        remoteHandle: '+39 333 1234567', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
      },
      {
        entry: 'message', id: 'm2', conversationId: 't1', channel: 'whatsapp', direction: 'outbound',
        sync: 'delivered', body: 'Certo, ti propongo giovedi alle 18', teamAuthorId: 'elena',
        remoteHandle: '+39 333 1234567', errorCode: null, occurredAt: '2026-10-20T09:05:00.000Z',
      },
      {
        entry: 'message', id: 'm3', conversationId: 't2', channel: 'instagram', direction: 'inbound',
        sync: 'received', body: 'Quanto costa il pacchetto?', teamAuthorId: null,
        remoteHandle: 'guido.presti', errorCode: null, occurredAt: '2026-10-20T11:00:00.000Z',
      },
      {
        entry: 'call', id: 'c9', conversationId: null, channel: 'phone', direction: 'outbound',
        sync: 'completed', durationSec: 372, teamAuthorId: 'marco',
        remoteHandle: '+39 333 1234567', errorCode: null, occurredAt: '2026-10-20T12:00:00.000Z',
      },
    ],
  },
  appointments: {
    available: true,
    count: 1,
    truncated: false,
    items: [{
      id: 'b1', status: 'booked', startsAt: '2026-10-23T16:00:00.000Z', endsAt: '2026-10-23T17:00:00.000Z',
      serviceKey: 'pt-single', teamMemberId: 'coach-guido', priceCents: 4000, currency: 'EUR', notes: null,
    }],
  },
  contactPoints: { available: true, count: 3, items: [] },
  timelineNote: 'Accordo-managed threads and bookings only.',
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: {
    linked: true,
    clusterKey: 'k1',
    canonical: { resource: 'contact', id: 'c1', role: 'canonical' },
    members: [
      {
        resource: 'contact', id: 'c1', role: 'canonical',
        decisionId: 'd1', decidedAt: '2026-10-19T10:00:00.000Z',
        reason: 'stesso numero su WhatsApp e Instagram', decidedBy: { type: 'user', id: 'elena' },
      },
      {
        resource: 'contact', id: 'c2', role: 'alias',
        decisionId: 'd1', decidedAt: '2026-10-19T10:00:00.000Z',
        reason: 'stesso numero su WhatsApp e Instagram', decidedBy: { type: 'user', id: 'elena' },
      },
    ],
    note: 'every record below still exists and was never rewritten',
  },
  identity: { company: { id: 'co1', name: 'Palestra Esempio' }, contact: { id: 'c1', email: 'guido@palestra-esempio.it' } },
  externalIdentities: [],
  opportunities: { available: true, count: 1, countIsComplete: true, items: [{ id: 'o1', status: 'open', name: 'Pacchetto 10 ingressi' }], truncated: false },
  quotes: { available: true, count: 1, countIsComplete: true, items: [{ id: 'q1', status: 'sent', name: 'Preventivo 10 ingressi' }], truncated: false },
  orders: { available: false, reason: 'not composed', items: null, count: null },
  contracts: { available: false, reason: 'not composed', items: null, count: null },
  subscriptions: { available: false, reason: 'not composed', items: null, count: null },
  deliveryProjects: { available: false, reason: 'not composed', items: null, count: null },
  serviceCoverages: { available: false, reason: 'not composed', items: null, count: null },
  supportCases: { available: false, reason: 'not composed', items: null, count: null },
  workTasks: {
    available: true, count: 2, countIsComplete: true,
    items: [
      { id: 'w1', status: 'open', name: 'Richiamare per la prova' },
      { id: 'w2', status: 'done', name: 'Inviare il listino' },
    ],
    truncated: false,
  },
  successions: { available: false, reason: 'not composed', items: null, count: null },
  dataQualityIssues: [],
  duplicateCandidates: [],
  completeTimeline: false,
  timelineNote: 'This profile spans Accordo-managed records only.',
  limitations: [],
};

function stubClient({ card = CARD, timeline = TIMELINE, profile = PROFILE, failHub = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(path) {
      calls.push(path);
      if (path.startsWith('/api/customer-hub/')) {
        if (failHub) throw Object.assign(new Error('Not Found'), { status: 404 });
        if (path.includes('/card/')) return card;
        return timeline;
      }
      if (path.startsWith('/api/customer-data/profile/')) {
        if (!profile) throw Object.assign(new Error('no profile'), { status: 404 });
        return profile;
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

const renderCard = async (client) => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');
  return mount;
};

test('the scheda renders three columns: actions, identities with motivation, timeline and next steps', async () => {
  const mount = await renderCard(stubClient());
  const text = mount.textContent;

  // Left: quick actions are real links, identities carry their motivation.
  const links = mount.findAll('a');
  const call = links.find((node) => node.getAttribute('data-action') === 'call-customer');
  assert.ok(call, 'a Chiama action exists');
  assert.equal(call.getAttribute('href'), 'tel:+393331234567');
  const mail = links.find((node) => node.getAttribute('data-action') === 'mail-customer');
  assert.equal(mail.getAttribute('href'), 'mailto:guido@palestra-esempio.it');

  assert.ok(text.includes('stesso numero su WhatsApp e Instagram'), 'the link motivation is shown');
  assert.ok(text.includes('elena'), 'the decider is shown');
  assert.ok(text.includes("Arricchito dall'AI"), 'the enriched section exists');
  assert.ok(text.includes('fonte'), 'the enriched section names its source rule');

  // The grid holds exactly three columns.
  const grid = mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-grid');
  assert.ok(grid, 'the three-column grid exists');
  assert.equal(grid.findAll('div').filter((node) => node.getAttribute('class') === 'bo-scheda-col').length, 3);

  // Center: every passage with channel, direction and sync state.
  assert.ok(text.includes('WhatsApp'), 'channel label');
  assert.ok(text.includes('inviato da elena'), 'outbound direction with author');
  assert.ok(text.includes('da +39 333 1234567'), 'inbound direction with peer');
  assert.ok(text.includes('consegnato'), 'message delivery state');
  assert.ok(text.includes('completata'), 'call outcome');

  // Right: next steps skip done tasks, offer and appointment come from real rows.
  assert.ok(text.includes('Richiamare per la prova'), 'the open task is a next step');
  assert.ok(!text.includes('Inviare il listino'), 'a done task is not a next step');
  assert.ok(text.includes('Preventivo 10 ingressi'), 'the offer is shown');
  assert.ok(text.includes('coach-guido'), 'the next appointment names its owner');
});

test('the channel filter narrows the timeline to one channel', async () => {
  const client = stubClient();
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');

  const chips = mount.findAll('button');
  assert.ok(chips.some((node) => node.textContent === 'Tutti'), 'a Tutti chip exists');
  assert.ok(chips.some((node) => node.textContent === 'Instagram'), 'one chip per channel');
  const instagram = chips.find((node) => node.getAttribute('data-channel') === 'instagram');
  instagram.dispatch('click');

  const text = mount.textContent;
  assert.ok(text.includes('Quanto costa il pacchetto?'), 'the Instagram passage stays');
  assert.ok(!text.includes('vorrei prenotare una prova'), 'the WhatsApp passage is filtered out');
});

test('a hub the server does not compose renders an honest error, never blank', async () => {
  const mount = await renderCard(stubClient({ failHub: true }));
  assert.ok(mount.textContent.includes('Scheda non disponibile'));
});

test('hostile server text renders as text, never as markup', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const mount = await renderCard(stubClient({
    card: { ...CARD, name: nasty },
    timeline: {
      ...TIMELINE,
      entries: {
        ...TIMELINE.entries,
        items: [{ ...TIMELINE.entries.items[0], body: nasty }],
      },
    },
  }));
  assert.ok(mount.textContent.includes(nasty), 'the value is shown as text');
  assert.deepEqual(mount.findAll('img'), [], 'and no element was created from it');
  assert.deepEqual(mount.findAll('script'), []);
});
