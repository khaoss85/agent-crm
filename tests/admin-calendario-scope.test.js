// @ts-check
/**
 * backlog:573a1e85942f — modifica e annullo di un'occorrenza di serie nel
 * Calendario (/bo) con scope «Solo questo / Questo e i successivi / Tutti».
 *
 * - L'annullo di un'occorrenza chiede lo scope e lo manda; la riga singola
 *   non chiede niente e non lo manda (filo invariato).
 * - Il modulo «Sposta» di un'occorrenza chiede lo scope e lo manda.
 * - Il trascinamento di un'occorrenza non muove da solo: apre il modulo con
 *   la casella del rilascio e chiede lo scope; il trascinamento di una riga
 *   singola muove diretto come prima.
 * - Su una serie collegata a Google il rifiuto di sync (502) si legge in
 *   italiano chiaro, sia per lo spostamento che per l'annullo; il vecchio
 *   409 non esiste più e non ha frase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarioView,
  calendarRefusalText,
  cancelRefusalText,
} from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
  ],
};

const SERIES_RULE = { kind: 'weekly', unit: 'week', interval: 1, days: null, count: 4, until: null };

const CUSTOMERS = [{ resource: 'contact', id: 'c1', name: 'Ada' }];

function customersOf(items) {
  return (path) => {
    const query = new URL(path, 'http://stub.test').searchParams.get('q') ?? '';
    const needle = query.toLowerCase();
    return { items: items.filter((item) => String(item?.name ?? '').toLowerCase().includes(needle)), complete: true };
  };
}

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

function stubClient({ failCancelWith = null, failRescheduleWith = null } = {}) {
  const calls = [];
  const week = WEEK();
  const customers = customersOf(CUSTOMERS);
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method: options.method ?? 'GET', body });
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/customer-data/customers')) return customers(path);
      if (path.startsWith('/api/customer-data/')) {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (path === '/api/appointments/services') {
        const error = new Error('not composed');
        error.code = 'NOT_FOUND';
        error.status = 404;
        throw error;
      }
      if (path.startsWith('/api/appointments/team-week')) return JSON.parse(JSON.stringify(week));
      if (path === '/api/appointments/cancel') {
        if (failCancelWith !== null) throw failCancelWith;
        return { appointment: { id: body.id, status: 'cancelled' }, cancelled: true };
      }
      if (path === '/api/appointments/reschedule') {
        if (failRescheduleWith !== null) throw failRescheduleWith;
        return { appointment: { id: body.id, status: 'booked', startsAt: body.startsAt, endsAt: body.endsAt }, moved: true };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 14) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openCalendar(clientOverrides = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(clientOverrides);
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-11-16T07:00:00Z'),
  });
  await view.render();
  await settle();
  return { doc, mount, client };
}

function openEvent(mount, id) {
  mount.findAll('button').find((node) => node.getAttribute('data-event-id') === id).dispatch('click');
}

function eventPopover(mount) {
  return mount.findAll('div').find((node) => node.getAttribute('data-role') === 'event-detail');
}

function scopeRadios(box, name) {
  return box.findAll('input').filter((node) => node.getAttribute('name') === name);
}

function pickScope(mount, name, value) {
  const pop = eventPopover(mount);
  assert.ok(pop, 'il popover è aperto');
  const radios = scopeRadios(pop, name);
  assert.equal(radios.length, 3, 'tre scope: solo questo, successivi, tutti');
  for (const radio of radios) radio.checked = radio.getAttribute('value') === value;
  radios.find((radio) => radio.getAttribute('value') === value).dispatch('change');
}

/**
 * Element.closest, so the dragged nodes get one that walks parentNode like
 * the real one (class, [attr="value"], and comma lists — the only selectors
 * the calendar's pointer path uses).
 */
function attachClosest(node) {
  node.closest = (selector) => {
    const parts = String(selector).split(',').map((part) => part.trim()).filter(Boolean);
    let current = node;
    while (current) {
      for (const part of parts) {
        if (part.startsWith('.')) {
          const wanted = part.slice(1);
          if ((current.getAttribute?.('class') ?? '').split(/\s+/).includes(wanted)) return current;
        } else {
          const attr = part.match(/^\[([a-zA-Z-]+)="([^"]*)"\]$/);
          if (attr && current.getAttribute?.(attr[1]) === attr[2]) return current;
        }
      }
      current = current.parentNode ?? null;
    }
    return null;
  };
  for (const child of node.childNodes ?? []) attachClosest(child);
}

function dragColumnOf(mount, id) {
  const button = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === id);
  assert.ok(button, `l'evento ${id} è in griglia`);
  const col = button.parentNode;
  attachClosest(mount);
  // 1 px per minute from 09:00 Rome: s1 paints 17:00–18:00, press at 17:30.
  col.getBoundingClientRect = () => ({ top: 0, height: 720 });
  return { button, col };
}

test('573a1e85942f: annullare un’occorrenza chiede lo scope e lo manda', async () => {
  const { mount, client } = await openCalendar();
  openEvent(mount, 's1');
  await settle();
  eventPopover(mount).findAll('button').find((node) => node.getAttribute('data-action') === 'event-cancel').dispatch('click');
  await settle();
  pickScope(mount, 'cancel-scope', 'following');
  const box = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-confirm');
  box.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-yes').dispatch('click');
  await settle();
  const cancels = client.calls.filter((call) => call.path === '/api/appointments/cancel');
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].body.scope, 'following', 'lo scope scelto viaggia nella richiesta');
});

test('573a1e85942f: l’annullo di serie senza scelta manda «solo questo»', async () => {
  const { mount, client } = await openCalendar();
  openEvent(mount, 's1');
  await settle();
  eventPopover(mount).findAll('button').find((node) => node.getAttribute('data-action') === 'event-cancel').dispatch('click');
  await settle();
  const box = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-confirm');
  const radios = scopeRadios(box, 'cancel-scope');
  assert.equal(radios.length, 3);
  assert.equal(radios.find((radio) => radio.checked)?.getAttribute('value'), 'single', 'il predefinito è «solo questo»');
  box.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-yes').dispatch('click');
  await settle();
  const cancels = client.calls.filter((call) => call.path === '/api/appointments/cancel');
  assert.equal(cancels[0].body.scope, 'single');
});

test('573a1e85942f: il modulo Sposta di un’occorrenza chiede lo scope e lo manda', async () => {
  const { mount, client } = await openCalendar();
  openEvent(mount, 's1');
  await settle();
  eventPopover(mount).findAll('button').find((node) => node.getAttribute('data-action') === 'event-edit').dispatch('click');
  await settle();
  pickScope(mount, 'move-scope', 'all');
  const form = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'move-form');
  form.findAll('input').find((node) => node.getAttribute('name') === 'move-start').value = '17:30';
  form.findAll('input').find((node) => node.getAttribute('name') === 'move-end').value = '18:30';
  form.findAll('button').find((node) => node.getAttribute('data-action') === 'move-submit').dispatch('click');
  await settle(20);
  const moves = client.calls.filter((call) => call.path === '/api/appointments/reschedule');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].body.scope, 'all', 'lo scope scelto viaggia nella richiesta');
});

test('573a1e85942f: trascinare un’occorrenza chiede lo scope, non muove da solo', async () => {
  const { mount, client } = await openCalendar();
  const { button, col } = dragColumnOf(mount, 's1');
  col.dispatch('pointerdown', { target: button, button: 0, clientY: 510 });
  col.dispatch('pointermove', { clientY: 450 });
  col.dispatch('pointerup', {});
  await settle(20);
  assert.ok(
    !client.calls.some((call) => call.path === '/api/appointments/reschedule'),
    'il rilascio da solo non scrive niente',
  );
  const form = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'move-form');
  assert.ok(form, 'il modulo Sposta si apre sulla riga trascinata');
  const hint = form.findAll('p').find((node) => node.getAttribute('data-role') === 'move-drag-scope');
  assert.ok(hint, 'il modulo dice che il trascinamento aspetta lo scope');
  const radios = scopeRadios(form, 'move-scope');
  assert.equal(radios.length, 3, 'il trascinamento chiede lo scope');
  pickScope(mount, 'move-scope', 'all');
  form.findAll('button').find((node) => node.getAttribute('data-action') === 'move-submit').dispatch('click');
  await settle(20);
  const moves = client.calls.filter((call) => call.path === '/api/appointments/reschedule');
  assert.equal(moves.length, 1, 'la conferma scrive una volta sola');
  assert.equal(moves[0].body.id, 's1');
  assert.equal(moves[0].body.scope, 'all');
});

test('573a1e85942f: trascinare una riga singola muove diretto senza scope', async () => {
  const { mount, client } = await openCalendar();
  const button = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 'p1');
  const col = button.parentNode;
  attachClosest(mount);
  // p1 paints 10:00–10:30 Rome (CET): press at 10:15, drop one hour later.
  col.getBoundingClientRect = () => ({ top: 0, height: 720 });
  col.dispatch('pointerdown', { target: button, button: 0, clientY: 75 });
  col.dispatch('pointermove', { clientY: 135 });
  col.dispatch('pointerup', {});
  await settle(20);
  const moves = client.calls.filter((call) => call.path === '/api/appointments/reschedule');
  assert.equal(moves.length, 1, 'la riga singola si muove al rilascio');
  assert.ok(!('scope' in moves[0].body), 'la riga singola tiene il suo filo senza scope');
});

test('6acf0a73bfc3: serie Google, il rifiuto di sync parla chiaro in spostamento e annullo', () => {
  const serverMessage = 'Google ha rifiutato la modifica della serie (GOOGLE_FORBIDDEN): la griglia non è cambiata. Riprova.';
  const move = calendarRefusalText({ code: 'APPOINTMENTS_SERIES_SYNC_FAILED', message: serverMessage });
  assert.equal(move, serverMessage, 'lo spostamento rifiutato mostra il motivo del server');
  const cancel = cancelRefusalText({ code: 'APPOINTMENTS_SERIES_SYNC_FAILED', message: serverMessage });
  assert.equal(cancel, serverMessage, 'l’annullo rifiutato mostra il motivo del server');
  assert.equal(calendarRefusalText({ code: 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED' }), null, 'il vecchio 409 non ha più frase');
  assert.equal(cancelRefusalText({ code: 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED' }), null, 'il vecchio 409 non ha più frase');
});

test('6acf0a73bfc3: «successivi» e «tutti» su serie collegata mostrano il motivo del server', () => {
  const serverMessage = '«Questo e i successivi» su una serie collegata a Google non è ancora supportato: la griglia non è cambiata. Usa «solo questo».';
  const move = calendarRefusalText({ code: 'APPOINTMENTS_SERIES_SCOPE_GOOGLE', message: serverMessage });
  assert.equal(move, serverMessage, 'lo spostamento rifiutato mostra il motivo del server');
  const cancel = cancelRefusalText({ code: 'APPOINTMENTS_SERIES_SCOPE_GOOGLE', message: serverMessage });
  assert.equal(cancel, serverMessage, 'l’annullo rifiutato mostra il motivo del server');
});

test('6acf0a73bfc3: il rifiuto Google sull’annullo resta nella domanda in italiano', async () => {
  const refused = new Error('Google ha rifiutato la modifica della serie (GOOGLE_FORBIDDEN): la griglia non è cambiata. Riprova.');
  refused.code = 'APPOINTMENTS_SERIES_SYNC_FAILED';
  refused.status = 502;
  const { mount, client } = await openCalendar({ failCancelWith: refused });
  openEvent(mount, 's1');
  await settle();
  eventPopover(mount).findAll('button').find((node) => node.getAttribute('data-action') === 'event-cancel').dispatch('click');
  await settle();
  pickScope(mount, 'cancel-scope', 'single');
  const box = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'cancel-confirm');
  box.findAll('button').find((node) => node.getAttribute('data-action') === 'cancel-yes').dispatch('click');
  await settle();
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/cancel').length, 1);
  const note = mount.findAll('div')
    .find((node) => node.getAttribute('data-role') === 'event-detail')
    .findAll('p')
    .find((node) => node.getAttribute('data-role') === 'cancel-note');
  assert.ok(note, 'il rifiuto resta nella domanda');
  assert.ok(note.textContent.includes('Google'), 'il messaggio nomina Google');
  assert.ok(note.textContent.includes('griglia non è cambiata'), 'il messaggio dice che la griglia è ferma');
});
