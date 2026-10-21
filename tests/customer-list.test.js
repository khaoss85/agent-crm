import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCustomerStatus } from '../packages/core/src/customer-status.js';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import {
  CUSTOMER_COLUMNS,
  CUSTOMER_PAGE_SIZES,
  CUSTOMER_VIEWS,
  applyCustomerListQuery,
  channelWordsIn,
  parseCustomerListQuery,
  shapeCustomerRow,
} from '../packages/customer-data/src/customers.js';

/**
 * The customer list (BO-F1-05): views as saved queries, channel and status
 * filters, free-text search with channel-word detection, sorting and
 * server-side pagination over exact page sizes.
 *
 * What it must prove: the five quick views are saved filter descriptors (no
 * row snapshots); filters combine and clear to `all`; unknown query values
 * refuse fail-closed; pages slice server-side with an exact total; the
 * shared status rule promotes only on signed business; the AI budget column
 * reads stored signals with their source and stays unavailable — never
 * broken — without them.
 */

const CONTACT = (over = {}) => ({
  id: 'c1', companyId: 'co1', firstName: 'Guido', lastName: 'Presti',
  email: 'guido@palestra-esempio.it', role: 'titolare',
  createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', ...over,
});
const COMPANY = (over = {}) => ({
  id: 'co1', name: 'Palestra Esempio', domain: 'palestra-esempio.it',
  createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z', ...over,
});
const IDENTITY = (over = {}) => ({
  id: 'e1', system: 'whatsapp', externalId: '+39 333 1234567',
  subjectResource: 'contact', subjectId: 'c1', status: 'active', ...over,
});

const rowOf = (over = {}, reads = {}) => shapeCustomerRow(
  { contact: CONTACT(over.contact ?? {}), company: COMPANY(over.company ?? {}) },
  reads,
);

const baseReads = () => ({
  identitiesBySubject: new Map([['contact:c1', [IDENTITY()]]]),
  statusBySubject: new Map([['contact:c1', { value: 'contatto', reason: 'nessuna firma' }]]),
});

/* ------------------------------------------------------------ query parse */

test('the list query parses the prototype grammar and refuses the rest', () => {
  const query = parseCustomerListQuery({
    q: 'guido', canale: 'whatsapp', stato: 'cliente', sort: 'name', vista: 'tutti', page: '2', pageSize: '25',
  });
  assert.equal(query.q, 'guido');
  assert.equal(query.canale, 'whatsapp');
  assert.equal(query.stato, 'cliente');
  assert.equal(query.sort, 'name');
  assert.equal(query.page, 2);
  assert.equal(query.pageSize, 25);
  const defaults = parseCustomerListQuery({});
  assert.equal(defaults.canale, 'all');
  assert.equal(defaults.stato, 'all');
  assert.equal(defaults.sort, 'recent');
  assert.equal(defaults.vista, 'tutti');
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 10);
  for (const bad of [
    { pageSize: '20' }, { pageSize: '100' }, { page: '0' }, { page: '-1' }, { page: 'x' },
    { sort: 'fuzzy' }, { vista: 'mie' }, { canale: 'piccioni' }, { stato: 'forse' },
    { q: 'x'.repeat(201) },
  ]) {
    assert.throws(() => parseCustomerListQuery(bad), /customer list query/, JSON.stringify(bad));
  }
  assert.deepEqual([...CUSTOMER_PAGE_SIZES], [10, 25, 50]);
});

/* ------------------------------------------------------- channel words */

test('channel words in the search act as a channel filter, without any LLM', () => {
  assert.deepEqual(channelWordsIn('clienti di Milano su WhatsApp'), ['whatsapp']);
  assert.deepEqual(channelWordsIn('telefonami'), []);
  assert.deepEqual(channelWordsIn('mail e telefono'), ['email', 'phone']);
  const wa = rowOf({}, baseReads());
  const mail = rowOf({}, {
    identitiesBySubject: new Map([['contact:c1', [IDENTITY({ system: 'email', externalId: 'guido@palestra-esempio.it' })]]]),
    statusBySubject: new Map([['contact:c1', { value: 'contatto', reason: 'x' }]]),
  });
  const query = parseCustomerListQuery({ q: 'guido whatsapp' });
  const page = applyCustomerListQuery([wa, mail], query);
  assert.equal(page.total, 1);
  assert.equal(page.items[0].channels[0], 'whatsapp');
});

/* ------------------------------------------------------------- filtering */

test('channel and status filters combine, and clearing one restores the rows', () => {
  const wa = rowOf({}, baseReads());
  const cliente = rowOf({}, {
    identitiesBySubject: new Map([['contact:c1', [IDENTITY({ system: 'instagram', externalId: 'guido.presti' })]]]),
    statusBySubject: new Map([['contact:c1', { value: 'cliente', reason: 'orders: 1 on record' }]]),
  });
  assert.equal(applyCustomerListQuery([wa, cliente], parseCustomerListQuery({})).total, 2);
  assert.equal(applyCustomerListQuery([wa, cliente], parseCustomerListQuery({ canale: 'instagram' })).total, 1);
  assert.equal(applyCustomerListQuery([wa, cliente], parseCustomerListQuery({ stato: 'cliente' })).total, 1);
  const both = applyCustomerListQuery([wa, cliente], parseCustomerListQuery({ canale: 'instagram', stato: 'cliente' }));
  assert.equal(both.total, 1);
  assert.equal(both.items[0].status.value, 'cliente');
  // × on a filter is parsing `all` again: the rows come back, nothing cached.
  assert.equal(applyCustomerListQuery([wa, cliente], parseCustomerListQuery({ canale: 'all', stato: 'all' })).total, 2);
});

test('free text matches name, email, company and phone, case-insensitively', () => {
  const row = rowOf({}, baseReads());
  assert.equal(applyCustomerListQuery([row], parseCustomerListQuery({ q: 'GUIDO' })).total, 1);
  assert.equal(applyCustomerListQuery([row], parseCustomerListQuery({ q: 'palestra-esempio' })).total, 1);
  assert.equal(applyCustomerListQuery([row], parseCustomerListQuery({ q: '333 1234567' })).total, 1);
  assert.equal(applyCustomerListQuery([row], parseCustomerListQuery({ q: 'inesistente' })).total, 0);
});

/* ----------------------------------------------------------------- views */

test('the five quick views are saved filter descriptors, not row snapshots', () => {
  assert.equal(CUSTOMER_VIEWS.length, 5);
  assert.deepEqual(CUSTOMER_VIEWS.map((view) => view.id),
    ['tutti', 'nuovi-lead', 'clienti-attivi', 'ricontattare-oggi', 'rinnovi-30-giorni']);
  for (const view of CUSTOMER_VIEWS) {
    assert.equal(typeof view.label, 'string');
    assert.ok(view.label.length > 0);
    assert.equal(typeof view.filters, 'object');
  }
  // nuovi-lead and clienti-attivi are the list status cut, re-read live.
  const contatto = rowOf({}, baseReads());
  const cliente = rowOf({}, {
    identitiesBySubject: new Map([['contact:c1', [IDENTITY()]]]),
    statusBySubject: new Map([['contact:c1', { value: 'cliente', reason: 'orders: 1 on record' }]]),
  });
  assert.equal(applyCustomerListQuery([contatto, cliente], parseCustomerListQuery({ vista: 'nuovi-lead' })).total, 1);
  assert.equal(applyCustomerListQuery([contatto, cliente], parseCustomerListQuery({ vista: 'clienti-attivi' })).total, 1);
  assert.equal(applyCustomerListQuery([contatto, cliente], parseCustomerListQuery({ vista: 'tutti' })).total, 2);
});

test('ricontattare-oggi matches open tasks due today or overdue, nothing else', () => {
  const today = '2026-10-21';
  const due = (dueAt) => rowOf({}, {
    ...baseReads(),
    taskBySubject: new Map([['contact:c1', { title: 'Richiama', dueAt, overdue: dueAt.slice(0, 10) < today }]]),
  });
  const q = parseCustomerListQuery({ vista: 'ricontattare-oggi' });
  assert.equal(applyCustomerListQuery([due(`${today}T18:00:00.000Z`)], q, today).total, 1);
  assert.equal(applyCustomerListQuery([due('2026-10-20T18:00:00.000Z')], q, today).total, 1);
  assert.equal(applyCustomerListQuery([due('2026-10-22T18:00:00.000Z')], q, today).total, 0);
  assert.equal(applyCustomerListQuery([rowOf({}, baseReads())], q, today).total, 0);
});

test('rinnovi-30-giorni matches only customers with a renewal inside the window', () => {
  const withRenewal = rowOf({}, { ...baseReads(), renewalBySubject: new Map([['contact:c1', true]]) });
  const without = rowOf({}, { ...baseReads(), renewalBySubject: new Map([['contact:c1', false]]) });
  const q = parseCustomerListQuery({ vista: 'rinnovi-30-giorni' });
  assert.equal(applyCustomerListQuery([withRenewal, without], q).total, 1);
});

/* -------------------------------------------------------------- pagination */

test('pages slice server-side with an exact total and clamped pages', () => {
  const rows = Array.from({ length: 27 }, (_, index) => rowOf({
    contact: { id: `c${index}`, email: `c${index}@example.it` },
  }, {
    identitiesBySubject: new Map([[`contact:c${index}`, []]]),
    statusBySubject: new Map([[`contact:c${index}`, { value: 'contatto', reason: 'x' }]]),
  }));
  const first = applyCustomerListQuery(rows, parseCustomerListQuery({ pageSize: '10', page: '1' }));
  assert.equal(first.total, 27);
  assert.equal(first.pages, 3);
  assert.equal(first.items.length, 10);
  const third = applyCustomerListQuery(rows, parseCustomerListQuery({ pageSize: '10', page: '3' }));
  assert.equal(third.items.length, 7);
  // A page past the end clamps to the last page: a page nobody asked for is
  // never answered empty while rows exist.
  const past = applyCustomerListQuery(rows, parseCustomerListQuery({ pageSize: '10', page: '9' }));
  assert.equal(past.page, 3);
  assert.equal(past.items.length, 7);
  const wide = applyCustomerListQuery(rows, parseCustomerListQuery({ pageSize: '25' }));
  assert.equal(wide.pages, 2);
  assert.equal(wide.items.length, 25);
});

/* ---------------------------------------------------------------- sorting */

test('sorting covers recent, name, value and status', () => {
  const mk = (name, extra = {}) => rowOf({ contact: { firstName: name, lastName: '', email: `${name}@x.it` } }, {
    identitiesBySubject: new Map([['contact:c1', []]]),
    statusBySubject: new Map([['contact:c1', { value: extra.status ?? 'contatto', reason: 'x' }]]),
    activityBySubject: new Map(extra.occurredAt ? [['contact:c1', { occurredAt: extra.occurredAt, channel: 'email' }]] : []),
    offerBySubject: new Map(extra.valueCents ? [['contact:c1', { valueCents: extra.valueCents, currency: 'EUR' }]] : []),
  });
  const rows = [mk('guido', { occurredAt: '2026-10-20T09:00:00.000Z', valueCents: 100, status: 'cliente' }), mk('anna', { occurredAt: '2026-10-21T09:00:00.000Z', valueCents: 5000 })];
  assert.equal(applyCustomerListQuery(rows, parseCustomerListQuery({ sort: 'recent' })).items[0].name, 'anna');
  assert.equal(applyCustomerListQuery(rows, parseCustomerListQuery({ sort: 'name' })).items[0].name, 'anna');
  assert.equal(applyCustomerListQuery(rows, parseCustomerListQuery({ sort: 'value' })).items[0].name, 'anna');
  assert.equal(applyCustomerListQuery(rows, parseCustomerListQuery({ sort: 'status' })).items[0].name, 'guido');
});

/* ------------------------------------------------------------ status rule */

test('the shared status rule promotes only on signed business', () => {
  const none = { available: false, count: null, countIsComplete: true };
  assert.equal(deriveCustomerStatus({ orders: { available: true, count: 1, countIsComplete: true }, contracts: none, subscriptions: none }).value, 'cliente');
  const proven = deriveCustomerStatus({
    orders: { available: true, count: 0, countIsComplete: true },
    contracts: { available: true, count: 0, countIsComplete: true },
    subscriptions: { available: true, count: 0, countIsComplete: true },
  });
  assert.equal(proven.value, 'contatto');
  assert.match(proven.reason, /quotes and opportunities alone/);
  const unreadable = deriveCustomerStatus({ orders: none, contracts: none, subscriptions: none });
  assert.equal(unreadable.value, 'contatto');
  assert.match(unreadable.reason, /not all readable/);
  const partial = deriveCustomerStatus({
    orders: { available: true, count: 0, countIsComplete: false },
    contracts: { available: true, count: 0, countIsComplete: true },
    subscriptions: { available: true, count: 0, countIsComplete: true },
  });
  assert.equal(partial.value, 'contatto');
  assert.match(partial.reason, /partially readable/);
});

/* ------------------------------------------------------------- row shape */

test('a row joins the contact to its company and the held phone identity', () => {
  const row = rowOf({}, baseReads());
  assert.equal(row.name, 'Guido Presti');
  assert.equal(row.company.name, 'Palestra Esempio');
  assert.deepEqual(row.channels, ['whatsapp']);
  assert.deepEqual(row.phone, { value: '+39 333 1234567', system: 'whatsapp' });
  // The list shows the held identity; dialability stays the scheda's verdict.
  const social = rowOf({}, {
    identitiesBySubject: new Map([['contact:c1', [IDENTITY({ system: 'instagram', externalId: 'guido.presti' })]]]),
    statusBySubject: new Map([['contact:c1', { value: 'contatto', reason: 'x' }]]),
  });
  assert.equal(social.phone, null);
  assert.deepEqual(social.channels, ['instagram']);
});

test('the AI budget column reads stored signals with their source, or stays unavailable', () => {
  const plain = rowOf({}, baseReads());
  assert.equal(plain.budget.available, false);
  assert.match(plain.budget.reason, /nessun budget estratto/);
  const withBudget = rowOf({}, {
    ...baseReads(),
    budgetBySubject: new Map([['contact:c1', {
      available: true, value: '25–30.000 €', source: { resource: 'contact', id: 'c1' },
    }]]),
  });
  assert.equal(withBudget.budget.available, true);
  assert.equal(withBudget.budget.value, '25–30.000 €');
  assert.deepEqual(withBudget.budget.source, { resource: 'contact', id: 'c1' });
});

/* --------------------------------------------- orchestration over fake modules */

const matchShape = (rows, filters) => rows.filter((row) => Object.entries(filters ?? {}).every(([field, value]) => {
  if (Array.isArray(value)) return value.includes(row[field]);
  return row[field] === value;
}));

/** A module map with exact-match reads and no writes: any write attempt throws. */
function fakeModules({ contacts, companies, identities = [], orders = [], opportunities = [], tasks = [], signals = [] }) {
  const exact = (rows) => ({
    listWhere: async (filters) => matchShape(rows, filters),
    createManaged: async () => { throw new Error('the list writes nothing'); },
  });
  const map = new Map([
    ['contact', { service: { list: async () => contacts } }],
    ['company', { service: { list: async () => companies } }],
    ['external-identity', { service: exact(identities) }],
    ['order', { service: exact(orders) }],
    ['opportunity', { service: exact(opportunities) }],
    ['work-task', { service: exact(tasks) }],
    ['call-signal', { service: exact(signals) }],
  ]);
  return {
    get: (name) => {
      const entry = map.get(name);
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
}

const SCENE = () => {
  const contacts = [
    { id: 'c1', companyId: 'co1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it' },
    { id: 'c2', companyId: 'co2', firstName: 'Anna', lastName: 'Bianchi', email: 'anna@example.it' },
  ];
  const companies = [
    { id: 'co1', name: 'Palestra Esempio', domain: 'palestra-esempio.it' },
    { id: 'co2', name: 'Studio Bianchi', domain: 'studio-bianchi.it' },
  ];
  const identities = [
    { id: 'e1', system: 'whatsapp', externalId: '+39 333 1234567', subjectResource: 'contact', subjectId: 'c1', status: 'active' },
    { id: 'e2', system: 'email', externalId: 'anna@example.it', subjectResource: 'contact', subjectId: 'c2', status: 'active' },
  ];
  return { contacts, companies, identities };
};

test('the operation joins, enriches and pages over the module map, writing nothing', async () => {
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({
    contacts,
    companies,
    identities,
    orders: [{ id: 'o1', companyId: 'co1' }],
    opportunities: [{ id: 'op1', contactId: 'c2', valueCents: 120000, currency: 'EUR', stage: 'proposal' }],
    tasks: [{ id: 't1', title: 'Richiama', status: 'open', dueAt: '2026-10-21T18:00:00.000Z', subjectResource: 'contact', subjectId: 'c1' }],
  });
  const before = JSON.stringify({ contacts, companies, identities });
  const page = await listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', sort: 'name', pageSize: '10' },
  );
  assert.equal(before, JSON.stringify({ contacts, companies, identities }), 'the read wrote something');
  assert.equal(page.customerListContract, 1);
  assert.equal(page.total, 2);
  assert.equal(page.totalIsExact, true);
  assert.equal(page.items[0].name, 'Anna Bianchi');
  const guido = page.items.find((item) => item.name === 'Guido Presti');
  assert.deepEqual(guido.channels, ['whatsapp']);
  assert.equal(guido.status.value, 'cliente');
  assert.match(guido.status.reason, /orders/);
  assert.equal(guido.nextStep.title, 'Richiama');
  const anna = page.items.find((item) => item.name === 'Anna Bianchi');
  assert.equal(anna.status.value, 'contatto');
  assert.equal(anna.offerValueCents, 120000);
  // No spaceId, no budget read: the AI column stays unavailable, never broken.
  assert.equal(guido.budget.available, false);
});

test('views, filters and search run on the same page the server returns', async () => {
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({ contacts, companies, identities });
  const run = (request) => listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, request);
  assert.equal((await run({ vista: 'nuovi-lead' })).total, 2);
  assert.equal((await run({ vista: 'clienti-attivi' })).total, 0);
  assert.equal((await run({ canale: 'email' })).total, 1);
  assert.equal((await run({ q: 'anna' })).total, 1);
  assert.equal((await run({ q: 'guido whatsapp' })).total, 1);
  assert.equal((await run({ q: 'anna whatsapp' })).total, 0);
});

test('budget signals attach with their source only when a space is named', async () => {
  const { contacts, companies, identities } = SCENE();
  const signals = [{
    id: 's1', spaceId: 'sp1', subjectResource: 'contact', subjectId: 'c1',
    signalType: 'budget', excerpt: '25–30.000 €', observedAt: '2026-10-20T12:00:00.000Z',
  }];
  const modules = fakeModules({ contacts, companies, identities, signals });
  const run = (request) => listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, request);
  const without = await run({});
  assert.equal(without.items.find((item) => item.name === 'Guido Presti').budget.available, false);
  const withSpace = await run({ spaceId: 'sp1' });
  const budget = withSpace.items.find((item) => item.name === 'Guido Presti').budget;
  assert.equal(budget.available, true);
  assert.equal(budget.value, '25–30.000 €');
  assert.deepEqual(budget.source, { resource: 'contact', id: 'c1' });
});

test('budget is an opt-in column: cliente, canali, stato, ultimo and prossimo are on by default', () => {
  const on = Object.fromEntries(CUSTOMER_COLUMNS.filter((column) => column.def).map((column) => [column.id, true]));
  assert.deepEqual(on, { canali: true, stato: true, ultimo: true, prossimo: true });
  assert.equal(CUSTOMER_COLUMNS.find((column) => column.id === 'budget').ai, true);
  assert.equal(CUSTOMER_COLUMNS.find((column) => column.id === 'cliente').always, true);
});
