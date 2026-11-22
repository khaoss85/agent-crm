// backlog:f6b9d189 (seguito 19/11 20:xZ su #1067 + VERIFIER_BACK su be63fa7).
// Repro del NON PASSA live: rossi sul codice prima della cura, verdi dopo.
// - AC-1 «pr»: la prima pagina contiene solo trovati per azienda, il modulo
//   dice «Nessun cliente» e non chiede mai la pagina dopo (server ne trova 19).
// - AC-2 «-note@»: righe senza corrispondenza visibile (omonimi con
//   l'indizio «pr…@» che nasconde «note»).
// - «40» non trova «Prova verifica 40 NoteInvio» (cifre sotto la soglia
//   telefono mai cercate nel nome).
// - «000 001»: tre telefoni diversi con lo stesso indizio «…0000…».
// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCalendarioView,
  customerMatchReason,
  customerResultVisible,
} from '../apps/admin/public/admin-calendario.js';
import {
  matchesSearch,
  searchMatchFields,
  searchNeedle,
  searchRank,
} from '../packages/customer-data/src/customers.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const CATALOG = {
  products: [
    { active: true, sku: 'taglio', name: 'Taglio', offers: [{ active: true, currency: 'EUR', components: [{ chargeType: 'one_time', pricingModel: 'flat_fee', flatAmountCents: 100 }] }] },
  ],
};

const WEEK = {
  from: '2026-10-19T00:00:00.000Z',
  to: '2026-10-26T00:00:00.000Z',
  members: [{
    teamMemberId: 'marco',
    appointments: [],
  }],
};

function notFound() {
  const error = new Error('not composed');
  /** @type {any} */ (error).code = 'NOT_FOUND';
  /** @type {any} */ (error).status = 404;
  return error;
}

/** Page-aware customer stub: serves `pages` shaped like the list endpoint. */
function pagedClient({ catalog = CATALOG, pages = [[]] } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [{ subject: 'marco', displayName: 'Marco', email: 'marco@example.com' }] };
      if (path === '/api/profile') return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      if (path.startsWith('/api/catalog/products')) return catalog;
      if (path === '/api/appointments/services') throw Object.assign(notFound(), { status: 404 });
      if (path.startsWith('/api/customer-data/customers')) {
        const query = new URL(path, 'http://localhost').searchParams;
        const page = Number(query.get('page') ?? '1');
        const items = pages[page - 1] ?? [];
        return { items, complete: true, total: pages.flat().length, page, pageSize: 10, pages: pages.length };
      }
      if (path.startsWith('/api/customer-data/')) throw notFound();
      if (path.startsWith('/api/appointments/team-week')) return WEEK;
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle(rounds = 24) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const byName = (mount, name) => mount.findAll('input').concat(mount.findAll('select')).find((node) => node.getAttribute('name') === name);

function openManual(mount) {
  const toggle = mount.findAll('button').find((node) => node.textContent.startsWith('Nuovo appuntamento'));
  toggle.dispatch('click');
  const voice = mount.querySelector('.bo-clienti-menu').findAll('button').find((node) => node.textContent.includes('Compila manualmente'));
  voice.dispatch('click');
}

const customerBox = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'customer-results');

function companyRow(id, name, company) {
  return {
    resource: 'contact', id, name, email: `${id}@example.it`,
    phone: null, company: { name: company }, searchMatch: ['company'],
  };
}

// AC-1: «pr» con la prima pagina tutta «per azienda» non legge mai «nessun
// cliente» mentre il server ha altro: il modulo chiede la pagina dopo.
test('f6b9d189/AC-1: «pr» asks the next page instead of reading no match', async () => {
  const first = Array.from({ length: 10 }, (_, index) => companyRow(`c-pr-${index}`, `Cliente Prova ${index}`, 'Studio Pronto'));
  const second = [{
    resource: 'contact', id: 'c-paola', name: 'Paola Prini', email: 'paola.prini@example.it',
    phone: null, company: null, searchMatch: ['name'],
  }];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: pagedClient({ pages: [first, second] }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = 'pr';
  search.dispatch('input');
  await settle();
  const labels = customerBox(mount).findAll('button').map((node) => node.textContent);
  assert.ok(labels.includes('Paola Prini'), `the second page names the visible match: ${labels.join(' | ')}`);
  assert.ok(!customerBox(mount).textContent.includes('Nessun cliente corrisponde'), 'never «nessun cliente» while the server has more');
});

// Cura 4 del 20:xZ: «40» trova il 40 nel nome (cifre sotto la soglia del
// telefono lette come parole, mai come numero).
test('f6b9d189/40: short digits find the number in the name, never as a phone', () => {
  const parts = ['Prova verifica 40 NoteInvio', null, null, null];
  assert.ok(searchRank(parts, searchNeedle('40'), '') >= 0, '«40» ranks the row with 40 in its name');
  assert.ok(matchesSearch(parts, searchNeedle('40'), ''), '«40» matches the row with 40 in its name');
  const row = { name: 'Prova verifica 40 NoteInvio', email: null, company: null, phone: null };
  assert.ok(searchMatchFields(row, '40').includes('name'), 'the blame names the visible field');
  assert.equal(customerResultVisible(row, ['name'], '40'), true, 'the form keeps the row');
  assert.equal(
    customerResultVisible({ name: 'Ada Rossi', email: null, company: null, phone: null }, ['name'], '33'),
    false,
    'short digits nothing shows still match nothing',
  );
});

// Cura 2 del 20:xZ: «000 001» mostra la parte che combacia, diversa per
// ogni telefono, mai tre volte «…0000…».
test('f6b9d189/phone: the motive shows the matched digits, apart per phone', () => {
  const hints = ['+39000001888', '+39000001999', '+39000001777'].map((tel) => customerMatchReason(
    { name: 'Cliente', phone: { value: tel } }, ['phone'], '000 001',
  ));
  for (const hint of hints) {
    assert.ok(String(hint).includes('000001'), `the motive holds the searched run, got: ${hint}`);
  }
  assert.equal(new Set(hints).size, 3, `one hint per phone, got: ${hints.join(' | ')}`);
});

// AC-2: «-note@» sugli omonimi non nasconde «note» nei puntini: il motivo
// ancorato vince sul disambiguatore quando il nome non spiega la ricerca.
test('f6b9d189/AC-2: «-note@» shows the matched piece on homonyms too', async () => {
  const sibs = [
    {
      resource: 'contact', id: 'c-rossi-1', name: 'Daniele Rossi', email: 'prenote@esempio.it',
      phone: null, company: null, searchMatch: ['email'],
    },
    {
      resource: 'contact', id: 'c-rossi-2', name: 'Daniele Rossi', email: 'pranote@esempio.it',
      phone: null, company: null, searchMatch: ['email'],
    },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createCalendarioView({
    searchDelayMs: 0, doc, mount, client: pagedClient({ pages: [sibs] }), now: () => new Date('2026-10-21T06:00:00Z'),
  });
  await view.render();
  await settle();
  openManual(mount);
  const search = byName(mount, 'customerSearch');
  search.value = '-note@';
  search.dispatch('input');
  await settle();
  const labels = customerBox(mount).findAll('button').map((node) => node.textContent);
  assert.equal(labels.length, 2, `both homonyms stay listed: ${labels.join(' | ')}`);
  for (const label of labels) {
    assert.ok(label.includes('note'), `the hint shows the searched piece, got: ${label}`);
  }
});
