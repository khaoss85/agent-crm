import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCustomerCardView,
  mergeLinkedIdentities,
  offerStageTargets,
  OPPORTUNITY_ALLOWED_TRANSITIONS as CARD_TRANSITIONS,
} from '../apps/admin/public/admin-customer-card.js';
import { OPPORTUNITY_ALLOWED_TRANSITIONS as SERVICE_TRANSITIONS } from '../packages/modules/opportunity/src/opportunity-service.js';
import { OPPORTUNITY_STAGES } from '../packages/core/src/schema.js';
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

function stubClient({ card = CARD, timeline = TIMELINE, profile = PROFILE, enriched = ENRICHED, failHub = false, cardError = null, timelineError = null, profileError = null, calls = null, failCalls = false, callsError = null, enrichedError = null } = {}) {
  const requested = [];
  return {
    calls: requested,
    async request(path) {
      requested.push(path);
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
      throw new Error(`unexpected request ${path}`);
    },
  };
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
  assert.ok(text.includes('nessun dato arricchito registrato'), 'the empty enriched section stays honest');

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
    request() { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
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
  assert.ok(text.includes('non disponibile: nessun riepilogo registrato'), 'no summary is invented after erasure');
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
  assert.ok(mount.textContent.includes('non disponibile: nessun dato di chiamata registrato'),
    'without a space the calls section stays unavailable');
  assert.ok(!nospace.calls.some((path) => path.startsWith('/api/call-intelligence/')),
    'without a space no calls read is attempted');

  const uncomposed = await renderCard(stubClient({ failCalls: true }), 'call-a');
  assert.ok(uncomposed.textContent.includes('Riepilogo AI'), 'the card still renders');
  assert.ok(uncomposed.textContent.includes('non disponibile: nessun riepilogo registrato'),
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
  assert.ok(mount.textContent.includes('non disponibile: dati arricchiti non leggibili'),
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
  assert.ok(!mount.textContent.includes('nessun dato arricchito registrato'),
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
  assert.ok(text.includes('verifiche non complete'), 'unreadable evidence never reads as a definitive none');
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
  assert.ok(!text.includes('verifiche non complete'), 'proven absence carries no hedge');
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

  // C17: every card names channel, direction detail and `<hh:mm>`, and the
  // sync row reads `←/→ <canale> · <stato>`.
  assert.ok(text.includes('WhatsApp · da +39 333 1234567 · 11:00'), 'inbound card with its hour');
  assert.ok(text.includes('WhatsApp · inviato da elena · 11:05'), 'outbound card with its hour');
  assert.ok(text.includes('← WhatsApp · ricevuto'), 'inbound sync row with its arrow');
  assert.ok(text.includes('→ WhatsApp · consegnato'), 'outbound sync row with its arrow');
  assert.ok(text.includes('→ Telefono · completata'), 'call sync row with its arrow and outcome');

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
    async request(path) {
      if (path.startsWith('/api/customer-data/enriched/')) return current;
      return stubClient().request(path);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, toast }).renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('nessun dato arricchito registrato'), 'the section starts empty');
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
    async request(path) {
      if (path.startsWith('/api/customer-data/enriched/')) {
        if (fail) throw Object.assign(new Error('boom'), { status: 500 });
        return enriched;
      }
      return stubClient().request(path);
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
test('the offer panel names the quote after its opportunity, with the state in Italian', async () => {
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
  assert.ok(text.includes('Pacchetto 10 ingressi · approvata'),
    'the offer reads with its opportunity name and the Italian state');
  assert.ok(!text.includes('8d8f1d4d-25c1-4641-8836-267581100b32'),
    'a bare record id is never the offer name');
  assert.ok(!text.includes('approved'), 'the raw English state is never shown');
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

  // The default fixture reads a quote line (fromQuote): quotes have no
  // governed stage transition, so no menu is offered there.
  const quoteMount = await renderCard(stubClient());
  assert.ok(quoteMount.textContent.includes('Preventivo 10 ingressi'), 'the fixture reads a quote line');
  assert.equal(
    quoteMount.findAll('button').filter((node) => node.getAttribute('data-action') === 'change-offer-stage').length,
    0,
    'a quote line carries no stage menu',
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
  byAction('new-offer').dispatch('click');
  assert.deepEqual(navs, ['#/modules/opportunity/new'], 'Nuova offerta opens the offer creation screen');
  assert.deepEqual(JSON.parse(storage.getItem('accordo.bo.customer-pick.offer')), {
    resource: 'contact', id: 'c1', name: 'Guido Presti',
    company: { id: 'co1', name: 'Palestra Esempio' },
  }, 'the offer pick names the record and its company');
  assert.equal(storage.getItem('accordo.bo.customer-pick.appointment'), null,
    'no appointment pick leaks from the offer voice');

  byAction('new-appointment').dispatch('click');
  assert.deepEqual(navs, ['#/modules/opportunity/new', '#/calendario'],
    'Nuovo appuntamento opens the calendar manual booking');
  assert.deepEqual(JSON.parse(storage.getItem('accordo.bo.customer-pick.appointment')), {
    resource: 'contact', id: 'c1', name: 'Guido Presti',
    company: { id: 'co1', name: 'Palestra Esempio' },
  }, 'the appointment pick names the same record');
});
