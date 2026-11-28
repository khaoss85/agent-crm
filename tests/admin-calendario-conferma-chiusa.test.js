// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:ca12bbcc16b4 — «Conferma» su uno slot riapre il modulo «Nuovo
 * appuntamento» con quello slot anche se era stato chiuso con la X. Il
 * difetto gemello 134f3ed7 (il pannello resta aperto dopo Conferma) resta
 * com'è: a prenotazione riuscita il modulo si chiude e il blocco si
 * evidenzia; qui si cura il caso in cui non si prenota (servizio mancante,
 * rifiuto del server) e la nota nomina un modulo rimasto nascosto.
 */

const SLOT = { startsAt: '2026-10-22T14:00:00.000Z', endsAt: '2026-10-22T14:30:00.000Z' };

const DRAFT = {
  teamMemberId: 'marco',
  serviceKey: 'taglio',
  startsAt: SLOT.startsAt,
  endsAt: SLOT.endsAt,
  notes: 'taglio per Ada',
};

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
    { active: true, sku: 'barba', name: 'Barba', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 2000 }] }] },
  ],
};

const SERVED = {
  services: [
    { serviceKey: 'taglio', name: 'Taglio', priceCents: 4500, currency: 'EUR' },
    { serviceKey: 'barba', name: 'Barba', priceCents: 2000, currency: 'EUR' },
  ],
};

const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{ teamMemberId: 'marco', appointments: [] }],
};

function notFound() {
  const error = new Error('not composed');
  error.code = 'NOT_FOUND';
  error.status = 404;
  return error;
}

/** Bodies travel through the submissions wrapper as JSON text: parse back. */
function payload(call) {
  if (typeof call.body === 'string') {
    try { return JSON.parse(call.body); } catch { return call.body; }
  }
  return call.body;
}

function stubClient({ served = false, failConfirmWith = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/appointments/services') {
        if (served) return SERVED;
        throw notFound();
      }
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/customer-data/profile/')) throw notFound();
      if (path.startsWith('/api/customer-data/customers')) throw notFound();
      if (path === '/api/spine/memberships') throw notFound();
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots: [{ ...SLOT }] }] };
      }
      if (path === '/api/appointments/phrase') return { draft: { ...DRAFT }, dryRun: false, spaceId: 'locale' };
      if (path === '/api/appointments/confirm') {
        if (failConfirmWith) throw failConfirmWith;
        const body = payload({ body: options.body });
        return { decision: 'booked', appointment: { ...body, id: 'b1', status: 'confirmed' }, replayed: false, spaceId: 'locale' };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

const flush = async (rounds = 12) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const texts = (mount, tag) => mount.findAll(tag).map((node) => node.textContent);

const formPops = (mount) => mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');

const isOpen = (pop) => pop.getAttribute('hidden') === null && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden');

const byName = (mount) => Object.fromEntries(
  mount.findAll('input').map((node) => [node.getAttribute('name'), node])
    .concat(mount.findAll('select').map((node) => [node.getAttribute('name'), node])),
);

function clickButton(mount, label) {
  const button = mount.findAll('button').find((node) => node.textContent.includes(label));
  assert.ok(button, `button "${label}" exists`);
  button.dispatch('click');
  return button;
}

async function askPhrase(view, mount) {
  await view.render();
  await flush(14);
  byName(mount).members.value = 'marco';
  clickButton(mount, 'Mostra settimana');
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco';
  clickButton(mount, 'Trova slot liberi');
  await flush();
}

function closeModule(mount) {
  const pop = formPops(mount)[0];
  assert.ok(isOpen(pop), 'setup: the draft opened the form');
  const shut = pop.findAll('button').find((node) => node.getAttribute('data-action') === 'manual-close');
  assert.ok(shut, 'the open form carries a close control');
  shut.dispatch('click');
  assert.equal(isOpen(formPops(mount)[0]), false, 'the operator shuts the form');
}

function slotConfirm(mount) {
  const list = mount.querySelector('.cal-slots');
  assert.ok(list, 'the proposal rows stay while the form is shut');
  const confirms = list.findAll('button').filter((node) => node.textContent === 'Conferma');
  assert.equal(confirms.length, 1, 'one proposal Conferma');
  return confirms[0];
}

function assertSlotInForm(mount) {
  const form = byName(mount);
  assert.equal(form.date?.value, '2026-10-22', 'the reopened form carries the slot day');
  assert.equal(form.start?.value, '16:00', 'the reopened form carries the slot start (Rome)');
  assert.equal(form.end?.value, '16:30', 'the reopened form carries the slot end (Rome)');
  assert.equal(form.teamMemberId?.value, 'marco', 'the reopened form carries the slot person');
}

test('chiudi modulo, Conferma senza servizio: il modulo riapre con quello slot, niente prenotato', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ served: true });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount);
  closeModule(mount);
  slotConfirm(mount).dispatch('click');
  await flush();
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 0, 'nothing booked without a service');
  assert.ok(isOpen(formPops(mount)[0]), 'slot Conferma reopens the form even when shut');
  assertSlotInForm(mount);
  assert.ok(
    texts(mount, 'p').some((text) => text.includes('Mancano dei dati: servizio')),
    'the reopened form keeps the missing-data note',
  );
});

test('Conferma rifiutata a modulo chiuso: il modulo riapre con lo slot e nomina il modulo', async () => {
  const refused = new Error('taken');
  refused.code = 'APPOINTMENTS_SLOT_TAKEN';
  refused.status = 409;
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ failConfirmWith: refused });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount);
  closeModule(mount);
  slotConfirm(mount).dispatch('click');
  await flush();
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 1, 'the slot was tried once');
  assert.ok(isOpen(formPops(mount)[0]), 'the refused Conferma reopens the form');
  assertSlotInForm(mount);
  assert.ok(
    texts(mount, 'p').includes('Conferma non riuscita: controlla cliente, servizio e prezzo nel modulo «Nuovo appuntamento».'),
    'the refusal names the manual form in plain words',
  );
});
