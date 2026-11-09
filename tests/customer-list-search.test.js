import test from 'node:test';
import assert from 'node:assert/strict';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import { ContactService } from '../packages/modules/contact/src/contact-service.js';
import { CompanyService } from '../packages/modules/company/src/company-service.js';
import {
  CUSTOMER_SCAN_LIMIT,
  CUSTOMER_SEARCH_SCAN_LIMIT,
  applyCustomerListQuery,
  parseCustomerListQuery,
  shapeCustomerRow,
} from '../packages/customer-data/src/customers.js';

/**
 * backlog:d128847d21fc (production 08/11, release 77e13cf): the Calendar
 * customer search «Prova» did not find «Prova verifica 07/11 …». Two causes
 * on the server the search rides on:
 * - the scan reads the newest CUSTOMER_SCAN_LIMIT records only and filters
 *   afterwards, so in a space with hundreds of fresh contacts (the Gmail
 *   sync of 08/11) an older customer could never be found;
 * - the text matched as one glued phrase over a haystack that kept its
 *   punctuation, so «verifica 07/11» missed «… verifica 07/11 …», and it
 *   matched inside words («ada» found «Canada»), with accents significant.
 * The search now matches the start of any word, folding case and accents,
 * and with text to search it looks beyond the bound.
 */

const row = (firstName, lastName, extra = {}) => shapeCustomerRow({
  contact: { id: `c-${firstName}-${lastName}`, companyId: null, firstName, lastName, email: null, ...extra },
  company: null,
}, {});

const hits = (rows, q) => applyCustomerListQuery(rows, parseCustomerListQuery({ q })).items.map((item) => item.name);

test('d128847d21fc: the search matches the start of any word of the name', () => {
  const rows = [row('Prova verifica', '07/11 Calendario'), row('Ada', 'Rossi'), row('Studio', 'Canada')];
  assert.deepEqual(hits(rows, 'Prova'), ['Prova verifica 07/11 Calendario']);
  assert.deepEqual(hits(rows, 'verifica'), ['Prova verifica 07/11 Calendario'], 'a later word is found too');
  assert.deepEqual(hits(rows, 'verifica 07/11'), ['Prova verifica 07/11 Calendario'], 'punctuation never breaks a match');
  assert.deepEqual(hits(rows, 'prova cal'), ['Prova verifica 07/11 Calendario'], 'every word is a word start, in any order');
  assert.deepEqual(hits(rows, 'ada'), ['Ada Rossi'], '«ada» is a word start, not a piece of «Canada»');
  assert.deepEqual(hits(rows, 'ROSSI'), ['Ada Rossi'], 'case never matters');
});

test('review #678: a word of 4 or more letters also matches inside a word, word starts come first', () => {
  const giovanni = row('Giovanni', 'Rossi', { email: 'gio@example.it' });
  const vanni = row('Vanni', 'Bianchi');
  const canada = row('Studio', 'Canada');
  assert.deepEqual(hits([giovanni], 'ovanni'), ['Giovanni Rossi'], '«ovanni» finds Giovanni');
  assert.deepEqual(hits([giovanni], 'ossi'), ['Giovanni Rossi'], '«ossi» finds Rossi');
  assert.deepEqual(hits([giovanni], 'xample'), ['Giovanni Rossi'], 'a piece of the email');
  assert.deepEqual(hits([giovanni], 'OVÀNNI'), ['Giovanni Rossi'], 'case and accents folded inside words too');
  assert.deepEqual(hits([canada], 'ada'), [], '«ada» (3 letters) never matches inside «Canada»');
  assert.deepEqual(hits([giovanni], 'ssi'), [], 'a 3-letter piece inside a word does not match');
  // «vanni» starts Vanni and sits inside Giovanni: the word start comes
  // first whatever the list order, the inside match stays in the answer.
  const ordered = applyCustomerListQuery([giovanni, vanni], parseCustomerListQuery({ q: 'vanni', sort: 'name' })).items.map((item) => item.name);
  assert.deepEqual(ordered, ['Vanni Bianchi', 'Giovanni Rossi']);
});

test('d128847d21fc: accents never matter', () => {
  const rows = [row('Josè', 'Niccolò')];
  assert.deepEqual(hits(rows, 'jose'), ['Josè Niccolò']);
  assert.deepEqual(hits(rows, 'NICCOLO'), ['Josè Niccolò']);
  assert.deepEqual(hits(rows, 'josé'), ['Josè Niccolò']);
});

/**
 * Contact and company services shaped like the real ones: `list` newest
 * first capped at 500, `scan` newest first capped at its own ceiling, and
 * no `listWhere` (ContactService and CompanyService have none). Every
 * read limit is recorded so the ceiling can be proven.
 */
function boundedModules(contacts, companies, reads = []) {
  const service = (name, rows) => ({
    list: async ({ limit = 100 } = {}) => {
      const capped = Math.min(limit, 500);
      reads.push({ name, method: 'list', limit: capped });
      return rows.slice(0, capped);
    },
    scan: async ({ limit = 5000 } = {}) => {
      const capped = Math.min(limit, 5000);
      reads.push({ name, method: 'scan', limit: capped });
      return rows.slice(0, capped);
    },
  });
  const map = new Map([
    ['contact', { service: service('contact', contacts) }],
    ['company', { service: service('company', companies) }],
  ]);
  return {
    get: (name) => {
      const entry = map.get(name);
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
}

const senders = (count) => Array.from({ length: count }, (_, index) => ({
  id: `g${index}`, companyId: null, firstName: `Mittente${index}`, lastName: 'Posta', email: `m${index}@example.test`,
}));

test('d128847d21fc: a customer older than the scan bound is still found by name', async () => {
  // Newest first, like the core list: a whole bound of fresh contacts (a
  // mailbox sync), then the customer created the day before.
  const fresh = senders(CUSTOMER_SCAN_LIMIT);
  const older = { id: 'p1', companyId: 'co-p', firstName: 'Prova verifica', lastName: '07/11 Calendario', email: null };
  const modules = boundedModules([...fresh, older], [{ id: 'co-p', name: 'Studio Prova' }]);
  const run = (request) => listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, request);
  const page = await run({ q: 'Prova', pageSize: '10' });
  assert.deepEqual(page.items.map((item) => item.name), ['Prova verifica 07/11 Calendario'], 'found beyond the bound');
  assert.equal(page.items[0].company?.name, 'Studio Prova', 'its company comes along');
  assert.equal(page.complete, false, 'the scan stays declared partial');
  const byCompany = await run({ q: 'studio prova', pageSize: '10' });
  assert.deepEqual(byCompany.items.map((item) => item.name), ['Prova verifica 07/11 Calendario'], 'the company name finds it too');
  const none = await run({ q: 'Inesistente', pageSize: '10' });
  assert.equal(none.items.length, 0);
  const unfiltered = await run({ pageSize: '10' });
  assert.ok(!unfiltered.items.some((item) => item.id === 'p1'), 'without text the bounded scan is unchanged');
});

test('d128847d21fc: the search scan has a fixed ceiling across contacts and companies', async () => {
  assert.equal(CUSTOMER_SEARCH_SCAN_LIMIT, 5000, 'the named ceiling');
  // The customer sits past the ceiling: the scan never reads the whole
  // table, so it is not found and the answer says the list is partial.
  const older = { id: 'p1', companyId: null, firstName: 'Prova verifica', lastName: '07/11', email: null };
  const reads = [];
  const modules = boundedModules([...senders(CUSTOMER_SEARCH_SCAN_LIMIT), older], [{ id: 'co1', name: 'Prova Srl' }], reads);
  const page = await listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, { q: 'Prova', pageSize: '10' });
  assert.ok(!page.items.some((item) => item.id === 'p1'), 'past the ceiling the customer is not read');
  assert.equal(page.complete, false, 'the answer stays partial');
  const scanned = reads.filter((entry) => entry.method === 'scan').reduce((sum, entry) => sum + entry.limit, 0);
  assert.ok(scanned <= CUSTOMER_SEARCH_SCAN_LIMIT, `the scan asked for ${scanned} rows, at most the ceiling`);
  assert.ok(!reads.some((entry) => entry.name === 'company' && entry.method === 'scan'),
    'a full contact scan leaves no company budget: the ceiling is shared');
});

test('d128847d21fc: the services clamp the search scan to their own ceiling, the list stays at 500', () => {
  const seen = [];
  const database = { storage: { sync: { execute() {}, many(statement) { seen.push(statement); return []; } } } };
  const contacts = new ContactService({ database, audit: null, events: null, companies: null });
  const companies = new CompanyService({ database, audit: null, events: null });
  contacts.scan({ limit: 1_000_000 });
  companies.scan({ limit: 1_000_000 });
  contacts.scan();
  contacts.list({ limit: 1_000_000 });
  assert.deepEqual(seen.map((statement) => [statement.table, statement.limit]), [
    ['contacts', 5000], ['companies', 5000], ['contacts', 5000], ['contacts', 500],
  ]);
  assert.ok(seen.every((statement) => statement.orderBy?.[0]?.column === 'created_at' && statement.orderBy[0].direction === 'desc'),
    'newest first, like the list');
});
