import test from 'node:test';
import assert from 'node:assert/strict';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import {
  CUSTOMER_COLUMNS,
  CUSTOMER_SORTS,
  applyCustomerListQuery,
  parseCustomerListQuery,
  shapeCustomerRow,
} from '../packages/customer-data/src/customers.js';

/**
 * The Clienti Punteggio column (backlog:e80c6aee42c5): the contact-fit score
 * against the space's ideal customer, computed on read and never stored.
 *
 * What it must prove: a shaped row carries the score with its reasons (or
 * the unavailable reason, never a zero); the fit sort orders highest first
 * with unavailable last; the operation answers the punteggio column and the
 * fit sort only when the playbook scores at least one row, and names
 * neither without a playbook; per-row reasons stay on every scored row.
 */

const GUIDO = { id: 'c1', companyId: 'co1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it', role: 'Titolare' };
const ANNA = { id: 'c2', companyId: 'co2', firstName: 'Anna', lastName: 'Bianchi', email: 'anna@studio-associato.it', role: 'Commercialista' };
const PALESTRA = { id: 'co1', name: 'Palestra Esempio', domain: 'palestra-esempio.it' };
const STUDIO = { id: 'co2', name: 'Studio Associato', domain: 'studio-associato.it' };
const PLAYBOOK = { idealCustomer: 'Il cliente ideale è il titolare di una palestra che vende abbonamenti e pacchetti' };

const rowOf = (contact, company, reads = {}) => shapeCustomerRow({ contact, company }, {
  statusBySubject: new Map([[`${contact ? 'contact' : 'company'}:${contact?.id ?? company?.id}`, { value: 'contatto', reason: 'x' }]]),
  ...reads,
});

/* ------------------------------------------------------------------ shape */

test('a shaped row carries the fit with its reasons, or the unavailable reason', () => {
  const plain = rowOf(GUIDO, PALESTRA);
  assert.equal(plain.fit.available, false);
  assert.equal(plain.fit.value, null);
  assert.ok(plain.fit.reasons.length > 0);
  assert.match(plain.fit.reasons[0], /playbook/);
  const scored = rowOf(GUIDO, PALESTRA, {
    fitBySubject: new Map([['contact:c1', { available: true, value: 80, reasons: ['ruolo «titolare» nel cliente ideale'] }]]),
  });
  assert.equal(scored.fit.available, true);
  assert.equal(scored.fit.value, 80);
  assert.deepEqual(scored.fit.reasons, ['ruolo «titolare» nel cliente ideale']);
});

test('the fit sort orders highest first, unavailable last', () => {
  const high = rowOf(GUIDO, PALESTRA, { fitBySubject: new Map([['contact:c1', { available: true, value: 80, reasons: ['a'] }]]) });
  const low = rowOf(ANNA, STUDIO, { fitBySubject: new Map([['contact:c2', { available: true, value: 20, reasons: ['b'] }]]) });
  const none = rowOf(ANNA, STUDIO);
  const page = applyCustomerListQuery([low, none, high], parseCustomerListQuery({ sort: 'fit' }));
  assert.deepEqual(page.items.map((row) => row.id), ['c1', 'c2', 'c2']);
  assert.equal(page.items[0].fit.value, 80);
  assert.equal(page.items[2].fit.available, false);
  assert.equal(parseCustomerListQuery({ sort: 'fit' }).sort, 'fit');
});

/* ------------------------------------------------------- operation wiring */

const matchShape = (rows, filters) => rows.filter((row) => Object.entries(filters ?? {}).every(([field, value]) => {
  if (Array.isArray(value)) return value.includes(row[field]);
  return row[field] === value;
}));

const fakeModules = ({ contacts, companies, identities = [], playbook = null, withPlaybook = false }) => {
  const exact = (rows) => ({
    listWhere: async (filters) => matchShape(rows, filters),
    createManaged: async () => { throw new Error('the list writes nothing'); },
  });
  const entries = [
    ['contact', { service: { list: async () => contacts } }],
    ['company', { service: { list: async () => companies } }],
    ['external-identity', { service: exact(identities) }],
    ['opportunity', { service: exact([]) }],
    ['work-task', { service: exact([]) }],
    ['interaction-message', { service: exact([]) }],
    ['interaction-call', { service: exact([]) }],
    ['call-signal', { service: exact([]) }],
  ];
  if (withPlaybook) entries.push(['sales-playbook', { service: { getBySpace: async () => playbook } }]);
  const map = new Map(entries);
  return { get: (name) => { const entry = map.get(name); if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' }); return entry; } };
};

const SCENE = () => ({ contacts: [GUIDO, ANNA], companies: [PALESTRA, STUDIO], identities: [] });

test('with a playbook the operation answers the punteggio column, the fit sort and per-row reasons', async () => {
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({ contacts, companies, identities, playbook: PLAYBOOK, withPlaybook: true });
  const page = await listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', sort: 'recent', pageSize: '10', spaceId: 's1' },
  );
  assert.ok(page.columns.some((column) => column.id === 'punteggio'), 'the column is named');
  assert.ok(page.sorts.some((sort) => sort.id === 'fit'), 'the sort is named');
  const guido = page.items.find((item) => item.id === 'c1');
  const anna = page.items.find((item) => item.id === 'c2');
  assert.equal(guido.fit.available, true);
  assert.equal(anna.fit.available, true);
  assert.ok(guido.fit.value > anna.fit.value, `profiles differ: ${guido.fit.value} vs ${anna.fit.value}`);
  assert.ok(guido.fit.reasons.length >= 2 && guido.fit.reasons.every((reason) => typeof reason === 'string' && reason !== ''));
  const sorted = await listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', sort: 'fit', pageSize: '10', spaceId: 's1' },
  );
  assert.equal(sorted.items[0].id, 'c1', 'the fit sort reads highest first');
});

test('without a playbook the operation names no punteggio column and no fit sort', async () => {
  const { contacts, companies, identities } = SCENE();
  for (const modules of [
    fakeModules({ contacts, companies, identities, withPlaybook: false }),
    fakeModules({ contacts, companies, identities, playbook: { idealCustomer: '' }, withPlaybook: true }),
    fakeModules({ contacts, companies, identities, playbook: null, withPlaybook: true }),
  ]) {
    const page = await listCustomerRecords(
      { modules, core: {}, names: { identity: 'external-identity' } },
      { vista: 'tutti', sort: 'recent', pageSize: '10', spaceId: 's1' },
    );
    assert.ok(!page.columns.some((column) => column.id === 'punteggio'), 'no empty column');
    assert.ok(!page.sorts.some((sort) => sort.id === 'fit'), 'no empty sort');
    for (const item of page.items) {
      assert.equal(item.fit.available, false);
      assert.equal(item.fit.value, null);
    }
  }
});

test('the declared sorts and columns name the new entries', () => {
  assert.ok(CUSTOMER_SORTS.some((sort) => sort.id === 'fit' && sort.label === 'Punteggio'));
  assert.ok(CUSTOMER_COLUMNS.some((column) => column.id === 'punteggio' && column.label === 'Punteggio'));
});
