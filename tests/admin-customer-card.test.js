import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createCustomerCardView,
  detailsRefusalText,
  failedSendReason,
  mergeLinkedIdentities,
  observedDirections,
  offerStageTargets,
  OPPORTUNITY_ALLOWED_TRANSITIONS as CARD_TRANSITIONS,
  NO_COMPANY_NAME,
  shownCompanyName,
  offerStageMenu,
  shownOfferState,
  teamName,
} from '../apps/admin/public/admin-customer-card.js';
import { offerStageLabel } from '../apps/admin/public/admin-labels.js';
import { accordoSalesPipeline } from '../packages/pipelines/accordo-sales.js';
import { OPPORTUNITY_ALLOWED_TRANSITIONS as SERVICE_TRANSITIONS } from '../packages/modules/opportunity/src/opportunity-service.js';
import { OPPORTUNITY_STAGES } from '../packages/core/src/schema.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
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
  headline: {
    city: { available: false, value: null, reason: 'no city on record' },
    origin: { available: true, system: 'whatsapp', firstObservedAt: '2026-10-19T10:00:00.000Z', reason: null },
    assignee: { available: false, value: null, reason: 'no referente on record' },
  },
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
      // Far-future on purpose: the view shows the next *upcoming* booking, so
      // the fixture booking must stay upcoming whatever day the test runs.
      id: 'b1', status: 'booked', startsAt: '2099-10-23T16:00:00.000Z', endsAt: '2099-10-23T17:00:00.000Z',
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
  externalIdentities: [
    {
      system: 'whatsapp', externalId: '+39 333 1234567',
      subject: { resource: 'contact', id: 'c1' },
      firstObservedAt: '2026-10-19T08:00:00.000Z', lastObservedAt: '2026-10-20T09:00:00.000Z',
    },
    {
      system: 'instagram', externalId: 'guido.presti',
      subject: { resource: 'contact', id: 'c2' },
      firstObservedAt: '2026-10-19T10:00:00.000Z', lastObservedAt: '2026-10-20T11:00:00.000Z',
    },
  ],
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

const ENRICHED = {
  customerEnrichmentContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  linked: false,
  optedOut: null,
  items: [],
};

const CALLS = {
  calls: [
    {
      callRef: 'call-1', channel: 'phone', noticedAt: '2026-10-20T11:55:00.000Z',
      recordedAt: '2026-10-20T12:00:00.000Z', expiresAt: '2027-10-20T12:00:00.000Z',
      summary: 'Cliente con budget 800 euro, inizio a gennaio.',
      summarized: true, purgedAt: null,
      signals: [
        { type: 'budget', excerpt: 'il budget massimo è 800 euro', transcriptRef: 'call-transcript:call-a:call-1' },
        { type: 'timing', excerpt: 'vorrei iniziare a gennaio', transcriptRef: 'call-transcript:call-a:call-1' },
      ],
      transcript: { available: true, text: 'Operatrice: buongiorno.\nCliente: il budget massimo è 800 euro.' },
    },
  ],
};

function stubClient({ card = CARD, timeline = TIMELINE, profile = PROFILE, enriched = ENRICHED, failHub = false, cardError = null, timelineError = null, profileError = null, calls = null, failCalls = false, callsError = null, enrichedError = null, fieldDefs = [], fieldValues = [], onRequest = null, schema = null, audit = [], auditError = null } = {}) {
  const requested = [];
  const writes = [];
  const client = {
    calls: requested,
    writes,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      let body = options?.body ?? {};
      if (typeof body === 'string') {
        try { body = body === '' ? {} : JSON.parse(body); } catch { /* keep raw */ }
      }
      requested.push(path);
      if ((options?.method ?? 'GET') !== 'GET') writes.push({ path, method: options.method, body });
      if (onRequest) return onRequest(path, body, options);
      if (path === '/api/schema' && schema) return schema;
      if (path === '/api/customer-data/fields') return { definitions: fieldDefs };
      if (path.startsWith('/api/customer-data/fields/values')) return { values: fieldValues };
      if (path.startsWith('/api/customer-hub/')) {
        if (failHub) throw Object.assign(new Error('Not Found'), { status: 404 });
        if (path.includes('/card/')) {
          if (cardError) throw cardError;
          return card;
        }
        if (timelineError) throw timelineError;
        return timeline;
      }
      if (path.startsWith('/api/customer-data/profile/')) {
        if (profileError) throw profileError;
        if (!profile) throw Object.assign(new Error('no profile'), { status: 404 });
        return profile;
      }
      if (path.startsWith('/api/customer-data/enriched/')) {
        if (enrichedError) throw enrichedError;
        if (!enriched) throw Object.assign(new Error('Not Found'), { status: 404 });
        return enriched;
      }
      if (path.startsWith('/api/call-intelligence/calls/')) {
        if (failCalls) throw Object.assign(new Error('Not Found'), { status: 404 });
        if (callsError) throw callsError;
        return calls;
      }
      if (path.startsWith('/api/audit')) {
        if (auditError) throw auditError;
        return { items: audit };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  return client;
}

const renderCard = async (client, spaceId = undefined, toast = undefined) => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, spaceId, toast }).renderCard('contact', 'c1');
  return mount;
};

test('the scheda renders three columns: actions, identities with motivation, timeline and next steps', async () => {
  const mount = await renderCard(stubClient());
  const text = mount.textContent;

  // Left: quick actions are a voice-aware Chiama button (the tel: fallback
  // appears only after the voice check names no connector, voce 105563eea902)
  // and the Scrivi composer button — no mailto: anywhere (backlog:e9b4fc2f).
  // Identities carry their motivation.
  const links = mount.findAll('a');
  const call = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'call-customer');
  assert.ok(call, 'a Chiama action exists');
  assert.equal(call.textContent, 'Chiama');
  assert.ok(!links.some((node) => String(node.getAttribute('href') ?? '').startsWith('tel:')),
    'no device-dial link before the voice check');
  assert.ok(links.every((node) => !String(node.getAttribute('href') ?? '').startsWith('mailto:')),
    'no mailto: link in the quick actions');
  const write = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message');
  assert.ok(write, 'a Scrivi action opens the composer');
  assert.equal(write.textContent, 'Scrivi');

  assert.ok(text.includes('stesso numero su WhatsApp e Instagram'), 'the link motivation is shown');
  assert.ok(text.includes('elena'), 'the decider is shown');
  assert.ok(text.includes("Arricchito dall'AI"), 'the enriched section exists');
  assert.ok(text.includes('Nessun dato arricchito ancora'), 'the empty enriched section stays honest');

  // The grid holds exactly three columns.
  const grid = mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-grid');
  assert.ok(grid, 'the three-column grid exists');
  const cols = grid.findAll('div').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-col'));
  assert.equal(cols.length, 3);
  assert.deepEqual(cols.map((node) => node.getAttribute('class')),
    ['bo-scheda-col bo-scheda-col-side', 'bo-scheda-col bo-scheda-col-main', 'bo-scheda-col bo-scheda-col-side'],
    'the side columns stay put while the conversation scrolls (Dan 06/11)');

  // Center: every passage with channel, direction and sync state.
  assert.ok(text.includes('WhatsApp'), 'channel label');
  assert.ok(text.includes('WhatsApp · Elena'), 'outbound passage names its writer');
  assert.ok(text.includes('WhatsApp · +39 333 1234567'), 'inbound passage names its peer');
  assert.ok(text.includes('consegnato'), 'message delivery state');
  assert.ok(text.includes('completata'), 'call outcome');

  // Right: next steps skip done tasks, offer and appointment come from real rows.
  assert.ok(text.includes('Richiamare per la prova'), 'the open task is a next step');
  assert.ok(!text.includes('Inviare il listino'), 'a done task is not a next step');
  assert.ok(text.includes('Preventivo 10 ingressi'), 'the offer is shown');
  assert.ok(text.includes('23 ott'), 'the next appointment reads as a plain Italian date');
  assert.ok(text.includes('18:00–19:00'), 'the slot shows its readable time range, no ISO instant');
});

test('BO-F6-09 fetta 2a: the header shows back, avatar initials, H1 name and the stato pill', async () => {
  let navigated = null;
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc,
    mount,
    client: stubClient(),
    navigate: (hash) => { navigated = hash; },
  }).renderCard('contact', 'c1');

  const back = mount.findAll('button').find((node) => node.textContent === '← Clienti');
  assert.ok(back, 'the back button keeps its exact text');
  assert.ok(
    String(back.getAttribute('class') ?? '').split(/\s+/).some((cls) => cls === 'ui' || cls.startsWith('ui-')),
    'the back button carries the visual system',
  );
  back.dispatch('click');
  assert.equal(navigated, '#/customer-data', 'back returns to the clienti list');

  const avatar = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-avatar');
  assert.ok(avatar, 'the avatar circle exists');
  assert.equal(avatar.textContent, 'GP', 'the initials come from the card name');

  const title = mount.findAll('h1').find((node) => node.getAttribute('class') === 'bo-scheda-name');
  assert.ok(title, 'the customer name is an H1');
  assert.equal(title.textContent, 'Guido Presti', 'the H1 names the customer');

  const badge = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-badge');
  assert.ok(badge, 'the stato pill exists');
  assert.equal(badge.textContent, 'Contatto', 'the pill shows the card stato in Italian, not a lowercase code');
});

test('BO-F6-09 fetta 2a: a hostile name stays text in the H1 and the avatar', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const mount = await renderCard(stubClient({ card: { ...CARD, name: nasty } }));
  assert.ok(mount.textContent.includes(nasty), 'the hostile name is shown as text');
  assert.deepEqual(mount.findAll('img'), [], 'and no element was created from it');
  const avatar = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-avatar');
  assert.ok(avatar, 'the avatar still renders');
  assert.ok(!String(avatar.textContent).includes('<'), 'the initials carry no markup');
});

test('BO-F6-09 fetta C3 (backlog:f84626a0): the header shows only the segments a record holds', async () => {
  const mount = await renderCard(stubClient());
  const sub = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-sub');
  assert.ok(sub, 'the meta line exists under the H1 next to the stato pill');
  assert.equal(sub.textContent, 'via WhatsApp',
    'the origin reads as the prototype (via <canale>); the missing city and referente are left out');
  assert.ok(!sub.textContent.includes('Da raccogliere'), 'no placeholder in the header');
});

test('BO-F6-09 fetta C3: with city, origin and referente the line reads as the prototype', async () => {
  const mount = await renderCard(stubClient({
    card: {
      ...CARD,
      headline: {
        city: { available: true, value: 'Milano', reason: null },
        origin: { available: true, system: 'instagram', firstObservedAt: '2026-10-19T10:00:00.000Z', reason: null },
        assignee: { available: true, value: 'Marco', reason: null },
      },
    },
  }));
  const sub = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-sub');
  assert.equal(sub.textContent, 'Milano · via Instagram · la segue Marco');
});

test('BO-F6-09 fetta C3: an unknown origin channel is left out, never the raw key', async () => {
  const mount = await renderCard(stubClient({
    card: {
      ...CARD,
      headline: {
        city: { available: false, value: null, reason: 'no city on record' },
        origin: { available: true, system: 'pigeon-post', firstObservedAt: '2026-10-19T10:00:00.000Z', reason: null },
        assignee: { available: false, value: null, reason: 'no referente on record' },
      },
    },
  }));
  const sub = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-sub');
  assert.ok(sub, 'the meta line exists');
  assert.ok(!sub.textContent.includes('pigeon-post'), 'no raw channel key on screen');
  assert.equal(sub.textContent, 'Palestra Esempio', 'nothing known: the line keeps the company');
});

test('BO-F6-09 fetta C3: a prototype-named origin is left out, never Object source', async () => {
  for (const system of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const mount = await renderCard(stubClient({
      card: {
        ...CARD,
        headline: {
          city: { available: false, value: null, reason: 'no city on record' },
          origin: { available: true, system, firstObservedAt: '2026-10-19T10:00:00.000Z', reason: null },
          assignee: { available: false, value: null, reason: 'no referente on record' },
        },
      },
    }));
    const sub = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-sub');
    assert.ok(sub, `the meta line exists for system ${system}`);
    assert.equal(sub.textContent, 'Palestra Esempio',
      `a prototype-named origin (${system}) falls back to the company, never Object.prototype`);
    assert.ok(!sub.textContent.includes('function'), 'no function source on screen');
  }
});

test('BO-F6-09: every control on the scheda carries the visual system', async () => {
  const mount = await renderCard(stubClient());
  const raw = [];
  const walk = (node) => {
    const tag = String(node.tagName ?? '').toLowerCase();
    if (tag === 'button' || tag === 'select' || tag === 'input' || tag === 'textarea') {
      const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) {
        raw.push(`${tag}[${classes.join('.')}]`);
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(mount);
  assert.deepEqual(raw, [], 'no button/select/input/textarea on the scheda renders without a ui-* class');
});

test('the next appointment skips cancelled, past and done bookings', async () => {
  const row = (overrides) => ({
    serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR', notes: null, endsAt: null,
    ...overrides,
  });
  const mount = await renderCard(stubClient({
    timeline: {
      ...TIMELINE,
      appointments: {
        available: true,
        count: 4,
        truncated: false,
        // Soonest-first, like readSchedule: a cancelled past slot, a done
        // past slot and a past booked slot all sort before the real booking.
        items: [
          row({ id: 'b0', status: 'cancelled', startsAt: '2000-01-01T10:00:00.000Z', teamMemberId: 'coach-old' }),
          row({ id: 'b1', status: 'done', startsAt: '2000-02-01T10:00:00.000Z', teamMemberId: 'coach-old' }),
          row({ id: 'b2', status: 'booked', startsAt: '2000-03-01T10:00:00.000Z', teamMemberId: 'coach-old' }),
          row({ id: 'b3', status: 'booked', startsAt: '2099-10-23T16:00:00.000Z', endsAt: '2099-10-23T17:00:00.000Z', teamMemberId: 'coach-guido' }),
        ],
      },
    },
  }));
  const text = mount.textContent;
  assert.ok(text.includes('23 ott'), 'the future booked slot is the next appointment, as a readable date');
  assert.ok(text.includes('18:00–19:00'), 'the readable slot shows its time range');
  assert.ok(!text.includes('coach-old'), 'no cancelled, done or past slot is ever labelled next');
  assert.ok(!text.includes('coach-guido'), 'the slot never prints the internal member id');
});

test('with no upcoming booking the scheda says none is booked', async () => {
  const mount = await renderCard(stubClient({
    timeline: {
      ...TIMELINE,
      appointments: {
        available: true,
        count: 1,
        truncated: false,
        items: [
          {
            id: 'b0', status: 'cancelled', startsAt: '2000-01-01T10:00:00.000Z', endsAt: '2000-01-01T11:00:00.000Z',
            serviceKey: 'pt-single', teamMemberId: 'coach-old', priceCents: 4000, currency: 'EUR', notes: null,
          },
        ],
      },
    },
  }));
  assert.ok(mount.textContent.includes('nessun appuntamento prenotato'), 'a terminal-only schedule reads as none booked');
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

test('voce 908f2eb9bbfb: with the profile in error the scheda keeps name, timeline and other sections, with the error on every profile section', async () => {
  const failure = Object.assign(new Error('PostgreSQL storage is unavailable'), { status: 503 });
  const mount = await renderCard(stubClient({ profileError: failure }));
  const text = mount.textContent;
  // No whole-card failure: the name, the timeline and the other sections stay.
  assert.ok(!text.includes('Scheda non disponibile'), 'the card does not fail as a whole');
  assert.ok(text.includes('Guido Presti'), 'the name still shows');
  assert.ok(text.includes('vorrei prenotare una prova'), 'the cronologia still shows');
  assert.ok(text.includes('Tutti i contatti'), 'the timeline section stays');
  // Every profile-fed section names the failure in plain Italian, never a raw
  // status: a failed read must never hide as "no offer / no next steps".
  assert.ok(text.includes('Dettagli'), 'the Dettagli section stays');
  assert.ok(text.includes('I dettagli non si sono potuti leggere. Riprova più tardi.'), 'Dettagli names the failure');
  assert.ok(text.includes('Identità collegate'), 'the identities section stays');
  assert.ok(text.includes('Le identità non si sono potute leggere. Riprova più tardi.'), 'the identities name the failure');
  assert.ok(text.includes('Offerta'), 'the offer section stays');
  assert.ok(text.includes("L'offerta non si è potuta leggere. Riprova più tardi."), 'the offer names the failure instead of hiding as none');
  assert.ok(text.includes('Prossimi passi'), 'the next-steps section stays');
  assert.ok(text.includes('I prossimi passi non si sono potuti leggere. Riprova più tardi.'), 'the next steps name the failure instead of hiding as none');
  assert.ok(!text.includes('503'), 'no raw status on screen');
});

test('voce 908f2eb9bbfb, review round 2: with the timeline in error the next appointment names the failure too', async () => {
  const failure = Object.assign(new Error('PostgreSQL storage is unavailable'), { status: 503 });
  const mount = await renderCard(stubClient({ timelineError: failure }));
  const text = mount.textContent;
  assert.ok(!text.includes('Scheda non disponibile'), 'the card does not fail as a whole');
  assert.ok(text.includes('La cronologia non si è potuta leggere. Riprova più tardi.'), 'the cronologia names the failure');
  assert.ok(text.includes('Prossimo appuntamento'), 'the next-appointment section stays');
  assert.ok(text.includes('Il prossimo appuntamento non si è potuto leggere. Riprova più tardi.'), 'the next appointment names the failure instead of hiding as none');
  assert.ok(!text.includes('503'), 'no raw status on screen');
});

test('voce 908f2eb9bbfb, review round 2: with the calls in error the Chiamate card names the failure too', async () => {
  const failure = Object.assign(new Error('boom'), { status: 500 });
  const mount = await renderCard(stubClient({ callsError: failure }), 'call-x');
  const text = mount.textContent;
  assert.ok(!text.includes('Scheda non disponibile'), 'the card does not fail as a whole');
  assert.ok(text.includes('Il riepilogo non si è potuto leggere. Riprova più tardi.'), 'the AI summary names the failure');
  assert.ok(text.includes('Chiamate'), 'the calls section stays');
  assert.ok(text.includes('Le chiamate non si sono potute leggere. Riprova più tardi.'), 'the calls name the failure instead of dropping the card');
});

test('voce 908f2eb9bbfb, review round 2: a 404 timeline or profile is not-composed, never a retry error', async () => {
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  const mount = await renderCard(stubClient({ timelineError: notFound, profileError: notFound }));
  const text = mount.textContent;
  assert.ok(!text.includes('Scheda non disponibile'), 'the card does not fail as a whole');
  assert.ok(!text.includes('Riprova più tardi'), 'a 404 never invites a retry that cannot succeed');
  assert.ok(text.includes('Guido Presti'), 'the name still shows');
});

test('voce 908f2eb9bbfb, review round 2: a synchronously-throwing read fails the card, never blanks it', async () => {
  const syncThrow = {
    request(path = '', options = {}) {
      enforceAdminWriteGate(path, options);
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
  };
  const mount = await renderCard(syncThrow);
  const text = mount.textContent;
  assert.ok(text.includes('Scheda non disponibile'), 'the whole-card error panel shows');
  assert.ok(text.includes('La scheda non si è potuta leggere. Riprova più tardi.'), 'the panel names the failure in Italian');
});

test('voce 908f2eb9bbfb: with the timeline in error the scheda keeps the card and names the failure on the cronologia', async () => {
  const failure = Object.assign(new Error('PostgreSQL storage is unavailable'), { status: 503 });
  const mount = await renderCard(stubClient({ timelineError: failure }));
  const text = mount.textContent;
  assert.ok(!text.includes('Scheda non disponibile'), 'the card does not fail as a whole');
  assert.ok(text.includes('Guido Presti'), 'the name still shows');
  assert.ok(text.includes('Tutti i contatti'), 'the timeline section stays');
  assert.ok(text.includes('La cronologia non si è potuta leggere. Riprova più tardi.'), 'the cronologia names the failure');
});

test('826e377c review giro-6: with the timeline in error the identities name the failure, never zero channels', async () => {
  // The review on head f1ed030c (P1): linkedIdentities merged null on a
  // timeline failure (zero rows), so the zero-row branch printed
  // 'nessun canale osservato' beside the failure notice — a failed read
  // claiming knowledge of zero channels. The section now names the failure
  // and stops: no count, no empty claim, no rows.
  const failure = Object.assign(new Error('PostgreSQL storage is unavailable'), { status: 503 });
  const mount = await renderCard(stubClient({ timelineError: failure }));
  const text = mount.textContent;
  assert.ok(text.includes('Identità collegate'), 'the identities section stays');
  assert.ok(
    text.includes('I canali osservati non si sono potuti leggere. Riprova più tardi.'),
    'the observed read names the failure instead of merging in silence',
  );
  // The number still reads in Contatti (the card's own phone field), so the
  // absence checks scope to the Identità collegate section.
  const sectionHead = mount.findByText('h4', 'Identità collegate');
  assert.ok(sectionHead, 'the identities section stays');
  const sectionText = sectionHead.parentNode?.textContent ?? '';
  assert.ok(!sectionText.includes('nessun canale osservato'), 'a failed observed read claims no zero channels');
  assert.ok(!sectionText.includes('+39 333 1234567'), 'no observed row renders on a failed read');
  assert.ok(!sectionText.includes('guido.presti'), 'no observed handle renders on a failed read');
  assert.ok(!text.includes('503'), 'no raw status on screen');
});

test('826e377c review giro-7: a truncated timeline names a partial list, never an exact count', async () => {
  // The review on head 3c77ca1 (P2): mergeLinkedIdentities ignored the
  // timeline truncation flags, so a customer with a channel beyond the page
  // read an exact «N canali». The section now renders the page it read and
  // names it partial.
  const mount = await renderCard(stubClient({
    timeline: { ...TIMELINE, entries: { ...TIMELINE.entries, truncated: true, count: 9 } },
  }));
  const sectionHead = mount.findByText('h4', 'Identità collegate');
  assert.ok(sectionHead, 'the identities section stays');
  const sectionText = sectionHead.parentNode?.textContent ?? '';
  assert.ok(sectionText.includes('3 canali (elenco parziale)'), 'the partial page names itself partial, not exact');
  assert.ok(sectionText.includes('+39 333 1234567'), 'the read rows still render');
  assert.ok(!sectionText.includes('nessun canale osservato'), 'a partial read never claims zero channels');
});

test('826e377c review giro-7: a null timeline names unavailability, never zero channels', async () => {
  // A 404 timeline (the package is not composed for this reader) loads as
  // null with no error: the section used to merge null to zero rows and
  // print «nessun canale osservato» — a false zero for a read that never
  // happened. It now names its state and stops.
  const mount = await renderCard(stubClient({ timeline: null }));
  const sectionHead = mount.findByText('h4', 'Identità collegate');
  assert.ok(sectionHead, 'the identities section stays');
  const sectionText = sectionHead.parentNode?.textContent ?? '';
  assert.ok(
    sectionText.includes('I canali osservati non sono disponibili.'),
    'an unavailable observed read names its state',
  );
  assert.ok(!sectionText.includes('nessun canale osservato'), 'an unavailable read claims no zero channels');
  assert.ok(!sectionText.includes('+39 333 1234567'), 'no observed row renders without a timeline');
});

test('voce 908f2eb9bbfb: with enrichment or calls in error only that section names the failure', async () => {
  const failure = Object.assign(new Error('boom'), { status: 500 });
  const mount = await renderCard(stubClient({ enrichedError: failure, callsError: failure }), 'call-x');
  const text = mount.textContent;
  assert.ok(!text.includes('Scheda non disponibile'), 'the card does not fail as a whole');
  assert.ok(text.includes('Guido Presti'), 'the name still shows');
  assert.ok(text.includes("I dati arricchiti non si sono potuti leggere. Riprova più tardi."), 'the enriched section names the failure');
  assert.ok(text.includes('Il riepilogo non si è potuto leggere. Riprova più tardi.'), 'the AI summary names the failure');
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

test('BO-F1-08: the scheda shows the AI summary, the signals and the openable transcript', async () => {
  const client = stubClient({ calls: CALLS });
  const mount = await renderCard(client, 'call-a');
  const text = mount.textContent;

  const callsPath = client.calls.find((path) => path.startsWith('/api/call-intelligence/calls/'));
  assert.ok(callsPath, 'the card reads the calls for this customer');
  assert.ok(callsPath.includes('spaceId=call-a'), 'the space stays explicit in the read');

  assert.ok(text.includes('Riepilogo AI'), 'the summary section exists');
  assert.ok(text.includes('Cliente con budget 800 euro'), 'the AI summary is shown');
  assert.ok(text.includes('Chiamate'), 'the calls section exists');
  assert.ok(text.includes('Budget'), 'the budget signal label is shown');
  assert.ok(text.includes('Tempi'), 'the timing signal label is shown');
  assert.ok(text.includes('il budget massimo è 800 euro'), 'the signal excerpt quotes the transcript');

  assert.ok(text.includes('Aggiornato 20 ott, 14:00'), 'the summary carries its <quando aggiornato> row');

  // Voce 59def6cb805d (C20): the prototype toggle with its exact texts.
  const toggles = mount.findAll('button').filter((node) => node.textContent === 'Mostra trascrizione');
  assert.equal(toggles.length, 1, 'the transcript toggle reads Mostra trascrizione while closed');
  assert.ok(!text.includes('Operatrice: buongiorno'), 'a closed transcript shows none of its content');
  toggles[0].dispatch('click');
  assert.equal(toggles[0].textContent, 'Nascondi trascrizione', 'the open toggle reads Nascondi trascrizione');
  const rows = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-scheda-transcript-row');
  assert.equal(rows.length, 2, 'one speaker row per transcript line');
  assert.ok(rows[0].textContent.includes('Operatrice: buongiorno'), 'the speaker rows carry the transcript text');
  toggles[0].dispatch('click');
  assert.equal(toggles[0].textContent, 'Mostra trascrizione', 'closing restores the exact text');
  assert.deepEqual(
    mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-scheda-transcript-row'),
    [],
    'a closed transcript mounts no speaker row',
  );
});

test('BO-F1-08: a purged transcript reads as erased, never as missing, and wiped excerpts read as erased', async () => {
  const purged = {
    calls: [{
      ...CALLS.calls[0],
      summary: null,
      summarized: false,
      signals: [{ type: 'doubt', excerpt: null, transcriptRef: 'call-transcript:call-a:call-1' }],
      transcript: { available: false, reason: 'cancellata il 2027-10-01 (retention scaduta)' },
    }],
  };
  const mount = await renderCard(stubClient({ calls: purged }), 'call-a');
  const text = mount.textContent;
  assert.ok(text.includes('Nessun riepilogo registrato'), 'no summary is invented after erasure');
  assert.ok(text.includes('Dubbi'), 'the surviving signal label is shown');
  assert.ok(text.includes('citazione cancellata: retention scaduta'), 'the wiped excerpt reads as erased, never as an empty quote');
  assert.deepEqual(
    mount.findAll('button').filter((node) => (node.textContent ?? '').includes('trascrizione')),
    [],
    'an erased transcript has no toggle',
  );
  assert.ok(text.includes('cancellata il 2027-10-01 (retention scaduta)'), 'the erasure reads as erased with its date');
});

test('BO-F1-08: a hostile excerpt on an available transcript stays text', async () => {
  const nasty = '<script>alert(1)</script>';
  const hostile = {
    calls: [{
      ...CALLS.calls[0],
      signals: [{ type: 'doubt', excerpt: nasty, transcriptRef: 'call-transcript:call-a:call-1' }],
    }],
  };
  const mount = await renderCard(stubClient({ calls: hostile }), 'call-a');
  assert.ok(mount.textContent.includes(nasty), 'the excerpt is shown as text');
  assert.deepEqual(mount.findAll('script'), [], 'and no element was created from it');
});

test('BO-F1-08: without a space or without intelligence composed the card stays honest', async () => {
  const nospace = stubClient({ calls: CALLS });
  const mount = await renderCard(nospace);
  assert.ok(mount.textContent.includes('Nessun dato di chiamata registrato'),
    'without a space the calls section stays unavailable');
  assert.ok(!nospace.calls.some((path) => path.startsWith('/api/call-intelligence/')),
    'without a space no calls read is attempted');

  const uncomposed = await renderCard(stubClient({ failCalls: true }), 'call-a');
  assert.ok(uncomposed.textContent.includes('Riepilogo AI'), 'the card still renders');
  assert.ok(uncomposed.textContent.includes('Nessun riepilogo registrato'),
    'without intelligence composed no summary is shown');
});

test('BO-F1-08: a failing calls read is an error, never a quiet "no calls"', async () => {
  // Voce 908f2eb9bbfb narrows this promise: the failure names itself on its
  // own section instead of failing the whole scheda — still never a quiet
  // "no calls".
  const mount = await renderCard(
    stubClient({ callsError: Object.assign(new Error('boom'), { status: 500 }) }), 'call-a',
  );
  assert.ok(!mount.textContent.includes('Scheda non disponibile'), 'the card stays');
  assert.ok(mount.textContent.includes('Il riepilogo non si è potuto leggere. Riprova più tardi.'),
    'the AI summary names the failure');
  assert.ok(!mount.textContent.includes('nessuna chiamata registrata'),
    'a 500 never reads as no calls');
});

test('BO-F4-03: every enriched datum cites its free source and date', async () => {
  const client = stubClient({
    enriched: {
      customerEnrichmentContract: 1,
      subject: { resource: 'contact', id: 'c1' },
      linked: false,
      optedOut: null,
      items: [
        { subject: { resource: 'contact', id: 'c1' }, field: 'role', value: 'Istruttore', source: 'email-signature', sourceDetail: 'msg-1', observedAt: '2026-10-20T09:05:00.000Z' },
        { subject: { resource: 'contact', id: 'c1' }, field: 'firstName', value: 'Guido', source: 'google-contacts', sourceDetail: 'people/c1', observedAt: '2026-10-21T10:00:00.000Z' },
      ],
    },
  });
  const mount = await renderCard(client, 'call-a');
  const text = mount.textContent;

  const enrichedPath = client.calls.find((path) => path.startsWith('/api/customer-data/enriched/'));
  assert.ok(enrichedPath, 'the card reads the enrichment for this customer');
  assert.ok(enrichedPath.includes('/contact/c1'), 'the read names the scheda subject');

  assert.ok(text.includes("Arricchito dall'AI"), 'the enriched section exists');
  assert.ok(text.includes('Ruolo: Istruttore (fonte: firma email · 20 ott 2026)'), 'each datum cites its own source and date');
  assert.ok(text.includes('Nome: Guido (fonte: Contatti Google · 21 ott 2026)'), 'the second source is cited beside its datum');
});

test('BO-F4-03: an opted-out customer reads as opted out, never as empty', async () => {
  const mount = await renderCard(stubClient({
    enriched: {
      customerEnrichmentContract: 1,
      subject: { resource: 'contact', id: 'c1' },
      linked: false,
      optedOut: { reason: 'asked at the desk', optedOutAt: '2026-10-21T10:00:00.000Z' },
      items: [],
    },
  }));
  const text = mount.textContent;
  assert.ok(text.includes('arricchimento disattivato il 21 ott 2026 (opt-out)'), 'the opt-out is shown with its date');
  assert.ok(text.includes('nessun nuovo dato verrà salvato'), 'no further save is promised');
});

test('BO-F4-03: an unreadable enrichment read stays unavailable, never blank', async () => {
  const mount = await renderCard(stubClient({ enriched: null }));
  assert.ok(mount.textContent.includes('I dati arricchiti non si sono potuti leggere'),
    'an older server without the route leaves an honest section, not a failed card');
  assert.ok(mount.textContent.includes('Richiamare per la prova'), 'the rest of the scheda still renders');
});

test('BO-F4-03: a hostile enriched value renders as text, never as markup', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const mount = await renderCard(stubClient({
    enriched: {
      customerEnrichmentContract: 1,
      subject: { resource: 'contact', id: 'c1' },
      linked: false,
      optedOut: null,
      items: [
        { subject: { resource: 'contact', id: 'c1' }, field: 'role', value: nasty, source: 'email-signature', sourceDetail: 'msg-1', observedAt: '2026-10-20T09:05:00.000Z' },
      ],
    },
  }));
  assert.ok(mount.textContent.includes(nasty), 'the value is shown as text');
  assert.deepEqual(mount.findAll('img'), [], 'and no element was created from it');
});

test('BO-F4-03: a failing enrichment read is an error, never a quiet "no data"', async () => {
  // Voce 908f2eb9bbfb narrows this promise: the failure names itself on its
  // own section instead of failing the whole scheda — still never a quiet
  // "no data".
  const mount = await renderCard(
    stubClient({ enrichedError: Object.assign(new Error('boom'), { status: 500 }) }),
  );
  assert.ok(!mount.textContent.includes('Scheda non disponibile'), 'the card stays');
  assert.ok(mount.textContent.includes("I dati arricchiti non si sono potuti leggere. Riprova più tardi."),
    'the enriched section names the failure');
  assert.ok(!mount.textContent.includes('Nessun dato arricchito ancora'),
    'a 500 never reads as no enriched data');
});

// Voce 1a066ddfe42a: la scheda mostra solo italiano semplice — mai parole di
// sistema inglesi, mai UUID, mai date ISO. Vale con dati e senza dati.
const UUID_A = 'd394d386-4a1b-4c2d-8e3f-267581100b32';
const UUID_B = '8d8f1d4d-25c1-4641-8836-267581100b32';

const CARD_BARE = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: UUID_A },
  name: 'Ada Rossi',
  company: null,
  phone: {
    available: false, value: null, system: null,
    reason: 'no phone-bearing channel identity (WhatsApp, SMS, voice) is held beside this record — this is not a claim the customer has no phone',
  },
  email: null,
  socials: [],
  status: {
    value: 'contatto',
    reason: 'no signed business found in the composed packages (orders: not readable here; contracts: not readable here; subscriptions: not readable here) — the evidence packages are not all readable here, so this is not a claim none exist',
  },
  activePackage: {
    available: false, count: null, countIsComplete: true, countNote: null, truncated: false,
    active: [], items: [],
    reason: 'subscriptions are not composed in this application — this is not a claim the customer holds no package',
  },
  notes: { available: false, items: null, reason: 'this application composes no notes record for customers' },
  history: { available: false, items: [], count: 0, truncated: false, completeTimeline: false, reason: 'no history' },
};

const PROFILE_BARE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: UUID_A },
  canonicalIdentity: {
    linked: false,
    clusterKey: null,
    canonical: { resource: 'contact', id: UUID_A, role: 'canonical' },
    members: [Object.freeze({
      resource: 'contact', id: UUID_A, role: 'canonical',
      decisionId: null, decidedAt: '2026-10-18T15:33:11.774Z', reason: null,
      decidedBy: { type: 'user', id: UUID_B },
    })],
    note: 'no canonical identity decision has been recorded for this record; it stands for itself',
  },
  identity: { company: null, contact: { id: UUID_A, email: null, firstName: 'Ada', lastName: 'Rossi' } },
  externalIdentities: [],
  opportunities: { available: false, reason: 'not composed', items: null, count: null },
  quotes: {
    available: false,
    reason: 'the contracts package is not composed in this application, so subscriptions are not available — this is not a claim that there are none',
    items: null, count: null,
  },
  orders: { available: false, reason: 'not composed', items: null, count: null },
  contracts: { available: false, reason: 'not composed', items: null, count: null },
  subscriptions: { available: false, reason: 'not composed', items: null, count: null },
  deliveryProjects: { available: false, reason: 'not composed', items: null, count: null },
  serviceCoverages: { available: false, reason: 'not composed', items: null, count: null },
  supportCases: { available: false, reason: 'not composed', items: null, count: null },
  workTasks: { available: false, reason: 'not composed', items: null, count: null },
  successions: { available: false, reason: 'not composed', items: null, count: null },
  dataQualityIssues: [],
  duplicateCandidates: [],
  completeTimeline: false,
  timelineNote: 'This profile spans Accordo-managed records only.',
  limitations: [],
};

const TIMELINE_BARE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: UUID_A },
  conversations: { available: true, count: 0, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
  entries: {
    available: true, count: 1, truncated: false,
    items: [{
      entry: 'message', id: UUID_B, conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
      sync: 'received', body: 'Buongiorno, vorrei informazioni', teamAuthorId: null,
      remoteHandle: '+39 333 0000000', errorCode: null, occurredAt: '2026-10-18T15:33:11.774Z',
    }],
  },
  appointments: {
    available: true, count: 1, truncated: false,
    items: [{
      id: UUID_B, status: 'booked', startsAt: '2099-10-23T16:00:00.000Z', endsAt: '2099-10-23T17:00:00.000Z',
      serviceKey: 'pt-single', teamMemberId: UUID_A, priceCents: 4000, currency: 'EUR', notes: null,
    }],
  },
  contactPoints: { available: true, count: 0, items: [] },
  timelineNote: 'Accordo-managed threads and bookings only.',
};

const SYSTEM_ENGLISH = /\b(claim|record|composed|canonical|readable)\b/i;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function assertCustomerItalian(text, label) {
  assert.ok(!SYSTEM_ENGLISH.test(text), `${label}: no English system words on screen`);
  assert.ok(!UUID_SHAPE.test(text), `${label}: no UUID on screen`);
  assert.ok(!ISO_DATETIME.test(text), `${label}: no ISO datetime on screen`);
}

test('1a066ddfe42a: la scheda senza dati e con inglese/API grezza resta tutta italiana', async () => {
  const mount = await renderCard(stubClient({
    card: CARD_BARE, timeline: TIMELINE_BARE, profile: PROFILE_BARE, enriched: ENRICHED,
  }));
  const text = mount.textContent;
  assertCustomerItalian(text, 'bare card');
  assert.ok(text.includes('Nessun telefono collegato'), 'empty phone reads as plain Italian');
  assert.ok(!text.includes('Offerta'), 'an uncomposed offer package shows no offer block at all');
  assert.ok(text.includes('Contatto'), 'the stato badge reads Contatto, not lowercase technical contatto');
  assert.ok(text.includes('Ordini e contratti non leggibili adesso'), 'unreadable evidence never reads as a definitive none');
});

test('1a066ddfe42a: la scheda con dati non mostra UUID, date ISO né inglese di sistema', async () => {
  const mount = await renderCard(stubClient({
    card: {
      ...CARD,
      status: { value: 'cliente', reason: 'signed business on record: orders' },
      activePackage: {
        available: true, count: 1, countIsComplete: true, countNote: null, truncated: false,
        active: [{ id: UUID_B, name: null, status: 'active' }],
        items: [{ id: UUID_B, name: null, status: 'active' }],
        reason: null,
      },
    },
    profile: {
      ...PROFILE,
      quotes: {
        available: true, count: 1, countIsComplete: true,
        items: [{ id: UUID_B, status: 'approved', name: null }], truncated: false,
      },
    },
  }));
  const text = mount.textContent;
  assertCustomerItalian(text, 'full card');
  assert.ok(!text.includes(UUID_B), 'an offer without a name never falls back to its id');
  assert.ok(text.includes('approvata'), 'the offer status reads in Italian');
  assert.ok(text.includes('attivo'), 'the package status reads in Italian');
});

test('1a066ddfe42a: complete zero evidence reads as a definitive Italian none', async () => {
  const mount = await renderCard(stubClient({
    card: { ...CARD_BARE, activePackage: { available: true, count: 0, countIsComplete: true, active: [], items: [] } },
    timeline: TIMELINE_BARE,
    profile: {
      ...PROFILE_BARE,
      orders: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
      contracts: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
      subscriptions: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
      workTasks: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
      quotes: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
      opportunities: { available: true, count: 0, countIsComplete: true, items: [], truncated: false },
    },
    enriched: ENRICHED,
  }));
  const text = mount.textContent;
  assertCustomerItalian(text, 'proven-empty card');
  assert.ok(text.includes('Nessuna attività firmata collegata'), 'proven absence reads as a definitive none');
  assert.ok(!text.includes('Ordini e contratti non leggibili adesso'), 'proven absence carries no hedge');
  assert.ok(text.includes('Nessuna offerta firmata'), 'a composed-but-empty offer package reads its empty state');
  assert.ok(text.includes('Nessun pacchetto attivo'), 'a complete empty package page reads its empty state');
});

// Voce 59def6cb805d: la colonna centrale parla come il prototipo — titolo,
// giorni in maiuscolo, righe sync con freccia, durate `<m:ss>`, empty state.
test('59def6cb805d: the timeline reads like the prototype (C14, C16, C17, C19)', async () => {
  const mount = await renderCard(stubClient());
  const text = mount.textContent;

  // C14: the section title is the prototype's, and Tutti starts selected.
  const titles = mount.findAll('h4').map((node) => node.textContent);
  assert.ok(titles.includes('Tutti i contatti'), 'the center title reads Tutti i contatti');
  assert.ok(!titles.includes('Cronologia'), 'the record-kind title is gone');
  const tutti = mount.findAll('button').find((node) => node.textContent === 'Tutti');
  assert.ok(tutti, 'a Tutti chip exists');
  assert.equal(tutti.getAttribute('data-active'), 'true', 'Tutti starts selected');

  // C16: day groups read uppercase, like `<GIORNO> <DATA>`.
  const days = mount.findAll('h5').map((node) => node.textContent);
  assert.ok(days.length > 0, 'the timeline groups by day');
  assert.ok(days.includes('MARTEDÌ 20 OTTOBRE 2026'), 'the day reads uppercase');
  assert.ok(!days.some((day) => day !== day.toUpperCase()), 'no lowercase day header');

  // C17, rivisto da Dan 07/11 (chat): every bubble names channel, person
  // and `<hh:mm>` once; the side says the direction, the state reads only
  // where it says something.
  assert.ok(text.includes('WhatsApp · +39 333 1234567 · 11:00'), 'inbound bubble with its hour');
  assert.ok(text.includes('WhatsApp · Elena · 11:05'), 'outbound bubble with its hour');
  assert.ok(!text.includes('ricevuto'), 'a plain received passage carries no state line');
  assert.ok(text.includes('consegnato'), 'the outbound bubble reads its delivery state');
  assert.ok(text.includes('· completata'), 'the call reads its outcome on its own line');
  assert.ok(!/[←→] (WhatsApp|Telefono) ·/.test(text), 'the old arrow rows that repeated the channel are gone');

  // C19: the call duration reads `<m:ss>`, never raw seconds.
  assert.ok(text.includes('chiamata in uscita · 6:12'), '372 seconds read as 6:12');
  assert.ok(!text.includes('372s'), 'no raw second count on the card');
});

test('59def6cb805d: passages of today carry the OGGI prefix (C16)', async () => {
  const now = new Date();
  const romeToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [year, month, day] = romeToday.split('-').map(Number);
  const occurredAt = new Date(Date.UTC(year, month - 1, day, 10, 0, 0)).toISOString();
  const mount = await renderCard(stubClient({
    timeline: {
      ...TIMELINE,
      entries: {
        available: true, count: 1, truncated: false,
        items: [{
          entry: 'message', id: 'm-today', conversationId: 't1', channel: 'whatsapp',
          direction: 'inbound', sync: 'received', body: 'Ciao di oggi',
          teamAuthorId: null, remoteHandle: '+39 333 1234567', errorCode: null, occurredAt,
        }],
      },
    },
  }));
  const days = mount.findAll('h5').map((node) => node.textContent);
  assert.equal(days.length, 1, 'one day group');
  assert.ok(days[0].startsWith('OGGI · '), `today reads with the OGGI prefix, got ${days[0]}`);
  assert.equal(days[0], days[0].toUpperCase(), 'the OGGI header stays uppercase');
});

test('59def6cb805d: an empty timeline reads the exact prototype empty state (C27)', async () => {
  const mount = await renderCard(stubClient({
    timeline: { ...TIMELINE, entries: { available: true, count: 0, truncated: false, items: [] } },
  }));
  const text = mount.textContent;
  assert.ok(text.includes('Nessun messaggio qui'), 'the empty title is exact');
  assert.ok(text.includes('Prova un altro canale oppure scrivi il primo messaggio qui sotto.'),
    'the empty hint is exact');
  assert.ok(!text.includes('nessun passaggio'), 'no technical empty sentence remains');
});

// Voce 59def6cb805d (C15/C17) + voce 19c2e22a64a1 (6): every channel badge the
// scheda can paint has an Italian label — no raw channel key on screen.
test('59def6cb805d: every channel badge reads its Italian label (C15, C17)', async () => {
  const channels = ['whatsapp', 'instagram', 'facebook', 'tiktok', 'email', 'gmail',
    'outlook', 'phone', 'tel', 'mobile', 'voice', 'sms', 'messenger', 'web', 'form', 'calendar'];
  const mount = await renderCard(stubClient({
    timeline: {
      ...TIMELINE,
      entries: {
        available: true, count: channels.length, truncated: false,
        items: channels.map((channel, index) => ({
          entry: 'message', id: `mx-${index}`, conversationId: 't1', channel,
          direction: 'inbound', sync: 'received', body: `corpo ${channel}`,
          teamAuthorId: null, remoteHandle: '+39 333 0000000', errorCode: null,
          occurredAt: '2026-10-20T15:33:11.774Z',
        })),
      },
    },
  }));
  const text = mount.textContent;
  for (const label of ['WhatsApp', 'Instagram', 'Messenger', 'TikTok', 'Email', 'Gmail',
    'Outlook', 'Telefono', 'SMS', 'Sito', 'Form sito', 'Google Calendar']) {
    assert.ok(text.includes(label), `the Italian label ${label} is on screen`);
  }
  for (const raw of ['outlook', 'messenger', 'calendar']) {
    assert.ok(!text.includes(`· ${raw} ·`), `no raw ${raw} key in a sync row`);
    assert.ok(!text.includes(`da ${raw} ·`) && !text.includes(`${raw} · da `),
      `no raw ${raw} key in a card head`);
  }
});

// Voce 59def6cb805d (C13): `Arricchito dall'AI` carries the ghost `Aggiorna`
// button; the click re-reads the enrichment and reports through the toast.
test('59def6cb805d: Aggiorna re-reads the enrichment and toasts the outcome (C13)', async () => {
  const seen = [];
  const toast = (message, error) => { seen.push({ message, error: error ?? false }); };
  const mount = await renderCard(stubClient(), undefined, toast);
  const refresh = mount.findAll('button').find((node) => node.textContent === 'Aggiorna');
  assert.ok(refresh, 'the Aggiorna button is in the enriched section');
  assert.ok(
    String(refresh.getAttribute('class') ?? '').split(/\s+/).some((cls) => cls === 'ui' || cls.startsWith('ui-')),
    'Aggiorna carries the visual system',
  );
  refresh.dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [{ message: 'Nessun dato nuovo', error: false }],
    'an unchanged re-read toasts Nessun dato nuovo');
});

test('59def6cb805d: Aggiorna shows fresh rows when the re-read changed (C13)', async () => {
  const seen = [];
  const toast = (message, error) => { seen.push({ message, error: error ?? false }); };
  let current = {
    customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c1' },
    linked: false, optedOut: null, items: [],
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-data/enriched/')) return current;
      return stubClient().request(path, options);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, toast }).renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('Nessun dato arricchito ancora'), 'the section starts empty');
  current = {
    customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c1' },
    linked: false, optedOut: null,
    items: [{ field: 'firstName', value: 'Guido', source: 'google-contacts', observedAt: '2026-10-20T10:00:00.000Z' }],
  };
  mount.findAll('button').find((node) => node.textContent === 'Aggiorna').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(mount.textContent.includes('Nome: Guido (fonte: Contatti Google'),
    'the re-read rows render with source and date');
  assert.deepEqual(seen, [{ message: 'Dati aggiornati', error: false }],
    'a changed re-read toasts Dati aggiornati');
});

test('59def6cb805d: a failed Aggiorna keeps its rows and toasts the retry (C13)', async () => {
  const seen = [];
  const toast = (message, error) => { seen.push({ message, error: error ?? false }); };
  let fail = false;
  const enriched = {
    customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c1' },
    linked: false, optedOut: null,
    items: [{ field: 'firstName', value: 'Guido', source: 'google-contacts', observedAt: '2026-10-20T10:00:00.000Z' }],
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-data/enriched/')) {
        if (fail) throw Object.assign(new Error('boom'), { status: 500 });
        return enriched;
      }
      return stubClient().request(path, options);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, toast }).renderCard('contact', 'c1');
  fail = true;
  mount.findAll('button').find((node) => node.textContent === 'Aggiorna').dispatch('click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(mount.textContent.includes('Nome: Guido'), 'the previous rows stay on screen');
  assert.equal(seen.length, 1, 'one toast for the failed re-read');
  assert.equal(seen[0].error, true, 'the failure toasts as an error');
  assert.ok(seen[0].message.includes('Riprova'), 'the failure toasts the Italian retry');
});
test('the offer panel names the quote after its opportunity, with the opportunity stage in Italian', async () => {
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      opportunities: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{ id: 'o1', status: 'proposal', name: 'Pacchetto 10 ingressi' }],
      },
      quotes: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{
          id: '8d8f1d4d-25c1-4641-8836-267581100b32', status: 'approved', name: null,
          opportunityId: 'o1', opportunityName: 'Pacchetto 10 ingressi',
        }],
      },
    },
  }));
  const text = mount.textContent;
  // Backlog a551982c06eb: the line reads the sale's stage, never the quote's
  // approval («approvata») as if it were the offer's state.
  assert.ok(text.includes('Pacchetto 10 ingressi · proposta'),
    'the offer reads with its opportunity name and the Italian stage');
  assert.ok(!text.includes('approvata'), 'the quote approval is not the offer state');
  assert.ok(!text.includes('8d8f1d4d-25c1-4641-8836-267581100b32'),
    'a bare record id is never the offer name');
  assert.ok(!text.includes('approved'), 'the raw English state is never shown');
});

test('cf340b571e98: the quote offer line links to the quote detail', async () => {
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      opportunities: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{ id: 'o1', status: 'proposal', name: 'Pacchetto 10 ingressi' }],
      },
      quotes: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{
          id: 'q9', status: 'approved', name: null,
          opportunityId: 'o1', opportunityName: 'Pacchetto 10 ingressi',
        }],
      },
    },
  }));
  const link = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'bo-scheda-offer-link');
  assert.ok(link, 'the quote offer line is a link');
  assert.equal(link.getAttribute('href'), '#/quotes/q9', 'the link opens the quote detail');
  assert.ok(link.textContent.includes('Pacchetto 10 ingressi · proposta'),
    'the link keeps the opportunity name and the Italian stage');
});

test('a551982c06eb: an approved quote on an offer in Proposta reads «Proposta», the Pipeline board label', async () => {
  const schema = { pipelineContract: 1, pipelines: [accordoSalesPipeline] };
  const mount = await renderCard(stubClient({
    schema,
    profile: {
      ...PROFILE,
      opportunities: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{
          id: 'o1', status: 'qualification', stage: 'qualification', name: 'Pacchetto 10 ingressi',
          pipelineKey: 'accordo-sales', pipelineStage: 'proposta',
        }],
      },
      quotes: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{
          id: 'q9', status: 'approved', name: null, opportunityId: 'o1', opportunityName: 'Pacchetto 10 ingressi',
          opportunityStage: 'qualification', opportunityPipelineKey: 'accordo-sales', opportunityPipelineStage: 'proposta',
        }],
      },
    },
  }));
  const state = mount.findAll('span').find((node) => (node.getAttribute('class') ?? '') === 'bo-scheda-offer-state');
  assert.ok(state, 'the offer line shows a state');
  assert.equal(state.textContent, 'Proposta', 'the scheda says the stage the Pipeline board shows');
  // The same shared function names the stage on the board and the offer detail.
  assert.equal(offerStageLabel(schema.pipelines, { pipelineKey: 'accordo-sales', pipelineStage: 'proposta', stage: 'qualification' }), 'Proposta');
  assert.ok(!mount.textContent.includes('approvata'), 'the quote approval is not the offer state');
});

test('a551982c06eb: a quote without a readable opportunity still reads its own state', () => {
  assert.equal(shownOfferState({ id: 'q1', status: 'approved' }, true, [], []), 'approvata');
  assert.equal(shownOfferState({ id: 'q1', status: 'approved', opportunityId: 'gone' }, true, [{ id: 'o1', stage: 'proposal' }], []), 'approvata');
  assert.equal(shownOfferState({ id: 'o1', status: 'proposal', stage: 'proposal' }, false, null, []), 'proposta');
  assert.equal(shownOfferState({ id: 'o1', stage: 'proposal', pipelineKey: 'accordo-sales', pipelineStage: 'prova' }, false, null, [accordoSalesPipeline]), 'Prova');
});

test('cf340b571e98: a hostile quote id stays inside the detail href', async () => {
  const hostile = 'q1" onmouseover="alert(1)';
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      quotes: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{ id: hostile, status: 'sent', name: 'Preventivo 10 ingressi' }],
      },
    },
  }));
  const link = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'bo-scheda-offer-link');
  assert.ok(link, 'the quote offer line is a link');
  assert.equal(link.getAttribute('href'), `#/quotes/${encodeURIComponent(hostile)}`,
    'the id is encoded, never breaking out of the href');
});

test('cf340b571e98: the opportunity-fallback offer line stays plain text', async () => {
  // No quote, one staged opportunity: there is no opportunity detail screen,
  // so the fallback line must not pretend to open one.
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      opportunities: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{ id: 'o1', status: 'proposal', name: 'Pacchetto sede' }],
      },
      quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
    },
  }));
  assert.ok(mount.textContent.includes('Pacchetto sede · proposta'), 'the fallback offer line still reads');
  assert.equal(mount.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'bo-scheda-offer-link').length, 0,
    'no offer link without a quote');
});

test('the opportunity-fallback offer line reads the name with its Italian stage, never the bare name', async () => {
  // Voce cc525cd6a3c5 (review head 02e64495, P2): no quotes, one staged
  // opportunity. The item shape below is exactly what profile.js emits for a
  // stage-only opportunity row (status carried over from stage).
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      opportunities: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{ id: 'o1', status: 'proposal', name: 'Pacchetto sede' }],
      },
      quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
    },
  }));
  const text = mount.textContent;
  assert.ok(text.includes('Pacchetto sede · proposta'),
    'the fallback offer line reads with its Italian stage');
  assert.ok(!text.includes('proposal'), 'the raw English stage is never shown');
});

test('an unreadable quotes section reads unavailable in Italian, never a confirmed no-offer', async () => {
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
      quotes: { available: false, items: null, reason: 'the commercial package is not composed in this application, so quotes are not available — this is not a claim that there are none' },
    },
  }));
  const text = mount.textContent;
  assertCustomerItalian(text, 'unavailable quotes section');
  assert.ok(text.includes('offerte non disponibili'), 'the unavailable commercial section reads a fixed Italian line');
  assert.ok(!text.includes('Nessuna offerta firmata'),
    'an empty opportunities read never proves there are no quotes');
});

// Voce 59def6cb805d (C10), unita a 826e377c: Identità collegate conta i
// canali osservati e mostra una riga per canale con sigla e recapito, mai
// chiavi grezze o UUID. Le righe detenute e quelle osservate sui messaggi si
// fondono: lo stesso recapito in due forme non fa due righe.
test('59def6cb805d: the identities section counts channels with one row each (C10)', async () => {
  const mount = await renderCard(stubClient());
  const text = mount.textContent;
  // Observed WhatsApp +39 333 1234567 and Instagram guido.presti read one
  // row each, while the phone call on the same number is its own system.
  // Held identities are not listed here (owner split: read-only section).
  assert.ok(text.includes('3 canali'), 'the header counts the merged channels');
  const rows = mount.findAll('p').filter((node) => (node.getAttribute('data-channel') ?? '') !== ''
    && node.getAttribute('class') === 'bo-scheda-identity');
  assert.equal(rows.length, 3, 'one row per merged identity');
  assert.ok(text.includes('+39 333 1234567'), 'the WhatsApp handle reads as value');
  assert.ok(text.includes('guido.presti'), 'the Instagram handle reads as value');
});

// Voce 59def6cb805d (C10): i sistemi senza etichetta italiana e gli UUID non
// vanno mai su schermo — gli osservati sui messaggi; i detenuti non si
// leggono in questa sezione (owner split: solo osservate).
test('59def6cb805d: unlabelled systems and UUID handles never reach the screen (C10)', async () => {
  const emptyTimeline = {
    ...TIMELINE,
    conversations: { available: true, count: 0, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
    entries: { available: true, count: 0, truncated: false, items: [] },
  };
  const mount = await renderCard(stubClient({
    timeline: emptyTimeline,
    profile: {
      ...PROFILE,
      externalIdentities: [
        { system: 'google-contacts', externalId: 'people/c123', subject: { resource: 'contact', id: 'c1' } },
        {
          system: 'whatsapp', externalId: 'd394d386-4a1b-4c2d-8e3f-267581100b32',
          subject: { resource: 'contact', id: 'c1' },
        },
      ],
    },
  }));
  const text = mount.textContent;
  assert.ok(!text.includes('google-contacts'), 'no raw system key on screen');
  assert.ok(!text.includes('people/c123'), 'no enrichment-only handle on screen');
  assert.ok(!text.includes('d394d386-4a1b-4c2d-8e3f-267581100b32'), 'no UUID on screen');
  assert.ok(text.includes('nessun canale osservato'), 'the empty channel list stays honest');
});

// Voce 59def6cb805d (C11): la nota viola ✦ riporta la motivazione registrata;
// senza unione o senza motivazione non si inventa nulla.
test('59def6cb805d: the union note carries the recorded motivation (C11)', async () => {
  const mount = await renderCard(stubClient());
  const notes = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-scheda-union-note');
  assert.equal(notes.length, 1, 'one note for the distinct recorded reason');
  assert.equal(notes[0].textContent, '✦ stesso numero su WhatsApp e Instagram');
});

// Voce 59def6cb805d (C11): scheda non unita o senza motivazione, nessuna nota.
test('59def6cb805d: no union note is invented without a linked union (C11)', async () => {
  const silentTimeline = {
    ...TIMELINE_BARE,
    entries: { available: true, count: 0, truncated: false, items: [] },
  };
  const mount = await renderCard(stubClient({ profile: PROFILE_BARE, timeline: silentTimeline }));
  assert.deepEqual(
    mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-scheda-union-note'),
    [],
    'an unlinked record shows no union note',
  );
  assert.ok(mount.textContent.includes('nessun canale osservato'), 'and no channel is claimed');
});

// Voce 826e377c: Ada Rossi ha messaggi WhatsApp (+39 000 000 001) e
// Instagram (@ada-rossi.esempio) nella cronologia ma nessuna identità
// detenuta: Identità collegate elenca il numero e l'handle osservati, con il
// canale, invece di «nessun canale osservato».
test('826e377c: observed WhatsApp number and Instagram handle list with no held identities', async () => {
  const adaTimeline = {
    ...TIMELINE,
    conversations: {
      available: true, count: 2, truncated: false, unthreadedMessages: 0, unthreadedCalls: 0,
      items: [
        { channel: 'whatsapp', peer: '+39 000 000 001' },
        { channel: 'instagram', peer: '@ada-rossi.esempio' },
      ],
    },
    entries: {
      available: true, count: 2, truncated: false,
      items: [
        {
          entry: 'message', id: 'm-wa', conversationId: 't-wa', channel: 'whatsapp', direction: 'inbound',
          sync: 'received', body: 'Buongiorno, vorrei una prova', teamAuthorId: null,
          remoteHandle: '+39 000 000 001', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
        },
        {
          entry: 'message', id: 'm-ig', conversationId: 't-ig', channel: 'instagram', direction: 'inbound',
          sync: 'received', body: 'Quanto costa il pacchetto?', teamAuthorId: null,
          remoteHandle: '@ada-rossi.esempio', errorCode: null, occurredAt: '2026-10-20T11:00:00.000Z',
        },
      ],
    },
  };
  const mount = await renderCard(stubClient({
    profile: { ...PROFILE_BARE, externalIdentities: [] },
    timeline: adaTimeline,
  }));
  const text = mount.textContent;
  assert.ok(!text.includes('nessun canale osservato'), 'messages name their channels, never an empty claim');
  assert.ok(text.includes('2 canali'), 'the header counts the two observed channels');
  const rows = mount.findAll('p').filter((node) => (node.getAttribute('data-channel') ?? '') !== ''
    && node.getAttribute('class') === 'bo-scheda-identity');
  assert.equal(rows.length, 2, 'one row per observed identity');
  assert.equal(rows[0].getAttribute('data-channel'), 'whatsapp');
  assert.equal(rows[0].getAttribute('data-source'), 'observed');
  assert.equal(rows[1].getAttribute('data-channel'), 'instagram');
  assert.equal(rows[1].getAttribute('data-source'), 'observed');
  assert.ok(text.includes('+39 000 000 001'), 'the WhatsApp number reads as value');
  assert.ok(text.includes('@ada-rossi.esempio'), 'the Instagram handle reads as value');
  const held = rows.filter((node) => node.getAttribute('data-source') === 'held');
  assert.deepEqual(held, [], 'no held row is invented from messages alone');
});

test('826e377c review giro-5: a call with no handle still names its channel', () => {
  // Review on head 23aac0b6 (P2 card.js:305): the list CANALI column counts
  // calls, but the merge only kept timeline evidence with a handle — a
  // calls-only customer read phone in the list and «nessun canale osservato»
  // on the scheda. The union is authoritative: a handle-less channel lists
  // as a display-only observed row, never an invented handle.
  const merged = mergeLinkedIdentities({
    conversations: { items: [{ channel: 'phone', peer: null }] },
    entries: {
      items: [
        { entry: 'call', channel: 'phone', remoteHandle: null, occurredAt: '2026-10-21T10:00:00.000Z' },
      ],
    },
  });
  assert.equal(merged.rows.length, 1, 'one row for the handle-less phone channel');
  assert.equal(merged.rows[0].system, 'phone');
  assert.equal(merged.rows[0].externalId, null, 'no handle is invented');
  assert.equal(merged.rows[0].source, 'observed');
  assert.equal(merged.channelCount, 1);
});

test('826e377c review giro-5: the handle-less channel renders without Collega', async () => {
  const timeline = {
    ...TIMELINE,
    conversations: { available: true, count: 1, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 1 },
    entries: {
      available: true, count: 1, truncated: false,
      items: [
        {
          entry: 'call', id: 'k-1', conversationId: null, channel: 'phone', direction: 'inbound',
          sync: 'completed', durationSec: 120, teamAuthorId: null,
          remoteHandle: null, errorCode: null, occurredAt: '2026-10-21T10:00:00.000Z',
        },
      ],
    },
  };
  const mount = await renderCard(stubClient({
    profile: { ...PROFILE_BARE, externalIdentities: [] },
    timeline,
  }));
  const text = mount.textContent;
  assert.ok(!text.includes('nessun canale osservato'), 'a calls-only customer names its channel');
  assert.ok(text.includes('senza identificativo'), 'the handle-less channel reads honestly');
  const rows = mount.findAll('p').filter((node) => (node.getAttribute('data-channel') ?? '') !== ''
    && node.getAttribute('class') === 'bo-scheda-identity');
  assert.equal(rows.length, 1, 'one row for the handle-less phone channel');
  assert.equal(rows[0].getAttribute('data-channel'), 'phone');
  const buttons = mount.findAll('button').filter((node) => node.textContent === 'Collega');
  assert.deepEqual(buttons, [], 'no Collega without a handle to link');
});

test('826e377c: every labeled observed channel lists read-only, with no buttons', () => {
  // Owner split: manual Collega/Scollega is a follow-up voce, so the section
  // lists every labeled channel from the messages and offers no action.
  const merged = mergeLinkedIdentities({
    conversations: { items: [] },
    entries: {
      items: [
        { channel: 'whatsapp', remoteHandle: '+39 000 000 001' },
        { channel: 'sms', remoteHandle: '+39 000 000 002' },
        { channel: 'gmail', remoteHandle: 'ada.rossi@example.it' },
      ],
    },
  });
  assert.equal(merged.rows.length, 3, 'one row per observed channel');
  const byChannel = Object.fromEntries(merged.rows.map((row) => [row.system, row]));
  for (const system of ['whatsapp', 'sms', 'gmail']) {
    assert.equal(byChannel[system].source, 'observed');
    assert.ok(!('linked' in byChannel[system]), `${system} carries no linked flag`);
    assert.ok(!('linkable' in byChannel[system]), `${system} carries no linkable flag`);
  }
});

test('826e377c: held identities are not listed in the read-only section', async () => {
  // Owner split: the section reads only observed identities. Held rows stay
  // in the profile and in the Clienti CANALI column, never here.
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE_BARE,
      externalIdentities: [
        { system: 'whatsapp', externalId: '+39 000 000 001' },
        { system: 'sms', externalId: '+39000000002' },
      ],
    },
    timeline: {
      ...TIMELINE,
      conversations: { available: true, count: 0, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
      entries: { available: true, count: 0, truncated: false, items: [] },
    },
  }));
  const text = mount.textContent;
  assert.ok(text.includes('nessun canale osservato'), 'held rows alone name no observed channel');
  assert.ok(!text.includes('+39 000 000 001'), 'no held handle leaks into the section');
  const buttons = mount.findAll('button')
    .filter((node) => ['Collega', 'Scollega', 'Conferma'].includes(node.textContent));
  assert.deepEqual(buttons, [], 'no link buttons without the follow-up voce');
});

test('826e377c: observed rows on any labeled channel render with no buttons', async () => {
  const timeline = {
    ...TIMELINE,
    conversations: { available: true, count: 1, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
    entries: {
      available: true, count: 2, truncated: false,
      items: [
        {
          entry: 'message', id: 'm-wa', conversationId: 't-wa', channel: 'whatsapp', direction: 'inbound',
          sync: 'received', body: 'Buongiorno', teamAuthorId: null,
          remoteHandle: '+39 000 000 001', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
        },
        {
          entry: 'message', id: 'm-sms', conversationId: 't-sms', channel: 'sms', direction: 'inbound',
          sync: 'received', body: 'Ci vediamo domani', teamAuthorId: null,
          remoteHandle: '+39 000 000 002', errorCode: null, occurredAt: '2026-10-20T10:00:00.000Z',
        },
      ],
    },
  };
  const mount = await renderCard(stubClient({
    profile: { ...PROFILE_BARE, externalIdentities: [] },
    timeline,
  }));
  const text = mount.textContent;
  assert.ok(text.includes('+39 000 000 002'), 'the sms channel still lists, display-only');
  const rows = mount.findAll('p').filter((node) => (node.getAttribute('data-channel') ?? '') !== ''
    && node.getAttribute('class') === 'bo-scheda-identity');
  assert.equal(rows.length, 2, 'one row per observed identity');
  const buttons = mount.findAll('button')
    .filter((node) => ['Collega', 'Scollega', 'Conferma'].includes(node.textContent));
  assert.deepEqual(buttons, [], 'the read-only section offers no link buttons');
});

test('a customer with no linked offer reads none registered, never another customer offer', async () => {
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
      quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
    },
  }));
  const text = mount.textContent;
  assert.ok(text.includes('Nessuna offerta firmata'), 'the empty offer panel says so');
  assert.ok(!text.includes('Preventivo 10 ingressi'), 'no offer from anywhere is shown');
});

test('backlog:32820692: attachments render on the card: thumbnail, player, icon with name', async () => {
  const photo = {
    entry: 'message', id: 'm-photo', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
    sync: 'received', body: null, teamAuthorId: null, remoteHandle: '+39 333 1234567', errorCode: null,
    occurredAt: '2026-10-20T09:00:00.000Z',
    attachment: { kind: 'photo', name: null, size: 1234, ref: 'media-photo-1', preview: null },
  };
  const voice = {
    entry: 'message', id: 'm-voice', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
    sync: 'received', body: null, teamAuthorId: null, remoteHandle: '+39 333 1234567', errorCode: null,
    occurredAt: '2026-10-20T09:01:00.000Z',
    attachment: { kind: 'audio', name: null, size: null, ref: 'media-voice-1', preview: null },
  };
  const hostile = {
    entry: 'message', id: 'm-doc', conversationId: 't1', channel: 'instagram', direction: 'inbound',
    sync: 'received', body: null, teamAuthorId: null, remoteHandle: 'guido.presti', errorCode: null,
    occurredAt: '2026-10-20T09:02:00.000Z',
    attachment: { kind: 'document', name: '<script>alert(1)</script>.pdf', size: 42, ref: 'media-doc-1', preview: null },
  };
  const timeline = {
    ...TIMELINE,
    entries: { available: true, count: 3, truncated: false, items: [photo, voice, hostile] },
  };
  const mount = await renderCard(stubClient({ timeline }));
  const imgs = mount.findAll('img');
  assert.equal(imgs.length, 1, 'the photo shows one thumbnail');
  assert.equal(imgs[0].getAttribute('src'), 'media-photo-1');
  const players = mount.findAll('audio');
  assert.equal(players.length, 1, 'the voice note shows one player');
  assert.equal(players[0].getAttribute('src'), 'media-voice-1');
  assert.equal(players[0].getAttribute('controls'), '');
  assert.ok(mount.textContent.includes('<script>alert(1)</script>.pdf'), 'the document name reads as text');
  assert.deepEqual(mount.findAll('script'), [], 'a hostile filename never becomes markup');
});

// Voce 714433c2: Dettagli has Modifica with Salva and Annulla. Salva PATCHes
// the contact and re-reads the card; Annulla re-reads without writing.
const OPPORTUNITY_ONLY_PROFILE = {
  ...PROFILE,
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'qualification', name: 'Pacchetto 10 ingressi' }],
  },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

/** A client stub that records writes (method + parsed body) and serves reads from the base stub. */
const recordingClient = (base, onWrite = null) => {
  const writes = [];
  return {
    writes,
    async request(path, opts = {}) {
      enforceAdminWriteGate(path, opts);
      const method = opts?.method ?? 'GET';
      if (method === 'GET') return base.request(path);
      const body = opts?.body === undefined ? undefined : JSON.parse(String(opts.body));
      writes.push({ path, method, body });
      if (typeof onWrite === 'function') return onWrite({ path, method, body });
      return { ok: true };
    },
  };
};

const flushClicks = async (times = 3) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

test('714433c2: Modifica opens the edit form and Salva PATCHes the contact, then re-reads', async () => {
  const seen = [];
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  const edit = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details');
  assert.ok(edit, 'the Dettagli Modifica button exists');
  edit.dispatch('click');
  const save = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-details');
  const cancel = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-details');
  assert.ok(save, 'Salva is in the form');
  assert.ok(cancel, 'Annulla is in the form');

  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  byName('firstName').value = 'Guido';
  byName('lastName').value = 'Presti';
  byName('email').value = 'guido@palestra-esempio.it';
  save.dispatch('click');
  await flushClicks();

  assert.equal(client.writes.length, 1, 'one write for the save');
  assert.equal(client.writes[0].path, '/api/contacts/c1', 'Salva PATCHes the contact');
  assert.equal(client.writes[0].method, 'PATCH', 'the save is a PATCH');
  assert.deepEqual(client.writes[0].body,
    { firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it' },
    'only the editable keys travel, exactly as typed');
  assert.deepEqual(seen, [{ message: 'Dati salvati', error: false }], 'the save toasts in Italian');
  assert.ok(mount.textContent.includes('Dettagli'), 'the re-read card shows Dettagli again');
});

test('Dettagli › Modifica › Salva sends ONE PATCH, however many times it fires (production 07/11)', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base, () => pending.then(() => ({ ok: true })));
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  const save = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-details');
  save.dispatch('click');
  save.dispatch('click');
  await flushClicks();
  save.dispatch('click');
  assert.equal(save.disabled, true, 'Salva is off while the PATCH is in flight');
  release();
  await flushClicks(8);
  const patches = client.writes.filter((write) => write.method === 'PATCH');
  assert.equal(patches.length, 1, 'one PATCH /contacts/<id> for one Salva');
  assert.equal(patches[0].path, '/api/contacts/c1');
});

test('a contact typed without Azienda shows no Azienda on the scheda (production 07/11)', async () => {
  assert.equal(NO_COMPANY_NAME, 'Senza azienda', 'the same reserved name customer-data writes');
  assert.equal(shownCompanyName({ company: { id: 'k0', name: 'Senza azienda' } }), null);
  assert.equal(shownCompanyName({ company: { id: 'k1', name: 'Palestra Esempio' } }), 'Palestra Esempio');
  assert.equal(shownCompanyName({ company: null }), null);
  const card = { ...CARD, company: { id: 'k0', name: NO_COMPANY_NAME } };
  const mount = await renderCard(stubClient({ card, profile: OPPORTUNITY_ONLY_PROFILE }));
  assert.ok(!mount.textContent.includes(NO_COMPANY_NAME), 'the reserved company never reads as an Azienda');
  const facts = mount.findAll('span').filter((node) => node.getAttribute('class') === 'bo-scheda-fact-label');
  assert.ok(!facts.some((node) => node.textContent === 'Azienda'), 'no Azienda row for it');
});

// Voce 5e13c9ef: saving Dettagli with an email another customer holds is
// refused 409 CONFLICT by the server (contact-service EMAIL_TAKEN_MESSAGE).
// The scheda must show that message, not the generic retry line.
test('5e13c9ef: Dettagli Salva on a taken email shows the 409 message', async () => {
  const seen = [];
  const taken = () => {
    throw Object.assign(new Error('Questa email è già di un altro cliente'), { code: 'CONFLICT', status: 409 });
  };
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base, taken);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  const save = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-details');
  assert.ok(save, 'Salva is in the form');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'email').value = 'altrui@palestra-esempio.it';
  save.dispatch('click');
  await flushClicks();

  const fieldError = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error'
    && node.textContent !== '');
  assert.equal(fieldError?.textContent, 'Questa email è già di un altro cliente',
    'the field names the 409 reason, not the generic retry line');
  assert.deepEqual(seen, [{ message: 'Questa email è già di un altro cliente', error: true }],
    'the toast names the 409 reason too');
});

// Voce 5e13c9ef: detailsRefusalText names the 409 and keeps everything else.
test('5e13c9ef: detailsRefusalText maps the 409, keeps other failures generic', async () => {
  const taken = Object.assign(new Error('Questa email è già di un altro cliente'), { code: 'CONFLICT', status: 409 });
  assert.equal(detailsRefusalText(taken), 'Questa email è già di un altro cliente',
    'the server Italian sentence reaches the screen');
  const bare409 = Object.assign(new Error('Request failed (409)'), { code: 'CONFLICT', status: 409 });
  assert.equal(detailsRefusalText(bare409), 'Questa email è già di un altro cliente',
    'a 409 without a readable message reads our own words');
  const codeOnly = Object.assign(new Error('Questa email è già di un altro cliente'), { code: 'CONFLICT' });
  assert.equal(detailsRefusalText(codeOnly), 'Questa email è già di un altro cliente',
    'the CONFLICT code alone is enough, like PHONE_ALREADY_HELD');
  const technical = Object.assign(new Error('duplicate key value violates unique constraint'), { status: 409 });
  assert.equal(detailsRefusalText(technical), 'Questa email è già di un altro cliente',
    'a technical message never reaches the screen');
  const gone = Object.assign(new Error('Not Found'), { code: 'NOT_FOUND', status: 404 });
  assert.equal(detailsRefusalText(gone), 'Salvataggio non riuscito. Riprova più tardi.',
    'a 404 keeps the generic retry line');
  const network = Object.assign(new TypeError('fetch failed'), { status: 0 });
  assert.equal(detailsRefusalText(network), 'Salvataggio non riuscito. Riprova più tardi.',
    'a network fault keeps the generic retry line');
});

// Voce 5e13c9ef: any other save failure keeps the generic retry line.
test('5e13c9ef: Dettagli Salva on a 500 keeps the generic retry line', async () => {
  const seen = [];
  const failing = () => {
    throw Object.assign(new Error('boom'), { code: 'UNKNOWN', status: 500 });
  };
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base, failing);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-details').dispatch('click');
  await flushClicks();

  const fieldError = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error'
    && node.textContent !== '');
  assert.equal(fieldError?.textContent, 'Salvataggio non riuscito. Riprova più tardi.',
    'a 500 keeps the generic retry line');
  assert.deepEqual(seen, [{ message: 'Salvataggio non riuscito. Riprova più tardi.', error: true }],
    'the toast keeps the generic retry line too');
});

test('two renders racing paint one scheda, so there is one Dettagli Salva', async () => {
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCustomerCardView({ doc, mount, client: base });
  await Promise.all([view.renderCard('contact', 'c1'), view.renderCard('contact', 'c1')]);
  const panels = mount.childNodes.filter((node) => node.getAttribute?.('class') === 'bo-scheda');
  assert.equal(panels.length, 1, 'only the newest render lands');
  const edits = mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'edit-details');
  assert.equal(edits.length, 1, 'one Modifica, so one form and one Salva');
});

test('714433c2: Annulla drops the edits with no write and re-reads the card', async () => {
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  byName('firstName').value = 'Inventato';
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-details').dispatch('click');
  await flushClicks();

  assert.deepEqual(client.writes, [], 'Annulla writes nothing');
  assert.ok(!mount.textContent.includes('Inventato'), 'the dropped edit is not on screen');
  assert.ok(mount.textContent.includes('Dettagli'), 'the card re-read after Annulla');
});

test('714433c2: Aggiungi nota POSTs the operator note and re-reads the timeline', async () => {
  const seen = [];
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  const noteInput = mount.findAll('input').find((node) => node.getAttribute('name') === 'noteBody');
  assert.ok(noteInput, 'the note field names its purpose for assistive tech');
  noteInput.value = 'Richiamare giovedì';
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'add-note').dispatch('click');
  await flushClicks();

  assert.equal(client.writes.length, 1, 'one write for the note');
  assert.equal(client.writes[0].path, '/api/customer-hub/notes', 'the note goes to the hub notes route');
  assert.equal(client.writes[0].method, 'POST', 'the note is a POST');
  assert.deepEqual(client.writes[0].body,
    { resource: 'contact', id: 'c1', body: 'Richiamare giovedì' },
    'the note carries its subject and plain-text body');
  assert.deepEqual(seen, [{ message: 'Nota aggiunta', error: false }], 'the note toasts in Italian');
});

// Voce 714433c2: lo stato si cambia da un menu. The menu moves the shown
// opportunity through the governed stage workflow, offering only the legal
// moves: the transitions the workflow allows from the shown stage, never the
// current stage again, never the governed system state approval_pending (it
// is entered only through the approval gate). Every voice reads Italian.
test('714433c2: Cambia stato lists the legal moves in Italian and moves the opportunity', async () => {
  const seen = [];
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base, () => ({ output: { outcome: 'stage_changed' } }));
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  assert.ok(mount.textContent.includes('Pacchetto 10 ingressi · qualificazione'),
    'the offer line shows the opportunity with its Italian stage');
  const change = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'change-offer-stage');
  assert.ok(change, 'the Cambia stato menu button exists');
  assert.equal(change.getAttribute('aria-haspopup'), 'menu', 'the button announces its menu');
  change.dispatch('click');
  const voices = mount.findAll('button').filter((node) => node.getAttribute('data-stage') !== null);
  const labels = voices.map((node) => node.textContent);
  // qualification allows proposal/approval_pending/lost; approval_pending is
  // a system state, so only proposta and persa are offered.
  assert.deepEqual(labels, ['proposta', 'persa'], 'from qualificazione only proposta and persa are offered');
  assert.ok(!voices.some((node) => node.getAttribute('data-stage') === 'qualification'),
    'the current stage key is not a voice');
  assert.ok(!voices.some((node) => node.getAttribute('data-stage') === 'approval_pending'),
    'the governed system state is never a voice');
  assert.ok(!labels.some((label) => label === 'discovery' || label === 'proposal' || label === 'negotiation'),
    'no raw stage key reaches the screen');

  voices.find((node) => node.getAttribute('data-stage') === 'proposal').dispatch('click');
  await flushClicks();

  assert.equal(client.writes.length, 1, 'one write for the stage move');
  assert.equal(client.writes[0].path, '/api/opportunities/o1/stage', 'the move goes through the governed stage route');
  assert.equal(client.writes[0].method, 'POST', 'the move is a POST');
  assert.deepEqual(client.writes[0].body, { targetStage: 'proposal' }, 'the move names its target stage');
  assert.deepEqual(seen, [{ message: 'Stato aggiornato', error: false }], 'the move toasts in Italian');
});

// Voce 714433c2: the menu mirror is pinned to the governed transition table
// of the opportunity service — not to a stubbed client. Every stage offers
// exactly its legal moves minus the governed system state, and nothing else.
test('714433c2: the menu targets match the real transition table on every stage', () => {
  assert.deepEqual(CARD_TRANSITIONS, SERVICE_TRANSITIONS,
    'the card mirror is the governed table, not a copy that can drift');
  for (const stage of OPPORTUNITY_STAGES) {
    const targets = offerStageTargets(stage);
    const legal = (SERVICE_TRANSITIONS[stage] ?? []).filter((key) => key !== 'approval_pending');
    assert.deepEqual(targets, legal, `from ${stage} the menu offers exactly the legal non-system moves`);
    assert.ok(!targets.includes('approval_pending'), `from ${stage} the system state is never offered`);
    assert.ok(!targets.includes(stage), `from ${stage} the current stage is never offered`);
  }
});

test('714433c2: an approval-gated move toasts the approval, and a quote line carries no menu', async () => {
  const seen = [];
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const client = recordingClient(base, () => ({ output: { outcome: 'approval_required' } }));
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'change-offer-stage').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-stage') === 'proposal').dispatch('click');
  await flushClicks();
  assert.deepEqual(seen, [{ message: 'Stato aggiornato: serve un\u2019approvazione', error: false }],
    'an approval-gated move says so honestly');

  // The default fixture reads a quote line with no opportunity behind it:
  // there is no offer stage to move, so no menu (backlog 1e939a362c7c: a
  // quote WITH an opportunity moves that opportunity).
  const quoteMount = await renderCard(stubClient());
  assert.ok(quoteMount.textContent.includes('Preventivo 10 ingressi'), 'the fixture reads a quote line');
  assert.equal(
    quoteMount.findAll('button').filter((node) => node.getAttribute('data-action') === 'change-offer-stage').length,
    0,
    'a quote line without an opportunity carries no stage menu',
  );
});

// Voce 714433c2: «Nuova offerta» and «Nuovo appuntamento» stash the shown
// customer as a one-time pick — with the linked company the offer form needs
// — and navigate to the creation screens. The destinations take the pick.
test('714433c2: quick actions stash the picked customer and navigate to the creation screens', async () => {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
  const navs = [];
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client: stubClient({ profile: OPPORTUNITY_ONLY_PROFILE }), storage,
    navigate: (hash) => navs.push(hash),
  }).renderCard('contact', 'c1');

  const byAction = (action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
  // Dan 06/11: Nuova offerta opens its window over the scheda (see
  // tests/admin-offer-panel.test.js) — no navigation, no stash.
  byAction('new-offer').dispatch('click');
  assert.deepEqual(navs, [], 'Nuova offerta stays on the scheda');
  assert.ok(mount.findAll('div').some((node) => node.getAttribute('data-offer-panel') === 'open'), 'the offer window opens');
  assert.equal(storage.getItem('accordo.bo.customer-pick.offer'), null, 'no page handoff is needed');
  assert.equal(storage.getItem('accordo.bo.customer-pick.appointment'), null,
    'no appointment pick leaks from the offer voice');

  byAction('new-appointment').dispatch('click');
  assert.deepEqual(navs, ['#/calendario'],
    'Nuovo appuntamento opens the calendar manual booking');
  assert.deepEqual(JSON.parse(storage.getItem('accordo.bo.customer-pick.appointment')), {
    resource: 'contact', id: 'c1', name: 'Guido Presti',
    company: { id: 'co1', name: 'Palestra Esempio' },
  }, 'the appointment pick names the same record');
});

test('review #654: a contact without Azienda picks its own placeholder id under the person name, never «Senza azienda»', async () => {
  // #616: «Nuova offerta» opens its window over the scheda; the pick it
  // files under is the companyId the window's Crea offerta posts.
  const pickFor = async (card, profile) => {
    const base = stubClient({ card, profile });
    const posts = [];
    const client = {
      async request(path, options = {}) {
        if (path === '/api/opportunities' && options.method === 'POST') {
          posts.push(JSON.parse(String(options.body)));
          return { id: 'o-new' };
        }
        return base.request(path, options);
      },
    };
    const doc = createFakeDocument();
    const mount = createMount();
    await createCustomerCardView({ doc, mount, client, navigate: () => {}, spaceId: 'presti', toast: () => {} })
      .renderCard('contact', 'c1');
    mount.findAll('button').find((node) => node.getAttribute('data-action') === 'new-offer').dispatch('click');
    const panel = mount.findAll('div').find((node) => node.getAttribute('data-offer-panel') === 'open');
    assert.ok(panel, 'the offer window opens');
    assert.ok(!panel.textContent.includes('deve avere un’azienda'), 'the placeholder company is a company: no block');
    const input = (name) => panel.findAll('input').find((node) => node.getAttribute('name') === name);
    input('offer-title').value = 'Pacchetto 10 PT';
    input('offer-value').value = '350';
    input('offer-owner').value = 'Elena';
    await panel.__submit();
    assert.equal(posts.length, 1, 'one offer is filed');
    assert.ok(!mount.textContent.includes(NO_COMPANY_NAME), 'the placeholder name never reads on screen');
    return posts[0].companyId;
  };
  const ownProfile = {
    ...OPPORTUNITY_ONLY_PROFILE,
    identity: {
      ...OPPORTUNITY_ONLY_PROFILE.identity,
      company: null,
      contact: { ...OPPORTUNITY_ONLY_PROFILE.identity.contact, companyId: 'k-own' },
    },
  };
  // The card API names no company for the placeholder (customer-data profile).
  const viaApi = await pickFor({ ...CARD, company: null }, ownProfile);
  assert.equal(viaApi, 'k-own', 'the offer files under the contact own placeholder');
  // An older server still naming the placeholder: same pick, never its name.
  const viaOld = await pickFor({ ...CARD, company: { id: 'k-own', name: NO_COMPANY_NAME } }, ownProfile);
  assert.equal(viaOld, 'k-own');
  assert.equal(shownCompanyName({ company: { name: '  SENZA   azienda ' } }), null, 'same normalization as the server');
});

// Backlog e9b4fc2f: «Scrivi» opens the composer inside the scheda with the
// customer's own channels. Email is linked (Gmail), WhatsApp has the number
// but no linked connection — it reads switched off with its Connettori link.
// A channel without any address (Messenger) names that instead. Invia posts
// the preselected recipient, never a caller-supplied address.
const COMPOSER_CONNECTORS = {
  connectors: [
    // A real connection row always names its account (readSyncState):
    // review #648 — a linked Email with no valid sender is not sendable.
    { channel: 'email', status: 'active', connectionKey: 'gmail-1', account: 'studio@palestra-esempio.it' },
    { channel: 'instagram', status: 'active', connectionKey: 'ig-1' },
  ],
};

function composerClient({ connectors = COMPOSER_CONNECTORS, profile = null, onPost = null, onResume = null } = {}) {
  const base = stubClient();
  const posts = [];
  const resumes = [];
  return {
    posts,
    resumes,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/connectors')) return connectors;
      if (path === '/api/profile') {
        if (profile instanceof Error) throw profile;
        if (!profile) throw Object.assign(new Error('no profile'), { status: 404 });
        return profile;
      }
      if (path === '/api/customer-hub/messages' && (options.method ?? 'GET') === 'POST') {
        posts.push(JSON.parse(options.body));
        if (onPost) return onPost(posts.length);
        return { channel: 'email', to: 'guido@palestra-esempio.it', jobId: 'job-1' };
      }
      if (path.startsWith('/api/customer-hub/messages?')) {
        resumes.push(path);
        if (onResume) return onResume(resumes.length);
        return { channel: 'email', to: 'guido@palestra-esempio.it', jobId: 'job-1' };
      }
      return base.request(path, options);
    },
  };
}

// Voce a935af6a6d19: the space profile links the operator's Gmail mailbox
// while no email channel connection exists — the owner's 03/11 case.
const COMPOSER_GMAIL_PROFILE = {
  member: { name: 'Daniele Pelleri', email: 'daniele.pelleri@gmail.com', role: 'owner' },
  connections: {
    available: true,
    reason: null,
    items: [
      { connector: 'calendar', status: 'connected', account: 'daniele.pelleri@gmail.com' },
      { connector: 'gmail', status: 'connected', account: 'daniele.pelleri@gmail.com' },
    ],
  },
};

const flushComposer = async (rounds = 6) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => { setImmediate(resolve); });
  }
};

async function openComposerMount({ client = composerClient(), spaceId = 'presti', toast = undefined } = {}) {
  const toasts = [];
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, spaceId, toast: toast ?? ((message) => toasts.push(message)),
    wait: () => Promise.resolve(),
  }).renderCard('contact', 'c1');
  const write = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message');
  assert.ok(write, 'a Scrivi action exists');
  write.dispatch('click');
  await flushComposer();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(panel, 'the composer panel opens inside the scheda');
  return { mount, panel, toasts, client };
}

test('e9b4fc2f: Scrivi opens the composer with the customer channels', async () => {
  const { panel } = await openComposerMount();
  const text = panel.textContent;
  assert.ok(text.includes('Scrivi al cliente'), 'the panel names its purpose');
  for (const label of ['Email', 'WhatsApp', 'Instagram']) {
    assert.ok(text.includes(label), `the ${label} channel is offered`);
  }
  assert.ok(text.includes('guido@palestra-esempio.it'), 'the email recipient is preselected');
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const byValue = (value) => radios.find((node) => node.getAttribute('value') === value);
  assert.ok(byValue('email'), 'the email channel row exists');
  assert.equal(byValue('email').getAttribute('disabled'), null, 'the linked email channel is selectable');
  assert.equal(byValue('whatsapp').getAttribute('disabled'), 'disabled', 'WhatsApp without a connection is switched off');
  assert.ok(text.includes('non collegato'), 'the off channel says it is not linked');
  const connectors = panel.findAll('a').find((node) => node.getAttribute('data-action') === 'composer-connectors');
  assert.ok(connectors, 'the off channel links to Connettori');
  assert.equal(connectors.getAttribute('href'), '#/connettori');
  assert.ok(!panel.textContent.includes('mailto:'), 'no mailto: in the composer either');
});

test('e9b4fc2f: Invia posts the preselected recipient through the outbox route', async () => {
  const { panel, toasts, client } = await openComposerMount();
  const area = panel.findAll('textarea')[0];
  assert.ok(area, 'the composer has its text field');
  area.value = 'Certo, domani alle 18.';
  const subject = panel.findAll('input').find((node) => String(node.getAttribute('class') ?? '').includes('composer-subject'));
  if (subject) subject.value = 'Re: Preventivo';
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send').dispatch('click');
  await flushComposer();
  assert.equal(client.posts.length, 1, 'exactly one send is queued');
  const [post] = client.posts;
  assert.equal(post.channel, 'email');
  assert.equal(post.text, 'Certo, domani alle 18.');
  assert.equal(post.resource, 'contact');
  assert.equal(post.id, 'c1');
  assert.ok(!('to' in post), 'the recipient stays server-derived: the panel never sends one');
  assert.deepEqual(toasts, ['Messaggio in consegna'], 'the operator reads the queued confirmation');
});

// Production 06/11: the web answered 504 BO_SEND_PENDING after 51 s, the
// worker mailed at +2.5 min, and the panel said «non inviato» — a re-tap
// minted a new key and would have mailed twice.
const pendingSend = () => Object.assign(new Error('Invio in attesa'), {
  status: 504, code: 'BO_SEND_PENDING', requestId: 'req-1', claimId: 'claim-1',
});
const composerSendButton = (panel) => panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send');
const typeAndSend = async (panel, value = 'Certo, domani alle 18.') => {
  panel.findAll('textarea')[0].value = value;
  composerSendButton(panel).dispatch('click');
  await flushComposer(12);
};

test('composer window hangs off the view, outside the sticky side columns', async () => {
  const { mount, panel } = await openComposerMount();
  assert.equal(panel.parentNode, mount, 'a fixed window inside a sticky column would sit under the next column');
});

test('send pending: a 504 BO_SEND_PENDING reads the same request back, never a second POST', async () => {
  const client = composerClient({
    onPost: () => { throw pendingSend(); },
    onResume: (round) => {
      if (round < 3) throw pendingSend();
      return { channel: 'email', to: 'guido@palestra-esempio.it', jobId: 'job-1' };
    },
  });
  const { panel, toasts } = await openComposerMount({ client });
  await typeAndSend(panel);
  await flushComposer(24);
  assert.equal(client.posts.length, 1, 'exactly one POST');
  assert.equal(client.resumes.length, 3, 'the queued request is read back until it settles');
  assert.ok(client.resumes.every((path) => path.includes('requestId=req-1') && path.includes('claimId=claim-1')),
    'the read-back names the 504 request and its claim');
  assert.ok(client.resumes.every((path) => path.includes('spaceId=presti')),
    'the read-back names the space, like every other customer-hub read');
  assert.deepEqual(toasts, ['Messaggio in consegna'], 'the settled send reads as delivered');
});

test('send pending: while queued the panel says so and Invia is busy, not «non inviato»', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = composerClient({
    onPost: () => { throw pendingSend(); },
    onResume: async () => { await gate; throw pendingSend(); },
  });
  const { panel } = await openComposerMount({ client });
  await typeAndSend(panel);
  const send = composerSendButton(panel);
  assert.equal(send.getAttribute('disabled'), 'disabled', 'Invia is off while the message is queued');
  assert.equal(send.textContent, 'Invio…');
  assert.ok(panel.textContent.includes('In consegna'), 'the panel says the message is on its way');
  assert.ok(!panel.textContent.includes('non inviato'), 'a queued message never reads as not sent');
  release();
});

test('send pending: still queued after the wait, a re-tap reuses the same key', async () => {
  const client = composerClient({
    onPost: () => { throw pendingSend(); },
    onResume: () => { throw pendingSend(); },
  });
  const { panel } = await openComposerMount({ client });
  await typeAndSend(panel);
  await flushComposer(200);
  assert.ok(panel.textContent.includes('Ancora in coda'), 'the panel says the message is still queued');
  assert.equal(composerSendButton(panel).getAttribute('disabled'), null, 'Invia comes back after the wait');
  composerSendButton(panel).dispatch('click');
  await flushComposer(12);
  assert.equal(client.posts.length, 2);
  assert.equal(client.posts[1].messageKey, client.posts[0].messageKey,
    'the same message re-tapped carries the same key: the server finds its own request');
});

test('send pending: an edited message or a definitive failure gets a fresh key', async () => {
  const client = composerClient({
    onPost: (n) => {
      if (n === 1) throw Object.assign(new Error('gateway'), { status: 504, code: 'UNKNOWN' });
      if (n === 3) throw Object.assign(new Error('rifiutato'), { status: 400, code: 'BO_SEND_BODY_REFUSED' });
      throw Object.assign(new Error('gateway'), { status: 504, code: 'UNKNOWN' });
    },
  });
  const { panel } = await openComposerMount({ client });
  await typeAndSend(panel, 'Primo testo');
  await typeAndSend(panel, 'Primo testo');
  assert.equal(client.posts[1].messageKey, client.posts[0].messageKey, 'an unknown outcome keeps the key');
  await typeAndSend(panel, 'Primo testo');
  await typeAndSend(panel, 'Primo testo');
  assert.notEqual(client.posts[3].messageKey, client.posts[2].messageKey, 'a refused send drops the key');
  await typeAndSend(panel, 'Testo cambiato');
  assert.notEqual(client.posts[4].messageKey, client.posts[3].messageKey, 'an edited message is a new message');
});

test('send pending: reopening Scrivi stops the old read-back, which never touches the new form', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = composerClient({
    onPost: () => { throw pendingSend(); },
    onResume: async () => { await gate; return { channel: 'email', to: 'guido@palestra-esempio.it', jobId: 'job-1' }; },
  });
  const { mount, panel, toasts } = await openComposerMount({ client });
  await typeAndSend(panel);
  assert.equal(client.resumes.length, 1, 'the first read-back is in flight');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  release();
  await flushComposer(24);
  assert.equal(client.resumes.length, 1, 'the stale send reads back no more');
  assert.deepEqual(toasts, [], 'the stale send neither toasts nor re-renders');
  const send = composerSendButton(panel);
  assert.equal(send.getAttribute('disabled'), null, 'the new form Invia is not held busy by the old send');
  assert.ok(!panel.textContent.includes('In consegna'), 'the new form shows no status of the old send');
});

test('send pending: the log names code, status and request, never the claim or the text', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const client = composerClient({
      onPost: () => { throw pendingSend(); },
      onResume: () => ({ channel: 'email', to: 'guido@palestra-esempio.it', jobId: 'job-1' }),
    });
    const { panel } = await openComposerMount({ client });
    await typeAndSend(panel, 'Testo riservato');
    await flushComposer(12);
  } finally {
    console.error = original;
  }
  const pending = logged.filter(([label]) => label === '[bo] invio in attesa');
  assert.equal(pending.length, 1, 'the pending send is logged once');
  assert.deepEqual(pending[0][1], { code: 'BO_SEND_PENDING', status: 504, requestId: 'req-1' });
  assert.ok(!JSON.stringify(logged).includes('claim-1'), 'the claim id never reaches the log');
  assert.ok(!JSON.stringify(logged).includes('Testo riservato'), 'the message text never reaches the log');
});

test('send pending: a trailing space or newline keeps the same key', async () => {
  const client = composerClient({
    onPost: () => { throw Object.assign(new Error('gateway'), { status: 504, code: 'UNKNOWN' }); },
  });
  const { panel } = await openComposerMount({ client });
  await typeAndSend(panel, 'Primo testo');
  await typeAndSend(panel, 'Primo testo  \n');
  assert.equal(client.posts[1].messageKey, client.posts[0].messageKey, 'whitespace around the text is the same message');
});

test('send pending: a transient miss of the read-back keeps waiting, never «non inviato»', async () => {
  const client = composerClient({
    onPost: () => { throw pendingSend(); },
    onResume: (round) => {
      if (round === 1) throw Object.assign(new Error('status'), { status: 502, code: 'BO_SEND_STATUS_FAILED' });
      if (round === 2) throw new TypeError('Failed to fetch');
      if (round === 3) throw Object.assign(new Error('slow'), { status: 429, code: 'UNKNOWN' });
      return { channel: 'email', to: 'guido@palestra-esempio.it', jobId: 'job-1' };
    },
  });
  const { panel, toasts } = await openComposerMount({ client });
  await typeAndSend(panel);
  await flushComposer(40);
  assert.equal(client.resumes.length, 4, 'gateway, network and rate limit do not stop the read-back');
  assert.deepEqual(toasts, ['Messaggio in consegna']);
  assert.equal(client.posts.length, 1);
});

test('send pending: the worker verdict failed ends the wait with an error and a fresh key', async () => {
  const client = composerClient({
    onPost: (n) => { if (n === 1) throw pendingSend(); return { channel: 'email', jobId: 'job-2' }; },
    onResume: () => { throw Object.assign(new Error('failed'), { status: 502, code: 'BO_SEND_FAILED' }); },
  });
  const { panel } = await openComposerMount({ client });
  await typeAndSend(panel, 'Stesso testo');
  await flushComposer(12);
  assert.equal(client.resumes.length, 1);
  assert.ok(panel.textContent.includes('non inviato') || panel.textContent.includes('non è partito') || panel.textContent.includes('Riprova'),
    'a failed send says so');
  await typeAndSend(panel, 'Stesso testo');
  assert.notEqual(client.posts[1].messageKey, client.posts[0].messageKey, 'a failed send is retried as a new request');
});

test('send: 408, 425, 429 and 503 keep the key and read as uncertain, not «non inviato»', async () => {
  for (const status of [408, 425, 429, 503]) {
    const client = composerClient({ onPost: () => { throw Object.assign(new Error('later'), { status, code: 'UNKNOWN' }); } });
    const { panel } = await openComposerMount({ client });
    await typeAndSend(panel, 'Testo');
    assert.ok(panel.textContent.includes('Non sappiamo ancora se è partito'), `${status} reads as uncertain`);
    assert.ok(!panel.textContent.includes('non inviato'), `${status} never reads as not sent`);
    await typeAndSend(panel, 'Testo');
    assert.equal(client.posts[1].messageKey, client.posts[0].messageKey, `${status} keeps the key`);
  }
});

test('send: a second message while the first is pending keeps the first key', async () => {
  const client = composerClient({ onPost: () => { throw Object.assign(new Error('gateway'), { status: 504, code: 'UNKNOWN' }); } });
  const { panel } = await openComposerMount({ client });
  await typeAndSend(panel, 'Primo messaggio');
  await typeAndSend(panel, 'Secondo messaggio');
  await typeAndSend(panel, 'Primo messaggio');
  assert.notEqual(client.posts[1].messageKey, client.posts[0].messageKey);
  assert.equal(client.posts[2].messageKey, client.posts[0].messageKey, 'the first message still finds its own request');
});

test('e9b4fc2f: with no linked channel every row is off and Invia stays disabled', async () => {
  const { panel } = await openComposerMount({
    client: composerClient({ connectors: { connectors: [] } }),
  });
  const send = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send');
  assert.ok(send, 'the Invia button exists');
  assert.equal(send.getAttribute('disabled'), 'disabled', 'with nothing linked there is nothing to send on');
});

// Voce a935af6a6d19 (acceptance 1): Gmail linked in the space profile, no
// email channel connection — Email reads connected and names its sender.
test('a935af6a6d19: with Gmail linked in the profile Email is connected and shows its sender', async () => {
  const { panel } = await openComposerMount({
    client: composerClient({ connectors: { connectors: [] }, profile: COMPOSER_GMAIL_PROFILE }),
  });
  const text = panel.textContent;
  assert.ok(text.includes('daniele.pelleri@gmail.com'), 'the linked mailbox reads as the sender');
  assert.ok(text.includes('guido@palestra-esempio.it'), 'the customer email still reads as the recipient');
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const byValue = (value) => radios.find((node) => node.getAttribute('value') === value);
  assert.equal(byValue('email').getAttribute('disabled'), null, 'Email is selectable on the profile Gmail link');
  assert.equal(byValue('whatsapp').getAttribute('disabled'), 'disabled', 'WhatsApp without a connection stays off');
  const links = panel.findAll('a').filter((node) => node.getAttribute('data-action') === 'composer-connectors');
  assert.ok(links.length > 0, 'the truly unlinked channels still link to Connettori');
  const send = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send');
  assert.equal(send.getAttribute('disabled'), null, 'Invia is available on the Gmail-linked Email');
});

// Voce eaa84ccafc53: the pilot merges the profile mailbox into the
// connections as an active email row. The «Da» row names that mailbox and
// the `profile:` connection key never reads as text.
const fromValueOf = (panel) => {
  const row = panel.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'bo-composer-row'
    && node.childNodes[0]?.textContent === 'Da');
  return row ? row.childNodes[1].textContent : null;
};

test('eaa84ccafc53: a profile-sourced email row fills «Da» with its mailbox', async () => {
  const { panel } = await openComposerMount({
    client: composerClient({
      connectors: { connectors: [{ connectionKey: 'profile:gmail', channel: 'email', account: ' studio@palestra.it ', status: 'active', source: 'profile' }] },
      profile: null,
    }),
  });
  assert.equal(fromValueOf(panel), 'studio@palestra.it', 'Da names the linked mailbox');
  assert.ok(!panel.textContent.toLowerCase().includes('profile:'), 'the connection key never reads as text');
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  assert.equal(radios.find((node) => node.getAttribute('value') === 'email').getAttribute('disabled'), null);
});

test('eaa84ccafc53: without the email row the profile Gmail still fills «Da»; a key never does', async () => {
  const old = await openComposerMount({
    client: composerClient({ connectors: { connectors: [] }, profile: COMPOSER_GMAIL_PROFILE }),
  });
  assert.equal(fromValueOf(old.panel), 'daniele.pelleri@gmail.com', 'the old shape is unchanged');
  const keyOnly = await openComposerMount({
    client: composerClient({
      connectors: { connectors: [{ connectionKey: 'profile:gmail', channel: 'email', account: 'profile:gmail', status: 'active' }] },
      profile: null,
    }),
  });
  assert.equal(fromValueOf(keyOnly.panel), '', 'a key posing as an account is never a sender');
  assert.ok(!keyOnly.panel.textContent.toLowerCase().includes('profile:'));
});

// Review #648 P1: the synthetic profile row is no channel connection — its
// `profile:` key never travels in the send payload; the server derives the
// route from the space mailbox.
test('review #648: a profile-sourced email row sends no connectionKey', async () => {
  for (const row of [
    { connectionKey: 'profile:gmail', channel: 'email', account: 'studio@palestra.it', status: 'active', source: 'profile' },
    { connectionKey: 'PROFILE:gmail', channel: 'email', account: 'studio@palestra.it', status: 'active' },
  ]) {
    const client = composerClient({ connectors: { connectors: [row] } });
    const { panel } = await openComposerMount({ client });
    assert.equal(fromValueOf(panel), 'studio@palestra.it');
    await typeAndSend(panel, 'Ciao Guido');
    assert.equal(client.posts.length, 1, `${row.connectionKey}: the send goes out`);
    assert.equal(client.posts[0].channel, 'email');
    assert.equal('connectionKey' in client.posts[0], false, `${row.connectionKey}: the synthetic key is never sent`);
  }
  // A real connection still sends its own key.
  const real = composerClient();
  const { panel } = await openComposerMount({ client: real });
  await typeAndSend(panel, 'Ciao Guido');
  assert.equal(real.posts[0].connectionKey, 'gmail-1', 'a real connection keeps its route');
});

// Review #648 giro 2 P1: with the synthetic profile row listed first and a
// real email connection after it, the real row routes the send and names
// «Da» — never the synthetic key, never a «Da» the route does not send from.
test('review #648 giro 2: a real email connection wins over the synthetic profile row, whatever the order', async () => {
  for (const syntheticKey of ['profile:gmail', 'PROFILE:Gmail']) {
    const client = composerClient({
      connectors: { connectors: [
        { connectionKey: syntheticKey, channel: 'email', account: 'studio@palestra.it', status: 'active', source: 'profile' },
        { connectionKey: 'real-123', channel: 'email', account: 'reale@studio.it', status: 'active' },
      ] },
    });
    const { panel } = await openComposerMount({ client });
    assert.equal(fromValueOf(panel), 'reale@studio.it', `${syntheticKey}: «Da» names the mailbox the route sends from`);
    await typeAndSend(panel, 'Ciao Guido');
    assert.equal(client.posts.length, 1);
    assert.equal(client.posts[0].connectionKey, 'real-123', `${syntheticKey}: the send queues on the real route`);
    assert.ok(!panel.textContent.toLowerCase().includes('profile:'));
  }
});

// Review #648 P1/P2: «connected» implies a valid sender. A linked Email row
// with no mailbox, or a key (any case) posing as one, reads off with the
// Connettori link — never an enabled channel with an empty «Da».
test('review #648: a linked Email without a valid sender is not sendable', async () => {
  for (const account of ['', '   ', 'PROFILE:gmail', 'Profile:Gmail', 'gmail-1']) {
    const client = composerClient({
      connectors: { connectors: [{ connectionKey: 'gmail-1', channel: 'email', account, status: 'active' }] },
    });
    const { panel } = await openComposerMount({ client });
    const email = panel.findAll('input').find((node) => node.getAttribute('name') === 'composer-channel' && node.getAttribute('value') === 'email');
    assert.equal(email.getAttribute('disabled'), 'disabled', `account «${account}»: Email is off`);
    const off = panel.findAll('p').find((node) => String(node.getAttribute('class') ?? '').includes('bo-composer-off'));
    assert.ok(off && off.textContent.includes('Email (guido@palestra-esempio.it)'), `account «${account}»: the off line names Email`);
    assert.ok(off.findAll('a').some((node) => node.getAttribute('data-action') === 'composer-connectors'), 'with its Collega in Connettori link');
    assert.equal(composerSendButton(panel).getAttribute('disabled'), 'disabled', 'nothing to send on');
    assert.ok(!panel.textContent.toLowerCase().includes('profile:'), 'the key never reads as text');
  }
});

// Voce a935af6a6d19 (acceptance 2): a channel with no link anywhere — no
// channel connection and no profile Gmail — reads off with its Collega link.
test('a935af6a6d19: a truly unlinked channel shows Collega to Connettori', async () => {
  const { panel } = await openComposerMount({
    client: composerClient({
      connectors: { connectors: [] },
      profile: {
        member: { name: 'Daniele Pelleri', email: 'daniele.pelleri@gmail.com', role: 'owner' },
        connections: {
          available: true,
          reason: null,
          items: [{ connector: 'gmail', status: 'disconnected', account: '' }],
        },
      },
    }),
  });
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const byValue = (value) => radios.find((node) => node.getAttribute('value') === value);
  assert.equal(byValue('email').getAttribute('disabled'), 'disabled', 'Email without any link stays off');
  assert.ok(panel.textContent.includes('non collegato'), 'the off channel says it is not linked');
  const link = panel.findAll('a').find((node) => node.getAttribute('data-action') === 'composer-connectors');
  assert.ok(link, 'the off channel links to Connettori');
  assert.equal(link.getAttribute('href'), '#/connettori');
});

// Voce 8ce25b0f445f (P3 review su #588): unlinked channels name the address
// to link in the visible «canale non collegato» line — a phone has no hover.
test('8ce25b0f445f: unlinked channels name their address in the off line', async () => {
  const { panel } = await openComposerMount();
  const off = panel.findAll('p')
    .find((node) => String(node.getAttribute('class') ?? '').includes('bo-composer-off'));
  assert.ok(off, 'the off line exists');
  assert.ok(off.textContent.includes('non collegato'), 'the off line says the channel is not linked');
  assert.ok(off.textContent.includes('+39 333 1234567'),
    'the off line names the number to link, readable without hover');
});

// Voce 8ce25b0f445f (P3 review su #588): Scrivi pressed twice while channels
// load paints the newest opening only — no crash, no doubled form.
test('8ce25b0f445f: Scrivi twice while loading paints one panel', async () => {
  const profileReleases = [];
  const connectorReleases = [];
  const slow = composerClient();
  const client = {
    posts: slow.posts,
    async request(path, options = {}) {
      if (path === '/api/profile') {
        return new Promise((_, reject) => profileReleases.push(
          () => reject(Object.assign(new Error('no profile'), { status: 404 }))));
      }
      if (path.startsWith('/api/connectors')) {
        return new Promise((resolve) => connectorReleases.push(() => resolve(COMPOSER_CONNECTORS)));
      }
      return slow.request(path, options);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, spaceId: 'presti' }).renderCard('contact', 'c1');
  const write = mount.findAll('button')
    .find((node) => node.getAttribute('data-action') === 'compose-message');
  assert.ok(write, 'a Scrivi action exists');
  write.dispatch('click');
  write.dispatch('click');
  assert.equal(profileReleases.length, 2, 'both openings are loading');
  for (const release of profileReleases.splice(0)) release();
  await flushComposer();
  assert.equal(connectorReleases.length, 1, 'only the newest opening keeps loading');
  for (const release of connectorReleases.splice(0)) release();
  await flushComposer();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(panel, 'the composer panel is open');
  const bodies = panel.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-composer-body'));
  assert.equal(bodies.length, 1, 'the newest opening paints exactly one form');
  assert.ok(!panel.textContent.includes('Leggo i canali collegati'),
    'no stale loading line survives the newest opening');
});

// Voce a935af6a6d19: a revoked Gmail link connects nothing — revocation
// reads like no link, never like a sender.
test('a935af6a6d19: a revoked Gmail link leaves Email off', async () => {
  const { panel } = await openComposerMount({
    client: composerClient({
      connectors: { connectors: [] },
      profile: {
        member: { name: 'Daniele Pelleri', email: null, role: 'owner' },
        connections: {
          available: true,
          reason: null,
          items: [{ connector: 'gmail', status: 'revoked', account: 'daniele.pelleri@gmail.com' }],
        },
      },
    }),
  });
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const email = radios.find((node) => node.getAttribute('value') === 'email');
  assert.equal(email.getAttribute('disabled'), 'disabled', 'a revoked mailbox connects nothing');
  assert.ok(!panel.textContent.includes('daniele.pelleri@gmail.com'), 'no sender reads from a revoked link');
});

test('e9b4fc2f: the composer names its honest limit and shows the text refusal', async () => {
  const refusal = {
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Il messaggio non entra nella cronologia (limite: 2000 caratteri): il testo è lungo',
    details: { field: 'text' },
  };
  const base = composerClient();
  const client = {
    ...base,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/customer-hub/messages' && (options.method ?? 'GET') === 'POST') throw refusal;
      return base.request(path, options);
    },
  };
  const { panel } = await openComposerMount({ client });
  assert.ok(panel.textContent.includes('Massimo 2000 caratteri'), 'the composer names its honest limit');
  const area = panel.findAll('textarea')[0];
  assert.ok(area, 'the composer has its text field');
  area.value = `Salve, ${'x'.repeat(1994)}`;
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send').dispatch('click');
  await flushComposer();
  const err = panel.findAll('p').find((node) => String(node.getAttribute('class') ?? '').includes('field-error'));
  assert.ok(err, 'the composer has its error line');
  assert.ok(
    String(err.textContent ?? '').includes('limite: 2000 caratteri'),
    'the text refusal names the limit instead of a generic failure',
  );
});

// Voce c2793930850a: the four quick actions are equal tiles — Chiama,
// Scrivi, Nuova offerta and Nuovo appuntamento all carry the tile class, so
// the 2x2 grid never shows a bare overflowing button. The note field, its
// button and the help sentence live in the note form block inside the card,
// and the ✦ union note keeps its class (its card-text size is CSS).
test('c2793930850a: quick actions are equal tiles, the note form holds field, button and help', async () => {
  const mount = await renderCard(stubClient());
  const byAction = (action) => mount.findAll('button')
    .find((node) => node.getAttribute('data-action') === action);
  for (const action of ['call-customer', 'compose-message', 'new-offer', 'new-appointment']) {
    const tile = byAction(action);
    assert.ok(tile, `the ${action} quick action exists`);
    assert.ok(String(tile.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-tile'),
      `${action} is a tile like the other three`);
  }
  const form = mount.findAll('div')
    .find((node) => node.getAttribute('class') === 'bo-scheda-note-form');
  assert.ok(form, 'the note field lives in the note form block');
  assert.ok(form.findAll('input').some((node) => node.getAttribute('name') === 'noteBody'),
    'the note field is inside the form');
  assert.ok(form.findAll('button').some((node) => node.getAttribute('data-action') === 'add-note'),
    'the note button is inside the form');
  assert.ok(form.textContent.includes('Non viene inviata a nessuno'),
    'the help sentence stays inside the card form');
  // bo:shots at 1440 cut «Nuovo appuntamento» mid-word (appuntam/ento):
  // overflow-wrap:anywhere shrinks the tile below its longest word, so the
  // tile rule must wrap at spaces (break-word), never inside a word.
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const tileRules = [...css.matchAll(/\.bo-scheda-tile\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(tileRules.length > 0, 'the tile rule exists in styles.css');
  const tileRule = tileRules[tileRules.length - 1];
  // 31/10 (bo:shots su 79efbf01): break-word spezza ancora una parola più
  // larga della tessera; la regola giusta non spezza mai dentro una parola.
  assert.ok(/word-break\s*:\s*keep-all/.test(tileRule) && !/overflow-wrap\s*:\s*break-word/.test(tileRule),
    'the tile never breaks inside a word (keep-all, no break-word)');
  assert.ok(!/overflow-wrap\s*:\s*anywhere/.test(tileRule),
    'the tile rule no longer shrinks below its longest word');
});

// Voce d525f4aa48b2: «✦ Chiedi all'AI» in Dettagli apre la barra AI con il
// cliente nel contesto; senza pannello, il bottone indica la barra ⌘K.
test("d525f4aa48b2: Dettagli shows «✦ Chiedi all'AI» beside Modifica and opens the AI bar with the customer in context", async () => {
  const seen = [];
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc,
    mount,
    client: stubClient(),
    onAskAi: (screenId, draft, customer) => seen.push({ screenId, draft, customer }),
  }).renderCard('contact', 'c1');
  const details = mount.findAll('section')
    .find((node) => node.findAll('h4').some((head) => head.textContent === 'Dettagli'));
  assert.ok(details, 'the Dettagli section renders');
  const edit = details.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details');
  const ask = details.findAll('button').find((node) => node.getAttribute('data-action') === 'ask-ai');
  assert.ok(edit, 'Modifica is shown');
  assert.ok(ask, 'the AI voice is shown in Dettagli');
  assert.equal(ask.textContent, "✦ Chiedi all'AI");
  ask.dispatch('click', {});
  assert.deepEqual(seen, [{
    screenId: 'scheda-cliente',
    draft: 'Cliente Guido Presti (contact/c1)',
    customer: { resource: 'contact', id: 'c1' },
  }]);
});

test("d525f4aa48b2: company schede get «✦ Chiedi all'AI» even without Modifica, and the fallback toasts the ⌘K hint", async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  await createCustomerCardView({
    doc,
    mount,
    client: stubClient({
      card: { ...CARD, subject: { resource: 'company', id: 'co1' } },
      profile: { ...PROFILE, identity: {} },
    }),
    toast: (message) => toasts.push(message),
  }).renderCard('company', 'co1');
  const buttons = mount.findAll('button');
  assert.equal(buttons.filter((node) => node.getAttribute('data-action') === 'edit-details').length, 0,
    'a company scheda shows no Modifica');
  const ask = buttons.find((node) => node.getAttribute('data-action') === 'ask-ai');
  assert.ok(ask, 'the AI voice is shown on a company scheda too');
  ask.dispatch('click', {});
  assert.ok(toasts.some((message) => message.includes('⌘K')), 'without a panel the button points at the ⌘K bar');
});

// Voce d525f4aa48b2: nessun «non disponibile:» né «verifiche non complete»
// nella scheda, in ogni combinazione che li stampava (stato, arricchiti,
// riepilogo, chiamate).
test('d525f4aa48b2: the scheda never prints «non disponibile:» or «verifiche non complete»', async () => {
  const variants = {
    'bare card': stubClient(),
    'unreadable enrichment': stubClient({ enriched: null }),
    'recorded calls': stubClient({ calls: CALLS }),
  };
  for (const [label, client] of Object.entries(variants)) {
    const mount = await renderCard(client);
    const text = mount.textContent;
    assert.ok(!text.includes('non disponibile:'), `${label}: no «non disponibile:» on screen`);
    assert.ok(!text.includes('verifiche non complete'), `${label}: no «verifiche non complete» on screen`);
  }
});

// Voce d525f4aa48b2: la frase ✦ delle identità compare una volta sola, anche
// con motivi diversi per ogni scheda unita.
test('d525f4aa48b2: distinct union reasons join into a single ✦ note', async () => {
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      canonicalIdentity: {
        ...PROFILE.canonicalIdentity,
        members: [
          { ...PROFILE.canonicalIdentity.members[0], reason: 'stesso numero su WhatsApp' },
          { ...PROFILE.canonicalIdentity.members[1], reason: 'stessa email sul form' },
        ],
      },
    },
  }));
  const notes = mount.findAll('p')
    .filter((node) => node.getAttribute('class') === 'bo-scheda-union-note');
  assert.equal(notes.length, 1, 'exactly one union note');
  assert.equal(notes[0].textContent, '✦ stesso numero su WhatsApp · stessa email sul form');
});

// Voce d525f4aa48b2: le quattro tessere condividono un'unica altezza di riga
// (bo:shots del supervisore a 1440 e 390); a 390px la colonna è una sola e
// l'ordine torna quello del DOM — Azioni rapide sopra Tutti i contatti.
test('d525f4aa48b2: tiles share one row height and the phone column stacks actions first', async () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const actionsRules = [...css.matchAll(/\.bo-scheda-actions\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(actionsRules.length > 0, 'the actions grid rule exists in styles.css');
  const actionsRule = actionsRules[actionsRules.length - 1];
  assert.ok(/grid-auto-rows\s*:\s*1fr/.test(actionsRule),
    'every grid row — both rows of the 2x2 — shares the same height');
  const phone = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.ok(/\.bo-scheda-grid\s*>\s*\.bo-scheda-col:nth-child\(2\)\s*\{[^}]*order:\s*0[^}]*\}/.test(phone),
    'at phone width the timeline-first rule stops: Azioni rapide read above Tutti i contatti');
});

/**
 * Campi personalizzati sulla scheda (backlog:434cc39a), contro un server finto.
 *
 * What it must prove: the space-wide fields read on the scheda with this
 * customer's values, an edit rewrites the value through the governed route
 * and re-reads, + Aggiungi campo defines a field for every scheda, and a
 * failed defs read hides the section without failing the scheda.
 */

const FIELD_DEFS = [
  { key: 'amico', label: 'Amico', type: 'si-no', options: [] },
  { key: 'hobby', label: 'Hobby', type: 'testo', options: [] },
];

const FIELD_VALUES = [
  { key: 'amico', label: 'Amico', type: 'si-no', options: [], value: 'sì', updatedAt: '2026-11-03', updatedBy: 'u1' },
  { key: 'hobby', label: 'Hobby', type: 'testo', options: [], value: null, updatedAt: null, updatedBy: null },
];

const flush = async (times = 24) => {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

test('434cc39a: the scheda reads the space fields with this customer values', async () => {
  const mount = await renderCard(stubClient({ fieldDefs: FIELD_DEFS, fieldValues: FIELD_VALUES }));
  const text = mount.textContent;
  assert.ok(text.includes('Campi personalizzati'), 'the section reads');
  assert.ok(text.includes('Amico'), 'the space field reads on the scheda');
  assert.ok(text.includes('sì'), 'the stored value reads');
});

test('the scheda shows a saved Sì/No value from the bare array the server answers (production 07/11)', async () => {
  // Space 2f07eeb9: GET fields/values answered 200 with this exact bare
  // array, and the scheda still showed «Amico verifica L1 —».
  const defs = [{ key: 'amico-verifica-l1', label: 'Amico verifica L1', type: 'si-no', options: [], createdBy: 'u1' }];
  const values = [{
    key: 'amico-verifica-l1', label: 'Amico verifica L1', type: 'si-no', options: [],
    createdBy: 'u1', value: 'sì', updatedAt: '2026-11-07T16:23:09.466Z', updatedBy: 'u1',
  }];
  const client = stubClient({
    onRequest: (path) => {
      if (path === '/api/customer-data/fields') return defs;
      if (path.startsWith('/api/customer-data/fields/values')) return values;
      if (path.startsWith('/api/customer-hub/')) return path.includes('/card/') ? CARD : TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) return ENRICHED;
      if (path.startsWith('/api/call-intelligence/calls/')) return null;
      throw new Error(`unexpected request ${path}`);
    },
  });
  const mount = await renderCard(client);
  const row = mount.findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-fact'
    && node.textContent.startsWith('Amico verifica L1'));
  assert.ok(row, 'the field row reads');
  assert.equal(row.childNodes[1].textContent, 'sì', 'the saved value reads, never «—»');
});

test('434cc39a: an edit rewrites the single row and re-reads', async () => {
  let saved = null;
  const client = stubClient({
    fieldDefs: FIELD_DEFS,
    fieldValues: FIELD_VALUES,
    onRequest: (path, body) => {
      if (path === '/api/customer-data/fields') return { definitions: FIELD_DEFS };
      if (path.startsWith('/api/customer-data/fields/values')) return { values: FIELD_VALUES };
      if (path === '/api/customer-data/fields/value') {
        saved = body;
        return { value: { key: body.key, label: 'Amico', type: 'si-no', options: [], value: body.value } };
      }
      if (path.startsWith('/api/customer-hub/')) return path.includes('/card/') ? CARD : TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) return ENRICHED;
      if (path.startsWith('/api/call-intelligence/calls/')) return null;
      throw new Error(`unexpected request ${path}`);
    },
  });
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');
  const edit = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-field:amico');
  assert.ok(edit, 'every field carries its Modifica');
  edit.dispatch('click');
  await flush();
  const save = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-field-value');
  assert.ok(save, 'the edit form carries Salva');
  save.dispatch('click');
  await flush();
  assert.deepEqual(saved, { resource: 'contact', id: 'c1', key: 'amico', value: 'sì' }, 'one governed value write');
});

test('434cc39a: + Aggiungi campo defines a space field from the scheda', async () => {
  let defined = null;
  const client = stubClient({
    onRequest: (path, body) => {
      if (path === '/api/customer-data/fields') return { definitions: [] };
      if (path.startsWith('/api/customer-data/fields/values')) return { values: [] };
      if (path === '/api/customer-data/fields/define') {
        defined = body;
        return { definition: { key: 'amico', label: 'Amico', type: 'si-no', options: [] }, replayed: false };
      }
      if (path.startsWith('/api/customer-hub/')) return path.includes('/card/') ? CARD : TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) return ENRICHED;
      if (path.startsWith('/api/call-intelligence/calls/')) return null;
      throw new Error(`unexpected request ${path}`);
    },
  });
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('+ Aggiungi campo'), 'the adder reads even with no fields yet');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'add-field').dispatch('click');
  await flush();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'nuovo-campo-label').value = 'Amico';
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'create-field').dispatch('click');
  await flush();
  assert.equal(defined?.label, 'Amico', 'the define reaches the governed route');
});

test('434cc39a: a failed fields read hides the section, never the scheda', async () => {
  const failure = Object.assign(new Error('PostgreSQL storage is unavailable'), { status: 503 });
  const client = stubClient({
    onRequest: (path) => {
      if (path === '/api/customer-data/fields') throw failure;
      if (path.startsWith('/api/customer-data/fields/values')) throw failure;
      if (path.startsWith('/api/customer-hub/')) return path.includes('/card/') ? CARD : TIMELINE;
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path.startsWith('/api/customer-data/enriched/')) return ENRICHED;
      if (path.startsWith('/api/call-intelligence/calls/')) return null;
      throw new Error(`unexpected request ${path}`);
    },
  });
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');
  const text = mount.textContent;
  assert.ok(!text.includes('Campi personalizzati'), 'no section on a failed read');
  assert.ok(text.includes('Guido Presti'), 'the name still shows');
});

test('every card write carries a submission-owned Idempotency-Key, as the real client demands (production 04/11)', async () => {
  // The real /bo client refuses a mutation without an idempotency key before
  // any request leaves (requireSubmissionContext): «Aggiungi nota» answered
  // «Nota non salvata» in production with no request at all.
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  const writes = [];
  const strict = {
    async request(path, opts = {}) {
      const method = String(opts?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return base.request(path);
      enforceAdminWriteGate(path, opts);
      writes.push({ path, method });
      return { ok: true };
    },
  };
  const seen = [];
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client: strict, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'noteBody').value = 'Richiamare giovedì';
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'add-note').dispatch('click');
  await flushClicks();
  assert.deepEqual(writes, [{ path: '/api/customer-hub/notes', method: 'POST' }], 'the note leaves with its key');
  assert.deepEqual(seen, [{ message: 'Nota aggiunta', error: false }]);
});

// Composer stile Gmail (Dan 04/11): ✕ and Esc close the window but never
// lose the typed text — the draft comes back when Scrivi reopens it.
test('composer gmail: closing keeps the draft and Scrivi brings it back', async () => {
  const { mount, panel } = await openComposerMount();
  const area = panel.findAll('textarea')[0];
  area.value = 'Bozza da non perdere';
  area.dispatch('input');
  const close = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-close');
  assert.ok(close, 'the window has a close button');
  close.dispatch('click');
  await flushComposer();
  assert.equal(mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open'), undefined,
    'the composer window is closed');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.ok(reopened, 'Scrivi reopens the window');
  assert.equal(reopened.findAll('textarea')[0].value, 'Bozza da non perdere', 'the draft is restored');
});

// Muse P1 on #588: Scrivi pressed again while open rebuilds the same panel;
// Cmd/Ctrl+Invio must still queue exactly one message.
test('composer gmail: reopen then Cmd+Invio sends exactly once', async () => {
  const { mount, client } = await openComposerMount();
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  panel.findAll('textarea')[0].value = 'Una volta sola';
  panel.dispatch('keydown', { key: 'Enter', metaKey: true });
  await flushComposer();
  assert.equal(client.posts.length, 1, 'one keydown, one send');
});

// Muse P2 on #588: arrow keys move the radio with `change`; the shown
// recipient and the sent channel follow it.
test('composer gmail: a keyboard change of channel moves the recipient too', async () => {
  const { panel } = await openComposerMount({
    client: composerClient({ profile: COMPOSER_GMAIL_PROFILE }),
  });
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const usable = radios.filter((node) => node.getAttribute('disabled') === null);
  assert.ok(usable.length >= 1, 'at least one usable channel');
  for (const radio of usable) {
    radio.dispatch('change');
    const chip = radio.parentNode;
    assert.equal(chip.getAttribute('data-selected'), 'true', 'the pill follows the keyboard choice');
  }
});


// Dan 06/11: a long conversation reads newest first, a page at a time, with
// readable text, and Annulla on Dettagli puts the card back without a reload.
test('the timeline shows the newest 20 first and opens older ones on demand', async () => {
  const items = Array.from({ length: 45 }, (_, index) => ({
    entry: 'message', id: `m${index}`, channel: 'email', direction: 'inbound', sync: 'received',
    body: `Messaggio ${index}`, remoteHandle: 'a@b.it',
    occurredAt: new Date(Date.UTC(2026, 10, 5, 8, index)).toISOString(),
  }));
  const mount = await renderCard(stubClient({ timeline: { ...TIMELINE, entries: { available: true, count: 45, truncated: false, items } } }));
  const shown = () => mount.findAll('div').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-entry')).map((node) => node.getAttribute('data-entry'));
  assert.equal(shown().length, 20, 'one page');
  assert.equal(shown()[0], 'm44', 'newest first');
  const older = () => mount.findAll('button').find((node) => node.getAttribute('data-action') === 'timeline-older');
  assert.equal(older().textContent, 'Mostra precedenti · 20 di 25');
  older().dispatch('click');
  assert.equal(shown().length, 40);
  older().dispatch('click');
  assert.equal(shown().length, 45);
  assert.equal(older(), undefined, 'no button when everything shows');
});

test('message text reads cleanly and a long one folds behind «Mostra tutto»', async () => {
  const long = `We&#39;ve got news &amp; more \u034f \u034f \u034f ${'parola '.repeat(80)}`;
  const items = [{ entry: 'message', id: 'x1', channel: 'email', direction: 'inbound', sync: 'received', body: long, remoteHandle: 'a@b.it', occurredAt: '2026-11-05T10:00:00.000Z' }];
  const mount = await renderCard(stubClient({ timeline: { ...TIMELINE, entries: { available: true, count: 1, truncated: false, items } } }));
  const body = mount.findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-entry-body');
  assert.ok(body.textContent.startsWith("We've got news & more parola"), body.textContent.slice(0, 40));
  assert.ok(!/&#39;|&amp;|\u034f/.test(body.textContent), 'no entity or padding left');
  assert.equal(body.getAttribute('data-folded'), 'true');
  const more = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'entry-expand');
  more.dispatch('click');
  assert.equal(body.getAttribute('data-folded'), 'false');
  assert.equal(more.textContent, 'Mostra meno');
});

test('Annulla on Dettagli restores the card in place, without re-reading the scheda', async () => {
  const client = stubClient();
  const mount = await renderCard(client);
  const before = client.calls ? client.calls.length : null;
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'cancel-details'));
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-details').dispatch('click');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'edit-details'), 'Modifica is back');
  assert.ok(mount.textContent.includes('Tutti i contatti'), 'the scheda never blanks');
  if (before !== null) assert.equal(client.calls.length, before, 'no re-read of the card');
});

// «Da leggere» (Dan 06/11): the unread inbound messages read «Nuovo» and
// opening the scheda marks them read, up to the newest one.
async function unreadCard({ items, spaceId = 'presti', onMark = null }) {
  const doc = createFakeDocument();
  const mount = createMount();
  const marks = [];
  const base = stubClient();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-hub/timeline/')) {
        return { entries: { available: true, count: items.length, truncated: false, items }, appointments: { available: true, items: [] } };
      }
      if (path === '/api/customer-hub/mark-read') {
        marks.push(JSON.parse(options.body));
        if (onMark) return onMark();
        return { ok: true };
      }
      return base.request(path, options);
    },
  };
  await createCustomerCardView({ doc, mount, client, spaceId }).renderCard('contact', 'c1');
  await flushComposer(6);
  return { mount, marks };
}
const inbound = (id, at, read) => ({ entry: 'message', id, conversationId: 't1', channel: 'email', direction: 'inbound', sync: 'received', body: `testo ${id}`, remoteHandle: 'guido@palestra-esempio.it', occurredAt: at, read });

test('da leggere: unread inbound messages read «Nuovo» and the scheda marks them read up to the newest', async () => {
  const { mount, marks } = await unreadCard({ items: [
    inbound('m1', '2026-11-06T08:00:00.000Z', true),
    inbound('m2', '2026-11-06T09:00:00.000Z', false),
    inbound('m3', '2026-11-06T10:00:00.000Z', false),
    { ...inbound('o1', '2026-11-06T11:00:00.000Z', false), direction: 'outbound', remoteHandle: null },
  ] });
  const unread = mount.findAll('div').filter((node) => node.getAttribute('data-unread') === 'true').map((node) => node.getAttribute('data-entry'));
  assert.deepEqual(unread.sort(), ['m2', 'm3'], 'only unread inbound messages light up, never an outbound one');
  assert.equal(mount.findAll('span').filter((node) => node.textContent === 'Nuovo').length, 2);
  assert.deepEqual(marks, [{ spaceId: 'presti', resource: 'contact', id: 'c1', upTo: '2026-11-06T10:00:00.000Z' }]);
});

test('da leggere: nothing unread or no read state sends no mark, and a refused mark stays silent', async () => {
  const none = await unreadCard({ items: [inbound('m1', '2026-11-06T08:00:00.000Z', true)] });
  assert.deepEqual(none.marks, []);
  const legacy = await unreadCard({ items: [inbound('m1', '2026-11-06T08:00:00.000Z', undefined)] });
  assert.deepEqual(legacy.marks, [], 'an older server without read state is never asked');
  assert.equal(legacy.mount.findAll('div').filter((node) => node.getAttribute('data-unread') !== null).length, 0);
  const refused = await unreadCard({
    items: [inbound('m1', '2026-11-06T08:00:00.000Z', false)],
    onMark: () => { throw Object.assign(new Error('nope'), { status: 404 }); },
  });
  assert.equal(refused.marks.length, 1);
  assert.ok(refused.mount.textContent.includes('testo m1'), 'the scheda stays whole');
});

test('da leggere: badge and mark-read share one rule — no direction or no date never lights up', async () => {
  const { mount, marks } = await unreadCard({ items: [
    { ...inbound('nodir', '2026-11-06T12:00:00.000Z', false), direction: undefined },
    inbound('nodate', null, false),
    inbound('bad', 'ieri', false),
    inbound('ok', '2026-11-06T09:00:00.000Z', false),
  ] });
  const lit = mount.findAll('div').filter((node) => node.getAttribute('data-unread') === 'true').map((node) => node.getAttribute('data-entry'));
  assert.deepEqual(lit, ['ok'], 'only what mark-read can reach lights up');
  assert.deepEqual(marks.map((mark) => mark.upTo), ['2026-11-06T09:00:00.000Z']);
});

// Composer agentico (Dan 05/11): «Chiedi all'AI» writes the text from a
// prompt through POST /api/customer-hub/messages/draft; it never sends.
function draftClient(answer) {
  const inner = composerClient();
  const drafts = [];
  return {
    posts: inner.posts,
    drafts,
    async request(path, options = {}) {
      if (path === '/api/customer-hub/messages/draft') {
        enforceAdminWriteGate(path, options);
        drafts.push(JSON.parse(options.body));
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return inner.request(path, options);
    },
  };
}
const aiParts = (panel) => ({
  input: panel.findAll('input').find((node) => String(node.getAttribute('class') ?? '').includes('bo-composer-ai-input')),
  go: panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-generate'),
  area: panel.findAll('textarea')[0],
  subject: panel.findAll('input').find((node) => String(node.getAttribute('class') ?? '').includes('composer-subject')),
});

test('composer AI: a prompt fills message and empty subject, editable, and nothing is sent', async () => {
  const client = draftClient({ subject: 'Prova di giovedì', body: 'Ciao Guido, ti aspettiamo giovedì alle 18 per la prova.' });
  const { panel, toasts } = await openComposerMount({ client });
  const { input, go, area, subject } = aiParts(panel);
  assert.ok(input && go, 'the AI row sits in the composer');
  assert.equal(go.textContent, 'Genera');
  input.value = 'ricordagli la prova di giovedì';
  go.dispatch('click');
  await flushComposer();
  assert.deepEqual(client.drafts, [{ spaceId: 'presti', contactId: 'c1', channel: 'email', prompt: 'ricordagli la prova di giovedì' }]);
  assert.equal(area.value, 'Ciao Guido, ti aspettiamo giovedì alle 18 per la prova.');
  assert.equal(subject.value, 'Prova di giovedì');
  assert.equal(go.textContent, 'Rigenera');
  assert.match(panel.textContent, /rileggila e modificala prima di inviare/);
  assert.equal(client.posts.length, 0, 'the draft never sends');
  assert.deepEqual(toasts, []);
});

test('composer AI (backlog:01289e73): three versions offer a choice, never one text at once', async () => {
  const versions = {
    corta: 'Ciao Guido!',
    lunga: 'Ciao Guido, ti aspettiamo giovedì alle 18 per la prova con piacere.',
    diretta: 'Guido, ci vediamo giovedì alle 18 per la prova.',
  };
  const client = draftClient({ ...versions, subject: 'Prova di giovedì' });
  const { panel, toasts } = await openComposerMount({ client });
  const { input, go, area, subject } = aiParts(panel);
  area.value = 'Il mio testo';
  input.value = 'ricordagli la prova di giovedì';
  go.dispatch('click');
  await flushComposer();
  assert.equal(area.value, 'Il mio testo', 'no version fills the field before the member picks one');
  const picks = panel.findAll('button').filter((node) => node.getAttribute('data-action') === 'composer-ai-pick');
  assert.deepEqual(picks.map((node) => node.textContent), ['Corta', 'Lunga', 'Diretta']);
  assert.match(panel.textContent, /Scegli la versione da usare/);
  picks[1].dispatch('click');
  await flushComposer();
  assert.equal(area.value, versions.lunga, 'the picked wording fills the message, editable');
  assert.equal(subject.value, 'Prova di giovedì');
  assert.equal(go.textContent, 'Rigenera');
  assert.equal(client.posts.length, 0, 'the draft never sends');
  assert.deepEqual(toasts, []);
  const undo = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-undo');
  assert.ok(undo, 'Annulla is offered after the pick');
  undo.dispatch('click');
  assert.equal(area.value, 'Il mio testo');
});

// Muse #718 P2: a channel switch between the answer and the pick replaces
// the subject input; the pick fills the live one, never a detached field.
test('composer AI (backlog:01289e73): a pick after a channel switch fills the live subject', async () => {
  const client = draftClient({ corta: 'Ciao!', lunga: 'Ciao Guido, ci vediamo giovedì.', diretta: 'Giovedì alle 18.', subject: 'Prova di giovedì' });
  const { panel } = await openComposerMount({ client });
  const { input, go, area, subject: before } = aiParts(panel);
  input.value = 'ricordagli la prova';
  go.dispatch('click');
  await flushComposer();
  const radios = panel.findAll('input').filter((node) => node.getAttribute('name') === 'composer-channel');
  const byValue = (value) => radios.find((node) => node.getAttribute('value') === value);
  byValue('instagram').dispatch('change');
  byValue('email').dispatch('change');
  const live = aiParts(panel).subject;
  assert.ok(live && live !== before, 'the switch back to Email mounts a new subject field');
  const picks = panel.findAll('button').filter((node) => node.getAttribute('data-action') === 'composer-ai-pick');
  picks[0].dispatch('click');
  await flushComposer();
  assert.equal(area.value, 'Ciao!');
  assert.equal(live.value, 'Prova di giovedì', 'the title lands in the subject the member sees');
});

// Production 10/11 12:41Z (seguito di #718): after a pick the three
// versions stay on screen; switching version refills the field with no new
// draft call, and a hand-edited text is never replaced in silence.
const aiPicks = (panel) => panel.findAll('button').filter((node) => node.getAttribute('data-action') === 'composer-ai-pick');
const threeVersions = {
  corta: 'Ciao Guido!',
  lunga: 'Ciao Guido, ti aspettiamo giovedì alle 18 per la prova con piacere.',
  diretta: 'Guido, ci vediamo giovedì alle 18 per la prova.',
};
async function pickedComposer() {
  const client = draftClient({ ...threeVersions, subject: 'Prova di giovedì' });
  const { panel, toasts } = await openComposerMount({ client });
  const parts = aiParts(panel);
  parts.area.value = 'Il mio testo';
  parts.input.value = 'ricordagli la prova di giovedì';
  parts.go.dispatch('click');
  await flushComposer();
  aiPicks(panel)[2].dispatch('click');
  await flushComposer();
  return { client, panel, toasts, ...parts };
}

test('composer AI: after a pick the three versions stay, the picked one is marked, a switch calls nothing', async () => {
  const { client, panel, area, subject, toasts } = await pickedComposer();
  assert.equal(area.value, threeVersions.diretta);
  assert.equal(subject.value, 'Prova di giovedì');
  const picks = aiPicks(panel);
  assert.deepEqual(picks.map((node) => node.textContent), ['Corta', 'Lunga', 'Diretta'], 'the three versions stay after the pick');
  assert.deepEqual(picks.map((node) => node.getAttribute('aria-pressed')), ['false', 'false', 'true'], 'the picked version reads as selected');
  picks[0].dispatch('click');
  await flushComposer();
  assert.equal(area.value, threeVersions.corta, 'switching refills the field with the other version');
  assert.deepEqual(aiPicks(panel).map((node) => node.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  assert.equal(subject.value, 'Prova di giovedì');
  assert.equal(client.drafts.length, 1, 'a switch never asks the draft route again');
  assert.equal(client.posts.length, 0, 'the draft never sends');
  assert.deepEqual(toasts, []);
  const undo = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-undo');
  assert.ok(undo, 'Annulla stays offered');
  undo.dispatch('click');
  assert.equal(area.value, 'Il mio testo');
  assert.deepEqual(aiPicks(panel).map((node) => node.getAttribute('aria-pressed')), ['false', 'false', 'false'], 'Annulla keeps the versions, none selected');
  aiPicks(panel)[1].dispatch('click');
  await flushComposer();
  assert.equal(area.value, threeVersions.lunga, 'after Annulla a pick fills again, no confirmation over the person’s own text');
  assert.equal(client.drafts.length, 1);
});

test('composer AI: a hand-edited text asks inline before a version replaces it, and Tieni il mio keeps it', async () => {
  const { client, panel, area } = await pickedComposer();
  area.value = `${threeVersions.diretta} A presto, Laura`;
  aiPicks(panel)[1].dispatch('click');
  await flushComposer();
  assert.equal(area.value, `${threeVersions.diretta} A presto, Laura`, 'the edits are never replaced in silence');
  assert.match(panel.textContent, /Sostituire il testo modificato/);
  const keep = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-keep');
  assert.ok(keep, 'the member can keep the edited text');
  keep.dispatch('click');
  assert.equal(area.value, `${threeVersions.diretta} A presto, Laura`);
  assert.doesNotMatch(panel.textContent, /Sostituire il testo modificato/);
  assert.deepEqual(aiPicks(panel).map((node) => node.getAttribute('aria-pressed')), ['false', 'false', 'true'], 'the selection stays on the kept version');
  // Replace when confirmed.
  aiPicks(panel)[1].dispatch('click');
  await flushComposer();
  const replace = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-replace');
  assert.ok(replace, 'Sostituisci confirms inline');
  replace.dispatch('click');
  await flushComposer();
  assert.equal(area.value, threeVersions.lunga);
  assert.deepEqual(aiPicks(panel).map((node) => node.getAttribute('aria-pressed')), ['false', 'true', 'false']);
  assert.equal(client.drafts.length, 1, 'no new draft call');
});

test('composer AI: Rigenera asks three new versions that replace the old choice', async () => {
  const { client, panel, go } = await pickedComposer();
  assert.equal(go.textContent, 'Rigenera');
  go.dispatch('click');
  await flushComposer();
  assert.equal(client.drafts.length, 2, 'Rigenera is the one way to ask again');
  const picks = aiPicks(panel);
  assert.equal(picks.length, 3, 'one set of versions, never two');
  assert.deepEqual(picks.map((node) => node.getAttribute('aria-pressed')), ['false', 'false', 'false'], 'new versions start unpicked');
});

test('composer AI (backlog:01289e73): a single-text answer from an older pilot still fills at once', async () => {
  const client = draftClient({ subject: 'Prova di giovedì', body: 'Ciao Guido, ti aspettiamo giovedì alle 18 per la prova.' });
  const { panel } = await openComposerMount({ client });
  const { input, go, area } = aiParts(panel);
  input.value = 'ricordagli la prova di giovedì';
  go.dispatch('click');
  await flushComposer();
  assert.deepEqual(
    panel.findAll('button').filter((node) => node.getAttribute('data-action') === 'composer-ai-pick'),
    [],
    'no choice buttons on a legacy single-text answer',
  );
  assert.equal(area.value, 'Ciao Guido, ti aspettiamo giovedì alle 18 per la prova.');
});

test('composer AI: existing text is replaced with an Annulla that restores it once', async () => {
  const client = draftClient({ body: 'Testo dell’AI' });
  const { panel } = await openComposerMount({ client });
  const { input, go, area, subject } = aiParts(panel);
  area.value = 'Il mio testo';
  subject.value = 'Oggetto mio';
  input.value = 'più cortese';
  go.dispatch('click');
  await flushComposer();
  assert.equal(area.value, 'Testo dell’AI');
  assert.equal(subject.value, 'Oggetto mio', 'a subject the person wrote is never overwritten');
  const undo = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-undo');
  assert.ok(undo, 'Annulla is offered');
  undo.dispatch('click');
  assert.equal(area.value, 'Il mio testo');
});

test('composer AI: an empty prompt asks for words and sends no request', async () => {
  const client = draftClient({ body: 'x' });
  const { panel } = await openComposerMount({ client });
  const { go } = aiParts(panel);
  go.dispatch('click');
  await flushComposer();
  assert.equal(client.drafts.length, 0);
  assert.match(panel.textContent, /Scrivi cosa vuoi dire al cliente/);
});

test('composer AI: AI off or route missing turns the row into one honest line', async () => {
  const cases = [
    [Object.assign(new Error('off'), { status: 503, code: 'LLM_SPACE_DISABLED' }), /non è attiva in questo spazio/],
    [Object.assign(new Error('no key'), { status: 503, code: 'LLM_SECRET_UNAVAILABLE' }), /non è ancora configurata/],
    [Object.assign(new Error('nope'), { status: 405 }), /non è ancora disponibile qui/],
  ];
  for (const [error, sentence] of cases) {
    const client = draftClient(error);
    const { panel } = await openComposerMount({ client });
    const { input, go } = aiParts(panel);
    input.value = 'scrivi tu';
    const logged = [];
    const realError = console.error;
    console.error = (...args) => { logged.push(args); };
    try {
      go.dispatch('click');
      await flushComposer();
    } finally {
      console.error = realError;
    }
    assert.equal(logged.length, 1, 'AI off leaves one line for the operator');
    assert.equal(logged[0][0], '[bo] AI spenta nel composer');
    assert.deepEqual(Object.keys(logged[0][1]).sort(), ['code', 'spaceId', 'status']);
    assert.equal(logged[0][1].code, error.code ?? null);
    assert.equal(logged[0][1].status, error.status);
    assert.ok(!JSON.stringify(logged).includes('scrivi tu'), 'the prompt never reaches the log');
    assert.match(panel.textContent, sentence);
    assert.equal(aiParts(panel).go, undefined, 'no dead Genera button stays');
    assert.ok(aiParts(panel).area, 'the message field stays for writing by hand');
    assert.ok(!panel.textContent.includes(error.code ?? 'LLM_'), 'no code on screen');
  }
});

test('review #599 P2: an AI draft that lands after close and reopen never overwrites the new typing', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const inner = composerClient();
  const client = {
    posts: inner.posts,
    async request(path, options = {}) {
      if (path === '/api/customer-hub/messages/draft') {
        enforceAdminWriteGate(path, options);
        await pending;
        return { body: 'Testo vecchio dell’AI' };
      }
      return inner.request(path, options);
    },
  };
  const { mount, panel } = await openComposerMount({ client });
  const first = aiParts(panel);
  first.input.value = 'scrivi tu';
  first.go.dispatch('click');
  await flushComposer(2);
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-close').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  const area = reopened.findAll('textarea')[0];
  area.value = 'IBAN per il bonifico';
  area.dispatch?.('input');
  release();
  await flushComposer();
  assert.equal(area.value, 'IBAN per il bonifico', 'the visible text keeps the new typing');
  reopened.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-close').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const third = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.equal(third.findAll('textarea')[0].value, 'IBAN per il bonifico', 'the shared draft kept the new typing, not the stale AI text');
});

test('review #599 P2: Annulla restores the subject the AI filled, and the shared draft drops it', async () => {
  const client = draftClient({ subject: 'S-AI', body: 'B' });
  const { mount, panel } = await openComposerMount({ client });
  const { input, go, area, subject } = aiParts(panel);
  area.value = 'A';
  area.dispatch?.('input');
  input.value = 'più cortese';
  go.dispatch('click');
  await flushComposer();
  assert.equal(subject.value, 'S-AI');
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-undo').dispatch('click');
  assert.equal(area.value, 'A');
  assert.equal(subject.value, '', 'the AI subject is undone too');
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-close').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const again = aiParts(mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open'));
  assert.equal(again.area.value, 'A');
  assert.equal(again.subject.value, '', 'the shared draft kept the undo');
});

test('review #599 P2: closing after Genera keeps the way back to the person’s text across reopen', async () => {
  const client = draftClient({ body: 'Testo AI' });
  const { mount, panel } = await openComposerMount({ client });
  const first = aiParts(panel);
  first.area.value = 'Il mio testo';
  first.area.dispatch?.('input');
  first.input.value = 'riscrivi';
  first.go.dispatch('click');
  await flushComposer();
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-close').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  const parts = aiParts(reopened);
  assert.equal(parts.area.value, 'Testo AI', 'the AI draft comes back');
  const undo = reopened.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-undo');
  assert.ok(undo, 'Annulla is still offered after reopen');
  undo.dispatch('click');
  assert.equal(parts.area.value, 'Il mio testo', 'the original text is never lost');
});

test('review #599 P3: the prompt is cut to 500 characters before it leaves', async () => {
  const client = draftClient({ body: 'ok' });
  const { panel } = await openComposerMount({ client });
  const { input, go } = aiParts(panel);
  input.value = 'x'.repeat(800);
  go.dispatch('click');
  await flushComposer();
  assert.equal(client.drafts[0].prompt.length, 500);
});

const chooseChannel = (panel, channel) => {
  const radio = panel.findAll('input').find((node) => node.getAttribute('name') === 'composer-channel'
    && (node.getAttribute('value') ?? node.value) === channel);
  assert.ok(radio, `the ${channel} chip exists`);
  assert.equal(radio.getAttribute('disabled'), null, `${channel} is usable`);
  radio.checked = true;
  radio.dispatch('change');
};

test('review #599 P2 (round 3): Annulla on another channel still drops the AI subject for Email', async () => {
  const client = draftClient({ subject: 'S-AI', body: 'B' });
  const { panel } = await openComposerMount({ client });
  const { input, go, area } = aiParts(panel);
  area.value = 'A';
  input.value = 'più cortese';
  go.dispatch('click');
  await flushComposer();
  assert.equal(aiParts(panel).subject.value, 'S-AI');
  chooseChannel(panel, 'instagram');
  assert.equal(aiParts(panel).subject, undefined, 'Instagram has no subject field');
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-ai-undo').dispatch('click');
  assert.equal(aiParts(panel).area.value, 'A');
  chooseChannel(panel, 'email');
  assert.equal(aiParts(panel).subject.value, '', 'the undone AI subject never comes back');
});

test('review #599 P3: a 400 says to write the prompt shorter and Genera stays', async () => {
  const client = draftClient(Object.assign(new Error('bad'), { status: 400, code: 'BO_DRAFT_REFUSED' }));
  const { panel } = await openComposerMount({ client });
  const { input, go } = aiParts(panel);
  input.value = 'scrivi tu';
  go.dispatch('click');
  await flushComposer();
  assert.match(panel.textContent, /scrivila più breve e con parole tue/);
  assert.ok(aiParts(panel).go, 'Genera stays for another try');
  assert.ok(!panel.textContent.includes('BO_DRAFT_REFUSED'), 'no code on screen');
});

test('review #599 P3: with no connected channel Genera asks no draft and says why', async () => {
  const inner = draftClient({ body: 'x' });
  const client = {
    posts: inner.posts,
    drafts: inner.drafts,
    async request(path, options = {}) {
      if (path.startsWith('/api/connectors')) return { connectors: [] };
      if (path === '/api/profile') return { member: {}, connections: { available: true, reason: null, items: [] } };
      return inner.request(path, options);
    },
  };
  const { panel } = await openComposerMount({ client });
  const { input, go } = aiParts(panel);
  if (!go) {
    assert.match(panel.textContent, /Nessun canale collegato/, 'without channels the composer says so');
    return;
  }
  input.value = 'scrivi tu';
  go.dispatch('click');
  await flushComposer();
  assert.equal(inner.drafts.length, 0, 'no draft request without a channel');
  assert.match(panel.textContent, /Nessun canale collegato/);
});

// Dan 06/11: «ho aggiunto una nota ma non si vede e non si capisce dove;
// servirebbe un filtro per vedere tutte le note (da chi sono lasciate)».
test('Dan 06/11: notes read as notes, with a Note chip and one chip per writer', async () => {
  const note = (id, author, at, body) => ({
    entry: 'note', id, conversationId: null, channel: null, direction: null, sync: null,
    body, teamAuthorId: author, remoteHandle: null, errorCode: null, occurredAt: at,
  });
  const timeline = {
    ...TIMELINE,
    entries: {
      ...TIMELINE.entries,
      count: TIMELINE.entries.items.length + 3,
      items: [
        ...TIMELINE.entries.items,
        note('n1', 'dan', '2026-10-21T09:00:00.000Z', 'Richiamare lunedì'),
        note('n2', 'elena', '2026-10-21T10:00:00.000Z', 'Preferisce la sera'),
        note('n3', null, '2026-10-21T11:00:00.000Z', 'Nota di sistema'),
      ],
    },
  };
  const mount = createMount();
  await createCustomerCardView({ doc: createFakeDocument(), mount, client: stubClient({ timeline }) }).renderCard('contact', 'c1');
  const chipOf = (key) => mount.findAll('button').find((node) => node.getAttribute('data-channel') === key);

  const noteRow = mount.findAll('div').find((node) => node.getAttribute('data-entry') === 'n1');
  assert.ok(String(noteRow.getAttribute('class')).includes('bo-scheda-entry-note'), 'a note has its own look');
  assert.ok(noteRow.textContent.includes('✎'), 'and its own mark');
  assert.ok(noteRow.textContent.includes('Nota · da Dan'), 'the writer reads');

  assert.equal(chipOf('note').textContent, 'Note · 3', 'the Note chip counts the notes');
  assert.equal(chipOf('note:dan'), undefined, 'writer chips show only under Note');
  chipOf('note').dispatch('click');
  let text = mount.textContent;
  assert.ok(text.includes('Richiamare lunedì') && text.includes('Preferisce la sera') && text.includes('Nota di sistema'));
  assert.ok(!text.includes('vorrei prenotare una prova'), 'messages are filtered out');
  assert.ok(chipOf('note:dan') && chipOf('note:elena') && chipOf('note:'), 'one chip per writer');
  assert.equal(chipOf('note:').textContent, 'dal team');

  chipOf('note:elena').dispatch('click');
  text = mount.textContent;
  assert.ok(text.includes('Preferisce la sera'));
  assert.ok(!text.includes('Richiamare lunedì'), 'only elena’s notes');
  chipOf('note:elena').dispatch('click');
  assert.ok(mount.textContent.includes('Richiamare lunedì'), 'a second tap shows every writer again');

  chipOf('all').dispatch('click');
  assert.ok(mount.textContent.includes('vorrei prenotare una prova'), 'Tutti brings the messages back');
});

test('Dan 06/11: without notes there is no Note chip', async () => {
  const mount = createMount();
  await createCustomerCardView({ doc: createFakeDocument(), mount, client: stubClient() }).renderCard('contact', 'c1');
  assert.equal(mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'note'), undefined);
});

test('review #617: a cut cronologia counts the notes as a floor, and a note body reads like text', async () => {
  const timeline = {
    ...TIMELINE,
    entries: {
      ...TIMELINE.entries,
      count: 120,
      truncated: true,
      items: [
        ...TIMELINE.entries.items,
        {
          entry: 'note', id: 'n1', conversationId: null, channel: null, direction: null, sync: null,
          body: 'Prezzo &quot;speciale&quot; &amp; prova​ gratuita', teamAuthorId: 'dan',
          remoteHandle: null, errorCode: null, occurredAt: '2026-10-21T09:00:00.000Z',
        },
      ],
    },
  };
  const mount = createMount();
  await createCustomerCardView({ doc: createFakeDocument(), mount, client: stubClient({ timeline }) }).renderCard('contact', 'c1');
  const noteChip = mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'note');
  assert.equal(noteChip.textContent, 'Note · 1+', 'older notes may sit past the page');
  const body = mount.findAll('p').find((node) => String(node.getAttribute('class')).includes('bo-scheda-note-body'));
  assert.equal(body.textContent, 'Prezzo "speciale" & prova gratuita', 'entities decoded, invisible marks dropped');
});


// Dan 07/11: «inviato e ricevuto sarebbe più chiaro a destra / sinistra,
// come una conversazione».
test('Dan 07/11: the conversation reads like a chat — received left, sent right', async () => {
  const items = [
    { entry: 'message', id: 'in1', channel: 'whatsapp', direction: 'inbound', sync: 'received', body: 'Vorrei una lezione di prova', remoteHandle: '+39 000 000 004', occurredAt: '2026-11-07T10:51:00.000Z' },
    { entry: 'message', id: 'out1', channel: 'whatsapp', direction: 'outbound', sync: 'delivered', body: 'Certo, ti preparo una proposta', teamAuthorId: 'coach-guido', occurredAt: '2026-11-07T10:52:00.000Z' },
    { entry: 'message', id: 'out2', channel: 'email', direction: 'outbound', sync: 'failed', body: 'Ecco la proposta', teamAuthorId: null, occurredAt: '2026-11-07T10:53:00.000Z' },
  ];
  const mount = await renderCard(stubClient({ timeline: { ...TIMELINE, entries: { available: true, count: 3, truncated: false, items } } }));
  const row = (id) => mount.findAll('div').find((node) => node.getAttribute('data-entry') === id);
  assert.equal(row('in1').getAttribute('data-direction'), 'in');
  assert.ok(String(row('in1').getAttribute('class')).includes('bo-scheda-entry-in'), 'received sits on the left');
  assert.equal(row('out1').getAttribute('data-direction'), 'out');
  assert.ok(String(row('out1').getAttribute('class')).includes('bo-scheda-entry-out'), 'sent sits on the right');
  const bubble = (id) => row(id).findAll('div').find((node) => node.getAttribute('class') === 'bo-scheda-bubble');
  assert.ok(bubble('in1') && bubble('out1'), 'each passage has its own bubble');
  assert.ok(bubble('out1').textContent.includes('WhatsApp · Coach Guido · '), 'the writer reads as a name, never as a slug');
  assert.ok(!mount.textContent.includes('coach-guido'), 'no raw handle on the page');
  assert.ok(bubble('out2').textContent.includes('Email · il team · '), 'an unnamed writer reads «il team»');
  const state = bubble('out2').findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-sync');
  assert.equal(state.textContent, 'non consegnato');
  assert.equal(state.getAttribute('data-sync'), 'failed', 'a failed send is marked for its warning colour');
  assert.ok(!bubble('in1').textContent.includes('ricevuto'), 'a plain received passage has no state line');
  assert.equal((bubble('in1').textContent.match(/WhatsApp/g) ?? []).length, 1, 'the channel reads once per bubble');
});

test('teamName turns handles into names and refuses ids', () => {
  assert.equal(teamName('coach-guido'), 'Coach Guido');
  assert.equal(teamName('elena'), 'Elena');
  assert.equal(teamName('mario.rossi@esempio.it'), 'Mario Rossi');
  assert.equal(teamName('Daniele Pelleri'), 'Daniele Pelleri');
  assert.equal(teamName('8d8f1d4d-25c1-4641-8836-267581100b32'), null);
  assert.equal(teamName('user-12345'), null);
  assert.equal(teamName(''), null);
  // Review #626 giro 2: an e-mail never leaks its domain.
  assert.equal(teamName('elena2@example.it'), 'elena2');
  assert.equal(teamName('mario.rossi+promo@esempio.it'), 'Mario Rossi');
});

test('review #626 giro 2: a received passage without a handle still names its direction', async () => {
  const items = [{ entry: 'message', id: 'in0', channel: 'whatsapp', direction: 'inbound', sync: 'received', body: 'Ciao', occurredAt: '2026-11-07T10:51:00.000Z' }];
  const mount = await renderCard(stubClient({ timeline: { ...TIMELINE, entries: { available: true, count: 1, truncated: false, items } } }));
  const row = mount.findAll('div').find((node) => node.getAttribute('data-entry') === 'in0');
  assert.ok(row.textContent.includes('WhatsApp · ricevuto · '), 'the head reads the direction when no handle is known');
});

test('review #626: direction reads aloud, no direction stays neutral, writer chips use names, state case is normalized', async () => {
  const items = [
    { entry: 'message', id: 'in1', channel: 'whatsapp', direction: 'inbound', sync: 'received', body: 'Ciao', remoteHandle: '+39 000 000 004', occurredAt: '2026-11-07T10:51:00.000Z' },
    { entry: 'message', id: 'out1', channel: 'email', direction: 'outbound', sync: 'FAILED', body: 'Ecco la proposta', teamAuthorId: 'coach-guido', occurredAt: '2026-11-07T10:52:00.000Z' },
    { entry: 'message', id: 'x1', channel: 'whatsapp', direction: null, sync: 'received', body: 'Senza direzione', occurredAt: '2026-11-07T10:53:00.000Z' },
    { entry: 'call', id: 'x2', channel: 'phone', direction: 'sideways', sync: 'completed', durationSec: 30, occurredAt: '2026-11-07T10:54:00.000Z' },
    { entry: 'note', id: 'n1', body: 'Nota di Guido', teamAuthorId: 'coach-guido', occurredAt: '2026-11-07T10:55:00.000Z' },
    { entry: 'note', id: 'n2', body: 'Nota di Elena', teamAuthorId: 'elena', occurredAt: '2026-11-07T10:56:00.000Z' },
  ];
  const mount = await renderCard(stubClient({ timeline: { ...TIMELINE, entries: { available: true, count: items.length, truncated: false, items } } }));
  const row = (id) => mount.findAll('div').find((node) => node.getAttribute('data-entry') === id);
  const srText = (id) => row(id).findAll('span').filter((node) => node.getAttribute('class') === 'sr-only').map((node) => node.textContent).join('');
  // 1) the side is visual only: a screen reader hears the direction.
  assert.equal(srText('in1'), 'Ricevuto. ');
  assert.equal(srText('out1'), 'Inviato. ');
  assert.equal(row('in1').getAttribute('aria-label'), null, 'no aria-label on a role-less div');
  // 2) no recorded direction is never guessed.
  for (const id of ['x1', 'x2']) {
    assert.equal(row(id).getAttribute('data-direction'), 'none', `${id} sits in the middle`);
    assert.ok(String(row(id).getAttribute('class')).includes('bo-scheda-entry-none'));
    assert.equal(srText(id), '', `${id} names no direction`);
  }
  assert.ok(row('x2').textContent.includes('chiamata · 0:30'), 'a call without direction says neither in uscita nor in entrata');
  assert.ok(!row('x2').textContent.includes('in entrata') && !row('x2').textContent.includes('in uscita'));
  // 4) the state key is normalized before it drives the warning colour.
  const state = row('out1').findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-sync');
  assert.equal(state.getAttribute('data-sync'), 'failed');
  assert.equal(state.textContent, 'non consegnato');
  // 3) the writer chips under Note read names, like the notes.
  mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'note').dispatch('click');
  const chip = mount.findAll('button').find((node) => node.getAttribute('data-author') === 'coach-guido');
  assert.ok(chip, 'a chip per writer');
  assert.ok(chip.textContent.includes('da Coach Guido'), 'the chip reads the name, never the handle');
});

// Voce 785428ec3de0: a customer with no union reads no technical line under
// Identità collegate — no «nessuna unione registrata», no lone
// «scheda principale» row; a real union still reads its schede.
test('785428ec3de0: Identità collegate says nothing technical for a single scheda', async () => {
  const single = await renderCard(stubClient({ profile: PROFILE_BARE }));
  const text = single.textContent;
  assert.ok(!text.includes('nessuna unione'), 'no «nessuna unione registrata»');
  assert.ok(!text.includes('una sola scheda'), 'no technical single-scheda line');
  assert.ok(!text.includes('scheda principale'), 'no lone principal row without a union');
  const linked = await renderCard(stubClient());
  assert.ok(linked.textContent.includes('della stessa persona'), 'a real union still reads its schede');
});

// #627 followed up: the quick-action icons are real SVG elements, never a CSS
// data: mask — the host CSP (default-src 'self') blocks data: images, so the
// masked icons never painted in production.
test('Azioni rapide: every tile carries its stroke icon as an SVG element, and the label stays the text', async () => {
  const mount = await renderCard(stubClient());
  const tiles = mount.findAll('button').filter((node) => String(node.getAttribute('class') ?? node.className ?? '').split(/\s+/).includes('bo-scheda-tile'));
  assert.ok(tiles.length >= 3, 'the quick actions render');
  for (const node of tiles) {
    const icon = node.findAll('svg')[0];
    assert.ok(icon, `${node.textContent} has an icon`);
    assert.match(String(icon.getAttribute('class')), /ui-icon ui-icon-(telefono|telefono-piu|messaggio|offerta|appuntamento)/);
    assert.equal(icon.getAttribute('aria-hidden'), 'true', 'decorative: the label names the action');
  }
  assert.ok(tiles.some((node) => node.textContent === 'Scrivi'), 'the label is still the whole text');
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(!/url\(["']?data:/.test(css), 'no data: url in the stylesheet — the host CSP would block it');
});

// backlog:59def6cb805d — completion like the prototype: the missing details.

test('59def6cb805d: each identity reads its sync line from the observed passages (C10)', async () => {
  const mount = await renderCard(stubClient());
  const rows = mount.findAll('p').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-identity')
    && node.getAttribute('data-channel'));
  const byChannel = Object.fromEntries(rows.map((node) => [node.getAttribute('data-channel'), node.textContent]));
  assert.ok(byChannel.whatsapp.includes('↔ sincronizzato'), `received and sent on WhatsApp: ${byChannel.whatsapp}`);
  assert.ok(byChannel.instagram.includes('← in entrata'), `only received on Instagram: ${byChannel.instagram}`);
  assert.ok(byChannel.phone.includes('→ in uscita'), `only an outgoing call: ${byChannel.phone}`);
});

test('59def6cb805d review: on a truncated page a one-way sync line names itself partial (C10)', async () => {
  // The first page holds only inbound Instagram passages; the outbound one
  // may sit on a later page. «← in entrata» alone would claim the channel
  // never sent anything: on a partial read it says so, like the count line.
  const truncated = { ...TIMELINE, entries: { ...TIMELINE.entries, truncated: true } };
  const mount = await renderCard(stubClient({ timeline: truncated }));
  const rows = mount.findAll('p').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-identity')
    && node.getAttribute('data-channel'));
  const syncOf = (channel) => rows.find((node) => node.getAttribute('data-channel') === channel)
    ?.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-identity-sync')?.textContent ?? null;
  assert.equal(syncOf('instagram'), '← in entrata (elenco parziale)', 'one direction on a partial page is not exhaustive');
  assert.equal(syncOf('phone'), '→ in uscita (elenco parziale)');
  assert.equal(syncOf('whatsapp'), '↔ sincronizzato', 'both directions seen are proven even on a partial page');
  assert.ok(mount.textContent.includes('(elenco parziale)'), 'the count line and the sync lines share one honesty standard');
  const complete = await renderCard(stubClient());
  assert.ok(!complete.textContent.includes('in entrata (elenco parziale)'), 'a complete read keeps the exact line');
});

test('59def6cb805d: observedDirections never assumes a direction nobody recorded (C10)', () => {
  const seen = observedDirections({ entries: { items: [
    { channel: 'WhatsApp', direction: 'inbound' },
    { channel: 'whatsapp', direction: 'outbound' },
    { channel: 'email', direction: null },
    { channel: '', direction: 'inbound' },
  ] } });
  assert.deepEqual(seen.get('whatsapp'), { in: true, out: true });
  assert.equal(seen.has('email'), false, 'a passage with no direction proves nothing');
  assert.equal(observedDirections(null).size, 0);
});

test('59def6cb805d: a next step completes its work task from the circular check (C24)', async () => {
  const toasts = [];
  let completed = false;
  const base = stubClient();
  const client = {
    ...base,
    async request(path, options = {}) {
      if (path === '/api/modules/work-task/records/w1/actions/complete') {
        enforceAdminWriteGate(path, options);
        assert.equal(options.method, 'POST');
        completed = true;
        return { id: 'w1', status: 'done' };
      }
      if (completed && path.startsWith('/api/customer-data/profile/')) {
        return { ...PROFILE, workTasks: { ...PROFILE.workTasks, items: [{ id: 'w1', status: 'done', name: 'Richiamare per la prova' }] } };
      }
      return base.request(path, options);
    },
  };
  const mount = await renderCard(client, undefined, (message) => toasts.push(message));
  const check = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'complete-step');
  assert.ok(check, 'the open step carries the circular check');
  assert.equal(check.getAttribute('aria-label'), 'Segna come fatto: Richiamare per la prova');
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'complete-step').length, 1,
    'a done task carries no check');
  check.dispatch('click');
  await flushComposer(10);
  assert.ok(completed, 'the work-task complete action ran');
  assert.deepEqual(toasts, ['Fatto: Richiamare per la prova']);
  assert.ok(mount.textContent.includes('nessun passo aperto'), 'the card re-reads: the server list, never an optimistic copy');
});

test('59def6cb805d: a refused step completion keeps the step and says so in Italian (C24)', async () => {
  const toasts = [];
  const base = stubClient();
  const client = {
    ...base,
    async request(path, options = {}) {
      if (path.includes('/actions/complete')) throw Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' });
      return base.request(path, options);
    },
  };
  const mount = await renderCard(client, undefined, (message) => toasts.push(message));
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'complete-step').dispatch('click');
  await flushComposer(10);
  assert.ok(mount.textContent.includes('Richiamare per la prova'), 'the step stays');
  assert.equal(toasts.length, 1);
  assert.doesNotMatch(toasts[0], /INTERNAL|boom|500/);
});

test('59def6cb805d: the offer card shows the server amount, none without one (C25)', async () => {
  const withAmount = await renderCard(stubClient({
    profile: { ...PROFILE, quotes: { ...PROFILE.quotes, items: [{ id: 'q1', status: 'sent', name: 'Preventivo 10 ingressi', amountCents: 2750000, currency: 'EUR' }] } },
  }));
  const amount = withAmount.findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-offer-amount');
  assert.ok(amount, 'the amount paints');
  assert.equal(amount.textContent, '27.500 €');
  const without = await renderCard(stubClient());
  assert.equal(without.findAll('p').filter((node) => node.getAttribute('class') === 'bo-scheda-offer-amount').length, 0,
    'no server amount, no figure');
  const recurring = await renderCard(stubClient({
    profile: { ...PROFILE, quotes: { ...PROFILE.quotes, items: [{ id: 'q1', status: 'sent', name: 'Abbonamento', amountCents: null, currency: 'EUR' }] } },
  }));
  assert.equal(recurring.findAll('p').filter((node) => node.getAttribute('class') === 'bo-scheda-offer-amount').length, 0);
});

test('59def6cb805d review: an opportunity without quotes paints its server amount on the scheda (C25)', async () => {
  const mount = await renderCard(stubClient({
    profile: {
      ...PROFILE,
      quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
      opportunities: {
        available: true, count: 1, countIsComplete: true, truncated: false,
        items: [{ id: 'o1', status: 'open', name: 'Pacchetto 10 ingressi', amountCents: 120000, currency: 'EUR' }],
      },
    },
  }));
  const amount = mount.findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-offer-amount');
  assert.ok(amount, 'the opportunity fallback paints its amount');
  assert.equal(amount.textContent, '1.200 €');
  assert.equal(mount.findAll('a').filter((node) => node.getAttribute('class') === 'bo-scheda-offer-link').length, 0,
    'an opportunity has no quote detail: the line stays plain');
});

test('59def6cb805d: the next appointment reads title then day and hours (C26)', async () => {
  const mount = await renderCard(stubClient());
  const card = mount.findAll('section').find((node) => String(node.getAttribute('class') ?? '').includes('bo-scheda-card-appt'));
  assert.ok(card, 'the appointment card paints');
  const title = card.findAll('p').find((node) => node.getAttribute('class') === 'bo-scheda-appt-title');
  assert.equal(title.textContent, 'Pt single · con Coach Guido', 'service made readable, member by name');
  assert.ok(card.textContent.includes('Venerdì 23 ottobre 2099 · 18:00–19:00'), card.textContent);
  assert.ok(!card.textContent.includes('pt-single') && !card.textContent.includes('coach-guido'), 'no raw keys');
  assert.ok(!card.textContent.includes('Google Calendar'), 'no sync line the booking does not record');
});

test('59def6cb805d: the composer reads «Rispondi su», the named placeholder, «Invia su» and the channel note (C21, C22)', async () => {
  const { panel } = await openComposerMount();
  assert.ok(panel.textContent.includes('Rispondi su'), 'the channel row is labelled');
  const area = panel.findAll('textarea').find((node) => node.getAttribute('aria-label') === 'Messaggio');
  assert.equal(area.getAttribute('placeholder'), 'Scrivi a Guido su Email…');
  const send = panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send');
  assert.equal(send.textContent, 'Invia su Email');
  assert.ok(panel.textContent.includes('parte da Email · resta anche lì'), 'the channel note sits beside Invia');
});

test('97cba17cbb8c: un invio fallito resta in cronologia con il motivo italiano e Riprova', async () => {
  assert.equal(
    failedSendReason('CHANNEL_TEMPLATE_REQUIRED'),
    'Fuori dalla finestra di 24 ore: serve un modello approvato.',
  );
  const failed = {
    entry: 'message', id: 'm9', conversationId: 't1', channel: 'whatsapp', direction: 'outbound',
    sync: 'failed', body: 'Ciao, ti mando il listino', teamAuthorId: 'elena',
    remoteHandle: '+39 333 1234567', errorCode: 'CHANNEL_TEMPLATE_REQUIRED',
    occurredAt: '2026-10-20T09:10:00.000Z',
  };
  const timeline = {
    ...TIMELINE,
    entries: { ...TIMELINE.entries, count: 5, items: [...TIMELINE.entries.items, failed] },
  };
  const client = stubClient({ timeline });
  const mount = await renderCard(client);
  assert.ok(mount.textContent.includes('Non consegnato'), 'the failed row names the delivery state');
  assert.ok(
    mount.textContent.includes('Fuori dalla finestra di 24 ore: serve un modello approvato.'),
    'the failed row names the Italian reason, never the raw code alone',
  );
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'message-retry');
  assert.ok(retry, 'the failed row offers Riprova');
  assert.equal(retry.textContent, 'Riprova');
  retry.dispatch('click');
  await flushComposer(10);
  const post = client.writes.find((write) => write.path === '/api/customer-hub/messages');
  assert.ok(post, 'Riprova resends through the composer route');
  assert.equal(post.body.channel, 'whatsapp');
  assert.equal(post.body.text, 'Ciao, ti mando il listino');
  assert.ok(typeof post.body.messageKey === 'string' && post.body.messageKey !== '', 'a fresh key per retry');
});

// Supervisor 06/11 sera: after Invia the scheda went blank for about a
// second while it re-read itself. A re-read of the scheda already on screen
// keeps it up and swaps in place: no blank, same scroll, same filter.
function gatedClient(options = {}) {
  const base = stubClient(options);
  const gated = {
    gate: null,
    calls: base.calls,
    writes: base.writes,
    async request(path, opts) {
      if (gated.gate) await gated.gate;
      return base.request(path, opts);
    },
  };
  return gated;
}

const hold = (client) => {
  let open;
  client.gate = new Promise((resolve) => { open = resolve; });
  return () => { client.gate = null; open(); };
};

test('re-reading the same scheda keeps it on screen while it loads, never blank', async () => {
  const client = gatedClient();
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  const before = mount.firstChild;
  assert.ok(mount.textContent.includes('Guido Presti'));

  const release = hold(client);
  const again = view.renderCard('contact', 'c1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mount.firstChild, before, 'the old scheda stays up during the re-read');
  assert.ok(mount.textContent.includes('Guido Presti'), 'never blank while loading');

  release();
  await again;
  assert.notEqual(mount.firstChild, before, 'the fresh scheda replaced it');
  assert.equal(mount.childNodes.length, 1, 'one scheda, swapped in one step');
});

test('re-reading the same scheda keeps the channel filter, the open pages and the side columns scroll', async () => {
  const items = Array.from({ length: 45 }, (_, i) => ({
    entry: 'message', id: `e${i}`, conversationId: 't1', channel: i % 2 ? 'whatsapp' : 'instagram',
    direction: 'inbound', sync: 'received', body: `messaggio ${i}`, teamAuthorId: null,
    remoteHandle: 'x', errorCode: null, occurredAt: new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString(),
  }));
  const timeline = { ...TIMELINE, entries: { available: true, count: items.length, truncated: false, items } };
  const client = gatedClient({ timeline });
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');

  mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'whatsapp').dispatch('click');
  mount.querySelector('button[data-action="timeline-older"]').dispatch('click');
  const shownBefore = mount.textContent.match(/messaggio \d+/g).length;
  assert.ok(shownBefore > 20, 'a second page is open');
  mount.querySelector('.bo-scheda-col-side').scrollTop = 140;

  await view.renderCard('contact', 'c1');

  const active = mount.findAll('button').find((node) => node.getAttribute('data-active') === 'true');
  assert.equal(active.getAttribute('data-channel'), 'whatsapp', 'the filter stays');
  assert.equal(mount.textContent.match(/messaggio \d+/g).length, shownBefore, 'the open pages stay');
  assert.ok(!mount.textContent.includes('messaggio 44 ') && !/messaggio (0|2|4)\b/.test(mount.textContent), 'still WhatsApp only');
  assert.equal(mount.querySelector('.bo-scheda-col-side').scrollTop, 140, 'the side column keeps its scroll');
});

test('another customer clears at once and starts from Tutti', async () => {
  const client = gatedClient();
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'instagram').dispatch('click');

  const release = hold(client);
  const other = view.renderCard('contact', 'c2');
  await new Promise((resolve) => setImmediate(resolve));
  // Backlog 608aa14d554c: only the loading state is left, never the old scheda.
  assert.equal(mount.childNodes.length, 1, 'the previous customer never stays up under another id');
  assert.equal(mount.childNodes[0].getAttribute('role'), 'status', 'the new scheda shows its loading state');
  release();
  await other;
  const active = mount.findAll('button').find((node) => node.getAttribute('data-active') === 'true');
  assert.equal(active.getAttribute('data-channel'), 'all', 'a new scheda starts from Tutti');
});

test('a slower older re-read never overwrites a newer one', async () => {
  const client = gatedClient();
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');

  // The older read is held until the newer one is on screen, then lands.
  let releaseOlder;
  client.gate = new Promise((resolve) => { releaseOlder = resolve; });
  const older = view.renderCard('contact', 'c1');
  await new Promise((resolve) => setImmediate(resolve));
  client.gate = null;
  const newer = view.renderCard('contact', 'c1');
  await newer;
  const shown = mount.firstChild;
  assert.ok(shown, 'the newer scheda is on screen');
  releaseOlder();
  await older;
  assert.equal(mount.firstChild, shown, 'the older read landing late never replaces the newer scheda');
  assert.equal(mount.childNodes.length, 1);
});

test('review #612 round 2: the Scrivi window stays open with its text through a re-read', async () => {
  const { mount, panel } = await openComposerMount();
  const area = panel.findAll('textarea')[0];
  area.value = 'Ciao, ti scrivo per';
  // Same customer re-read (as after a note or an Invia elsewhere).
  const card = mount.findAll('div').find((node) => String(node.getAttribute('class')).split(' ').includes('bo-scheda'));
  assert.ok(card);
  await reRead();
  const still = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.equal(still, panel, 'the same window stays');
  assert.equal(still.findAll('textarea')[0].value, 'Ciao, ti scrivo per', 'with the text being written');
  assert.notEqual(mount.findAll('div').find((node) => String(node.getAttribute('class')).split(' ').includes('bo-scheda')), card, 'the scheda itself was swapped');

  async function reRead() {
    mount.findAll('input').find((node) => node.getAttribute('name') === 'noteBody').value = 'nota';
    mount.findAll('button').find((node) => node.getAttribute('data-action') === 'add-note').dispatch('click');
    await flushComposer();
  }
});

// Review #612: the in-place swap must never throw away what the person is
// typing in the scheda when a re-read comes from elsewhere (an Invia).
test('review #612: a note being typed survives a re-read of the same scheda', async () => {
  const client = recordingClient(stubClient({ profile: OPPORTUNITY_ONLY_PROFILE }));
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  const noteField = () => mount.findAll('input').find((node) => node.getAttribute('name') === 'noteBody');
  noteField().value = 'Richiamare giovedì';

  await view.renderCard('contact', 'c1');
  assert.equal(noteField().value, 'Richiamare giovedì', 'the half-written note is still there');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'add-note').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 1);
  assert.equal(noteField().value, '', 'a saved note leaves the field empty, never copied back');
});

test('review #612: an open Dettagli form keeps its edits through a re-read, and closes on Salva', async () => {
  const client = recordingClient(stubClient({ profile: OPPORTUNITY_ONLY_PROFILE }));
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  byName('firstName').value = 'Guidino';
  byName('email').value = 'nuova@esempio.invalid';

  await view.renderCard('contact', 'c1');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'save-details'), 'the form is still open');
  assert.equal(byName('firstName').value, 'Guidino', 'the typed name stays');
  assert.equal(byName('email').value, 'nuova@esempio.invalid', 'the typed email stays');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-details').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].body.firstName, 'Guidino');
  assert.ok(!mount.findAll('button').some((node) => node.getAttribute('data-action') === 'save-details'), 'Salva closes the form');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'edit-details'), 'Modifica is back');
});

test('review #612: a phone number being typed survives a re-read, Annulla closes the panel', async () => {
  const client = recordingClient(stubClient({ card: { ...CARD, phone: CARD_BARE.phone } }));
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'add-phone').dispatch('click');
  const phoneField = () => mount.findAll('input').find((node) => node.getAttribute('type') === 'tel');
  phoneField().value = '+39333000111';

  await view.renderCard('contact', 'c1');
  assert.equal(phoneField()?.value, '+39333000111', 'the half-typed number is still there');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-phone').dispatch('click');
  await flushClicks();
  assert.equal(phoneField(), undefined, 'Annulla closes the panel for good');
});

test('review #612: another customer never inherits the previous one\'s typing', async () => {
  const client = recordingClient(stubClient({ profile: OPPORTUNITY_ONLY_PROFILE }));
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'noteBody').value = 'solo per c1';
  await view.renderCard('contact', 'c2');
  assert.equal(mount.findAll('input').find((node) => node.getAttribute('name') === 'noteBody').value ?? '', '');
});

// Review #612 round 3 (P1): an open Dettagli form carries through a re-read
// only the fields the person changed. An untouched field takes the fresh
// server value, so Salva never writes back a stale name over a newer one.
test('review #612 round 3: an untouched Dettagli field takes the fresh value after a re-read', async () => {
  const profile = structuredClone({
    ...OPPORTUNITY_ONLY_PROFILE,
    identity: {
      ...OPPORTUNITY_ONLY_PROFILE.identity,
      contact: { ...OPPORTUNITY_ONLY_PROFILE.identity.contact, firstName: 'Guido', lastName: 'Presti' },
    },
  });
  const client = recordingClient(stubClient({ profile }));
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  byName('email').value = 'nuova@esempio.invalid';

  // Another operator renames the contact; an Invia elsewhere re-reads.
  profile.identity.contact.firstName = 'Guidone';
  await view.renderCard('contact', 'c1');
  assert.equal(byName('email').value, 'nuova@esempio.invalid', 'the typed email stays');
  assert.equal(byName('firstName').value, 'Guidone', 'the untouched name is the fresh one');

  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'save-details').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 1);
  assert.equal(client.writes[0].body.firstName, 'Guidone', 'Salva never writes the stale name back');
  assert.equal(client.writes[0].body.email, 'nuova@esempio.invalid');
});

// Review #612 round 3 (P2): a failed re-read of the scheda already shown
// keeps the Scrivi window and its half-written text.
test('review #612 round 3: a failed re-read of the same scheda keeps the Scrivi window', async () => {
  const inner = composerClient();
  let failCard = false;
  const client = {
    posts: inner.posts,
    async request(path, options = {}) {
      if (failCard && path.includes('/card/')) throw Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' });
      return inner.request(path, options);
    },
  };
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client, spaceId: 'presti', toast: () => {}, wait: () => Promise.resolve() });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  panel.findAll('textarea')[0].value = 'Ciao, ti scrivo per';

  failCard = true;
  await view.renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('Scheda non disponibile'), 'the failure is said');
  const still = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  assert.equal(still, panel, 'the Scrivi window stays');
  assert.equal(still.findAll('textarea')[0].value, 'Ciao, ti scrivo per', 'with its text');
});

// Review #612 round 3 (P2): a kept filter whose channel the fresh cronologia
// no longer has falls back to «Tutti», never a chip-less false empty state.
test('review #612 round 3: a kept filter on a channel gone from the re-read falls back to Tutti', async () => {
  const message = (i, channel) => ({
    entry: 'message', id: `e${i}`, conversationId: 't1', channel,
    direction: 'inbound', sync: 'received', body: `messaggio ${i}`, teamAuthorId: null,
    remoteHandle: 'x', errorCode: null, occurredAt: new Date(Date.UTC(2026, 10, 1, 8, i)).toISOString(),
  });
  const timeline = structuredClone({ ...TIMELINE, entries: { available: true, count: 2, truncated: false, items: [message(1, 'whatsapp'), message(2, 'instagram')] } });
  const client = stubClient({ timeline });
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'whatsapp').dispatch('click');

  timeline.entries.items = [message(2, 'instagram')];
  timeline.entries.count = 1;
  await view.renderCard('contact', 'c1');
  const active = mount.findAll('button').find((node) => node.getAttribute('data-active') === 'true');
  assert.equal(active?.getAttribute('data-channel'), 'all', 'the filter falls back to Tutti');
  assert.ok(mount.textContent.includes('messaggio 2'), 'the remaining messages show');
});

// The in-place swap keeps open windows; the window that just sent closes as
// on main, so the sent text never stays under a live Invia.
test('review #612 round 3: Invia closes its own Scrivi window before the re-read', async () => {
  const { mount, panel, client } = await openComposerMount();
  panel.findAll('textarea')[0].value = 'Certo, domani alle 18.';
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-send').dispatch('click');
  await flushComposer();
  assert.equal(client.posts.length, 1);
  assert.equal(mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open'), undefined, 'the sent window is closed');
  assert.ok(mount.textContent.includes('Guido Presti'), 'the scheda is on screen');
});

// Review #612 round 5 (P1): a failed re-read of the scheda already shown
// replaces it with the error panel; what was being typed in it (a note, a
// Dettagli edit) comes back with the next scheda that loads.
test('review #612 round 5: typing in the scheda survives a failed re-read and returns on the next one', async () => {
  const base = stubClient({ profile: OPPORTUNITY_ONLY_PROFILE });
  let failCard = false;
  const client = {
    async request(path, options = {}) {
      if (failCard && path.includes('/card/')) throw Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' });
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client, toast: () => {} });
  await view.renderCard('contact', 'c1');
  const byName = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  byName('noteBody').value = 'Richiamare giovedì';
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'edit-details').dispatch('click');
  byName('email').value = 'nuova@esempio.invalid';

  failCard = true;
  await view.renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('Scheda non disponibile'), 'the failure is said');
  // A second failure in a row keeps what the first one saved.
  await view.renderCard('contact', 'c1');

  failCard = false;
  await view.renderCard('contact', 'c1');
  assert.equal(byName('noteBody').value, 'Richiamare giovedì', 'the half-written note is back');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('data-action') === 'save-details'), 'Dettagli is open again');
  assert.equal(byName('email').value, 'nuova@esempio.invalid', 'with the edit');

  // Another customer never inherits it.
  failCard = true;
  await view.renderCard('contact', 'c1');
  failCard = false;
  await view.renderCard('contact', 'c2');
  assert.equal(byName('noteBody').value ?? '', '', 'another customer starts empty');
});

// Production 07/11 (same shape as the calendar phrase): a queued AI draft
// answers 504 BO_DRAFT_PENDING with a requestId and is read back on the same
// path, never asked again; the server's English message never shows.
function pendingDraftClient({ readyAfter = 1 } = {}) {
  const inner = composerClient();
  const drafts = [];
  const reads = [];
  return {
    posts: inner.posts,
    drafts,
    reads,
    async request(path, options = {}) {
      if (path === '/api/customer-hub/messages/draft') {
        enforceAdminWriteGate(path, options);
        drafts.push(JSON.parse(options.body));
        throw Object.assign(new Error('Composer draft pending: poll ?requestId, do not resubmit'), {
          status: 504, code: 'BO_DRAFT_PENDING', requestId: 'draft-req-1',
        });
      }
      if (path.startsWith('/api/customer-hub/messages/draft?requestId=')) {
        reads.push(path);
        if (reads.length < readyAfter) {
          throw Object.assign(new Error('Composer draft pending: poll ?requestId, do not resubmit'), {
            status: 504, code: 'BO_DRAFT_PENDING', requestId: 'draft-req-1',
          });
        }
        return { body: 'Ciao Guido, ti aspettiamo giovedì.' };
      }
      return inner.request(path, options);
    },
  };
}

test('composer AI: a queued draft is read back with its requestId and fills the message', async () => {
  const client = pendingDraftClient({ readyAfter: 3 });
  const { panel } = await openComposerMount({ client });
  const { input, go, area } = aiParts(panel);
  input.value = 'ricordagli la prova';
  go.dispatch('click');
  await flushComposer(20);
  assert.equal(client.drafts.length, 1, 'one POST only');
  assert.equal(client.reads.length, 3, 'read back until ready');
  assert.ok(client.reads.every((path) => path.endsWith('requestId=draft-req-1')));
  assert.equal(area.value, 'Ciao Guido, ti aspettiamo giovedì.');
  assert.ok(!panel.textContent.includes('poll ?requestId'), 'never the English server message');
});

test('composer AI: a draft still queued after a minute says so in Italian and Genera resumes the same request', async () => {
  const client = pendingDraftClient({ readyAfter: 21 });
  const { panel } = await openComposerMount({ client });
  const { input, go, area } = aiParts(panel);
  input.value = 'ricordagli la prova';
  go.dispatch('click');
  await flushComposer(80);
  assert.equal(client.reads.length, 20, 'about a minute of reads');
  assert.match(panel.textContent, /L’AI sta impiegando più del previsto/);
  assert.ok(!panel.textContent.includes('poll ?requestId'), 'never the English server message');
  go.dispatch('click');
  await flushComposer(20);
  assert.equal(client.drafts.length, 1, 'Genera resumes, never a second POST');
  assert.equal(client.reads.length, 21);
  assert.equal(area.value, 'Ciao Guido, ti aspettiamo giovedì.');
});

// Review #664 P1: a transient read failure kept the draft request, never a new POST.
test('composer AI: a transient read-back failure keeps reading the same queued draft', async () => {
  const inner = pendingDraftClient({ readyAfter: 2 });
  let failed = false;
  const client = {
    posts: inner.posts,
    drafts: inner.drafts,
    reads: inner.reads,
    async request(path, options = {}) {
      if (path.startsWith('/api/customer-hub/messages/draft?requestId=') && !failed) {
        failed = true;
        inner.reads.push(path);
        throw Object.assign(new Error('Bad Gateway'), { status: 502, code: 'UNKNOWN' });
      }
      return inner.request(path, options);
    },
  };
  const { panel } = await openComposerMount({ client });
  const { input, go, area } = aiParts(panel);
  input.value = 'ricordagli la prova';
  go.dispatch('click');
  await flushComposer(30);
  assert.equal(client.drafts.length, 1, 'one POST only');
  assert.equal(area.value, 'Ciao Guido, ti aspettiamo giovedì.', 'the ready draft lands after the hiccup');
  assert.ok(!panel.textContent.includes('Bad Gateway'));
});

// Review #664 round 2 P2: the queued draft request survives closing and
// reopening the composer — never a second POST for the same words.
test('composer AI: a queued draft is resumed after ✕ and Scrivi, never asked again', async () => {
  const client = pendingDraftClient({ readyAfter: 21 });
  const { mount, panel } = await openComposerMount({ client });
  const first = aiParts(panel);
  first.input.value = 'ricordagli la prova';
  first.go.dispatch('click');
  await flushComposer(80);
  assert.match(panel.textContent, /L’AI sta impiegando più del previsto/);
  panel.findAll('button').find((node) => node.getAttribute('data-action') === 'composer-close').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'compose-message').dispatch('click');
  await flushComposer();
  const reopened = mount.findAll('div').find((node) => node.getAttribute('data-composer') === 'open');
  const again = aiParts(reopened);
  again.input.value = 'ricordagli la prova';
  again.go.dispatch('click');
  await flushComposer(20);
  assert.equal(client.drafts.length, 1, 'the reopened composer reads the same request back');
  assert.equal(client.reads.length, 21);
  assert.ok(client.reads.at(-1).endsWith('requestId=draft-req-1'));
  assert.equal(again.area.value, 'Ciao Guido, ti aspettiamo giovedì.');
});

// Review #664 round 3 P2: a Genera with other words during the minute of
// read-back was silently dropped.
test('composer AI: other words during the read-back supersede it, the same words keep it', async () => {
  const drafts = [];
  const reads = [];
  const inner = composerClient();
  let releaseRead = () => {};
  const client = {
    posts: inner.posts,
    async request(path, options = {}) {
      if (path === '/api/customer-hub/messages/draft') {
        enforceAdminWriteGate(path, options);
        const body = JSON.parse(options.body);
        drafts.push(body);
        if (body.prompt === 'ricordagli la prova') {
          throw Object.assign(new Error('Composer draft pending: poll ?requestId, do not resubmit'), {
            status: 504, code: 'BO_DRAFT_PENDING', requestId: 'draft-req-1',
          });
        }
        return { body: 'Ciao Guido, il listino è in allegato.' };
      }
      if (path.startsWith('/api/customer-hub/messages/draft?requestId=')) {
        reads.push(path);
        await new Promise((resolve) => { releaseRead = resolve; });
        return { body: 'Testo della prima richiesta' };
      }
      return inner.request(path, options);
    },
  };
  const { panel } = await openComposerMount({ client });
  const { input, go, area } = aiParts(panel);
  input.value = 'ricordagli la prova';
  go.dispatch('click');
  await flushComposer(10);
  assert.equal(reads.length, 1, 'the queued draft is being read back');
  go.dispatch('click');
  await flushComposer(10);
  assert.equal(drafts.length, 1, 'the same words keep the read going, no second POST');
  input.value = 'mandagli il listino';
  go.dispatch('click');
  await flushComposer(10);
  assert.equal(drafts.length, 2, 'other words are a new request');
  assert.equal(drafts[1].prompt, 'mandagli il listino');
  assert.equal(area.value, 'Ciao Guido, il listino è in allegato.');
  releaseRead();
  await flushComposer(10);
  assert.equal(area.value, 'Ciao Guido, il listino è in allegato.', 'the superseded read never overwrites the newer draft');
});

test('608aa14d554c: a scheda opened from a direct link shows the loading state before its data arrives', async () => {
  /** @type {Array<() => void>} */
  const held = [];
  const base = stubClient();
  const client = {
    ...base,
    request(path, options) {
      return new Promise((resolve, reject) => {
        held.push(() => base.request(path, options).then(resolve, reject));
      });
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const rendering = createCustomerCardView({ doc, mount, client }).renderCard('contact', 'c1');
  const loading = () => mount.findAll('div').find((node) => node.getAttribute('role') === 'status'
    && (node.getAttribute('class') ?? '').split(/\s+/).includes('ui-loading'));
  assert.ok(loading(), 'the loading state is painted at once, not a blank mount');
  assert.equal(loading().textContent, 'Carico la scheda…');
  assert.equal(loading().getAttribute('aria-busy'), 'true');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(held.length > 0, 'the reads are still in flight');
  assert.ok(loading(), 'the loading state stays while the reads are pending');
  for (const release of held.splice(0)) release();
  await rendering;
  assert.ok(!loading(), 'the scheda replaces the loading state');
  assert.ok(mount.textContent.includes(CARD.name), 'the scheda painted');
});

const PLACED_QUOTE_PROFILE = {
  ...PROFILE,
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{
      id: 'o1', status: 'qualification', stage: 'qualification', name: 'Proposta esempio — Pacchetto 10 PT',
      pipelineKey: 'accordo-sales', pipelineStage: 'proposta',
    }],
  },
  quotes: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{
      id: 'q9', status: 'approved', name: null, opportunityId: 'o1', opportunityName: 'Proposta esempio — Pacchetto 10 PT',
      opportunityStage: 'qualification', opportunityPipelineKey: 'accordo-sales', opportunityPipelineStage: 'proposta',
    }],
  },
};

test('1e939a362c7c: an offer on a Pipeline has Cambia stato, moving through the same move-stage as the board', async () => {
  const seen = [];
  const base = stubClient({ profile: PLACED_QUOTE_PROFILE, schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] } });
  const client = recordingClient(base);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');

  const change = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'change-offer-stage');
  assert.ok(change, 'the placed offer has the Cambia stato menu');
  change.dispatch('click');
  const voices = mount.findAll('button').filter((node) => node.getAttribute('data-stage') !== null);
  assert.deepEqual(voices.map((node) => node.textContent), ['Richiesta info', 'Prova', 'Pagato', 'Perso'],
    'the voices are the pipeline stages with the board words, never the current one');

  // Pagato is a won stage: like the board it asks Conferma first, with the
  // board's own panel (never a native confirm()).
  voices.find((node) => node.getAttribute('data-stage') === 'pagato').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 0, 'Pagato never posts straight from the menu');
  const question = mount.findAll('p').find((node) => node.getAttribute('class') === 'confirm-question');
  assert.equal(question?.textContent, 'Segnare «Proposta esempio — Pacchetto 10 PT» come Pagato?', 'the board question names the offer');
  const box = question.parentNode;
  assert.equal(box.getAttribute('class'), 'card-confirm', 'the board Conferma panel is shown');
  box.findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 1, 'only Conferma posts');
  assert.equal(client.writes[0].path, '/api/modules/opportunity/records/o1/actions/move-stage',
    'the move rides the Pipeline board action, on the opportunity behind the quote');
  assert.deepEqual(client.writes[0].body, { toStage: 'pagato', fromStage: 'proposta' });
  assert.deepEqual(seen, [{ message: 'Spostata in Pagato.', error: false }]);
});

test('1e939a362c7c: an open pipeline stage moves at once, Annulla drops a pending Conferma', async () => {
  const base = stubClient({ profile: PLACED_QUOTE_PROFILE, schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] } });
  const client = recordingClient(base);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, toast: () => {} }).renderCard('contact', 'c1');
  const open = () => mount.findAll('button').find((node) => node.getAttribute('data-action') === 'change-offer-stage').dispatch('click');
  open();
  mount.findAll('button').find((node) => node.getAttribute('data-stage') === 'pagato').dispatch('click');
  const box = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '').startsWith('card-confirm'));
  box.findAll('button').find((node) => node.textContent === 'Annulla').dispatch('click');
  await flushClicks();
  assert.equal(box.getAttribute('class'), 'card-confirm hidden', 'Annulla hides the panel');
  assert.equal(client.writes.length, 0, 'Annulla never posts');
  open();
  mount.findAll('button').find((node) => node.getAttribute('data-stage') === 'prova').dispatch('click');
  await flushClicks();
  assert.deepEqual(client.writes[0].body, { toStage: 'prova', fromStage: 'proposta' }, 'an open stage needs no Conferma, like the board');
});

test('1e939a362c7c: Perso on a Pipeline asks the reason before moving', async () => {
  const base = stubClient({ profile: PLACED_QUOTE_PROFILE, schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] } });
  const client = recordingClient(base);
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, toast: () => {} }).renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'change-offer-stage').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-stage') === 'perso').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 0, 'Perso never posts without a reason');
  const question = mount.findAll('p').find((node) => node.getAttribute('class') === 'confirm-question');
  assert.ok(question.textContent.includes('Scrivi il motivo della perdita'), 'the board question asks the reason');
  const confirm = question.parentNode.findAll('button').find((node) => node.textContent === 'Conferma');
  confirm.dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 0);
  assert.ok(mount.textContent.includes('Scrivi il motivo della perdita, poi premi Conferma.'));
  const input = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo di chiusura');
  input.value = 'Budget finito';
  confirm.dispatch('click');
  await flushClicks();
  assert.deepEqual(client.writes[0].body, { toStage: 'perso', fromStage: 'proposta', reason: 'Budget finito' });
});

test('1e939a362c7c: the menu model covers every offer: quote → its opportunity, placed → pipeline, unplaced → core', () => {
  const pipelines = [accordoSalesPipeline];
  const placed = offerStageMenu(PLACED_QUOTE_PROFILE.quotes.items[0], true, PLACED_QUOTE_PROFILE.opportunities.items, pipelines);
  assert.equal(placed.kind, 'pipeline');
  assert.equal(placed.id, 'o1');
  const unplacedQuote = offerStageMenu({ id: 'q1', status: 'approved', opportunityId: 'o2' }, true, [{ id: 'o2', stage: 'proposal' }], pipelines);
  assert.equal(unplacedQuote.kind, 'core', 'a quote on an offer outside any pipeline moves the core stage');
  assert.equal(unplacedQuote.id, 'o2');
  assert.deepEqual(unplacedQuote.voices.map((voice) => voice.key), ['negotiation', 'won', 'lost']);
  assert.equal(offerStageMenu({ id: 'q1', status: 'approved' }, true, [], pipelines), null, 'no opportunity, no menu');
  assert.equal(offerStageMenu({ id: 'o3', stage: 'proposal', pipelineKey: 'ghost', pipelineStage: 'x' }, false, null, pipelines), null,
    'a pipeline this reader does not compose never falls back to a core move');
});

test('review #683: an offer on a stage its pipeline no longer defines has no Cambia stato', async () => {
  const drift = {
    ...PLACED_QUOTE_PROFILE,
    opportunities: {
      ...PLACED_QUOTE_PROFILE.opportunities,
      items: [{ ...PLACED_QUOTE_PROFILE.opportunities.items[0], pipelineStage: 'vecchia' }],
    },
    quotes: {
      ...PLACED_QUOTE_PROFILE.quotes,
      items: [{ ...PLACED_QUOTE_PROFILE.quotes.items[0], opportunityPipelineStage: 'vecchia' }],
    },
  };
  assert.equal(offerStageMenu(drift.quotes.items[0], true, drift.opportunities.items, [accordoSalesPipeline]), null,
    'no move from a stage outside the definition, and no core fallback');
  const mount = await renderCard(stubClient({ profile: drift, schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] } }));
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'change-offer-stage').length, 0,
    'the scheda shows no Cambia stato button');
});

test('review #683: a move still queued on the server reads neutral, never as an error', async () => {
  const seen = [];
  const base = stubClient({ profile: PLACED_QUOTE_PROFILE, schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] } });
  const client = recordingClient(base, () => { throw Object.assign(new Error('queued'), { code: 'BO_CRM_PENDING', status: 202 }); });
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({
    doc, mount, client, toast: (message, error) => { seen.push({ message, error: error ?? false }); },
  }).renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'change-offer-stage').dispatch('click');
  mount.findAll('button').find((node) => node.getAttribute('data-stage') === 'prova').dispatch('click');
  await flushClicks();
  assert.equal(client.writes.length, 1, 'the move was sent');
  assert.deepEqual(seen, [{ message: 'Non ancora confermato: ricarica la scheda tra poco.', error: false }],
    'the toast is neutral');
  const fieldError = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error'
    && node.textContent !== '');
  assert.equal(fieldError, undefined, 'no error line');
  const status = mount.findAll('small').find((node) => node.getAttribute('role') === 'status');
  assert.equal(status?.textContent, 'Non ancora confermato: ricarica la scheda tra poco.');
});

test('c1649d1d: the scheda Storia stati names who moved the offer from which stage to which', async () => {
  const profile = {
    ...PLACED_QUOTE_PROFILE,
    opportunities: {
      ...PLACED_QUOTE_PROFILE.opportunities,
      items: [{ ...PLACED_QUOTE_PROFILE.opportunities.items[0], owner: 'elena' }],
    },
  };
  const audit = [
    {
      action: 'opportunity.updated', actorId: 'elena', actorType: 'user', createdAt: '2026-11-08T10:00:00.000Z',
      data: { pipelineKey: 'accordo-sales', pipelineStage: 'prova', fromPipelineStage: 'richiesta-info' },
    },
    {
      action: 'opportunity.updated', actorId: 'elena', actorType: 'user', createdAt: '2026-11-08T11:00:00.000Z',
      data: { pipelineKey: 'accordo-sales', pipelineStage: 'spettro', fromPipelineStage: 'fantasma' },
    },
    {
      action: 'opportunity.updated', actorId: 'elena', actorType: 'user', createdAt: '2026-11-08T12:00:00.000Z',
      data: { owner: 'marco' },
    },
  ];
  const mount = await renderCard(stubClient({
    profile, schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] }, audit,
  }));
  await flushClicks(5);
  const text = mount.textContent;
  assert.ok(text.includes('Storia stati'), 'the history block is titled');
  assert.ok(text.includes('da Richiesta info a Prova · da elena'),
    'a pipeline move reads who, from which stage to which, with the actor the record corroborates');
  assert.ok(!text.includes('fantasma') && !text.includes('spettro'),
    'a move whose side has no label never paints a raw key');
  assert.ok(text.includes('Cambio di stato · da elena'),
    'an unlabelled move still reads the generic Italian line, like the detail');
});

test('c1649d1d: an unreadable audit trail reads one honest line', async () => {
  const mount = await renderCard(stubClient({
    profile: PLACED_QUOTE_PROFILE,
    schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] },
    auditError: new Error('boom'),
  }));
  await flushClicks(5);
  assert.ok(mount.textContent.includes('Storia stati non leggibile.'),
    'the trail failure is honest, and the card stands');
});

test('review giro 1: a rejected audit read logs its cause, never its payload', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const mount = await renderCard(stubClient({
      profile: PLACED_QUOTE_PROFILE,
      schema: { pipelineContract: 1, pipelines: [accordoSalesPipeline] },
      auditError: Object.assign(new Error('down'), { code: 'UNKNOWN', status: 500 }),
    }));
    await flushClicks(5);
    assert.ok(mount.textContent.includes('Storia stati non leggibile.'),
      'the operator still reads one honest line');
  } finally {
    console.error = original;
  }
  const reads = logged.filter(([label]) => label === '[bo] offerta non leggibile');
  assert.equal(reads.length, 1, 'the trail failure is logged once');
  assert.deepEqual(reads[0][1], { area: 'scheda-stati', code: 'UNKNOWN', status: 500 },
    'on-call sees area, code and status');
});

test('review giro 1: moves without pipelines read generic lines, never a false empty', async () => {
  const profile = {
    ...PLACED_QUOTE_PROFILE,
    opportunities: {
      ...PLACED_QUOTE_PROFILE.opportunities,
      items: [{ ...PLACED_QUOTE_PROFILE.opportunities.items[0], owner: 'elena' }],
    },
  };
  const audit = [
    {
      action: 'opportunity.updated', actorId: 'elena', actorType: 'user', createdAt: '2026-11-08T10:00:00.000Z',
      data: { pipelineKey: 'accordo-sales', pipelineStage: 'prova', fromPipelineStage: 'richiesta-info' },
    },
  ];
  const mount = await renderCard(stubClient({
    profile, schema: { pipelineContract: 1, pipelines: [] }, audit,
  }));
  await flushClicks(5);
  const text = mount.textContent;
  assert.ok(!text.includes('Ancora nessun cambio di stato.'),
    'real moves never read as no moves when the pipelines are unavailable');
  assert.ok(text.includes('Cambio di stato · da elena'),
    'the move reads the generic Italian line, like the detail');
});
