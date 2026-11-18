// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:1e3393038b8b — riprova del Mac 17/11 sul live, form «Nuovo
 * appuntamento» del Calendario. Tre difetti, rossi prima della cura:
 * (1) il campo Cliente fa saltare il pannello di circa 40px quando le
 *     risposte della ricerca arrivano (o si svuotano);
 * (2) «Mancano dei dati» sparisce non appena si sceglie il cliente, anche
 *     se mancano ancora la persona e il servizio;
 * (3) il blocco verde non segue l'ora di fine mentre la si cambia.
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

function customersOf(items) {
  return (path) => {
    const query = new URL(path, 'http://stub.test').searchParams.get('q') ?? '';
    const needle = query.toLowerCase();
    return { items: items.filter((item) => String(item?.name ?? '').toLowerCase().includes(needle)) };
  };
}

function stubClient() {
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
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) {
        return {
          from: '2026-10-19T00:00:00.000Z',
          to: '2026-10-26T00:00:00.000Z',
          members: [{ teamMemberId: 'marco', appointments: [] }],
        };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [] };
      }
      if (path === '/api/appointments/phrase') return { draft: null, dryRun: false, spaceId: 'locale' };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openManual() {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento')).dispatch('click');
  mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente')).dispatch('click');
  await settle(2);
  return { doc, mount, client };
}

const missingNote = (mount) => mount.findAll('p').find((node) => (node.textContent ?? '').startsWith('Mancano dei dati'));
const resultsBox = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');

test('il box dei suggerimenti tiene una riga: il pannello non salta (backlog:1e3393038b8b)', async () => {
  const { mount } = await openManual();
  const box = resultsBox(mount);
  assert.ok(box, 'the customer results box paints with the form');
  assert.equal(box.getAttribute('style'), 'min-height: 40px', 'one reserved row keeps the panel still');
});

test('«Mancano dei dati» resta finché manca un dato (backlog:1e3393038b8b)', async () => {
  const { mount } = await openManual();
  const byName = () => Object.fromEntries(
    mount.findAll('input').map((node) => [node.getAttribute('name'), node])
      .concat(mount.findAll('select').map((node) => [node.getAttribute('name'), node])),
  );
  // Conferma a form vuoto: la nota elenca cliente e persona (servizio e
  // orari sono proposti in automatico con un listino da una voce sola).
  mount.querySelector('.cal-manual').findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await settle(14);
  assert.ok(missingNote(mount), 'the missing-data note paints after Conferma');
  assert.ok(missingNote(mount).textContent.includes('cliente'), 'the note names the customer');
  assert.ok(missingNote(mount).textContent.includes('persona del team'), 'the note names the person');
  // La scelta del cliente riempie un dato solo: la nota resta e nomina
  // chi manca ancora, invece di sparire.
  const search = mount.querySelector('input[name="customerSearch"]');
  search.value = 'Ada';
  search.dispatch('input');
  await settle(7);
  mount.findAll('button').find((node) => node.textContent === 'Ada').dispatch('click');
  await settle(2);
  assert.ok(missingNote(mount), 'the note stays after the customer pick');
  assert.ok(!missingNote(mount).textContent.includes('cliente'), 'the note no longer names the customer');
  assert.ok(missingNote(mount).textContent.includes('persona del team'), 'the note still names the person');
  // L'ultimo dato mancante chiude la nota, come prima.
  byName().teamMemberId.value = 'marco';
  byName().teamMemberId.dispatch('input');
  await settle(2);
  assert.equal(missingNote(mount), undefined, 'the note goes once nothing is missing');
});

test('il blocco segue l\u2019ora di fine mentre la si cambia (backlog:1e3393038b8b)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  const filter = mount.findAll('input').find((node) => node.getAttribute('name') === 'members');
  filter.value = 'marco';
  mount.findAll('button').find((node) => node.textContent.includes('Mostra settimana')).dispatch('click');
  await settle();
  const cols = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(' ').includes('cal-day'));
  assert.ok(cols.length >= 3, 'the week paints its day columns');
  const col = cols[2];
  col.getBoundingClientRect = () => ({ top: 0, height: 540 });
  const target = { closest: () => null };
  col.dispatch('pointerdown', { button: 0, target, clientY: 60, pointerId: 1 });
  col.dispatch('pointerup', {});
  await settle(2);
  const byName = () => Object.fromEntries(
    mount.findAll('input').map((node) => [node.getAttribute('name'), node])
      .concat(mount.findAll('select').map((node) => [node.getAttribute('name'), node])),
  );
  const form = byName();
  assert.equal(form.date.value, '2026-10-21', 'the slot pick fills the day');
  assert.equal(form.start.value, '10:00', 'the slot pick fills the start');
  assert.equal(form.end.value, '10:30', 'the slot pick fills the end');
  const pick = () => mount.querySelector('[data-role="slot-pick"]');
  assert.ok(pick(), 'the grid block paints for the pick');
  assert.ok((pick().textContent ?? '').includes('10:00'), 'the block names the picked start');
  form.end.value = '11:00';
  form.end.dispatch('input');
  await settle(2);
  assert.equal(pick().getAttribute('style'), 'grid-row: 5 / span 4; grid-column: 1 / -1', 'the block spans the edited end');
  assert.ok((pick().textContent ?? '').includes('11:00'), 'the block names the edited end');
});
