// @ts-check
/**
 * backlog:0f2ae629e09b — appuntamento ricorrente nel Calendario (/bo),
 * ambito piccolo: il form «Nuovo appuntamento» ha la scelta «Si ripete»
 * con «Non si ripete» predefinito, «Ogni giorno», «Ogni settimana di
 * <giorno>», «Ogni mese il <n>° <giorno>» calcolate dalla data scelta;
 * Conferma manda la regola nella claim. Con Google Calendar collegato la
 * scelta resta su «Non si ripete», disattivata, con la riga che dice
 * perché, e il form non manda mai una serie.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
  ],
};

const CUSTOMERS = [{ resource: 'contact', id: 'c1', name: 'Ada' }];

function customersOf(items) {
  return (path) => {
    const query = new URL(path, 'http://stub.test').searchParams.get('q') ?? '';
    const needle = query.toLowerCase();
    return { items: items.filter((item) => String(item?.name ?? '').toLowerCase().includes(needle)), complete: true };
  };
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
  await new Promise((resolve) => setImmediate(resolve));
}

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

function stubClient({ profile = null } = {}) {
  const calls = [];
  const customers = customersOf(CUSTOMERS);
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method: options.method ?? 'GET', body });
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco' }] };
      if (path === '/api/profile') {
        if (profile) return profile;
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/customer-data/customers')) return customers(path);
      if (path.startsWith('/api/customer-data/')) throw notFound();
      if (path === '/api/appointments/services') throw notFound();
      if (path.startsWith('/api/appointments/team-week')) {
        return {
          from: '2026-11-16T00:00:00.000Z',
          to: '2026-11-23T00:00:00.000Z',
          members: [{ teamMemberId: 'marco', appointments: [] }],
        };
      }
      if (path === '/api/appointments/propose') return { decision: 'confirm-required', draft: body, spaceId: 'locale', permission: 'book-appointments' };
      if (path === '/api/appointments/confirm') {
        return { decision: 'booked', appointment: { ...body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 14) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openCalendar(client = null) {
  const doc = createFakeDocument();
  const mount = createMount();
  const used = client ?? stubClient();
  const view = createCalendarioView({
    // 18:30 di Roma: la griglia di oggi è piena, la proposta è domani
    // 2026-11-17 (martedì) — le etichette sotto lo provano.
    searchDelayMs: 0, doc, mount, client: used, now: () => new Date('2026-11-16T17:30:00Z'),
  });
  await view.render();
  await settle();
  return { doc, mount, client: used };
}

const byName = (root, name) => root.findAll('input').concat(root.findAll('select')).find((node) => node.getAttribute('name') === name) ?? null;

function openManual(mount) {
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  toggle.dispatch('click');
  mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente')).dispatch('click');
}

test('ricorrenza: il form ha «Si ripete» con Non si ripete predefinito e le etichette dalla data', async () => {
  const { mount } = await openCalendar();
  openManual(mount);
  const select = byName(mount, 'recurrence');
  assert.ok(select, 'la scelta «Si ripete» c’è');
  assert.equal(select.value, 'none', '«Non si ripete» è il predefinito');
  const labels = select.findAll('option').map((node) => node.textContent);
  assert.deepEqual(labels, [
    'Non si ripete', 'Ogni giorno', 'Ogni settimana di martedì', 'Ogni mese il 3° martedì',
  ], 'la data proposta (domani) dà etichette calcolate');
  byName(mount, 'date').value = '';
  byName(mount, 'date').dispatch('input');
  assert.deepEqual(select.findAll('option').map((node) => node.textContent), [
    'Non si ripete', 'Ogni giorno', 'Ogni settimana', 'Ogni mese',
  ], 'senza data, etichette neutre');
  byName(mount, 'date').value = '2026-11-17';
  byName(mount, 'date').dispatch('input');
  const dated = select.findAll('option').map((node) => node.textContent);
  assert.ok(dated.includes('Ogni settimana di martedì'), 'la settimana nomina il giorno scelto');
  assert.ok(dated.includes('Ogni mese il 3° martedì'), 'il mese nomina la posizione scelta');
});

test('ricorrenza: «Ogni settimana» manda la regola nella claim, senza scelta manda null', async () => {
  const { mount, client } = await openCalendar();
  openManual(mount);
  await pickCustomerByName(mount, 'Ada');
  const fill = (name, value) => { byName(mount, name).value = value; byName(mount, name).dispatch('input'); };
  fill('date', '2026-11-17');
  fill('start', '17:00');
  fill('end', '18:00');
  const person = byName(mount, 'teamMemberId');
  person.value = person.findAll('option').find((node) => node.getAttribute('value') !== '').getAttribute('value');
  person.dispatch('change');
  const service = byName(mount, 'serviceKey');
  service.value = 'taglio';
  service.dispatch('change');
  const repeat = byName(mount, 'recurrence');
  repeat.value = 'weekly';
  repeat.dispatch('change');
  await settle(2);
  mount.findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle();
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1, 'Conferma scrive una volta');
  assert.deepEqual(confirms[0].body.recurrence, { kind: 'weekly' }, 'la regola settimanale viaggia nella claim');
});

test('ricorrenza: senza scelta la claim manda recurrence null', async () => {
  const { mount, client } = await openCalendar();
  openManual(mount);
  await pickCustomerByName(mount, 'Ada');
  const fill = (name, value) => { byName(mount, name).value = value; byName(mount, name).dispatch('input'); };
  fill('date', '2026-11-17');
  fill('start', '17:00');
  fill('end', '18:00');
  const person = byName(mount, 'teamMemberId');
  person.value = person.findAll('option').find((node) => node.getAttribute('value') !== '').getAttribute('value');
  person.dispatch('change');
  const service = byName(mount, 'serviceKey');
  service.value = 'taglio';
  service.dispatch('change');
  mount.findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle();
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].body.recurrence, null, '«Non si ripete» manda null');
});

test('ricorrenza: con Google collegato «Si ripete» è disattivato e Conferma non manda serie', async () => {
  const linked = stubClient({
    profile: { member: null, connections: { available: true, items: [{ connector: 'calendar', status: 'connected' }] } },
  });
  const { mount, client } = await openCalendar(linked);
  openManual(mount);
  const select = byName(mount, 'recurrence');
  assert.ok(select, 'la scelta «Si ripete» c’è anche con Google collegato');
  assert.equal(select.value, 'none', 'resta su «Non si ripete»');
  assert.equal(select.getAttribute('disabled'), 'disabled', 'le opzioni sono disattivate');
  const note = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'recurrence-linked-note');
  assert.ok(note, 'la riga dice perché');
  assert.match(note.textContent, /ricorrenze arrivano presto/);
  await pickCustomerByName(mount, 'Ada');
  const fill = (name, value) => { byName(mount, name).value = value; byName(mount, name).dispatch('input'); };
  fill('date', '2026-11-17');
  fill('start', '17:00');
  fill('end', '18:00');
  const person = byName(mount, 'teamMemberId');
  person.value = person.findAll('option').find((node) => node.getAttribute('value') !== '').getAttribute('value');
  person.dispatch('change');
  const service = byName(mount, 'serviceKey');
  service.value = 'taglio';
  service.dispatch('change');
  mount.findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle();
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1, 'Conferma scrive una volta');
  assert.equal(confirms[0].body.recurrence, null, 'con Google collegato il form non manda mai una serie');
});
