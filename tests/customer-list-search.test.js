import test from 'node:test';
import assert from 'node:assert/strict';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import {
  CUSTOMER_SCAN_LIMIT,
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

test('d128847d21fc: accents never matter', () => {
  const rows = [row('Josè', 'Niccolò')];
  assert.deepEqual(hits(rows, 'jose'), ['Josè Niccolò']);
  assert.deepEqual(hits(rows, 'NICCOLO'), ['Josè Niccolò']);
  assert.deepEqual(hits(rows, 'josé'), ['Josè Niccolò']);
});

/** Contact and company services that honour the scan bound like the core: newest first, at most `limit`. */
function boundedModules(contacts, companies) {
  const service = (rows) => ({
    list: async ({ limit = 100 } = {}) => rows.slice(0, Math.min(limit, 500)),
    listWhere: async (filters = {}) => rows.filter((entry) => Object.entries(filters).every(([key, value]) => entry[key] === value)),
  });
  const map = new Map([
    ['contact', { service: service(contacts) }],
    ['company', { service: service(companies) }],
  ]);
  return {
    get: (name) => {
      const entry = map.get(name);
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
}

test('d128847d21fc: a customer older than the scan bound is still found by name', async () => {
  // Newest first, like the core list: a whole bound of fresh contacts (a
  // mailbox sync), then the customer created the day before.
  const fresh = Array.from({ length: CUSTOMER_SCAN_LIMIT }, (_, index) => ({
    id: `g${index}`, companyId: null, firstName: `Mittente${index}`, lastName: 'Posta', email: `m${index}@example.test`,
  }));
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
