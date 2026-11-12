import test from 'node:test';
import assert from 'node:assert/strict';
import { APPOINTMENT_CONFIRM_PATH, durationLabel, openAppointmentPanel } from '../apps/admin/public/admin-appointment-panel.js';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * «Nuovo appuntamento» from the scheda (Dan 11/11): a window over the page
 * like «Scrivi» and «Nuova offerta», with the customer already chosen. It
 * asks service, duration and team person, shows that person's free slots
 * (the Calendario's suggest-slots read) and books one with Conferma (the
 * Calendario's confirm claim). No AI: it works the same with the AI off.
 */

// Thursday 12/11/2026, 07:00 in Rome.
const NOW = new Date('2026-11-12T06:00:00.000Z');

const CATALOG = {
  products: [
    {
      name: 'Lezione prova', sku: 'lezione-prova', active: true,
      offers: [{ offerId: 'p1', active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 4500 }] }],
    },
    {
      name: 'Personal training', sku: 'pt', active: true,
      offers: [{ offerId: 'p2', active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 6000 }] }],
    },
  ],
};

const MEMBERS = {
  items: [
    { subject: 'google|marco', displayName: 'Marco Bianchi', email: 'marco@palestra.it' },
    { subject: 'google|sara', displayName: 'Sara Verdi', email: 'sara@palestra.it' },
  ],
};

const SLOTS = {
  members: [{
    teamMemberId: 'google|sara',
    slots: [
      { startsAt: '2026-11-12T05:00:00.000Z', endsAt: '2026-11-12T05:30:00.000Z' }, // past
      { startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:30:00.000Z' }, // 10:00 Rome
      { startsAt: '2026-11-12T22:00:00.000Z', endsAt: '2026-11-12T22:30:00.000Z' }, // 23:00 Rome
      { startsAt: '2026-11-13T13:00:00.000Z', endsAt: '2026-11-13T13:30:00.000Z' }, // 14:00 Rome
    ],
  }],
};

function fakeClient({ catalog = CATALOG, members = MEMBERS, slots = SLOTS, confirm = null } = {}) {
  const calls = [];
  return {
    calls,
    paths: () => calls.map((call) => call.path),
    confirms: () => calls.filter((call) => call.path === APPOINTMENT_CONFIRM_PATH),
    searches: () => calls.filter((call) => call.path.startsWith('/api/appointments/suggest-slots')),
    async request(path, options = {}) {
      const method = String(options.method ?? 'GET').toUpperCase();
      calls.push({ path, method, body: options.body ? JSON.parse(options.body) : null, key: options.idempotencyKey ?? null });
      // The framework on its own serves no bookable services list (review #805 giro 2).
      if (path === '/api/appointments/services') throw Object.assign(new Error('Not Found'), { status: 404 });
      if (path === '/api/catalog/products?limit=200') {
        if (catalog instanceof Error) throw catalog;
        return catalog;
      }
      if (path === '/api/spine/memberships') {
        if (members instanceof Error) throw members;
        return members;
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        if (slots instanceof Error) throw slots;
        return typeof slots === 'function' ? slots(path) : slots;
      }
      if (path === APPOINTMENT_CONFIRM_PATH) {
        if (typeof confirm === 'function') return confirm(calls.filter((call) => call.path === path).length);
        return { decision: 'booked', appointment: { id: 'a1' } };
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(options = {}) {
  const doc = createFakeDocument();
  const host = createMount();
  const client = options.client ?? fakeClient();
  const toasts = [];
  const booked = [];
  let keys = 0;
  const panel = openAppointmentPanel({
    doc,
    host,
    client,
    issueKey: () => `key-${(keys += 1)}`,
    customer: { resource: 'contact', id: 'c1', name: 'Guido Presti' },
    spaceId: options.spaceId === undefined ? 'presti' : options.spaceId,
    toast: (text, error = false) => toasts.push({ text, error }),
    onBooked: (answer) => booked.push(answer),
    now: () => NOW,
  });
  await flush();
  return { host, panel, client, toasts, booked };
}

const byAction = (node, action) => node.findAll('button').find((button) => button.getAttribute('data-action') === action);
const selectNamed = (node, name) => node.findAll('select').find((select) => select.getAttribute('name') === `appointment-${name}`);
const chips = (node) => node.findAll('button').filter((button) => button.getAttribute('data-slot') !== null);
const errorOf = (node, name) => selectNamed(node, name).parentNode.findAll('small')[0].textContent;
const general = (node) => node.findAll('p').find((p) => p.getAttribute('role') === 'alert').textContent;

async function choose(panel, { service = 'lezione-prova', person = '1', duration = null } = {}) {
  const serviceSelect = selectNamed(panel, 'service');
  serviceSelect.value = service;
  serviceSelect.dispatch('change');
  if (duration !== null) {
    const durationSelect = selectNamed(panel, 'duration');
    durationSelect.value = String(duration);
  }
  const personSelect = selectNamed(panel, 'person');
  personSelect.value = person;
  personSelect.dispatch('change');
  await flush();
}

test('Nuovo appuntamento: the window has the scheda frame, the customer chosen, and the four steps', async () => {
  const { host, panel } = await open();
  assert.equal(panel.getAttribute('data-appointment-panel'), 'open');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.ok(String(panel.getAttribute('class')).split(' ').includes('bo-scheda-composer'), 'same component as Scrivi and Nuova offerta');
  assert.ok(panel.findAll('div').some((node) => node.getAttribute('class') === 'bo-composer-head'));
  assert.ok(panel.textContent.includes('Nuovo appuntamento · Guido Presti'), 'the head names the chosen customer');
  const services = selectNamed(panel, 'service').findAll('option').map((node) => node.textContent);
  assert.deepEqual(services, ['Scegli il servizio', 'Lezione prova · 45,00 €', 'Personal training · 60,00 €']);
  assert.deepEqual(selectNamed(panel, 'duration').findAll('option').map((node) => node.textContent),
    ['15 min', '30 min', '45 min', '1 ora', '1 ora e 30', '2 ore']);
  assert.equal(selectNamed(panel, 'duration').value, '30');
  assert.deepEqual(selectNamed(panel, 'person').findAll('option').map((node) => node.textContent),
    ['Scegli la persona', 'Marco Bianchi', 'Sara Verdi'], 'team people by name, never an id');
  assert.ok(byAction(panel, 'appointment-confirm'), 'Conferma');
  assert.ok(byAction(panel, 'appointment-cancel'), 'Annulla');
  assert.equal(host.childNodes.length, 1);
});

test('Nuovo appuntamento: the person\'s free slots come from suggest-slots, future and in working hours only', async () => {
  const { panel, client } = await open();
  assert.equal(client.searches().length, 0, 'no search before a person is chosen');
  await choose(panel);
  assert.equal(client.searches().length, 1);
  const url = new URL(`http://x${client.searches()[0].path}`);
  assert.equal(url.searchParams.get('teamMemberIds'), 'google|sara');
  assert.equal(url.searchParams.get('slotMinutes'), '30');
  assert.equal(url.searchParams.get('from'), NOW.toISOString());
  assert.equal(url.searchParams.get('to'), '2026-11-19T06:00:00.000Z', 'the next seven days');
  // Verifica 12/11: one chip per day with free hours, then that day's hours.
  const dayChips = () => panel.findAll('button').filter((button) => button.getAttribute('data-day') !== null);
  assert.deepEqual(dayChips().map((chip) => [chip.getAttribute('data-day'), chip.textContent]),
    [['2026-11-12', 'gio 12 nov'], ['2026-11-13', 'ven 13 nov']], 'the days with room, never only today');
  assert.equal(dayChips()[0].getAttribute('aria-pressed'), 'true', 'the first day is chosen');
  assert.deepEqual(chips(panel).map((chip) => chip.getAttribute('data-slot')),
    ['2026-11-12T09:00:00.000Z'], 'the past and the night are not offered');
  assert.equal(chips(panel)[0].textContent, 'gio 12 nov · 10:00–10:30', 'Rome time with the weekday');
  dayChips()[1].dispatch('click');
  assert.deepEqual(chips(panel).map((chip) => chip.getAttribute('data-slot')), ['2026-11-13T13:00:00.000Z'],
    'another day shows its own hours');

  selectNamed(panel, 'duration').value = '60';
  selectNamed(panel, 'duration').dispatch('change');
  await flush();
  assert.equal(client.searches().length, 2, 'a new duration searches again');
  assert.equal(new URL(`http://x${client.searches()[1].path}`).searchParams.get('slotMinutes'), '60');
});

test('Nuovo appuntamento: Conferma books the Calendario claim for the chosen customer, waiting while it books', async () => {
  let release;
  const client = fakeClient({
    confirm: () => new Promise((resolve) => { release = () => resolve({ decision: 'booked', appointment: { id: 'a1' } }); }),
  });
  const { host, panel, toasts, booked } = await open({ client });
  await choose(panel);
  chips(panel)[0].dispatch('click');
  assert.equal(chips(panel)[0].getAttribute('aria-pressed'), 'true');
  const confirm = byAction(panel, 'appointment-confirm');
  const first = panel.__submit();
  assert.equal(confirm.textContent, 'Prenoto…');
  assert.equal(confirm.getAttribute('disabled'), 'disabled');
  assert.equal(confirm.getAttribute('aria-busy'), 'true');
  await panel.__submit();
  assert.equal(client.confirms().length, 1, 'a second click books nothing more');
  release();
  await first;
  const sent = client.confirms()[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.key, 'key-1', 'one submission key');
  assert.deepEqual(sent.body, {
    spaceId: 'presti',
    subject: { resource: 'contact', id: 'c1', owner: 'host' },
    teamMemberId: 'google|sara',
    serviceKey: 'lezione-prova',
    priceCents: 4500,
    currency: 'EUR',
    startsAt: '2026-11-12T09:00:00.000Z',
    endsAt: '2026-11-12T09:30:00.000Z',
    notes: null,
    sourceKey: 'calendario:google|sara:2026-11-12T09:00:00.000Z:c1',
    source: { package: 'host', action: 'calendar-book' },
    confirmed: true,
  });
  assert.equal(host.childNodes.length, 0, 'the window closes');
  assert.deepEqual(toasts, [{ text: 'Appuntamento fissato: gio 12 nov · 10:00–10:30', error: false }]);
  assert.equal(booked.length, 1, 'the scheda re-reads');
  assert.ok(!client.paths().some((path) => path.includes('/phrase')), 'no AI request, ever');
});

test('Nuovo appuntamento: Conferma without service, person or slot says what is missing and sends nothing', async () => {
  const { panel, client } = await open();
  await panel.__submit();
  assert.equal(errorOf(panel, 'service'), 'Scegli il servizio.');
  assert.equal(errorOf(panel, 'person'), 'Scegli la persona del team.');
  await choose(panel);
  await panel.__submit();
  assert.equal(general(panel), 'Scegli uno degli orari liberi.');
  assert.equal(client.confirms().length, 0);
});

test('Nuovo appuntamento: Annulla, ✕ and Escape close the window with no write', async () => {
  for (const close of [
    (panel) => byAction(panel, 'appointment-cancel').dispatch('click'),
    (panel) => byAction(panel, 'appointment-close').dispatch('click'),
    (panel) => panel.dispatch('keydown', { key: 'Escape' }),
  ]) {
    const { host, panel, client } = await open();
    await choose(panel);
    chips(panel)[0].dispatch('click');
    close(panel);
    assert.equal(host.childNodes.length, 0, 'the window is gone');
    assert.equal(client.confirms().length, 0, 'nothing is booked');
  }
});

test('Nuovo appuntamento: a slot taken meanwhile says so and searches again; other refusals stay Italian', async () => {
  const taken = fakeClient({ confirm: () => { throw Object.assign(new Error('overlap'), { status: 409, code: 'APPOINTMENTS_OVERLAP' }); } });
  const first = await open({ client: taken });
  await choose(first.panel);
  chips(first.panel)[0].dispatch('click');
  await first.panel.__submit();
  await flush();
  assert.equal(general(first.panel), 'Quell’orario è appena stato occupato: scegline un altro.');
  assert.equal(taken.searches().length, 2, 'the free slots are read again');
  assert.equal(byAction(first.panel, 'appointment-confirm').textContent, 'Conferma', 'the button is back');

  const down = fakeClient({ confirm: () => { throw Object.assign(new Error('boom'), { status: 503 }); } });
  const second = await open({ client: down });
  await choose(second.panel);
  chips(second.panel)[0].dispatch('click');
  await second.panel.__submit();
  assert.ok(!general(second.panel).includes('boom'), 'no server text');
  assert.notEqual(general(second.panel), '', 'a sentence is shown');
});

test('Nuovo appuntamento: closed while booking, a failure still reaches the person as a toast', async () => {
  let fail;
  const client = fakeClient({ confirm: () => new Promise((_, reject) => { fail = () => reject(Object.assign(new Error('x'), { status: 500 })); }) });
  const { panel, toasts } = await open({ client });
  await choose(panel);
  chips(panel)[0].dispatch('click');
  const pending = panel.__submit();
  panel.dispatch('keydown', { key: 'Escape' });
  fail();
  await pending;
  assert.deepEqual(toasts, [{ text: 'Appuntamento non fissato: riapri «Nuovo appuntamento» e riprova.', error: true }]);
});

test('Nuovo appuntamento: honest states — no space, no listino, no team, no free slot', async () => {
  const noSpace = await open({ spaceId: null });
  assert.ok(noSpace.panel.textContent.includes('Scegli uno spazio'));
  assert.ok(byAction(noSpace.panel, 'appointment-cancel'), 'the window still closes');
  assert.equal(noSpace.client.calls.length, 0);

  const empty = await open({ client: fakeClient({ catalog: { products: [] } }) });
  assert.equal(errorOf(empty.panel, 'service'), 'Nessun servizio prenotabile nel listino: aggiungine uno in Catalogo.');

  const noTeam = await open({ client: fakeClient({ members: Object.assign(new Error('x'), { status: 500 }) }) });
  assert.notEqual(errorOf(noTeam.panel, 'person'), '', 'the team read failure is said');
  assert.ok(noTeam.panel.textContent.includes('Senza una persona del team'));

  const busy = await open({ client: fakeClient({ slots: { members: [{ teamMemberId: 'google|sara', slots: [] }] } }) });
  await choose(busy.panel);
  assert.ok(busy.panel.textContent.includes('Nessun orario libero nei prossimi 7 giorni'));
});

test('Nuovo appuntamento: one team person is chosen at once and searched', async () => {
  const { panel, client } = await open({ client: fakeClient({ members: { items: [MEMBERS.items[1]] } }) });
  assert.equal(selectNamed(panel, 'person').value, '0');
  assert.equal(client.searches().length, 1);
});

test('durationLabel', () => {
  assert.deepEqual([15, 30, 60, 90, 120].map(durationLabel), ['15 min', '30 min', '1 ora', '1 ora e 30', '2 ore']);
});

// ---- Inside the scheda --------------------------------------------------

test('scheda: Nuovo appuntamento opens the window with the customer, and the booking shows on the card', async () => {
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const slot = { startsAt: `${day}T10:00:00.000Z`, endsAt: `${day}T10:30:00.000Z` };
  const booked = [];
  const calls = [];
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path.startsWith('/api/customer-hub/card/')) {
        return {
          customerCardContract: 1, subject: { resource: 'contact', id: 'c1' }, name: 'Guido Presti',
          company: { id: 'co1', name: 'Palestra Esempio' }, phone: { available: false, value: null },
          email: null, socials: [], status: { value: 'contatto' },
        };
      }
      if (path.startsWith('/api/customer-hub/timeline/')) {
        return {
          conversations: { items: [] }, entries: { items: [] },
          appointments: { items: booked.map((row) => ({ ...row, status: 'booked', serviceKey: 'lezione-prova' })) },
        };
      }
      if (path === '/api/catalog/products?limit=200') return CATALOG;
      if (path === '/api/spine/memberships') return { items: [MEMBERS.items[1]] };
      if (path.startsWith('/api/appointments/suggest-slots')) return { members: [{ teamMemberId: 'google|sara', slots: [slot] }] };
      if (path === APPOINTMENT_CONFIRM_PATH && options.method === 'POST') {
        const body = JSON.parse(options.body);
        booked.push({ startsAt: body.startsAt, endsAt: body.endsAt, teamMemberId: body.teamMemberId });
        return { decision: 'booked', appointment: { id: 'a1' } };
      }
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const navs = [];
  const toasts = [];
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti', navigate: (hash) => navs.push(hash), toast: (text) => toasts.push(text),
  });
  await view.renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('nessun appuntamento prenotato'));
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'new-appointment').dispatch('click');
  await flush();
  assert.deepEqual(navs, [], 'no jump to the Calendario');
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-appointment-panel') === 'open');
  assert.ok(panel, 'the window opens over the scheda');
  assert.ok(panel.textContent.includes('Guido Presti'), 'with the customer already chosen');
  await view.renderCard('contact', 'c1');
  assert.ok(mount.findAll('div').some((node) => node.getAttribute('data-appointment-panel') === 'open'),
    'a re-read of the same scheda keeps the window open');
  selectNamed(panel, 'service').value = 'lezione-prova';
  chips(panel)[0].dispatch('click');
  await panel.__submit();
  await flush();
  assert.ok(!mount.findAll('div').some((node) => node.getAttribute('data-appointment-panel') === 'open'), 'the window closes');
  assert.ok(toasts.some((text) => text.startsWith('Appuntamento fissato')), toasts.join('|'));
  const card = mount.findAll('section').find((node) => String(node.getAttribute('class')).includes('bo-scheda-card-appt'));
  assert.ok(card && !card.textContent.includes('nessun appuntamento prenotato'), 'the scheda shows the new appointment');
  assert.ok(card.textContent.includes('Lezione prova'), card?.textContent);
});

// Review #776 (P2): the roster is an administration read. A member or a
// manager is refused it and still books for themselves, never a dead window.
test('review #776: without the team roster the operator books for themselves', async () => {
  const forbidden = Object.assign(new Error('forbidden'), { status: 403, code: 'PERMISSION_NOT_IN_ROLE' });
  const client = fakeClient({ members: forbidden });
  const base = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if (path === '/api/spine/context') return { membership: { subject: 'google|sara', role: 'member' } };
    return base(path, options);
  };
  const { panel } = await open({ client });
  await flush();
  assert.deepEqual(selectNamed(panel, 'person').findAll('option').map((node) => node.textContent), ['Scegli la persona', 'Tu']);
  assert.equal(selectNamed(panel, 'person').value, '0', 'the operator is chosen at once');
  assert.ok(panel.textContent.includes('Prenoti per te'), 'the window says why only you');
  const url = new URL(`http://x${client.searches()[0].path}`);
  assert.equal(url.searchParams.get('teamMemberIds'), 'google|sara', 'the slots are the operator\'s own');
  assert.ok(chips(panel).length > 0, 'free slots are offered');
});

// Review #776 (P2): one window at a time, and Scrivi keeps its draft when
// Nuovo appuntamento takes its place.
test('review #776: opening Nuovo appuntamento keeps the Scrivi draft for when it reopens', async () => {
  const card = {
    customerCardContract: 1, subject: { resource: 'contact', id: 'c1' }, name: 'Guido Presti',
    company: { id: 'co1', name: 'Palestra Esempio' }, phone: { available: false, value: null },
    email: 'guido@palestra-esempio.it', socials: [], status: { value: 'contatto' },
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/customer-hub/card/')) return card;
      if (path.startsWith('/api/connectors')) return { connectors: [{ channel: 'email', status: 'active', connectionKey: 'g1', account: 'studio@esempio.it' }] };
      if (path === '/api/catalog/products?limit=200') return CATALOG;
      if (path === '/api/spine/memberships') return MEMBERS;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
  const mount = createMount();
  await createCustomerCardView({ doc: createFakeDocument(), mount, client, spaceId: 'presti' }).renderCard('contact', 'c1');
  const action = (name) => mount.findAll('button').find((node) => node.getAttribute('data-action') === name);
  action('compose-message').dispatch('click');
  await flush();
  const text = mount.findAll('textarea')[0];
  text.value = 'Ciao Guido, ti scrivo per';
  text.dispatch('input');
  action('new-appointment').dispatch('click');
  await flush();
  assert.ok(mount.findAll('div').some((node) => node.getAttribute('data-appointment-panel') === 'open'));
  action('appointment-cancel').dispatch('click');
  action('compose-message').dispatch('click');
  await flush();
  assert.equal(mount.findAll('textarea')[0].value, 'Ciao Guido, ti scrivo per', 'the draft is back');
});

// Review #776 (P2): a booking that answers after the operator moved to
// another customer never repaints the first one over it.
test('review #776: a booking answered after leaving the scheda keeps the next customer on screen', async () => {
  const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const slot = { startsAt: `${day}T10:00:00.000Z`, endsAt: `${day}T10:30:00.000Z` };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const reads = [];
  const cardOf = (id, name) => ({
    customerCardContract: 1, subject: { resource: 'contact', id }, name,
    company: { id: 'co1', name: 'Palestra Esempio' }, phone: { available: false, value: null },
    email: null, socials: [], status: { value: 'contatto' },
  });
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (options.method === 'POST' && path === APPOINTMENT_CONFIRM_PATH) {
        await gate;
        return { decision: 'booked', appointment: { id: 'a1' } };
      }
      reads.push(path);
      if (path === '/api/customer-hub/card/contact/c1') return cardOf('c1', 'Guido Presti');
      if (path === '/api/customer-hub/card/contact/c2') return cardOf('c2', 'Altra Persona');
      if (path === '/api/catalog/products?limit=200') return CATALOG;
      if (path === '/api/spine/memberships') return { items: [MEMBERS.items[1]] };
      if (path.startsWith('/api/appointments/suggest-slots')) return { members: [{ teamMemberId: 'google|sara', slots: [slot] }] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
  const mount = createMount();
  const view = createCustomerCardView({ doc: createFakeDocument(), mount, client, spaceId: 'presti' });
  await view.renderCard('contact', 'c1');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'new-appointment').dispatch('click');
  await flush();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-appointment-panel') === 'open');
  selectNamed(panel, 'service').value = 'lezione-prova';
  chips(panel)[0].dispatch('click');
  const booking = panel.__submit();
  await flush();
  await view.renderCard('contact', 'c2');
  reads.length = 0;
  release();
  await booking;
  await flush();
  assert.ok(mount.textContent.includes('Altra Persona'), 'the next customer stays');
  assert.ok(!reads.some((path) => path.includes('/card/contact/c1')), 'the first customer is not read again');
});

test('backlog:0a980182918f: a refused booking logs the shared write line, once, never «Object»', async () => {
  const refused = fakeClient({
    confirm: () => {
      throw Object.assign(new Error('Orario fuori dalle ore di lavoro'), {
        status: 400, code: 'VALIDATION_FAILED', method: 'POST', path: APPOINTMENT_CONFIRM_PATH,
      });
    },
  });
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const { panel } = await open({ client: refused });
    await choose(panel);
    chips(panel)[0].dispatch('click');
    await panel.__submit();
    await flush();
  } finally {
    console.error = original;
  }
  const lines = logged.map((args) => String(args[0]));
  assert.equal(lines.length, 1, `one line per failure: ${lines.join(' | ')}`);
  assert.equal(lines[0], `[bo] scrittura fallita POST ${APPOINTMENT_CONFIRM_PATH} · 400 VALIDATION_FAILED: Orario fuori dalle ore di lavoro`);
  assert.ok(!lines.some((line) => line.includes('appuntamento non fissato')));
});

// P1 11/11: the window books from the server's own bookable list when it
// serves one (the pilot), so Conferma sends the key the worker books.
test('P1 11/11: the window menu is the served bookable list and the claim books its key and price', async () => {
  const served = { services: [
    { serviceKey: 'lezione-prova', name: 'Lezione di prova', priceCents: 1500, currency: 'EUR' },
    { serviceKey: 'personal-training', name: 'PT singola', priceCents: 4000, currency: 'EUR' },
  ] };
  const base = fakeClient();
  const client = {
    ...base,
    async request(path, options = {}) {
      if (path === '/api/appointments/services') return served;
      return base.request(path, options);
    },
  };
  const { panel } = await open({ client });
  assert.deepEqual(selectNamed(panel, 'service').findAll('option').map((node) => node.textContent),
    ['Scegli il servizio', 'Lezione di prova · 15,00 €', 'PT singola · 40,00 €']);
  assert.ok(!base.paths().includes('/api/catalog/products?limit=200'), 'no second rule over the catalog');
  await choose(panel, { service: 'personal-training' });
  chips(panel)[0].dispatch('click');
  await panel.__submit();
  const sent = base.confirms()[0].body;
  assert.equal(sent.serviceKey, 'personal-training');
  assert.equal(sent.priceCents, 4000);
});

// Verifica 12/11: with a full free day the first twelve hours were all
// today and the next days could not be chosen.
test('verifica 12/11: a full free day never hides the next days', async () => {
  const today = Array.from({ length: 16 }, (_, index) => {
    const startMs = Date.parse('2026-11-12T08:00:00.000Z') + index * 30 * 60000;
    return { startsAt: new Date(startMs).toISOString(), endsAt: new Date(startMs + 30 * 60000).toISOString() };
  });
  const tomorrow = [{ startsAt: '2026-11-13T09:00:00.000Z', endsAt: '2026-11-13T09:30:00.000Z' }];
  const { panel, client } = await open({ client: fakeClient({ slots: { members: [{ teamMemberId: 'google|sara', slots: [...today, ...tomorrow] }] } }) });
  await choose(panel);
  const dayChips = panel.findAll('button').filter((button) => button.getAttribute('data-day') !== null);
  assert.deepEqual(dayChips.map((chip) => chip.getAttribute('data-day')), ['2026-11-12', '2026-11-13']);
  dayChips[1].dispatch('click');
  assert.deepEqual(chips(panel).map((chip) => chip.getAttribute('data-slot')), ['2026-11-13T09:00:00.000Z']);
  chips(panel)[0].dispatch('click');
  await panel.__submit();
  assert.equal(client.confirms()[0].body.startsAt, '2026-11-13T09:00:00.000Z', 'a later day books');
});
