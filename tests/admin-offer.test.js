import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce ef92f728: the deal page behind the pipeline card's Apri button.
 * These tests drive it against a stub client so the seven facts, the linked
 * quotes with their lines, the history, the Italian screen form and the
 * Modifica PATCH flow are asserted precisely.
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
};

function offerRecord(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function stubClient({ record: recordOverride, quotes = [], lines = [], versions = [], audit = [], failPatch = null } = {}) {
  const record = recordOverride ?? offerRecord();
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return SCHEMA;
      if (path.startsWith('/api/modules/opportunity/records/')) return { ...record };
      if (path === '/api/opportunities/off1' && options.method === 'PATCH') {
        if (failPatch) throw Object.assign(new Error(failPatch.message), failPatch);
        Object.assign(record, JSON.parse(options.body));
        return { ...record };
      }
      if (path.startsWith('/api/modules/quote/records')) return { items: quotes };
      if (path.startsWith('/api/modules/quote-line/records')) return { items: lines };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: versions };
      if (path.startsWith('/api/audit')) return { items: audit };
      return { items: [] };
    },
  };
}

const QUOTE = {
  id: 'q1',
  opportunityId: 'off1',
  priceBookId: 'pb1',
  currency: 'EUR',
  status: 'draft',
  totalsJson: JSON.stringify({
    oneTimeTotal: { currency: 'EUR', listAmountCents: 500000, discountAmountCents: 0, netAmountCents: 500000 },
    recurringTotals: [],
  }),
};

const LINE = {
  id: 'l1',
  quoteId: 'q1',
  sku: 'PT10',
  offerName: 'Pacchetto 10 PT',
  quantity: 2,
  discountBps: 500,
  netAmountCents: 1200000,
  removed: false,
  position: 1,
};

const VERSION = {
  id: 'v1',
  quoteId: 'q1',
  versionNumber: 1,
  policyDecision: 'auto_approve',
  totalsJson: QUOTE.totalsJson,
  currency: 'EUR',
};

const AUDIT = [
  { action: 'opportunity.created', actorId: 'maria', actorType: 'user', createdAt: '2026-10-02T09:15:00.000Z' },
  { action: 'opportunity.stage_changed', actorId: '00000000-0000-4000-8000-000000000000', actorType: 'user', createdAt: '2026-10-28T18:40:00.000Z' },
];

test('the detail shows the seven facts, quotes with lines, and history', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [QUOTE], lines: [LINE], versions: [VERSION], audit: AUDIT }) });
  await view.renderOfferDetail('off1');

  const text = mount.textContent;
  assert.ok(text.includes('Offerta'), 'the kicker names the page');
  assert.ok(text.includes('Cucina per Giulia'), 'the deal name paints');
  assert.ok(text.includes('Giulia Verdi'), 'the customer paints');
  assert.ok(text.includes('Referente:'), 'the referente fact paints');
  assert.ok(text.includes('maria'), 'the referente value paints');
  assert.ok(text.includes('Fase:'), 'the stage fact paints');
  assert.ok(text.includes('Scoperta'), 'the stage label paints, not its key');
  assert.ok(text.includes('Valore:'), 'the value fact paints');
  assert.ok(text.includes('27.500 €'), 'the value uses the Italian thousands separator');
  assert.ok(text.includes('Chiusura prevista:'), 'the expected close paints');
  assert.ok(text.includes('2026-11-20'), 'the close date paints as a day');
  assert.ok(text.includes('Creata il:'), 'the creation date paints');
  assert.ok(text.includes('2026-10-02'), 'the creation day paints');
  assert.ok(text.includes('Ultima modifica:'), 'the update date paints');
  assert.ok(text.includes('2026-10-28'), 'the update day paints');
  assert.ok(text.includes('Creata da:'), 'the author fact paints');
  // Quotes, lines, versions and history render from server state.
  assert.ok(text.includes('Preventivi (1)'), 'the linked quotes paint');
  assert.ok(text.includes('Preventivo · Bozza · 5.000 €'), 'the quote state and total paint in Italian');
  assert.ok(text.includes('Righe (1)'), 'the quote lines paint');
  assert.ok(text.includes('PT10 · Pacchetto 10 PT · quantità 2 · sconto 5,00% · netto 12.000 €'),
    'the line paints with an Italian percentage and thousands');
  assert.ok(text.includes('Versioni (1)'), 'the quote versions paint');
  assert.ok(text.includes('Cronologia (2)'), 'the history paints');
  assert.ok(text.includes('Creata'), 'the creation event paints in Italian');
  assert.ok(text.includes('Cambio di fase'), 'the stage event paints in Italian');
  // A UUID actor is a technical id, never a name; a named actor paints.
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), 'no UUID in visible text');
  assert.ok(text.includes('utente'), 'the UUID actor degrades to a generic word');
  // The quote opens in the quote page, never inline.
  const link = mount.findAll('a').find((node) => node.getAttribute('href') === '#/quotes/q1');
  assert.ok(link, 'the quote links to its page');
  assert.equal(link.textContent, 'Apri il preventivo', 'the link says where it goes');
});

test('the detail degrades honestly when the server is unreadable', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [], audit: [] }) });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(text.includes('Ancora nessun preventivo per questa offerta.'), 'empty quotes stay honest');
  assert.ok(text.includes('Ancora nessun evento registrato per questa offerta.'), 'empty history stays honest');
});

test('Modifica prefills from the record and Salva PATCHes the three facts', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ quotes: [], audit: [] });
  const view = createOfferDetail({ doc, mount, client });
  await view.renderOfferDetail('off1');

  const wrap = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  wrap.__edit();
  const form = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  assert.equal(form.__editInputs.value.value, '27500.00', 'the valore prefills in euro');
  assert.equal(form.__editInputs.expiry.value, '2026-11-20', 'the chiusura prefills as a day');
  assert.equal(form.__editInputs.owner.value, 'maria', 'the referente prefills');
  form.__editInputs.value.value = '300.50';
  form.__editInputs.expiry.value = '2026-12-01';
  form.__editInputs.owner.value = 'guido';
  await form.__save({ preventDefault() {} });

  const patches = client.calls.filter((call) => call.method === 'PATCH');
  assert.equal(patches.length, 1, 'one PATCH on Salva');
  assert.equal(patches[0].path, '/api/opportunities/off1');
  assert.deepEqual(
    JSON.parse(patches[0].body),
    { valueCents: 30050, expectedCloseDate: '2026-12-01', owner: 'guido' },
    'euro text becomes integer cents; the date and referente travel verbatim',
  );
  assert.ok(mount.textContent.includes('guido'), 'the re-rendered detail shows the saved referente');
});

test('the edit validates before writing and keeps the form on a refused save', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ quotes: [], audit: [], failPatch: { message: 'boom', status: 500 } });
  const view = createOfferDetail({ doc, mount, client });
  await view.renderOfferDetail('off1');

  const wrap = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  wrap.__edit();
  const form = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  form.__editInputs.value.value = 'not-a-number';
  form.__editInputs.owner.value = '';
  await form.__save({ preventDefault() {} });
  assert.equal(client.calls.filter((call) => call.method === 'PATCH').length, 0, 'no PATCH on invalid input');
  assert.ok(form.__editError.textContent.includes('euro'), 'the euro rule is explained in Italian');

  form.__editInputs.value.value = '200.00';
  form.__editInputs.owner.value = 'guido';
  await form.__save({ preventDefault() {} });
  assert.equal(client.calls.filter((call) => call.method === 'PATCH').length, 1, 'the valid retry PATCHes');
  const still = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  assert.ok(still.__editInputs, 'the form stays open after a refused save');
  assert.ok(still.__editError.textContent.includes('Riprova più tardi'), 'the failure stays friendly');

  still.__cancelEdit();
  assert.equal(client.calls.filter((call) => call.method === 'PATCH').length, 1, 'Annulla writes nothing');
  assert.ok(mount.textContent.includes('maria'), 'the detail still shows the stored referente');
});

test('offer routes parse canonically; hostile routes are invalid', async () => {
  assert.deepEqual(parseModuleRoute('#/offerte/off1'), { view: 'offer-detail', offerId: 'off1' });
  for (const bad of ['#/offerte/', '#/offerte//off1', '#/offerte/a/b', '#/offerte/a%2Fb', '#/offerte/%zz']) {
    assert.equal(parseModuleRoute(bad).view, 'invalid', `expected invalid for ${bad}`);
  }
});
