import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarioView,
  draftCustomerText,
  normalizeCustomerName,
} from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:3aabaea07bfe (live 18/11 ~16:55Z, spazio di test 2f07eeb9):
 * «trova 30 minuti con khaoss85 per Prova verifica 40 NoteInvio» metteva il
 * nome del cliente come serviceKey («prova-verifica-40-noteinvio») e il campo
 * cliente restava vuoto. Ora la frase che nomina un cliente esistente lo
 * propone nel campo cliente, e il nome del cliente non finisce mai nel campo
 * servizio.
 *
 * L'AI è stubbata con la bozza che il modello ha dato; il suggest stub
 * risponde come il server con un calendario vuoto.
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
const ROSTER = [
  { subject: 'khaoss85', displayName: 'Daniele Pelleri', email: 'daniele@azienda.it', role: 'member' },
];
const CUSTOMER = { resource: 'contact', id: 'f481bcbe', name: 'Prova verifica 40 NoteInvio', email: 'prova@example.it', phone: null, company: null };
const draftFor = (extra) => ({ teamMemberId: 'khaoss85', startsAt: '2026-11-12T14:00:00.000Z', ...extra });

const CATALOG = {
  products: [
    { active: true, sku: 'prova-verifica', name: 'Prova verifica 07/11 B prodotto', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 100 }] }] },
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'per_unit', unitAmountCents: 4500 }] }] },
  ],
};

function phraseClient({ draft = draftFor({ durationMinutes: 30 }), customers = [CUSTOMER] } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') return { draft: { ...draft }, dryRun: false, spaceId: 'test' };
      if (path === '/api/spine/memberships') return { items: ROSTER };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path === '/api/appointments/services') throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
      if (path.startsWith('/api/catalog/products')) return CATALOG;
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        const query = new URL(path, 'http://stub.test').searchParams;
        const ids = query.get('teamMemberIds')?.split(',') ?? [];
        const from = Date.parse(query.get('from') ?? '');
        const step = Number(query.get('slotMinutes')) * 60000;
        const slots = [];
        for (let at = from; at + step <= from + step * 4; at += step) {
          slots.push({ startsAt: new Date(at).toISOString(), endsAt: new Date(at + step).toISOString() });
        }
        return { members: ids.map((id) => ({ teamMemberId: id, slots })) };
      }
      if (path.startsWith('/api/customer-data/customers')) return { items: customers, complete: true };
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        throw new Error(`no booking call expected: ${path}`);
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 40) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const button = (mount, label) => mount.findAll('button').find((node) => node.textContent === label);
const byName = (mount, name) => mount.findAll('input').concat(mount.findAll('select')).find((node) => node.getAttribute('name') === name);
const pickName = (mount) => mount.findAll('p').find((node) => node.getAttribute('data-role') === 'customer-pick')?.textContent ?? null;

async function askPhrase(view, mount, phrase) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = phrase;
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
}

test('normalizeCustomerName reads a slug as the customer name (backlog:3aabaea07bfe)', () => {
  assert.equal(normalizeCustomerName('Prova verifica 40 NoteInvio'), 'prova verifica 40 noteinvio');
  assert.equal(normalizeCustomerName('prova-verifica-40-noteinvio'), 'prova verifica 40 noteinvio');
  assert.equal(normalizeCustomerName('  Prova__verifica   40  '), 'prova verifica 40');
  assert.equal(normalizeCustomerName(null), '');
});

test('draftCustomerText reads the stated customer, nothing else (backlog:3aabaea07bfe)', () => {
  assert.equal(draftCustomerText({ customer: '  Ada Rossi ' }), 'Ada Rossi');
  assert.equal(draftCustomerText({ serviceKey: 'prova-verifica' }), '', 'a slug-shaped service is not a statement');
  assert.equal(draftCustomerText({}), '');
  assert.equal(draftCustomerText(null), '');
});

test('il caso live: il nome del cliente lascia il servizio e propone il cliente (backlog:3aabaea07bfe)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    draft: draftFor({ serviceKey: 'prova-verifica-40-noteinvio', durationMinutes: 30 }),
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'trova 30 minuti con khaoss85 per Prova verifica 40 NoteInvio');
  assert.equal(pickName(mount), 'Prova verifica 40 NoteInvio', 'the existing customer is proposed in the customer field');
  assert.equal(byName(mount, 'serviceKey').value, '', 'the customer name never reaches the service field');
  assert.ok(!mount.textContent.includes('prova-verifica-40-noteinvio'), 'no slug of the customer anywhere on screen');
  assert.ok(mount.textContent.includes('Bozza pronta'), 'the draft is ready');
});

test('la bozza con il cliente dichiarato lo propone (backlog:3aabaea07bfe)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    draft: draftFor({ customer: 'Prova verifica 40 NoteInvio', durationMinutes: 30 }),
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'trova 30 minuti con khaoss85 per Prova verifica 40 NoteInvio');
  assert.equal(pickName(mount), 'Prova verifica 40 NoteInvio', 'the stated customer is proposed in the customer field');
  assert.equal(byName(mount, 'serviceKey').value, '', 'no service invented for the customer');
});

test('un servizio vero resta nel campo servizio (backlog:3aabaea07bfe)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    draft: draftFor({ serviceKey: 'taglio', durationMinutes: 30 }),
    customers: [],
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'trova 30 minuti con khaoss85 per un taglio');
  assert.equal(pickName(mount), null, 'no customer invented');
  assert.equal(byName(mount, 'serviceKey').value, 'taglio', 'the named service stays in the service field');
});

test('un cliente sconosciuto non propone nessuno e non tocca il servizio (backlog:3aabaea07bfe)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    draft: draftFor({ customer: 'Genoveffa X', serviceKey: 'taglio', durationMinutes: 30 }),
    customers: [],
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'trova 30 minuti con khaoss85 per Genoveffa X');
  assert.equal(pickName(mount), null, 'an unknown customer is never proposed');
  assert.equal(byName(mount, 'serviceKey').value, 'taglio', 'a real service still paints');
});

test('«Annulla» sulla bozza toglie anche il cliente proposto (backlog:3aabaea07bfe)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    draft: draftFor({ serviceKey: 'prova-verifica-40-noteinvio', durationMinutes: 30 }),
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'trova 30 minuti con khaoss85 per Prova verifica 40 NoteInvio');
  assert.equal(pickName(mount), 'Prova verifica 40 NoteInvio', 'the customer is proposed first');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'phrase-cancel').dispatch('click');
  await flush();
  assert.equal(pickName(mount), null, 'the proposed customer goes back with the draft');
});
