// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:134f3ed7 (seguito 18/11, prova del Mac sul live a7bd751) — la
 * risposta di Conferma in produzione non contiene l'id dell'appuntamento
 * (`{ decision: 'booked' }` senza `appointment`) e il codice evidenziava solo
 * quando l'id c'era: il pannello si chiudeva ma nessun blocco risultava mai
 * `cal-selected`/`aria-pressed`. Cura: evidenza per orario e persona quando
 * l'id manca (la riga locale accompagna la settimana, la ricarica adotta la
 * riga del server con stesso orario e persona). Entrambi rossi prima della
 * cura, verdi dopo.
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

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const teamWeekCalls = (client) => client.calls.filter((call) => call.path.startsWith('/api/appointments/team-week'));

/**
 * Il ponte di produzione risponde `{ decision: 'booked' }` senza
 * `appointment`: nessun id su cui agganciare la selezione.
 */
function noIdClient(server) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/appointments/services') throw notFound();
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/customer-data/profile/')) throw notFound();
      if (path.startsWith('/api/customer-data/customers')) {
        return customersOf([{ resource: 'contact', id: 'c1', name: 'Ada' }])(path);
      }
      if (path === '/api/spine/memberships') throw notFound();
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        return {
          from: '2026-10-19T00:00:00.000Z',
          to: '2026-10-26T00:00:00.000Z',
          members: [{ teamMemberId: 'marco', appointments: server.appointments }],
        };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots: [] }] };
      }
      if (path === '/api/appointments/phrase') return { draft: null, dryRun: false, spaceId: 'locale' };
      if (path === '/api/appointments/propose') {
        return { decision: 'confirm-required', draft: payload({ body: options.body }), spaceId: 'locale', permission: 'book-appointments' };
      }
      if (path === '/api/appointments/confirm') {
        return { decision: 'booked', replayed: false, spaceId: 'locale' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function bookWithoutId(client, mount) {
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento')).dispatch('click');
  mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente')).dispatch('click');
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'Ada';
  search.dispatch('input');
  await settle(7);
  mount.findAll('button').find((node) => node.textContent === 'Ada').dispatch('click');
  await settle(2);
  const byName = () => Object.fromEntries(
    mount.findAll('input').map((node) => [node.getAttribute('name'), node])
      .concat(mount.findAll('select').map((node) => [node.getAttribute('name'), node])),
  );
  const form = byName();
  form.teamMemberId.value = 'marco';
  form.teamMemberId.dispatch('change');
  form.serviceKey.value = 'taglio';
  form.serviceKey.dispatch('change');
  form.price.value = '45.00';
  form.date.value = '2026-10-22';
  form.start.value = '10:00';
  form.end.value = '10:30';
  mount.querySelector('.cal-manual').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle(14);
}

const highlighted = (mount) => mount.findAll('button')
  .filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-selected'));

test('Conferma senza id: il pannello si chiude e il blocco si vede evidenziato (backlog:134f3ed7)', async () => {
  const server = { appointments: [] };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = noIdClient(server);
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  const readsBefore = teamWeekCalls(client).length;
  await bookWithoutId(client, mount);
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 1, 'the booking is sent');
  assert.ok(teamWeekCalls(client).length > readsBefore, 'the week reloads after Conferma');
  const pops = mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');
  assert.equal(pops[0].getAttribute('hidden') === null && !(pops[0].getAttribute('class') ?? '').includes('hidden'), false, 'the panel closes after Conferma');
  const blocks = highlighted(mount);
  assert.equal(blocks.length, 1, 'the new block paints highlighted even without an id in the answer');
  assert.ok(blocks[0].getAttribute('aria-pressed') === 'true', 'the highlighted block presses aria-pressed');
  assert.ok((blocks[0].textContent ?? '').includes('10:00'), `the highlighted block is the booked hour, got ${blocks[0].textContent ?? '(no text)'}`);
});

test('Conferma senza id: il reload adotta la riga del server con stesso orario (backlog:134f3ed7)', async () => {
  const server = { appointments: [] };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = noIdClient(server);
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  await bookWithoutId(client, mount);
  assert.equal(highlighted(mount).length, 1, 'the optimistic block paints highlighted');
  // Il server ora conosce la riga (con il suo id): stesso membro, stesso orario.
  server.appointments = [{
    id: 'b9', status: 'booked',
    startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:30:00.000Z',
    teamMemberId: 'marco',
  }];
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle(14);
  const blocks = highlighted(mount);
  assert.equal(blocks.length, 1, 'one block stays highlighted after the server row lands');
  assert.equal(blocks[0].getAttribute('data-event-id'), 'b9', 'the highlight adopts the server row');
});
