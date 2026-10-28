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

function stubClient({ card = CARD, timeline = TIMELINE, profile = PROFILE, enriched = ENRICHED, failHub = false, calls = null, failCalls = false, callsError = null, enrichedError = null } = {}) {
  const requested = [];
  return {
    calls: requested,
    async request(path) {
      requested.push(path);
      if (path.startsWith('/api/customer-hub/')) {
        if (failHub) throw Object.assign(new Error('Not Found'), { status: 404 });
        if (path.includes('/card/')) return card;
        return timeline;
      }
      if (path.startsWith('/api/customer-data/profile/')) {
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

const renderCard = async (client, spaceId = undefined) => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, spaceId }).renderCard('contact', 'c1');
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
  assert.ok(text.includes('coach-guido'), 'the next appointment names its owner');
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
  assert.equal(badge.textContent, 'contatto', 'the pill shows the card stato');
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
  assert.ok(text.includes('coach-guido'), 'the future booked slot is the next appointment');
  assert.ok(!text.includes('coach-old'), 'no cancelled, done or past slot is ever labelled next');
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

  const details = mount.findAll('details');
  assert.equal(details.length, 1, 'the transcript is openable');
  assert.ok(details[0].textContent.includes('Trascrizione'), 'the opener names the transcript');
  assert.ok(details[0].textContent.includes('Operatrice: buongiorno'), 'the transcript text is inside the opener');
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
  assert.deepEqual(mount.findAll('details'), [], 'an erased transcript has no opener');
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
  const mount = await renderCard(
    stubClient({ callsError: Object.assign(new Error('boom'), { status: 500 }) }), 'call-a',
  );
  assert.ok(mount.textContent.includes('Scheda non disponibile'), 'the card shows its error UI');
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
  assert.ok(text.includes('Ruolo: Istruttore (fonte: firma email · 2026-10-20)'), 'each datum cites its own source and date');
  assert.ok(text.includes('Nome: Guido (fonte: Contatti Google · 2026-10-21)'), 'the second source is cited beside its datum');
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
  assert.ok(text.includes('arricchimento disattivato il 2026-10-21 (opt-out)'), 'the opt-out is shown with its date');
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
  const mount = await renderCard(
    stubClient({ enrichedError: Object.assign(new Error('boom'), { status: 500 }) }),
  );
  assert.ok(mount.textContent.includes('Scheda non disponibile'), 'the card shows its error UI');
  assert.ok(!mount.textContent.includes('nessun dato arricchito registrato'),
    'a 500 never reads as no enriched data');
});
