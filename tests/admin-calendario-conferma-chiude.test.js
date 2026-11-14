// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:134f3ed7 — dopo «Conferma» il pannello «Nuovo appuntamento»
 * restava aperto sopra la colonna del giorno (con «Prenotato: …»), restava
 * aperto anche uscendo e tornando nel Calendario, la seconda apertura aveva
 * giorno e ora vuoti e «Mancano dei dati: servizio» restava dopo la scelta.
 * Come Google Calendar: la Conferma chiude il pannello e il nuovo blocco si
 * vede evidenziato; ogni apertura propone giorno e ora; la nota sparisce
 * appena il dato c'è.
 */

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
    { active: true, sku: 'barba', name: 'Barba', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 2000 }] }] },
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

function stubClient({ customers = [], phrase = null, slots = [] } = {}) {
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
      if (path === '/api/spine/memberships') throw notFound();
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        return {
          from: '2026-10-19T00:00:00.000Z',
          to: '2026-10-26T00:00:00.000Z',
          members: [{ teamMemberId: 'marco', appointments: [...extra] }],
        };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots }] };
      }
      if (path === '/api/appointments/phrase') {
        return { draft: phrase, dryRun: false, spaceId: 'locale' };
      }
      if (path === '/api/appointments/propose') {
        const body = payload({ body: options.body });
        return { decision: 'confirm-required', draft: body, spaceId: 'locale', permission: 'book-appointments' };
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

async function openWeek(mount, now = '2026-10-21T06:00:00Z') {
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  return now;
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

const formPops = (mount) => mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');
const isOpen = (pop) => pop.getAttribute('hidden') === null && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden');
const texts = (mount, tag) => mount.findAll(tag).map((node) => node.textContent);
const byName = (mount) => Object.fromEntries(
  mount.findAll('input').map((node) => [node.getAttribute('name'), node])
    .concat(mount.findAll('select').map((node) => [node.getAttribute('name'), node])),
);

test('Conferma riuscita: il pannello si chiude e il nuovo blocco è visibile ed evidenziato', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ customers: [{ resource: 'contact', id: 'c1', name: 'Ada' }] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle(14);
  await openWeek(mount);
  openManual(mount);
  assert.ok(isOpen(formPops(mount)[0]), 'the form opens');
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
  mount.querySelector('.cal-manual').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle(12);
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 1);
  assert.equal(isOpen(formPops(mount)[0]), false, 'the panel closes after Conferma');
  assert.ok(!mount.textContent.includes('Prenotato:'), 'no «Prenotato» line covers the day');
  const reads = client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week'));
  assert.ok(reads.length >= 2, 'the week reloads so the new event paints');
  const block = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 'b1');
  assert.ok(block, 'the new block is on the grid');
  assert.ok(mount.querySelector('div[data-role="event-detail"]'), 'the new event opens highlighted beside its block');
});

test('uscendo e tornando nel Calendario non resta un pannello vecchio', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  openManual(mount);
  assert.ok(isOpen(formPops(mount)[0]), 'the form opens');
  byName(mount).date.value = '2026-10-23';
  byName(mount).date.dispatch('input');
  // Leaving the Calendario: the shell invalidates the view and mounts another screen.
  view.invalidate();
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  mount.appendChild(doc.createElement('div'));
  // Back on the Calendario: a fresh entry, no old panel.
  await view.render();
  await settle();
  assert.equal(isOpen(formPops(mount)[0]), false, 'no old panel on return');
  assert.ok(!mount.textContent.includes('Prenotato:'), 'no stale done line on return');
  openManual(mount);
  assert.ok(isOpen(formPops(mount)[0]), 'the form still opens');
  assert.equal(byName(mount).date.value, '2026-10-22', 'a clean opening proposes the day, never the old one');
});

test('ogni apertura propone giorno e ora: domani 09:30–10:00 senza slot cliccato', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  openManual(mount);
  // 2026-10-21 06:00Z is 08:00 in Rome: tomorrow is 2026-10-22.
  assert.equal(byName(mount).date.value, '2026-10-22');
  assert.equal(byName(mount).start.value, '09:30');
  assert.equal(byName(mount).end.value, '10:00');
});

test('il messaggio di dato mancante sparisce appena il dato c’è', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  openManual(mount);
  mount.querySelector('.cal-manual').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle(4);
  assert.ok(texts(mount, 'p').some((text) => text.includes('Mancano dei dati')), 'the missing fields are named');
  assert.ok(texts(mount, 'p').some((text) => text.includes('servizio')), 'the missing service is named');
  const form = byName(mount);
  form.serviceKey.value = 'taglio';
  form.serviceKey.dispatch('change');
  assert.ok(!texts(mount, 'p').some((text) => text.includes('Mancano dei dati')), 'choosing the service clears the note at once');
  form.teamMemberId.value = 'marco';
  form.teamMemberId.dispatch('change');
  assert.ok(!texts(mount, 'p').some((text) => text.includes('Mancano dei dati')), 'the note stays gone while filling the form');
});
