// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCalendarioView, isWebLink } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:9ff9a9ee1fea (VERIFIER_BACK del 17/11 su agent-crm#945: il form
 * «Nuovo appuntamento» non aveva il campo Luogo, niente popover né
 * dettaglio). Come il form evento di Google Calendar: il form ha «Luogo»
 * (indirizzo libero oppure «Online») e «Link riunione», la Conferma li
 * salva con l'appuntamento e il dettaglio li mostra — un link online è
 * cliccabile. Un link senza luogo non parte: lo dice in italiano.
 */

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
  ],
};

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

function payload(call) {
  if (typeof call.body === 'string') {
    try { return JSON.parse(call.body); } catch { return call.body; }
  }
  return call.body;
}

function customersOf(items) {
  return (path) => {
    const query = new URL(path, 'http://stub.test').searchParams.get('q') ?? '';
    const needle = query.toLowerCase();
    return { items: items.filter((item) => String(item?.name ?? '').toLowerCase().includes(needle)) };
  };
}

function stubClient({ customers = [], week = null } = {}) {
  const calls = [];
  let extra = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/appointments/services') throw notFound();
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/customer-data/profile/')) throw notFound();
      if (path.startsWith('/api/customer-data/customers')) return customersOf(customers)(path);
      if (path === '/api/spine/memberships') {
        return { items: [{ subject: 'marco', displayName: 'Marco', email: 'marco@example.com' }] };
      }
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        if (week) return week;
        return {
          from: '2026-10-19T00:00:00.000Z',
          to: '2026-10-26T00:00:00.000Z',
          members: [{ teamMemberId: 'marco', appointments: [...extra] }],
        };
      }
      if (path === '/api/appointments/propose') {
        return { decision: 'confirm-required', draft: payload({ body: options.body }), spaceId: 'locale', permission: 'book-appointments' };
      }
      if (path === '/api/appointments/confirm') {
        const body = payload({ body: options.body });
        const appointment = { ...body, id: 'b1', status: 'booked' };
        extra = [appointment];
        return { decision: 'booked', appointment, replayed: false, spaceId: 'locale' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 9) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function openManual(mount) {
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  toggle.dispatch('click');
  const voice = mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente'));
  voice.dispatch('click');
}

async function pickCustomerByName(mount, name, rounds = 7) {
  const search = mount.querySelector('input[name="customerSearch"]');
  assert.ok(search, 'the manual form searches the customer by name');
  search.value = name;
  search.dispatch('input');
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const choice = mount.findAll('button').find((node) => node.textContent === name);
  assert.ok(choice, `the search lists ${name} by name`);
  choice.dispatch('click');
  await settle(2);
}

const byName = (mount) => Object.fromEntries(
  mount.findAll('input').map((node) => [node.getAttribute('name'), node])
    .concat(mount.findAll('select').map((node) => [node.getAttribute('name'), node])),
);

const labelOf = (mount, name) => {
  const field = byName(mount)[name];
  assert.ok(field, `the form has a ${name} field`);
  let node = field;
  while (node && node.tagName !== 'LABEL') node = node.parentNode;
  return node ? node.findAll('span').find((span) => (span.getAttribute('class') ?? '').includes('cal-field-label'))?.textContent : null;
};

async function openCalendar({ customers = [], week = null } = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers, week });
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle(14);
  return { doc, mount, client, view };
}

async function fillAndConfirm(mount, { location = '', locationUrl = '' } = {}) {
  await pickCustomerByName(mount, 'Ada');
  const form = byName(mount);
  form.teamMemberId.value = 'marco';
  form.teamMemberId.dispatch('change');
  form.serviceKey.value = 'taglio';
  form.serviceKey.dispatch('change');
  form.price.value = '45.00';
  form.date.value = '2026-10-22';
  form.start.value = '18:00';
  form.end.value = '18:30';
  if ('location' in form) {
    form.location.value = location;
    form.location.dispatch('input');
  }
  if ('locationUrl' in form) {
    form.locationUrl.value = locationUrl;
    form.locationUrl.dispatch('input');
  }
  mount.querySelector('.cal-manual').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle(12);
}

test('9ff9a9ee1fea: il form «Nuovo appuntamento» ha Luogo e Link riunione, con etichetta', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  assert.equal(labelOf(mount, 'location'), 'Luogo');
  assert.equal(labelOf(mount, 'locationUrl'), 'Link riunione');
});

test('9ff9a9ee1fea: la Conferma salva luogo e link con l’appuntamento', async () => {
  const { mount, client } = await openCalendar({
    customers: [{ resource: 'contact', id: 'c1', name: 'Ada' }],
  });
  openManual(mount);
  await fillAndConfirm(mount, { location: 'Online', locationUrl: 'https://meet.example.com/abc-def' });
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1, 'one confirm write');
  const body = payload(confirms[0]);
  assert.equal(body.location, 'Online');
  assert.equal(body.locationUrl, 'https://meet.example.com/abc-def');
});

function weekWith(place) {
  return {
    from: '2026-11-09T00:00:00.000Z',
    to: '2026-11-16T00:00:00.000Z',
    members: [{
      teamMemberId: 'marco',
      appointments: [{
        id: 'p1', status: 'booked',
        startsAt: '2026-11-10T09:00:00.000Z', endsAt: '2026-11-10T09:45:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', sourceKey: 'calendario:marco:p1:c1',
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
        ...place,
      }],
    }],
  };
}

function listeningDocument() {
  const base = createFakeDocument();
  const listeners = { click: [], keydown: [] };
  return {
    ...base,
    activeElement: null,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    fire(type, event) { for (const handler of listeners[type] ?? []) handler(event); },
  };
}

async function openEvent(place) {
  const doc = listeningDocument();
  const mount = createMount();
  const client = stubClient({ week: weekWith(place) });
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-11-09T07:00:00Z'),
  });
  await view.render();
  await settle(14);
  const block = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 'p1');
  assert.ok(block, 'the event paints');
  block.dispatch('click', { target: block });
  doc.fire('click', { target: block });
  const pop = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(pop, 'the popover opens');
  return { doc, mount, client, view, pop };
}

test('9ff9a9ee1fea: il dettaglio mostra il luogo e il link online è cliccabile', async () => {
  const { pop } = await openEvent({ location: 'Online', locationUrl: 'https://meet.example.com/abc-def' });
  const place = pop.findAll('p').find((node) => node.getAttribute('data-role') === 'event-location');
  assert.ok(place, 'the place paints in the detail');
  const link = place.findAll('a')[0];
  assert.ok(link, 'the online link is clickable');
  assert.equal(link.textContent, 'Online');
  assert.equal(link.getAttribute('href'), 'https://meet.example.com/abc-def');
  assert.equal(link.getAttribute('target'), '_blank');
});

test('9ff9a9ee1fea: un indirizzo senza link si mostra come testo, mai come link', async () => {
  const { pop } = await openEvent({ location: 'Via delle Rose 12, Milano', locationUrl: null });
  const place = pop.findAll('p').find((node) => node.getAttribute('data-role') === 'event-location');
  assert.ok(place, 'the address paints in the detail');
  assert.ok(place.textContent.includes('Via delle Rose 12, Milano'));
  assert.equal(place.findAll('a').length, 0, 'no link without a meeting url');
});

test('9ff9a9ee1fea: un link senza luogo non parte e lo dice in italiano', async () => {
  const { mount, client } = await openCalendar({
    customers: [{ resource: 'contact', id: 'c1', name: 'Ada' }],
  });
  openManual(mount);
  await fillAndConfirm(mount, { location: '', locationUrl: 'https://meet.example.com/abc-def' });
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 0, 'no write without the place label');
  assert.ok(/luogo/i.test(mount.textContent), 'the note names the place in Italian');
});

test('9ff9a9ee1fea: il controllo del link non usa regex letterali con doppia barra', () => {
  const source = readFileSync(
    new URL('../apps/admin/public/admin-calendario.js', import.meta.url),
    'utf8',
  );
  assert.ok(!source.includes('/^https?:'), 'no literal http regex: the /bo pilot cuts the shell after //');
  assert.ok(isWebLink('https://meet.example.com/abc-def'));
  assert.ok(isWebLink('http://example.com/x'));
  assert.ok(isWebLink('  HTTPS://example.com/x  '));
  assert.ok(!isWebLink('ftp://example.com/x'));
  assert.ok(!isWebLink('meet.example.com/abc-def'));
  assert.ok(!isWebLink(''));
  assert.ok(!isWebLink(null));
});
