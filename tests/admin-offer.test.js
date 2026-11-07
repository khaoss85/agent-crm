import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfferDetail } from '../apps/admin/public/admin-offer.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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

function stubClient({ record: recordOverride, quotes = [], lines = [], versions = [], audit = [], failPatch = null, failAudit = null, failLinked = null } = {}) {
  const record = recordOverride ?? offerRecord();
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return SCHEMA;
      if (path.startsWith('/api/modules/opportunity/records/')) return { ...record };
      if (path === '/api/opportunities/off1' && options.method === 'PATCH') {
        if (failPatch) throw Object.assign(new Error(failPatch.message), failPatch);
        Object.assign(record, JSON.parse(options.body));
        return { ...record };
      }
      if (path.startsWith('/api/modules/quote/records')) {
        if (failLinked) throw Object.assign(new Error(failLinked.message), failLinked);
        return { items: quotes };
      }
      if (path.startsWith('/api/modules/quote-line/records')) return { items: lines };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: versions };
      if (path.startsWith('/api/audit')) {
        if (failAudit) throw Object.assign(new Error(failAudit.message), failAudit);
        return { items: audit };
      }
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

test('the detail shows who, stage, value and facts, quotes with lines, and history', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ quotes: [QUOTE], lines: [LINE], versions: [VERSION], audit: AUDIT });
  const view = createOfferDetail({ doc, mount, client });
  await view.renderOfferDetail('off1');

  const text = mount.textContent;
  assert.ok(text.includes('Offerta'), 'the kicker names the page');
  assert.ok(text.includes('Cucina per Giulia'), 'the deal name paints');
  assert.ok(text.includes('Per Giulia Verdi'), 'the customer paints');
  const fact = (label) => {
    const cell = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'offer-fact'
      && node.childNodes[0]?.textContent === label);
    return cell ? cell.childNodes[1].textContent : null;
  };
  assert.equal(fact('Referente'), 'maria', 'the referente fact paints');
  assert.equal(fact('Fase'), 'Scoperta', 'the stage label paints, not its key');
  const amount = mount.findAll('span').find((node) => (node.getAttribute('class') ?? '') === 'bo-offer-amount');
  assert.equal(amount?.textContent, '27.500 €', 'the value leads the page with the Italian thousands separator');
  assert.equal(fact('Chiusura prevista'), '20 nov 2026', 'the close date reads in Italian');
  assert.equal(fact('Creata da'), 'maria', 'who created the deal reads from its creation event');
  assert.equal(fact('Creata il'), '2 ott 2026', 'the creation day reads in Italian');
  assert.equal(fact('Ultima modifica'), '28 ott 2026', 'the update day reads in Italian');
  assert.ok(text.includes('chiusura prevista 20 nov 2026'), 'the close date sits under the value');
  // Quotes, lines, versions and history render from server state.
  assert.ok(text.includes('Preventivo'), 'the linked quotes paint');
  assert.ok(text.includes('Bozza') && text.includes('una tantum 5.000 €'), 'the quote state and total paint in Italian');
  assert.ok(text.includes('Approvazione automatica'), 'the version policy decision paints in Italian, not as a dash');
  const line = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'quote-line');
  assert.equal(line?.childNodes[0].textContent, 'Pacchetto 10 PT', 'the line names the package, never the SKU');
  assert.equal(line?.childNodes[1].textContent, 'Quantità 2 · sconto 5,00%', 'quantity and an Italian percentage');
  assert.equal(line?.childNodes[2].textContent, '12.000 €', 'the line amount uses Italian thousands');
  assert.ok(!text.includes('PT10'), 'no SKU on screen');
  assert.ok(text.includes('Cronologia'), 'the history paints');
  assert.ok(text.includes('Creata'), 'the creation event paints in Italian');
  assert.ok(text.includes('Cambio di fase'), 'the stage event paints in Italian');
  // A UUID actor is a technical id, never a name; a named actor paints.
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), 'no UUID in visible text');
  assert.ok(text.includes('utente'), 'the UUID actor degrades to a generic word');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no raw ISO timestamp');
  assert.ok(!/\b[A-Z]{3,}_[A-Z_]+\b/.test(text), 'no technical code');
  // The quote opens in the quote page, never inline.
  const link = mount.findAll('a').find((node) => node.getAttribute('href') === '#/quotes/q1');
  assert.ok(link, 'the quote links to its page');
  assert.equal(link.textContent, 'Apri il preventivo', 'the link says where it goes');
  // Linked collections are narrowed server-side, never a filtered global page.
  const paths = client.calls.map((call) => call.path);
  assert.ok(paths.some((path) => path.includes('/api/modules/quote/records') && path.includes('filter.opportunityId=off1')),
    'quotes are read with the server-side opportunity filter');
  assert.ok(paths.some((path) => path.includes('/api/modules/quote-line/records') && path.includes('filter.quoteId=q1')),
    'lines are read with the server-side quote filter');
  assert.ok(paths.some((path) => path.includes('/api/modules/quote-version/records') && path.includes('filter.quoteId=q1')),
    'versions are read with the server-side quote filter');
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

test('a subscription-only quote never paints a zero one-time total', async () => {
  const recurringOnly = {
    ...QUOTE,
    id: 'q2',
    totalsJson: JSON.stringify({
      oneTimeTotal: { currency: 'EUR', listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
      recurringTotals: [
        { currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 320000, discountAmountCents: 0, netAmountCents: 320000 },
      ],
    }),
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [recurringOnly], audit: [] }) });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(text.includes('3.200 € ogni 1 mese'), 'the recurring group paints with its own period');
  assert.ok(!text.includes('una tantum'), 'no zero one-time group paints beside it');
  const header = mount.findAll('h4').map((node) => node.textContent).join('\n');
  assert.equal(header, '3.200 € ogni 1 mese', 'the header is the recurring group alone');
});

test('an unreadable audit trail is not an empty one', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const view = createOfferDetail({
      doc,
      mount,
      client: stubClient({ quotes: [], audit: [], failAudit: { message: 'boom', code: 'AUDIT_READ_FAILED' } }),
    });
    await view.renderOfferDetail('off1');
  } finally {
    console.error = originalError;
  }
  const text = mount.textContent;
  assert.ok(text.includes('Cronologia non leggibile. Riprova più tardi.'), 'the failure gets its own line');
  assert.ok(!text.includes('Ancora nessun evento registrato'), 'the empty-trail line stays out');
  assert.ok(logged.length > 0, 'the cause is logged for diagnosis');
});

test('technical actor handles never paint, even off the UUID shape', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const audit = [
    { action: 'opportunity.created', actorId: 'admin-ui', actorType: 'user', createdAt: '2026-10-02T09:15:00.000Z' },
    { action: 'opportunity.updated', actorId: 'stranger-handle', actorType: 'user', createdAt: '2026-10-28T18:40:00.000Z' },
  ];
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [], audit }) });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(!text.includes('admin-ui'), 'the service handle never paints');
  assert.ok(!text.includes('stranger-handle'), 'an uncorroborated handle never paints');
  assert.ok(text.includes('Creata · da utente'), 'the author degrades to a generic word');
});

test('a full linked page says it shows only the first rows', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const full = { items: new Array(200).fill(null).map((_, index) => ({ id: `q${index}` })) };
  const client = {
    calls: [],
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      this.calls.push(path);
      if (path === '/api/schema') return SCHEMA;
      if (path.startsWith('/api/modules/opportunity/records/')) return { ...offerRecord() };
      if (path.startsWith('/api/modules/quote/records')) return full;
      if (path.startsWith('/api/modules/quote-line/records')) return { items: [] };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      return { items: [] };
    },
  };
  const view = createOfferDetail({ doc, mount, client });
  await view.renderOfferDetail('off1');
  assert.ok(mount.textContent.includes('Mostro solo i primi 200 preventivi.'), 'the truncation notice paints');
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

// Production 03/11: the shared space answered the record read 404 for a card
// the Pipeline board had just painted; the detail said «Offerta non trovata».
// The board's own list is the fallback, so the detail opens the same offer.
test('a record read 404 falls back to the board list and the detail opens', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const base = stubClient();
  const client = {
    calls: base.calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/modules/opportunity/records/')) {
        throw Object.assign(new Error('not found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (path.startsWith('/api/opportunities?')) return { items: [offerRecord()] };
      return base.request(path, options);
    },
  };
  const view = createOfferDetail({ doc, mount, client });
  await view.renderOfferDetail('off1');
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the offer from the board list paints');
  assert.ok(!mount.textContent.includes('Offerta non trovata'), 'never the not-found line for a card the board showed');
});

test('an offer missing from the board list too still says not found', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { modules: [] };
      if (path.startsWith('/api/modules/opportunity/records/')) {
        throw Object.assign(new Error('not found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (path.startsWith('/api/opportunities?')) return { items: [] };
      return { items: [] };
    },
  };
  const view = createOfferDetail({ doc, mount, client });
  await view.renderOfferDetail('assente');
  assert.ok(mount.textContent.includes('non trovata'), 'a truly missing offer says so');
});
