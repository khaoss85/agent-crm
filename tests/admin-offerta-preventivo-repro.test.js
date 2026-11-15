import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:a2ea75f705fd — repro for the VERIFIER_BACK verdict of 2026-11-13
 * (returns:1, OBSERVATION_FAILED): the offer page did two
 * `GET /api/modules/opportunity/records/<id>` reads that answer 404, the
 * quote screen read the same generic surface on its way back, «Crea
 * preventivo» stayed the main action with a quote already there,
 * `#/offerte/<quote id>` said «Offerta non trovata», and the quote
 * discount read «punti base». (The scheda offer card pointing at the offer
 * page is locked by the admin-customer-card tests updated in the same cure.)
 *
 * Every test below is RED on the code before the cure (the pilot-shaped
 * stub 404s the generic opportunity surface, like production) and GREEN
 * after it: 4/4 fail on 0afa74b6^, 4/4 pass with the cure. The cure itself
 * shipped with #832; this file is its observable proof and regression lock.
 */

const SCHEMA = {
  pipelines: [{
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'discovery',
    stages: [
      { key: 'discovery', label: 'Scoperta', order: 10, type: 'open', probability: 10 },
      { key: 'won', label: 'Vinta', order: 50, type: 'won', probability: 100 },
    ],
  }],
  commercial: {},
};

const OFFER = {
  id: 'off1',
  name: 'Cucina per Giulia',
  contactName: 'Giulia Verdi',
  companyName: null,
  pipelineKey: 'b2b-sales',
  pipelineStage: 'discovery',
  valueCents: 2750000,
  currency: 'EUR',
  expectedCloseDate: '2026-11-20',
  createdAt: '2026-10-02T09:15:00.000Z',
  updatedAt: '2026-10-28T18:40:00.000Z',
  owner: 'maria',
};

const flushAll = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * The pilot shape: the generic records surface never serves the core
 * offer (404, twice per page before the cure); only `/api/opportunities`
 * answers, and single quote reads answer on their own surface.
 */
function pilotClient({ quotes = [], quoteById = {}, books = [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }] } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      calls.push({ path, method, body: options.body ?? null });
      if (path === '/api/schema') return SCHEMA;
      if (path.startsWith('/api/modules/opportunity/records/') && !path.includes('/actions/')) {
        throw Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && method === 'GET') {
        if (path.endsWith('/off1')) return { ...OFFER };
        throw Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (path.startsWith('/api/opportunities?')) return { items: [{ ...OFFER }] };
      const quoteMatch = path.match(/^\/api\/modules\/quote\/records\/([^/?]+)$/);
      if (quoteMatch && quoteById[quoteMatch[1]]) return { ...quoteById[quoteMatch[1]] };
      if (path.startsWith('/api/modules/quote/records')) {
        return { items: quotes.filter((row) => path.includes(`filter.opportunityId=${row.opportunityId}`) || !path.includes('filter.')) };
      }
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      if (path.startsWith('/api/modules/price-book/records')) return { items: books };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
}

const QUOTE = (overrides = {}) => ({
  id: 'q1',
  opportunityId: 'off1',
  priceBookId: 'pb1',
  currency: 'EUR',
  status: 'draft',
  draftRevision: 3,
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
  ...overrides,
});

test('a2ea75f705fd repro: the offer page reads the offer on its own route — no generic read that 404s', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = pilotClient({ quotes: [QUOTE()] });
  await createOfferDetail({ doc, mount, client }).renderOfferDetail('off1');
  await flushAll();
  const gets = client.calls.filter((call) => call.method === 'GET').map((call) => call.path);
  assert.ok(gets.includes('/api/opportunities/off1'), 'the core offer route is read');
  assert.ok(
    !gets.some((path) => path.startsWith('/api/modules/opportunity/records/') && !path.includes('/actions/')),
    'never the generic records surface that answered 404 in the pilot',
  );
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the offer renders instead of «Offerta non trovata»');
  assert.ok(!mount.textContent.includes('non trovata'), 'no not-found line');
});

test('a2ea75f705fd repro: #/offerte/<quote id> opens the quote\u2019s offer', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = pilotClient({ quotes: [QUOTE({ id: 'q9' })], quoteById: { q9: QUOTE({ id: 'q9' }) } });
  await createOfferDetail({ doc, mount, client }).renderOfferDetail('q9');
  await flushAll();
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'a link naming the quote still opens its offer');
  assert.ok(!mount.textContent.includes('non trovata'), 'never «Offerta non trovata»');
});

test('a2ea75f705fd repro: with a quote already there, the main action opens it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = pilotClient({
    quotes: [QUOTE({ id: 'q-old', createdAt: '2026-11-01T00:00:00Z' }), QUOTE({ id: 'q-new', createdAt: '2026-11-10T00:00:00Z' })],
  });
  await createOfferDetail({ doc, mount, client }).renderOfferDetail('off1');
  await flushAll();
  const open = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-open-quote');
  assert.ok(open, 'the open action is there');
  assert.equal(open.getAttribute('href'), '#/quotes/q-new', 'it opens the newest quote');
  assert.match(String(open.getAttribute('class') ?? ''), /primary/, 'opening is the main action');
  const create = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'offer-create-quote');
  assert.ok(create, 'a new quote stays possible');
  assert.equal(create.textContent, 'Nuovo preventivo', 'creating another is the quiet second choice');
  assert.doesNotMatch(String(create.getAttribute('class') ?? ''), /primary/, 'never two primary actions');
});

const QUOTE_SCHEMA = {
  commercial: {
    commercialContract: 1,
    pricingContract: 1,
    chargeTypes: ['one_time', 'recurring'],
    pricingModels: ['flat_fee', 'per_unit', 'volume', 'graduated'],
    discountPolicies: [{ name: 'standard-sales-discount', version: 1, label: 'Standard', fingerprint: 'f'.repeat(64) }],
  },
};

const REPRO_LINE = {
  id: 'l1',
  quoteId: 'q1',
  offerId: 'o1',
  offerName: 'Pacchetto 10 PT',
  quantity: 2,
  discountBps: 500,
  discountAmountCents: 41000,
  netAmountCents: 459000,
  removed: false,
  position: 1,
};

const REPRO_ENTRY = {
  id: 'o1',
  priceBookId: 'pb1',
  logicalKey: 'fixture:offer:base',
  name: 'Pacchetto 10 PT',
  currency: 'EUR',
  componentCount: 1,
  active: true,
  quoteEligible: true,
};

function quoteClient() {
  const record = QUOTE();
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body ?? null });
      if (path === '/api/schema') return QUOTE_SCHEMA;
      if (options.method === 'POST') return { ok: true, result: { quote: record } };
      if (path.startsWith('/api/modules/opportunity/records/')) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (path.startsWith('/api/modules/quote/records/')) return { ...record };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [REPRO_LINE] };
      if (path.startsWith('/api/modules/offer/records')) return { items: [REPRO_ENTRY] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote/records')) return { items: [record] };
      if (path.startsWith('/api/modules/price-book/records')) return { items: [{ id: 'pb1', name: 'Standard EUR', currency: 'EUR', active: true }] };
      return { items: [] };
    },
  };
}

test('a2ea75f705fd repro AC-4: the discount reads in percent and euro, never «punti base»; garbage sends nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = quoteClient();
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  const text = mount.textContent;
  assert.ok(!/punti base/i.test(text), 'never «punti base» anywhere');
  assert.ok(text.includes('Sconto (%)'), 'the fields say percent');
  assert.ok(text.includes('sconto 5,00%'), 'the line reads the discount in percent');
  assert.ok(text.includes('410 €'), 'the line reads the discount in euro too');
  const row = mount.findAll('div').find((node) => node.getAttribute('data-line') === 'l1');
  const field = row.__discount ?? row.__discountBps;
  assert.equal(field.value, '5', 'the line field shows its percent, not basis points');

  const addPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-add-line');
  const addField = addPanel.__discount ?? addPanel.__discountBps;
  addField.value = 'tanto';
  await addPanel.__add();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'a malformed discount sends nothing');
  const error = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error');
  assert.match(String(error?.textContent ?? ''), /percentuale/, 'the refusal says percent');
});
