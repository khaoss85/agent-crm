// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:134f3ed7 — riprova del Mac 17/11 dopo #892: due resti.
 * (1) Dopo «Conferma» il blocco non è evidenziato: con il filtro svuotato
 *     (o il roster illeggibile) reloadAfterBooking non ricaricava affatto e
 *     la settimana senza il nuovo id toglieva la selezione in silenzio.
 * (2) Il pannello aperto da «Fissa con una frase» su una bozza giorno senza
 *     ora ha Inizio/Fine vuoti («--:--»): ogni apertura propone giorno e ora,
 *     qui il primo slot libero del giorno cercato.
 * Entrambi rossi sul codice prima della cura, verdi dopo.
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

/** Conferma con il filtro svuotato e una week che non riporta mai il nuovo id (lettura in ritardo). */
function lagClient() {
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
          members: [{ teamMemberId: 'marco', appointments: [] }],
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
        const body = payload({ body: options.body });
        const appointment = {
          ...body, id: 'b1', status: 'booked',
          startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:30:00.000Z',
          teamMemberId: 'marco',
        };
        return { decision: 'booked', appointment, replayed: false, spaceId: 'locale' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

test('Conferma con filtro svuotato: ricarica sul membro e blocco evidenziato (backlog:134f3ed7)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = lagClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  // Settimana caricata per nome (roster illeggibile, come il pilota senza composed).
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  const readsBefore = teamWeekCalls(client).length;
  assert.ok(readsBefore >= 1, 'the week loads for marco');
  // Il pannello si apre e l'operatore svuota il filtro prima di confermare.
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
  filter.value = '';
  filter.dispatch('input');
  mount.querySelector('.cal-manual').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle(14);
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 1, 'the booking is sent');
  assert.ok(teamWeekCalls(client).length > readsBefore, 'the week reloads even with the filter emptied');
  const lastRead = teamWeekCalls(client).at(-1).path;
  assert.ok(new URL(lastRead, 'http://stub.test').searchParams.get('teamMemberIds').includes('marco'), `the reload scopes the booked member, got ${lastRead}`);
  const pops = mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');
  assert.equal(pops[0].getAttribute('hidden') === null && !(pops[0].getAttribute('class') ?? '').includes('hidden'), false, 'the panel closes after Conferma');
  const block = mount.findAll('button').find((node) => node.getAttribute('data-event-id') === 'b1');
  assert.ok(block, 'the new block paints even when the reloaded week misses it');
  assert.ok((block.getAttribute('class') ?? '').split(' ').includes('cal-selected'), 'the new block reads highlighted');
});

/** Bozza giorno senza ora: la ricerca propone slot liberi quel giorno. */
function phraseClient() {
  const calls = [];
  const roster = [{ subject: 'marco', displayName: 'Marco', email: 'marco@example.com', role: 'member' }];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/spine/memberships') return { items: roster };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) {
        return { members: [{ teamMemberId: 'marco', appointments: [] }] };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return {
          members: [{
            teamMemberId: 'marco',
            slots: [
              { startsAt: '2026-11-12T08:30:00.000Z', endsAt: '2026-11-12T09:00:00.000Z' },
              { startsAt: '2026-11-12T09:00:00.000Z', endsAt: '2026-11-12T09:30:00.000Z' },
            ],
          }],
        };
      }
      if (path === '/api/appointments/phrase' && options.method === 'POST') {
        return { draft: { teamMemberId: 'marco', day: '2026-11-12' }, dryRun: false, spaceId: 'presti' };
      }
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        throw new Error(`no booking call expected: ${path}`);
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

test('bozza giorno senza ora: propone il primo slot libero (backlog:134f3ed7)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-11-10T08:00:00Z') });
  await view.render();
  await settle(16);
  mount.querySelector('textarea[name="phrase"]').value = 'giovedì con marco';
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await settle(20);
  const field = (name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
  assert.equal(field('date').value, '2026-11-12', 'the drafted day stays');
  assert.equal(field('start').value, '09:30', 'the first free step fills Inizio, never --:--');
  assert.equal(field('end').value, '10:00', 'the first free step fills Fine');
  const card = mount.querySelector('.cal-draft');
  assert.ok(card && card.textContent.includes('09:30'), `the draft card names the proposed hour: ${card?.textContent ?? '(no card)'}`);
});
