import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCustomerStatus } from '../packages/customer-data/src/customer-status.js';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import {
  CUSTOMER_COLUMNS,
  CUSTOMER_PAGE_SIZES,
  CUSTOMER_SCAN_LIMIT,
  CUSTOMER_VIEWS,
  LAST_CONTACT_PREVIEW_CHARS,
  applyCustomerListQuery,
  channelWordsIn,
  parseCustomerListQuery,
  previewLastContactText,
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

test('glue words of the phrase grammar leave the text needle, they do not join it', () => {
  const milano = rowOf({
    contact: { firstName: 'Marco', lastName: 'Rossi', email: 'marco@example.it' },
    company: { name: 'Palestra Milano', domain: 'milano.example.it' },
  }, baseReads());
  const page = applyCustomerListQuery([milano], parseCustomerListQuery({ q: 'clienti di Milano su WhatsApp' }));
  assert.equal(page.total, 1, '"su" is a connector, not part of the place name');
  const bare = applyCustomerListQuery([milano], parseCustomerListQuery({ q: 'Milano' }));
  assert.equal(bare.total, 1);
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
    ['tutti', 'ricontattare-oggi', 'nuovi-lead', 'clienti-attivi', 'rinnovi-30-giorni']);
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
function fakeModules({ contacts, companies, identities = [], orders = [], opportunities = [], tasks = [], signals = [], messages = [], calls = [], omit = [] }) {
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
    ['interaction-message', { service: exact(messages) }],
    ['interaction-call', { service: exact(calls) }],
  ]);
  for (const name of omit) map.delete(name);
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

test('evidence through another customer\u2019s opportunity never promotes this customer', async () => {
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({
    contacts,
    companies,
    identities,
    opportunities: [{ id: 'op9', contactId: 'c1', valueCents: 50000, currency: 'EUR', stage: 'proposal' }],
    // An order that names only Guido's opportunity: no company, no contact.
    orders: [{ id: 'ord9', opportunityId: 'op9' }],
  });
  const page = await listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', sort: 'name', pageSize: '10' },
  );
  const guido = page.items.find((item) => item.name === 'Guido Presti');
  const anna = page.items.find((item) => item.name === 'Anna Bianchi');
  assert.equal(guido.status.value, 'cliente', 'the opportunity owner is promoted through the scoped hop');
  assert.equal(anna.status.value, 'contatto', 'an order on another customer\u2019s opportunity is not mine');
  assert.match(anna.status.reason, /no signed business found/,
    'the negative claim still explains itself instead of going silent');
});

test('a derived view over an unreadable dependency refuses, never an empty page', async () => {
  const { contacts, companies, identities } = SCENE();
  // No subscription package composed: the renewal view cannot know.
  const noSubs = fakeModules({ contacts, companies, identities });
  await assert.rejects(
    listCustomerRecords(
      { modules: noSubs, core: {}, names: { identity: 'external-identity' } },
      { vista: 'rinnovi-30-giorni' },
    ),
    (error) => error.code === 'CUSTOMER_LIST_UNAVAILABLE' && /subscription/.test(error.message),
    'rinnovi-30-giorni without subscriptions refuses with its reason',
  );
  // No work-task package composed: the callback view cannot know.
  const noTasks = fakeModules({ contacts, companies, identities, omit: ['work-task'] });
  await assert.rejects(
    listCustomerRecords(
      { modules: noTasks, core: {}, names: { identity: 'external-identity' } },
      { vista: 'ricontattare-oggi' },
    ),
    (error) => error.code === 'CUSTOMER_LIST_UNAVAILABLE' && /work-task/.test(error.message),
    'ricontattare-oggi without work tasks refuses with its reason',
  );
  // The plain views still answer over the same map: the refusal is scoped
  // to the derived view, not a blanket outage.
  assert.equal((await listCustomerRecords(
    { modules: noTasks, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti' },
  )).total, 2);
});

test('ricontattare-oggi sees an overdue callback behind an undated open task', async () => {
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({
    contacts, companies, identities,
    tasks: [
      { id: 't1', title: 'Senza data', status: 'open', dueAt: null, subjectResource: 'contact', subjectId: 'c1' },
      { id: 't2', title: 'Richiama', status: 'open', dueAt: '2026-10-20T18:00:00.000Z', subjectResource: 'contact', subjectId: 'c1' },
    ],
  });
  const run = (request) => listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, request);
  const page = await run({ vista: 'ricontattare-oggi' });
  assert.equal(page.total, 1, 'an undated open task must not hide the overdue callback');
  const guido = page.items.find((item) => item.name === 'Guido Presti');
  assert.equal(guido.nextStep.title, 'Richiama', 'the row carries the most actionable task, not the earliest-sorted one');
  assert.equal(guido.nextStep.overdue, true);
});

test('a derived view over a truncated dependency refuses instead of omitting rows', async () => {
  const { contacts, companies, identities } = SCENE();
  const overdue = [{
    id: 't1', title: 'Richiama', status: 'open', dueAt: '2026-10-20T18:00:00.000Z',
    subjectResource: 'contact', subjectId: 'c1',
  }];
  // A handwritten service exposing only list(): the batched read is a bounded
  // page flagged partial (complete:false), never an exact answer.
  const listOnly = (rows) => ({ list: async () => rows });
  const base = fakeModules({ contacts, companies, identities, tasks: overdue });
  const swap = (name, service) => ({ get: (key) => (key === name ? { service } : base.get(key)) });
  await assert.rejects(
    listCustomerRecords(
      { modules: swap('work-task', listOnly(overdue)), core: {}, names: { identity: 'external-identity' } },
      { vista: 'ricontattare-oggi' },
    ),
    (error) => error.code === 'CUSTOMER_LIST_UNAVAILABLE' && /work-task/.test(error.message),
    'a truncated work-task read refuses the callback view instead of an exact-looking page',
  );
  await assert.rejects(
    listCustomerRecords(
      { modules: swap('subscription', listOnly([])), core: {}, names: { identity: 'external-identity' } },
      { vista: 'rinnovi-30-giorni' },
    ),
    (error) => error.code === 'CUSTOMER_LIST_UNAVAILABLE' && /subscription/.test(error.message),
    'a truncated subscription read refuses the renewal view instead of an exact-looking page',
  );
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

test('the list names a finite count per view it can know, omitting the rest', async () => {
  // C10: `<etichetta> <n>` beside the views, from the server — the pill
  // count is the same predicate the page applies, so it agrees with the
  // total of opening that view.
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({
    contacts, companies, identities,
    tasks: [{
      id: 't1', title: 'Richiama', status: 'open', dueAt: '2026-10-20T18:00:00.000Z',
      subjectResource: 'contact', subjectId: 'c1',
    }],
  });
  const run = (request) => listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } }, request);
  const page = await run({ vista: 'tutti', sort: 'name' });
  const byId = Object.fromEntries(page.views.map((view) => [view.id, view]));
  assert.equal(byId.tutti.count, page.total, 'the active pill agrees with the title total');
  for (const id of ['nuovi-lead', 'clienti-attivi', 'ricontattare-oggi']) {
    assert.equal(byId[id].count, (await run({ vista: id })).total, `${id} counts what opening it shows`);
  }
  // No subscription module composed: the renewal count stays absent, never a
  // floor dressed as a total.
  assert.ok(!('count' in byId['rinnovi-30-giorni']), 'an unknowable view names no count');
});

test('a view whose dependency is unreadable still answers without its count', async () => {
  const { contacts, companies, identities } = SCENE();
  const modules = fakeModules({ contacts, companies, identities, omit: ['work-task'] });
  const page = await listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } }, { vista: 'tutti' });
  const byId = Object.fromEntries(page.views.map((view) => [view.id, view]));
  assert.ok(!('count' in byId['ricontattare-oggi']), 'no work-task read, no callback count');
  assert.equal(byId.tutti.count, 2, 'the views the server can know still count');
});

/* --------------------------------- ultimo contatto: preview + quando --- */

test('the preview keeps one short line, never the full body or a call', () => {
  // backlog:22d4dd0f, C16: the Ultimo contatto cell shows the channel mark
  // plus a short message excerpt. Calls carry no text, so a latest call (or
  // no activity) previews as null — the view renders channel and date alone.
  assert.equal(previewLastContactText('Ci vediamo domani per la prova?'), 'Ci vediamo domani per la prova?');
  assert.equal(previewLastContactText('  prima riga\nseconda   riga  '), 'prima riga seconda riga');
  assert.equal(previewLastContactText(''), null, 'empty bodies preview as nothing');
  assert.equal(previewLastContactText('   \n  '), null, 'blank bodies preview as nothing');
  assert.equal(previewLastContactText(null), null, 'a call names no body field');
  assert.equal(previewLastContactText(undefined), null);
  assert.equal(previewLastContactText(42), null, 'a non-string body never leaks through');
  const exact = 'x'.repeat(LAST_CONTACT_PREVIEW_CHARS);
  assert.equal(previewLastContactText(exact), exact, 'a body at the bound stays whole');
  const long = `${'y'.repeat(LAST_CONTACT_PREVIEW_CHARS + 20)} tail`;
  const preview = previewLastContactText(long);
  assert.ok(preview.endsWith('…'), 'a long body truncates with an ellipsis');
  assert.ok(preview.length <= LAST_CONTACT_PREVIEW_CHARS + 1, 'the truncated preview stays bounded');
  assert.ok(!preview.includes('tail'), 'the truncation cuts, never keeps the tail');
});

test('a row carries the latest message excerpt beside channel and date', () => {
  const withText = rowOf({}, {
    ...baseReads(),
    activityBySubject: new Map([['contact:c1', {
      occurredAt: '2026-10-20T09:00:00.000Z', channel: 'whatsapp', text: 'Ci vediamo domani per la prova?',
    }]]),
  });
  assert.equal(withText.lastContactAt, '2026-10-20T09:00:00.000Z');
  assert.equal(withText.lastContactChannel, 'whatsapp');
  assert.equal(withText.lastContactText, 'Ci vediamo domani per la prova?');
  const callOnly = rowOf({}, {
    ...baseReads(),
    activityBySubject: new Map([['contact:c1', {
      occurredAt: '2026-10-20T09:00:00.000Z', channel: 'phone', text: null,
    }]]),
  });
  assert.equal(callOnly.lastContactText, null, 'a latest call previews as nothing, never an invented excerpt');
  assert.equal(rowOf({}, baseReads()).lastContactText, null, 'no activity previews as nothing');
});

test('the operation previews the latest message body, never a call', async () => {
  // backlog:22d4dd0f, C16: the server owns the excerpt; the view renders it.
  const { contacts, companies, identities } = SCENE();
  const message = {
    id: 'm1', subjectResource: 'contact', subjectId: 'c1',
    occurredAt: '2026-10-20T09:00:00.000Z', channel: 'whatsapp',
    body: 'Ci vediamo domani per la prova gratuita?',
  };
  const call = {
    id: 'k1', subjectResource: 'contact', subjectId: 'c1',
    occurredAt: '2026-10-21T10:00:00.000Z', channel: 'phone',
  };
  const run = (extra) => listCustomerRecords(
    { modules: fakeModules({ contacts, companies, identities, ...extra }), core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', sort: 'name', pageSize: '10' },
  );
  const withMessage = (await run({ messages: [message] })).items.find((item) => item.name === 'Guido Presti');
  assert.equal(withMessage.lastContactChannel, 'whatsapp');
  assert.equal(withMessage.lastContactText, 'Ci vediamo domani per la prova gratuita?');
  const withCall = (await run({ messages: [message], calls: [call] })).items
    .find((item) => item.name === 'Guido Presti');
  assert.equal(withCall.lastContactAt, '2026-10-21T10:00:00.000Z', 'the latest contact stays the call');
  assert.equal(withCall.lastContactChannel, 'phone');
  assert.equal(withCall.lastContactText, null, 'the newer call names no body, so no excerpt is invented');
  const hostile = (await run({
    messages: [{ ...message, id: 'm2', occurredAt: '2026-10-22T10:00:00.000Z', body: '<img src=x onerror=alert(1)>' }],
  })).items.find((item) => item.name === 'Guido Presti');
  assert.equal(hostile.lastContactText, '<img src=x onerror=alert(1)>', 'the server keeps the text verbatim; escaping stays the view\u2019s');
});

test('826e377c: the CANALI column unions held identities with observed message channels', () => {
  // The scheda's Identità collegate reads held plus observed; the list reads
  // the same union, so a customer with messages but no held identity still
  // shows its channels.
  const heldOnly = rowOf({}, baseReads());
  assert.deepEqual(heldOnly.channels, ['whatsapp']);
  const observedOnly = rowOf({}, {
    identitiesBySubject: new Map([['contact:c1', []]]),
    observedChannelsBySubject: new Map([['contact:c1', ['instagram', 'whatsapp']]]),
    statusBySubject: new Map([['contact:c1', { value: 'contatto', reason: 'x' }]]),
  });
  assert.deepEqual(observedOnly.channels, ['instagram', 'whatsapp']);
  const both = rowOf({}, {
    ...baseReads(),
    observedChannelsBySubject: new Map([['contact:c1', ['instagram', 'whatsapp']]]),
  });
  assert.deepEqual(both.channels, ['instagram', 'whatsapp'], 'one entry per channel, never doubled');
});

test('826e377c: the operation reads observed channels from the scanned messages and calls', async () => {
  const { contacts, companies } = SCENE();
  const run = (extra) => listCustomerRecords(
    { modules: fakeModules({ contacts, companies, identities: [], ...extra }), core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', sort: 'name', pageSize: '10' },
  );
  const messaged = (await run({
    messages: [
      {
        id: 'm1', subjectResource: 'contact', subjectId: 'c1',
        occurredAt: '2026-10-20T09:00:00.000Z', channel: 'whatsapp', body: 'Ciao',
      },
      {
        id: 'm2', subjectResource: 'contact', subjectId: 'c1',
        occurredAt: '2026-10-20T11:00:00.000Z', channel: 'instagram', body: 'Quanto costa?',
      },
    ],
  })).items.find((item) => item.name === 'Guido Presti');
  assert.deepEqual(messaged.channels, ['instagram', 'whatsapp'], 'messages with no held identity still name their channels');
  const silent = (await run({})).items.find((item) => item.name === 'Guido Presti');
  assert.deepEqual(silent.channels, [], 'no messages and no identities reads empty, never invented');
  const smsOnly = (await run({
    messages: [{
      id: 'm9', subjectResource: 'contact', subjectId: 'c1',
      occurredAt: '2026-10-20T09:00:00.000Z', channel: 'sms', body: 'Ciao',
    }],
  })).items.find((item) => item.name === 'Guido Presti');
  assert.deepEqual(
    smsOnly.channels, [],
    'an observed channel outside the filter vocabulary stays out of CANALI, like the canale filter refuses it',
  );
  const filtered = await listCustomerRecords(
    { modules: fakeModules({ contacts, companies, identities: [], messages: [{ id: 'm1', subjectResource: 'contact', subjectId: 'c1', occurredAt: '2026-10-20T09:00:00.000Z', channel: 'whatsapp', body: 'Ciao' }] }), core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti', canale: 'whatsapp' },
  );
  assert.equal(filtered.total, 1, 'the channel filter follows the same union');
});

test('a truncated subject scan names no per-view counts', async () => {
  const companies = [{ id: 'co1', name: 'Azienda' }];
  const contacts = Array.from({ length: CUSTOMER_SCAN_LIMIT }, (_, index) => ({
    id: `c${index}`, companyId: 'co1', firstName: `Nome${index}`, lastName: 'Prova',
  }));
  const modules = fakeModules({ contacts, companies, identities: [] });
  const page = await listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } }, { vista: 'tutti' });
  assert.equal(page.totalIsExact, false, 'the bound truncated the scan');
  for (const view of page.views) {
    assert.ok(!('count' in view), `${view.id} names no floor as a count`);
  }
});
