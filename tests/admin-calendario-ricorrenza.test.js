// @ts-check
/**
 * backlog:0f2ae629e09b — appuntamento ricorrente nel Calendario (/bo).
 *
 * Il form «Nuovo appuntamento» ha la scelta «Si ripete» con le etichette
 * calcolate dalla data scelta e «Personalizza…» (intervallo, giorni,
 * fine dopo N volte o in una data); Conferma manda la regola nella claim.
 * Annullare o spostare un'occorrenza di serie chiede «solo questo /
 * questo e i successivi / tutti» e lo scope viaggia nella scrittura.
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

const SERIES_RULE = { kind: 'weekly', unit: 'week', interval: 1, days: null, count: 4, until: null };

const WEEK = () => ({
  from: '2026-11-16T00:00:00.000Z',
  to: '2026-11-23T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [
      {
        id: 's1', status: 'booked', startsAt: '2026-11-17T16:00:00.000Z', endsAt: '2026-11-17T17:00:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', sourceKey: 'calendario:marco:2026-11-17T16:00:00.000Z:c1',
        seriesKey: 'gym:series:1', occurrenceIndex: 0, recurrenceRule: JSON.stringify(SERIES_RULE),
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
      },
      {
        id: 's2', status: 'booked', startsAt: '2026-11-24T16:00:00.000Z', endsAt: '2026-11-24T17:00:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', sourceKey: 'calendario:marco:2026-11-24T16:00:00.000Z:c1',
        seriesKey: 'gym:series:1', occurrenceIndex: 1, recurrenceRule: JSON.stringify(SERIES_RULE),
        subject: { resource: 'contact', id: 'c1', owner: 'host', ownerPackage: null, label: 'Ada' },
      },
      {
        id: 'p1', status: 'booked', startsAt: '2026-11-18T09:00:00.000Z', endsAt: '2026-11-18T09:30:00.000Z',
        serviceKey: 'taglio', teamMemberId: 'marco', sourceKey: 'calendario:marco:2026-11-18T09:00:00.000Z:c2',
        subject: { resource: 'contact', id: 'c2', owner: 'host', ownerPackage: null, label: 'Bea' },
      },
    ],
  }],
});

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

function stubClient() {
  const calls = [];
  const week = WEEK();
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method: options.method ?? 'GET', body });
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/customer-data/')) throw notFound();
      if (path === '/api/appointments/services') throw notFound();
      if (path.startsWith('/api/appointments/team-week')) return JSON.parse(JSON.stringify(week));
      if (path === '/api/appointments/propose') return { decision: 'confirm-required', draft: body, spaceId: 'locale', permission: 'book-appointments' };
      if (path === '/api/appointments/confirm') {
        return { decision: 'booked', appointment: { ...body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
      }
      if (path === '/api/appointments/cancel') {
        return { appointment: { id: body.id, status: 'cancelled' }, cancelled: true, occurrences: [], scope: body.scope ?? 'single' };
      }
      if (path === '/api/appointments/reschedule') {
        return { appointment: { id: body.id, status: 'booked', startsAt: body.startsAt, endsAt: body.endsAt }, moved: true, scope: body.scope ?? 'single' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 14) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openCalendar() {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-11-16T07:00:00Z'),
  });
  await view.render();
  await settle();
  return { doc, mount, client };
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
    'Non si ripete', 'Ogni giorno', 'Ogni settimana', 'Ogni mese', 'Ogni anno',
    'Tutti i giorni feriali (lun-ven)', 'Personalizza…',
  ], 'senza data, etichette neutre');
  byName(mount, 'date').value = '2026-11-17';
  byName(mount, 'date').dispatch('input');
  const dated = select.findAll('option').map((node) => node.textContent);
  assert.ok(dated.includes('Ogni settimana di martedì'), 'la settimana nomina il giorno scelto');
  assert.ok(dated.includes('Ogni mese il 3° martedì'), 'il mese nomina la posizione scelta');
  assert.ok(dated.includes('Ogni anno il 17 novembre'), 'l’anno nomina la data scelta');
});

test('ricorrenza: «Personalizza…» apre intervallo, giorni e fine, e Conferma manda la regola', async () => {
  const { mount, client } = await openCalendar();
  openManual(mount);
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
  repeat.value = 'custom';
  repeat.dispatch('change');
  await settle(2);
  assert.ok(byName(mount, 'recurrence-interval'), 'l’intervallo c’è');
  assert.ok(byName(mount, 'recurrence-unit'), 'il periodo c’è');
  assert.equal(mount.findAll('input').filter((node) => node.getAttribute('name') === 'recurrence-day').length, 7, 'sette giorni');
  assert.ok(byName(mount, 'recurrence-end'), 'la fine c’è');
  // Ogni 2 settimane, mar e gio, dopo 6 volte.
  byName(mount, 'recurrence-interval').value = '2';
  byName(mount, 'recurrence-interval').dispatch('input');
  for (const day of ['2', '4']) {
    const check = mount.findAll('input').find((node) => node.getAttribute('name') === 'recurrence-day' && node.getAttribute('value') === day);
    check.checked = true;
    check.dispatch('input');
  }
  const end = byName(mount, 'recurrence-end');
  end.value = 'count';
  end.dispatch('change');
  await settle(2);
  byName(mount, 'recurrence-count').value = '6';
  byName(mount, 'recurrence-count').dispatch('input');
  mount.findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle();
  const confirms = client.calls.filter((call) => call.path === '/api/appointments/confirm');
  assert.equal(confirms.length, 1, 'Conferma scrive una volta');
  assert.deepEqual(confirms[0].body.recurrence, {
    kind: 'custom', unit: 'week', interval: 2, days: [2, 4], count: 6,
  }, 'la regola personalizzata viaggia nella claim');
});

test('ricorrenza: senza scelta la claim non ha ricorrenza', async () => {
  const { mount, client } = await openCalendar();
  openManual(mount);
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

test('ricorrenza: annullare un’occorrenza chiede solo/seguiti/tutti e lo scope viaggia', async () => {
  const { mount, client } = await openCalendar();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 's2').dispatch('click');
  await settle();
  const pop = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  assert.ok(pop, 'il popover dell’occorrenza si apre');
  pop.findAll('button').find((node) => node.getAttribute('data-action') === 'event-cancel').dispatch('click');
  const box = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-confirm');
  assert.ok(box, 'la domanda si apre');
  const scopeBox = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-scope')
    ?? box.findAll('fieldset')[0];
  assert.ok(scopeBox, 'la scelta dello scope c’è solo per la serie');
  const radios = box.findAll('input').filter((node) => node.getAttribute('name') === 'cancel-scope');
  assert.deepEqual(radios.map((node) => node.getAttribute('value')), ['single', 'following', 'all']);
  assert.equal(radios.find((node) => node.checked)?.getAttribute('value'), 'single', '«Solo questo» è il predefinito');
  radios.find((node) => node.getAttribute('value') === 'following').checked = true;
  radios.find((node) => node.getAttribute('value') === 'following').dispatch('change');
  box.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-yes').dispatch('click');
  await settle();
  const cancels = client.calls.filter((call) => call.path === '/api/appointments/cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].body.scope, 'following', 'lo scope viaggia nella scrittura');
});

test('ricorrenza: annullare una riga singola non chiede lo scope e non lo manda', async () => {
  const { mount, client } = await openCalendar();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 'p1').dispatch('click');
  await settle();
  const pop = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
  pop.findAll('button').find((node) => node.getAttribute('data-action') === 'event-cancel').dispatch('click');
  const box = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-confirm');
  assert.equal(box.findAll('input').filter((node) => node.getAttribute('name') === 'cancel-scope').length, 0, 'nessuno scope per la riga singola');
  box.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-yes').dispatch('click');
  await settle();
  const cancels = client.calls.filter((call) => call.path === '/api/appointments/cancel');
  assert.equal(cancels.length, 1);
  assert.ok(!('scope' in cancels[0].body), 'la riga singola tiene il suo wire');
});

test('ricorrenza: spostare un’occorrenza chiede quanto si sposta e lo scope viaggia', async () => {
  const { mount, client } = await openCalendar();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 's1').dispatch('click');
  await settle();
  mount.querySelector('button[data-action="event-edit"]').dispatch('click');
  const form = mount.querySelector('div[data-role="move-form"]');
  assert.ok(form, 'il form Sposta si apre');
  const scope = form.querySelector('select[name="move-scope"]');
  assert.ok(scope, 'la scelta dello scope c’è solo per la serie');
  scope.value = 'all';
  scope.dispatch('change');
  form.querySelector('input[name="move-date"]').value = '2026-11-18';
  form.querySelector('input[name="move-start"]').value = '17:00';
  form.querySelector('input[name="move-end"]').value = '18:00';
  form.findAll('button').find((node) => node.textContent.includes('Sposta')).dispatch('click');
  await settle();
  const moves = client.calls.filter((call) => call.path === '/api/appointments/reschedule');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].body.scope, 'all', 'lo scope viaggia nella scrittura');
});
