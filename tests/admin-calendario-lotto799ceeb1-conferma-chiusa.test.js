// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * lot lot-apps-admin-public-799ceeb1, item ca12bbcc16b4 (a): la Conferma di
 * uno slot riapre il modulo «Nuovo appuntamento» anche se l'operatore lo ha
 * chiuso. I rifiuti che nominano il modulo (servizio da listino, dati
 * mancanti) dicono dove correggere: il modulo deve essere aperto e mostrare
 * la nota, non restare chiuso.
 */

const MEMBERSHIPS = [
  { subject: 'marco', role: 'operator', displayName: 'Marco' },
];

const DRAFT = {
  teamMemberId: 'marco',
  startsAt: '2026-10-22T08:00:00.000Z', // 10:00 Europe/Rome (CEST).
  endsAt: '2026-10-22T08:30:00.000Z',
};

const SLOT = { startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:30:00.000Z' };

const SERVED = {
  services: [
    { serviceKey: 'taglio', name: 'Taglio', priceCents: 4500, currency: 'EUR' },
    { serviceKey: 'barba', name: 'Barba', priceCents: 2000, currency: 'EUR' },
  ],
};

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
    { active: true, sku: 'barba', name: 'Barba', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 2000 }] }] },
  ],
};

function stubClient({ failConfirmWith = null, served = true } = {}) {
  const calls = [];
  const notFound = () => {
    const error = new Error('not composed');
    error.code = 'NOT_FOUND';
    error.status = 404;
    return error;
  };
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
      if (path === '/api/spine/memberships') return { items: MEMBERSHIPS };
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots: [SLOT] }] };
      }
      if (path === '/api/appointments/phrase' && (options.method ?? 'GET') === 'POST') {
        return { draft: { ...DRAFT }, dryRun: false, spaceId: 'locale' };
      }
      if (path === '/api/appointments/confirm') {
        if (failConfirmWith) throw failConfirmWith;
        throw new Error('no booking expected here');
      }
      throw notFound();
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const formPops = (mount) => mount.findAll('div').filter((node) => node.getAttribute('data-role') === 'manual-pop');
const isOpen = (pop) => pop.getAttribute('hidden') === null && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden');
const texts = (mount, tag) => mount.findAll(tag).map((node) => node.textContent);
const slotConfirms = (mount) => (mount.querySelector('.cal-slots')?.findAll('button') ?? [])
  .filter((node) => node.textContent === 'Conferma');

async function askPhrase(view, mount) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = 'giovedì alle 10 con marco';
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await flush();
}

function closeForm(mount) {
  formPops(mount)[0].findAll('button').find((node) => node.getAttribute('data-action') === 'manual-close').dispatch('click');
}

test('Conferma slot a modulo chiuso e servizio mancante: il modulo riapre con la nota', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount);
  assert.equal(slotConfirms(mount).length, 1, 'one proposal Conferma');
  assert.ok(isOpen(formPops(mount)[0]), 'the draft opened the form');
  closeForm(mount);
  assert.equal(isOpen(formPops(mount)[0]), false, 'the operator shut the form');
  slotConfirms(mount)[0].dispatch('click');
  await flush();
  assert.ok(isOpen(formPops(mount)[0]), 'slot Conferma reopens the form even when shut');
  assert.ok(
    texts(mount, 'p').some((text) => text.includes('Scegli il servizio dal listino nel modulo')),
    'the card says where to fix',
  );
  assert.ok(
    texts(mount, 'p').some((text) => text.includes('Mancano dei dati: servizio')),
    'the reopened form keeps the missing-data note',
  );
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 0, 'nothing booked');
});

test('Conferma slot a modulo chiuso con rifiuto del server: il modulo riapre e nomina i dati', async () => {
  const refused = new Error('taken');
  refused.code = 'APPOINTMENTS_SLOT_TAKEN';
  refused.status = 409;
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ failConfirmWith: refused, served: false });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount);
  closeForm(mount);
  assert.equal(isOpen(formPops(mount)[0]), false, 'the operator shut the form');
  // Shutting drops the typed values, so customer and service both miss here.
  slotConfirms(mount)[0].dispatch('click');
  await flush();
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 1, 'the slot was tried');
  assert.ok(isOpen(formPops(mount)[0]), 'the refused Conferma reopens the form');
  assert.ok(
    texts(mount, 'p').some((text) => text.includes('Mancano dei dati: cliente, servizio')),
    'the reopened form names exactly what still misses',
  );
});
