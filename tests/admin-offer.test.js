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
      // backlog:a2ea75f705fd: like the pilot, the generic records surface
      // never serves the core offer — only its own route answers.
      if (path.startsWith('/api/modules/opportunity/records/') && !path.includes('/actions/')) throw Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' });
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && String(options.method ?? 'GET').toUpperCase() === 'GET') return { ...record };
      if (path === '/api/opportunities/off1' && options.method === 'PATCH') {
        if (failPatch) throw Object.assign(new Error(failPatch.message), failPatch);
        Object.assign(record, JSON.parse(options.body));
        return { ...record };
      }
      if (path.startsWith('/api/modules/quote/records')) {
        if (failLinked) throw Object.assign(new Error(failLinked.message), failLinked);
        return { items: applyModuleFilter(quotes, path) };
      }
      if (path.startsWith('/api/modules/quote-line/records')) return { items: applyModuleFilter(lines, path) };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: applyModuleFilter(versions, path) };
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
  policy: 'standard',
  policyVersion: 3,
  policyDecision: 'auto_approve',
  totalsJson: QUOTE.totalsJson,
  currency: 'EUR',
};

/** Full-module rows the stub narrows by the filter.* query, like the server. */
function applyModuleFilter(rows, path) {
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  return rows.filter((row) => {
    for (const [key, value] of params) {
      if (!key.startsWith('filter.')) continue;
      if (String(row?.[key.slice('filter.'.length)] ?? '') !== value) return false;
    }
    return true;
  });
}

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
  assert.equal(fact('Referente'), 'Maria', 'the referente fact paints');
  assert.equal(fact('Stato'), 'Scoperta', 'the stage label paints, not its key');
  const amount = mount.findAll('span').find((node) => (node.getAttribute('class') ?? '') === 'bo-offer-amount');
  assert.equal(amount?.textContent, '27.500 €', 'the value leads the page with the Italian thousands separator');
  assert.equal(fact('Chiusura prevista'), '20 nov 2026', 'the close date reads in Italian');
  assert.equal(fact('Creata da'), 'Maria', 'who created the deal reads from its creation event');
  assert.equal(fact('Creata il'), '2 ott 2026', 'the creation day reads in Italian');
  assert.equal(fact('Ultima modifica'), '28 ott 2026', 'the update day reads in Italian');
  assert.ok(text.includes('chiusura prevista 20 nov 2026'), 'the close date sits under the value');
  // Quotes, lines, versions and history render from server state.
  assert.ok(text.includes('Preventivo'), 'the linked quotes paint');
  assert.ok(text.includes('Bozza') && text.includes('una tantum 5.000 €'), 'the quote state and total paint in Italian');
  assert.ok(text.includes('Approvazione automatica'), 'the version policy decision paints in Italian, not as a dash');
  assert.ok(text.includes('standard@3'), 'the version names the policy that decided it');
  const line = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'quote-line');
  assert.equal(line?.childNodes[0].textContent, 'Pacchetto 10 PT', 'the line names the package, never the SKU');
  assert.equal(line?.childNodes[1].textContent, 'Quantità 2 · sconto 5,00%', 'quantity and an Italian percentage');
  assert.equal(line?.childNodes[2].textContent, '12.000 €', 'the line amount uses Italian thousands');
  assert.ok(!text.includes('PT10'), 'no SKU on screen');
  assert.ok(text.includes('Cronologia'), 'the history paints');
  assert.ok(text.includes('Creata'), 'the creation event paints in Italian');
  assert.ok(text.includes('Cambio di stato'), 'the stage event paints in Italian');
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

test('the version row names the deciding policy and honors valued groups', async () => {
  const recurringVersion = {
    ...VERSION,
    id: 'v2',
    versionNumber: 2,
    totalsJson: JSON.stringify({
      oneTimeTotal: { currency: 'EUR', listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
      recurringTotals: [
        { currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 320000, discountAmountCents: 0, netAmountCents: 320000 },
      ],
    }),
  };
  const emptyVersion = {
    ...VERSION,
    id: 'v3',
    versionNumber: 3,
    totalsJson: JSON.stringify({
      oneTimeTotal: { currency: 'EUR', listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
      recurringTotals: [],
    }),
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({
    doc,
    mount,
    client: stubClient({ quotes: [QUOTE], audit: [], versions: [VERSION, recurringVersion, emptyVersion] }),
  });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(text.includes('standard@3'), 'the deciding policy paints as name@version');
  assert.ok(text.includes('3.200 € ogni 1 mese'), 'a recurring version keeps its period');
  assert.ok(text.includes('Versione 3 · Approvazione automatica · standard@3 · —'), 'a version with no value paints a dash like the header');
  assert.ok(!text.includes('una tantum 0'), 'no zero one-time total beside a valued group');
});

test('another parent\u2019s rows never paint: the server-side filter is honored', async () => {
  const decoyQuote = {
    ...QUOTE,
    id: 'qX',
    opportunityId: 'offX',
    totalsJson: JSON.stringify({
      oneTimeTotal: { currency: 'EUR', listAmountCents: 9900000, discountAmountCents: 0, netAmountCents: 9900000 },
      recurringTotals: [],
    }),
  };
  const decoyLine = { ...LINE, id: 'lX', quoteId: 'qX', offerName: 'ESCA MAIUSCOLA' };
  const decoyVersion = { ...VERSION, id: 'vX', quoteId: 'qX', versionNumber: 99 };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({
    doc,
    mount,
    client: stubClient({ quotes: [QUOTE, decoyQuote], lines: [LINE, decoyLine], versions: [VERSION, decoyVersion], audit: [] }),
  });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(!text.includes('99.000 €'), 'the other deal\u2019s quote never paints');
  assert.ok(!text.includes('ESCA MAIUSCOLA'), 'the other quote\u2019s lines never paint');
  assert.ok(!text.includes('Versione 99'), 'the other quote\u2019s versions never paint');
});

test('a full audit page says it is truncated and hides the author', async () => {
  const audit = new Array(100).fill(null).map((_, index) => ({
    action: 'opportunity.updated',
    actorId: 'maria',
    actorType: 'user',
    createdAt: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T09:15:00.000Z`,
  }));
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [], audit }) });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(text.includes('Mostro solo gli ultimi 100 eventi.'), 'the truncation is disclosed');
  const fact = (label) => {
    const cell = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'offer-fact'
      && node.childNodes[0]?.textContent === label);
    return cell ? cell.childNodes[1].textContent : null;
  };
  assert.equal(fact('Creata da'), '—', 'no author is read from a partial page');
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
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && String(options.method ?? 'GET').toUpperCase() === 'GET') return { ...offerRecord() };
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
  assert.equal(form.__editInputs.value.value, '27.500,00', 'the valore prefills in euro, in the Italian form');
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
  assert.ok(mount.textContent.includes('Guido'), 'the re-rendered detail shows the saved referente');
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
  assert.ok(mount.textContent.includes('Maria'), 'the detail still shows the stored referente');
});

test('offer routes parse canonically; hostile routes are invalid', async () => {
  assert.deepEqual(parseModuleRoute('#/offerte/off1'), { view: 'offer-detail', offerId: 'off1' });
  // backlog:96c7b56001ba: opened from a scheda, the route names it.
  assert.deepEqual(parseModuleRoute('#/offerte/off1/cliente/contact/c1'),
    { view: 'offer-detail', offerId: 'off1', from: { resource: 'contact', subjectId: 'c1' } });
  for (const bad of ['#/offerte/', '#/offerte//off1', '#/offerte/a/b', '#/offerte/a%2Fb', '#/offerte/%zz',
    '#/offerte/a/cliente/contact', '#/offerte/a/altro/contact/c1', '#/offerte/a/cliente/Contact/c1',
    '#/offerte/a/cliente/contact/c%2F1', '#/offerte/a/cliente/contact/c1/x']) {
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
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && String(options.method ?? 'GET').toUpperCase() === 'GET') {
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
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && String(options.method ?? 'GET').toUpperCase() === 'GET') {
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

test('c1649d1d: the history names who moved the offer from which stage to which', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const audit = [
    {
      action: 'opportunity.updated', actorId: 'maria', actorType: 'user', createdAt: '2026-10-29T10:00:00.000Z',
      data: { pipelineKey: 'b2b-sales', pipelineStage: 'won', fromPipelineStage: 'discovery' },
    },
    {
      action: 'opportunity.stage_changed', actorId: 'maria', actorType: 'user', createdAt: '2026-10-29T11:00:00.000Z',
      data: { from: 'qualification', to: 'proposal' },
    },
    {
      action: 'opportunity.updated', actorId: 'maria', actorType: 'user', createdAt: '2026-10-29T12:00:00.000Z',
      data: { pipelineKey: 'b2b-sales', pipelineStage: 'fantasma', fromPipelineStage: 'spettro' },
    },
  ];
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [], audit }) });
  await view.renderOfferDetail('off1');
  const text = mount.textContent;
  assert.ok(text.includes('Cambio di stato · da Scoperta a Vinta · da Maria'),
    'a pipeline move reads who, from which stage to which, and the actor the record corroborates');
  assert.ok(text.includes('Cambio di stato · da Qualificazione a Proposta · da Maria'),
    'a core move reads its from/to in Italian too, with the same word as a pipeline move');
  assert.ok(text.includes('Offerta aggiornata · da Maria'), 'an unlabeled move keeps the generic line');
  assert.ok(!text.includes('fantasma') && !text.includes('spettro'),
    'a side without a label never paints a raw key');
  assert.ok(!/\b[A-Z]{3,}_[A-Z_]+\b/.test(text), 'no technical code');
});

// Backlog 169cd4bc988c (giro UX 11/11, punti 23-24): the offer page is never
// a dead end — back to the Pipeline, the customer opens the scheda, the
// stato changes with the board's own writes, a quote can be created and the
// referente comes from the team.

const flushAll = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const LOST_SCHEMA = {
  ...SCHEMA,
  commercial: {},
  pipelines: [{
    ...SCHEMA.pipelines[0],
    stages: [
      ...SCHEMA.pipelines[0].stages,
      { key: 'proposal', label: 'Proposta', order: 20, type: 'open', probability: 40 },
      { key: 'lost', label: 'Perso', order: 60, type: 'lost', probability: 0 },
    ],
  }],
};

const ROSTER = [
  { subject: 'maria', displayName: 'Maria Rossi', email: 'maria@example.it' },
  { subject: 'google|123', displayName: 'Guido Presti', email: 'guido@example.it' },
];

function pageClient({ record: overrides = {}, schema = LOST_SCHEMA, books = [{ id: 'pb1', name: 'Listino', currency: 'EUR', active: true }], move = null, createQuote = null, roster = ROSTER } = {}) {
  const record = offerRecord({ contactId: 'c1', companyId: 'co1', ...overrides });
  const calls = [];
  return {
    calls,
    record,
    writes: () => calls.filter((call) => call.method !== 'GET'),
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      calls.push({ path, method, body: options.body ? JSON.parse(options.body) : null, key: options.idempotencyKey ?? null });
      if (path === '/api/schema') return schema;
      if (path.endsWith('/actions/move-stage') || /\/api\/opportunities\/[^/]+\/stage$/.test(path)) {
        if (move) return move(calls.filter((call) => call.path === path).length, JSON.parse(options.body));
        const body = JSON.parse(options.body);
        if (body.toStage) record.pipelineStage = body.toStage;
        if (body.targetStage) record.stage = body.targetStage;
        return { ok: true };
      }
      if (path.endsWith('/actions/create-quote')) {
        if (createQuote) return createQuote(calls.filter((call) => call.path === path).length);
        return { ok: true, result: { quote: { id: 'q9' } } };
      }
      // backlog:a2ea75f705fd: like the pilot, the generic records surface
      // never serves the core offer — only its own route answers.
      if (path.startsWith('/api/modules/opportunity/records/') && !path.includes('/actions/')) throw Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' });
      if (/^\/api\/opportunities\/[^/?]+$/.test(path) && String(options.method ?? 'GET').toUpperCase() === 'GET') return { ...record };
      if (path.startsWith('/api/modules/price-book/records')) {
        if (books instanceof Error) throw books;
        return { items: books };
      }
      if (path === '/api/spine/memberships') return { items: roster };
      if (path === '/api/opportunities/off1' && method === 'PATCH') {
        Object.assign(record, JSON.parse(options.body));
        return { ...record };
      }
      return { items: [] };
    },
  };
}

async function openPage(options = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = pageClient(options);
  const toasts = [];
  const went = [];
  const view = createOfferDetail({
    doc, mount, client,
    toast: (text, error = false) => toasts.push({ text, error }),
    navigate: (hash) => went.push(hash),
  });
  await view.renderOfferDetail('off1');
  await flushAll();
  return { doc, mount, client, toasts, went, view };
}

const button = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
const stageVoice = (mount, key) => mount.findAll('button').find((node) => node.getAttribute('data-stage') === key);
const voicesMenu = (mount) => mount.findAll('div').find((node) => String(node.getAttribute('class') ?? '').startsWith('bo-offer-stage-voices'));
const menuOpen = (mount) => !String(voicesMenu(mount).getAttribute('class')).split(/\s+/).includes('hidden');

test('169cd4bc988c: «← Pipeline» goes back to the board the offer sits on', async () => {
  const { mount } = await openPage();
  const back = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-back');
  assert.ok(back, 'the way back is there');
  assert.equal(back.textContent, '← Pipeline');
  assert.equal(back.getAttribute('href'), '#/pipelines/b2b-sales');
  assert.equal(parseModuleRoute(back.getAttribute('href')).view, 'pipeline', 'the link is a real route');
  const off = await openPage({ record: { pipelineKey: null, pipelineStage: null, stage: 'proposal' } });
  const offBack = off.mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-back');
  assert.equal(offBack.getAttribute('href'), '#/pipeline', 'an offer outside any board goes to the first board');
  assert.equal(parseModuleRoute('#/pipeline').view, 'pipeline');
});

test('169cd4bc988c: the customer is a link to the scheda; «Senza azienda» is nobody', async () => {
  const { mount } = await openPage();
  const link = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'bo-offer-customer');
  assert.equal(link?.textContent, 'Giulia Verdi');
  assert.equal(link.getAttribute('href'), '#/customer-card/contact/c1');
  assert.ok(mount.textContent.includes('Per Giulia Verdi'));
  const company = await openPage({ record: { contactName: null, contactId: null, companyName: 'Palestra Sole' } });
  const companyLink = company.mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'bo-offer-customer');
  assert.equal(companyLink.getAttribute('href'), '#/customer-card/company/co1', 'without a contact the company scheda opens');
  const nobody = await openPage({ record: { contactName: null, contactId: null, companyName: 'Senza azienda' } });
  assert.ok(!nobody.mount.textContent.includes('Senza azienda'), 'never «Per Senza azienda»');
  assert.equal(nobody.mount.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'bo-offer-customer').length, 0);
});

test('169cd4bc988c: Cambia stato moves a placed offer with the board’s move-stage and re-reads the page', async () => {
  const { mount, client, toasts } = await openPage();
  assert.ok(button(mount, 'change-offer-stage'), 'the stato changes from the page');
  assert.equal(menuOpen(mount), false);
  button(mount, 'change-offer-stage').dispatch('click');
  assert.equal(menuOpen(mount), true);
  assert.equal(button(mount, 'change-offer-stage').getAttribute('aria-expanded'), 'true');
  assert.equal(stageVoice(mount, 'discovery'), undefined, 'the current stato is not a voice');
  assert.equal(stageVoice(mount, 'proposal').textContent, 'Proposta');
  stageVoice(mount, 'proposal').dispatch('click');
  await flushAll();
  const writes = client.writes();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, '/api/modules/opportunity/records/off1/actions/move-stage');
  assert.deepEqual(writes[0].body, { toStage: 'proposal', fromStage: 'discovery' });
  assert.ok(writes[0].key, 'the write rides the submission controller');
  assert.deepEqual(toasts, [{ text: 'Spostata in Proposta.', error: false }]);
  const stateFact = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'offer-fact'
    && node.childNodes[0]?.textContent === 'Stato');
  assert.equal(stateFact.childNodes[1].textContent, 'Proposta', 'the page re-reads the server state');
});

test('169cd4bc988c: the stato menu closes with Esc and with a click elsewhere', async () => {
  const { mount } = await openPage();
  const open = button(mount, 'change-offer-stage');
  open.dispatch('click');
  voicesMenu(mount).dispatch('keydown', { key: 'Escape' });
  assert.equal(menuOpen(mount), false, 'Esc closes');
  assert.equal(open.__focused, true, 'focus goes back to the button');
  assert.equal(open.getAttribute('aria-expanded'), 'false');
  open.dispatch('click');
  open.dispatch('keydown', { key: 'Escape' });
  assert.equal(menuOpen(mount), false, 'Esc on the button closes too');
  open.dispatch('click');
  const page = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'bo-offer');
  const facts = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-facts');
  page.dispatch('click', { target: facts });
  assert.equal(menuOpen(mount), false, 'a click elsewhere closes');
  open.dispatch('click');
  page.dispatch('click', { target: open });
  assert.equal(menuOpen(mount), true, 'the click that opened it never closes it');
});

test('169cd4bc988c: a refused move stays on screen in Italian; a lost stato needs its reason', async () => {
  const refuse = () => { throw Object.assign(new Error('stale'), { status: 409, code: 'STALE_STAGE', message: 'Lo stato è cambiato nel frattempo.' }); };
  const { mount, client, toasts } = await openPage({ move: refuse });
  button(mount, 'change-offer-stage').dispatch('click');
  stageVoice(mount, 'proposal').dispatch('click');
  await flushAll();
  assert.equal(client.writes().length, 1);
  const error = mount.findAll('small').find((node) => node.getAttribute('role') === 'alert');
  assert.equal(error?.textContent, 'Stato non aggiornato. Riprova più tardi.', 'the refusal stays on screen');
  assert.ok(!/STALE_STAGE/.test(mount.textContent), 'never the code');
  assert.equal(toasts.at(-1).error, true);

  const lost = await openPage();
  button(lost.mount, 'change-offer-stage').dispatch('click');
  stageVoice(lost.mount, 'lost').dispatch('click');
  assert.equal(lost.client.writes().length, 0, 'a lost stato asks first');
  assert.match(lost.mount.textContent, /Segnare «Cucina per Giulia» come Perso\?/);
  const yes = lost.mount.findAll('button').find((node) => node.textContent === 'Conferma');
  yes.dispatch('click');
  await flushAll();
  assert.equal(lost.client.writes().length, 0, 'never without a reason');
  assert.match(lost.mount.textContent, /Scrivi il motivo della perdita/);
  const reason = lost.mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo di chiusura');
  reason.value = 'Budget';
  yes.dispatch('click');
  await flushAll();
  assert.deepEqual(lost.client.writes()[0].body, { toStage: 'lost', fromStage: 'discovery', reason: 'Budget' });
});

test('169cd4bc988c: a move the server still holds reads neutral; an offer outside any board uses the core workflow', async () => {
  const pending = () => { throw Object.assign(new Error('queued'), { code: 'BO_CRM_PENDING' }); };
  const held = await openPage({ move: pending });
  button(held.mount, 'change-offer-stage').dispatch('click');
  stageVoice(held.mount, 'proposal').dispatch('click');
  await flushAll();
  assert.match(held.mount.textContent, /Non ancora confermato/);
  assert.equal(held.toasts.filter((toast) => toast.error).length, 0, 'never an error');

  const core = await openPage({ record: { pipelineKey: null, pipelineStage: null, stage: 'qualification' } });
  button(core.mount, 'change-offer-stage').dispatch('click');
  assert.equal(stageVoice(core.mount, 'proposal').textContent, 'Proposta', 'core states read capitalised');
  stageVoice(core.mount, 'proposal').dispatch('click');
  await flushAll();
  assert.equal(core.client.writes()[0].path, '/api/opportunities/off1/stage');
  assert.deepEqual(core.client.writes()[0].body, { targetStage: 'proposal' });
});

test('169cd4bc988c: Crea preventivo opens a quote on the offer and goes where its lines are added', async () => {
  const { mount, client, went } = await openPage();
  const create = button(mount, 'offer-create-quote');
  assert.ok(create, 'the quotes heading offers Crea preventivo');
  create.dispatch('click');
  create.dispatch('click');
  await flushAll();
  const writes = client.writes();
  assert.equal(writes.length, 1, 'a double click opens one quote');
  assert.equal(writes[0].path, '/api/modules/opportunity/records/off1/actions/create-quote');
  assert.deepEqual(writes[0].body, { priceBookId: 'pb1' });
  assert.deepEqual(went, ['#/quotes/q9']);
});

test('169cd4bc988c: Crea preventivo retries on the same key, offers a menu for several books, and says when none exists', async () => {
  const outcomes = [() => { throw Object.assign(new Error('gateway'), { status: 502 }); }, () => ({ ok: true, result: { quote: { id: 'q9' } } })];
  const retry = await openPage({ createQuote: (n) => outcomes[n - 1]() });
  button(retry.mount, 'offer-create-quote').dispatch('click');
  await flushAll();
  assert.match(retry.mount.textContent, /Il server non risponde adesso, riprova tra poco\./, 'the failure says what to do');
  button(retry.mount, 'offer-create-quote').dispatch('click');
  await flushAll();
  const keys = retry.client.writes().map((call) => call.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'the retry never opens a second quote');
  assert.deepEqual(retry.went, ['#/quotes/q9']);

  const books = [
    { id: 'pb-usd', name: 'Listino US', currency: 'USD', active: true },
    { id: 'pb-old', name: 'Vecchio', currency: 'EUR', active: false },
    { id: 'pb-eur', name: 'Listino', currency: 'EUR', active: true },
  ];
  const many = await openPage({ books });
  const select = many.mount.findAll('select').find((node) => node.getAttribute('aria-label') === 'Listino del preventivo');
  assert.ok(select, 'several books are a menu');
  assert.deepEqual(select.findAll('option').map((node) => node.textContent), ['Listino (€)', 'Listino US (USD)'],
    'active books only, the offer currency first');
  select.value = 'pb-usd';
  button(many.mount, 'offer-create-quote').dispatch('click');
  await flushAll();
  assert.deepEqual(many.client.writes()[0].body, { priceBookId: 'pb-usd' });

  const none = await openPage({ books: [] });
  assert.equal(button(none.mount, 'offer-create-quote'), undefined, 'no dead button');
  assert.match(none.mount.textContent, /serve un listino attivo nel Catalogo/);
});

test('169cd4bc988c: the referente is picked from the team, never typed', async () => {
  const { mount, client } = await openPage();
  const wrap = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  wrap.__edit();
  const form = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  const owner = form.__editInputs.owner;
  assert.equal(owner.tagName, 'SELECT', 'a menu of people, not a text field');
  assert.deepEqual(owner.findAll('option').map((node) => [node.getAttribute('value'), node.textContent]),
    [['maria', 'Maria Rossi'], ['google|123', 'Guido Presti']]);
  assert.equal(owner.value, 'maria', 'the stored referente is chosen');
  owner.value = 'google|123';
  await form.__save({ preventDefault() {} });
  const patch = client.writes().find((call) => call.method === 'PATCH');
  assert.equal(patch.body.owner, 'google|123');
  assert.ok(mount.textContent.includes('Guido Presti'), 'the page names the new referente');

  const legacy = await openPage({ record: { owner: 'coach-guido' } });
  const legacyWrap = legacy.mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  legacyWrap.__edit();
  const legacyForm = legacy.mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  const first = legacyForm.__editInputs.owner.findAll('option')[0];
  assert.deepEqual([first.getAttribute('value'), first.textContent], ['coach-guido', 'Coach Guido'],
    'a referente the team does not know stays, named in words, never remapped in silence');
});

test('169cd4bc988c: one word for every state move, states capitalised', async () => {
  const audit = [
    { action: 'opportunity.stage_changed', actorId: 'maria', actorType: 'user', createdAt: '2026-10-29T11:00:00.000Z', data: { from: 'qualification', to: 'proposal' } },
    { action: 'opportunity.updated', actorId: 'maria', actorType: 'user', createdAt: '2026-10-29T12:00:00.000Z', data: { pipelineStage: 'won', fromPipelineStage: 'discovery' } },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOfferDetail({ doc, mount, client: stubClient({ quotes: [], audit }) });
  await view.renderOfferDetail('off1');
  assert.ok(!mount.textContent.includes('Cambio di fase'), 'never «Cambio di fase»');
  assert.ok(!mount.textContent.includes('Fase'), 'the fact is «Stato» too');
  assert.ok(mount.textContent.includes('da Qualificazione a Proposta'));
  assert.ok(mount.textContent.includes('Cambio di stato · da Scoperta a Vinta'));
});

test('169cd4bc988c: no /bo screen says «Cambio di fase» — one word for every state move', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../apps/admin/public/', import.meta.url);
  const sources = readdirSync(dir).filter((name) => name.endsWith('.js'));
  const offenders = sources.filter((name) => readFileSync(new URL(name, dir), 'utf8').includes('Cambio di fase'));
  assert.deepEqual(offenders, []);
});

test('169cd4bc988c: the app hands the offer page its toast', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const wiring = /const offerDetail = createOfferDetail\(\{([\s\S]*?)\}\);/.exec(app);
  assert.ok(wiring && /\btoast\b/.test(wiring[1]), 'moves and quotes answer with a toast like the scheda');
});

test('review #786: an answer landing after another offer opened never pulls the person back', async () => {
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const { mount, toasts, went, view } = await openPage({ createQuote: () => held.then(() => ({ ok: true, result: { quote: { id: 'q9' } } })) });
  button(mount, 'offer-create-quote').dispatch('click');
  await view.renderOfferDetail('off2');
  release();
  await flushAll();
  assert.deepEqual(went, [], 'no navigation to the old offer’s quote');
  assert.deepEqual(toasts, [], 'no toast for a page no longer on screen');

  let releaseMove = () => {};
  const heldMove = new Promise((resolve) => { releaseMove = resolve; });
  const moving = await openPage({ move: () => heldMove.then(() => ({ ok: true })) });
  button(moving.mount, 'change-offer-stage').dispatch('click');
  stageVoice(moving.mount, 'proposal').dispatch('click');
  await moving.view.renderOfferDetail('off2');
  const reads = moving.client.calls.filter((call) => call.path === '/api/schema').length;
  releaseMove();
  await flushAll();
  assert.equal(moving.client.calls.filter((call) => call.path === '/api/schema').length, reads, 'the old move never re-reads over the new page');
  assert.deepEqual(moving.toasts, []);
});

test('review #786: an offer outside any board asks Conferma before won or lost, with no reason it would drop', async () => {
  const core = await openPage({ record: { pipelineKey: null, pipelineStage: null, stage: 'proposal' } });
  button(core.mount, 'change-offer-stage').dispatch('click');
  const lost = stageVoice(core.mount, 'lost');
  assert.ok(lost, 'lost is a voice of the core workflow');
  lost.dispatch('click');
  await flushAll();
  assert.equal(core.client.writes().length, 0, 'never posted on the first click');
  assert.match(core.mount.textContent, /Segnare «Cucina per Giulia» come Persa\?/);
  const reason = core.mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo di chiusura');
  assert.match(reason.getAttribute('class') ?? '', /hidden/, 'the core workflow records no reason, so none is asked');
  core.mount.findAll('button').find((node) => node.textContent === 'Conferma').dispatch('click');
  await flushAll();
  assert.deepEqual(core.client.writes().map((call) => [call.path, call.body]), [['/api/opportunities/off1/stage', { targetStage: 'lost' }]]);

  const won = await openPage({ record: { pipelineKey: null, pipelineStage: null, stage: 'proposal' } });
  button(won.mount, 'change-offer-stage').dispatch('click');
  stageVoice(won.mount, 'won').dispatch('click');
  await flushAll();
  assert.equal(won.client.writes().length, 0);
  won.mount.findAll('button').find((node) => node.textContent === 'Annulla').dispatch('click');
  await flushAll();
  assert.equal(won.client.writes().length, 0, 'Annulla writes nothing');
});


// backlog:a2ea75f705fd (verifica 12/11, pilota 62654a1): no read that ends
// in 404, the existing quote is the main action, and the page opens from a
// quote id as well.
test('a2ea75f705fd: the page reads the offer on its own route — no generic read that 404s', async () => {
  const { client } = await openPage();
  const gets = client.calls.filter((call) => call.method === 'GET').map((call) => call.path);
  assert.ok(gets.includes('/api/opportunities/off1'), 'the core offer route');
  assert.ok(!gets.some((path) => path.startsWith('/api/modules/opportunity/records/')), 'never the generic records surface (404 in the pilot)');
});

test('a2ea75f705fd: with a quote already there, the main action opens it; a new one is the second choice', async () => {
  const base = pageClient();
  const withQuote = {
    calls: base.calls,
    writes: base.writes,
    request(path, options = {}) {
      if (path.startsWith('/api/modules/quote/records')) return Promise.resolve({ items: [{ ...QUOTE, id: 'q-old', createdAt: '2026-11-01T00:00:00Z' }, { ...QUOTE, id: 'q-new', createdAt: '2026-11-10T00:00:00Z' }] });
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client: withQuote });
  await view.renderOfferDetail('off1');
  await flushAll();
  const open = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-open-quote');
  assert.ok(open, 'the open action is there');
  assert.equal(open.getAttribute('href'), '#/quotes/q-new', 'it opens the newest quote');
  assert.match(open.getAttribute('class'), /ui-btn-primary/, 'it is the main action');
  const create = button(mount, 'offer-create-quote');
  assert.equal(create.textContent, 'Nuovo preventivo');
  assert.doesNotMatch(String(create.getAttribute('class')), /primary/, 'creating another is the quiet choice');

  const fresh = await openPage();
  assert.equal(button(fresh.mount, 'offer-create-quote').textContent, 'Crea preventivo', 'without quotes, creating is the main action');
  assert.match(String(button(fresh.mount, 'offer-create-quote').getAttribute('class')), /primary/);
  assert.equal(fresh.mount.findAll('a').filter((node) => node.getAttribute('data-action') === 'offer-open-quote').length, 0);
});

test('a2ea75f705fd: #/offerte/<quote id> opens the offer the quote belongs to, never «Offerta non trovata»', async () => {
  const base = pageClient();
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path === '/api/opportunities/q9') return Promise.reject(Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' }));
      if (path === '/api/modules/quote/records/q9') return Promise.resolve({ id: 'q9', opportunityId: 'off1' });
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  await view.renderOfferDetail('q9');
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the offer behind the quote paints');
  assert.ok(!mount.textContent.includes('non trovata'), 'never «Offerta non trovata» for a quote of an offer');
});


// backlog:a3d3b99c738e (verifica 12/11): the price book menu never says the
// currency twice — «Manuale EUR (EUR)» reads «Listino manuale (€)».
test('a3d3b99c738e: the price book menu names each book once, the currency once', async () => {
  const { priceBookLabel } = await import('../apps/admin/public/admin-labels.js');
  assert.equal(priceBookLabel({ name: 'Manuale EUR', currency: 'EUR' }), 'Listino manuale (€)');
  assert.equal(priceBookLabel({ name: 'Listino Presti', currency: 'EUR' }), 'Listino Presti (€)');
  assert.equal(priceBookLabel({ name: 'Stripe USD', currency: 'USD' }), 'Stripe (USD)');
  assert.equal(priceBookLabel({ name: '', currency: 'EUR' }), 'Listino (€)');
  const many = await openPage({ books: [
    { id: 'pb-man', name: 'Manuale EUR', currency: 'EUR', active: true },
    { id: 'pb-presti', name: 'Listino Presti', currency: 'EUR', active: true },
  ] });
  const select = many.mount.findAll('select').find((node) => node.getAttribute('aria-label') === 'Listino del preventivo');
  const labels = select.findAll('option').map((node) => node.textContent);
  assert.deepEqual(labels, ['Listino manuale (€)', 'Listino Presti (€)']);
  assert.ok(labels.every((label) => !/EUR\)?.*\(EUR\)/.test(label)), 'never «Manuale EUR (EUR)»');
});

// backlog:d8175e1c3495 (pilota 12/11: «Caricamento…» up to 6,6 s) and
// backlog:94eabbd4762f (pilota 13/11: 1,8-4 s from the click): every read
// of the page leaves at once, the offer first — the quotes, the history,
// the team and the price books never wait for the offer — and each quote's
// lines and versions leave the moment the quotes land.
test('94eabbd4762f f2d39e473e3a: the offer page reads at once — offer first, quotes, history, team and price books beside it, then lines and versions', async () => {
  const base = pageClient();
  const quotes = [{ ...QUOTE, id: 'q1' }, { ...QUOTE, id: 'q2' }];
  const pending = [];
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      return new Promise((resolve, reject) => {
        pending.push({
          path,
          go: () => {
            if (path.startsWith('/api/modules/quote/records')) return resolve({ items: quotes });
            if (path.startsWith('/api/modules/quote-line/records') || path.startsWith('/api/modules/quote-version/records')) return resolve({ items: [] });
            base.request(path, options).then(resolve, reject);
          },
        });
      });
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  const round = async () => {
    await flushAll(3);
    const now = pending.splice(0).map((entry) => entry);
    for (const entry of now) entry.go();
    await flushAll(3);
    return now.map((entry) => entry.path.split('?')[0]);
  };
  const first = await round();
  assert.equal(first[0], '/api/opportunities/off1', 'the offer is asked first');
  // backlog:f2d39e473e3a (pilota 13/11): the price books left only after
  // the schema (+1,3-4,4 s); they leave with the others.
  assert.deepEqual([...first].sort(), ['/api/audit', '/api/modules/price-book/records', '/api/modules/quote/records', '/api/opportunities/off1', '/api/schema', '/api/spine/memberships'],
    'offer, schema, quotes, history, team and price books together');
  const second = await round();
  assert.equal(second.filter((path) => path === '/api/modules/quote-line/records').length, 2, 'both quotes read their lines at once');
  assert.equal(second.filter((path) => path === '/api/modules/quote-version/records').length, 2, 'and their versions, in the same round');
  assert.ok(!second.includes('/api/modules/price-book/records'), 'the price books never wait for the schema');
  while (pending.length > 0) await round();
  await done;
  const cards = mount.findAll('div').filter((node) => node.getAttribute('data-quote'));
  assert.deepEqual(cards.map((node) => node.getAttribute('data-quote')), ['q1', 'q2'], 'cards keep the order the quotes were read');
  assert.ok(button(mount, 'offer-create-quote'), 'the action is there when the page is');
});

test('94eabbd4762f: on a host serving two reads at a time the page is complete under 2 s from the click', async () => {
  const { createReadPool } = await import('./helpers/read-pool.js');
  const base = pageClient({ record: { contactId: 'c1' } });
  const quoted = {
    request(path, options) {
      if (path.startsWith('/api/modules/quote/records')) return Promise.resolve({ items: [QUOTE] });
      return base.request(path, options);
    },
  };
  // Pilota 13/11: the offer read alone takes 1-2,2 s; the schema is the
  // shell's cached one after a click.
  const pool = createReadPool(quoted, {
    readers: 2,
    latency: (path) => (path.startsWith('/api/opportunities/') ? 1000 : 300),
    cached: (path) => path === '/api/schema',
  });
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client: pool });
  const ms = await pool.settle(view.renderOfferDetail('off1', { from: null }));
  assert.ok(mount.textContent.includes('Cucina per Giulia'));
  assert.ok(button(mount, 'offer-create-quote'), 'the whole page, its action included');
  assert.ok(ms < 2000, `complete in ${ms} ms`);
});

test('94eabbd4762f: a link naming a quote reads that offer’s quotes and history again, by the offer’s own id', async () => {
  const base = pageClient();
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path === '/api/opportunities/q9') return Promise.reject(Object.assign(new Error('Not Found'), { status: 404, code: 'NOT_FOUND' }));
      if (path === '/api/modules/quote/records/q9') return Promise.resolve({ id: 'q9', opportunityId: 'off1' });
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  await view.renderOfferDetail('q9');
  const paths = base.calls.map((call) => call.path);
  assert.ok(paths.some((path) => path.startsWith('/api/modules/quote/records?') && path.includes('filter.opportunityId=off1')), 'quotes by the offer id');
  assert.ok(paths.some((path) => path.startsWith('/api/audit') && path.includes('entityId=off1')), 'history by the offer id');
});

test('d8175e1c3495: the page shows its frame at once as a skeleton, never «Caricamento…», and the paint replaces it', async () => {
  const base = pageClient();
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const client = { calls: base.calls, request: (path, options) => held.then(() => base.request(path, options)) };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  // Painted in the same tick the page opens, before any answer.
  const skeleton = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.ok(skeleton, 'the skeleton is on screen at once');
  assert.equal(skeleton.getAttribute('aria-busy'), 'true');
  assert.ok(!mount.textContent.includes('Caricamento'), 'never a lone loading line');
  for (const label of ['Offerta', 'Referente', 'Stato', 'Chiusura prevista', 'Preventivo', 'Cronologia']) {
    assert.ok(mount.textContent.includes(label), `the frame names «${label}»`);
  }
  assert.ok(mount.findAll('span').filter((node) => node.getAttribute('data-skeleton') === 'true').length >= 10, 'grey bars where values arrive');
  assert.equal(mount.findAll('p').find((node) => node.getAttribute('role') === 'status')?.textContent, 'Carico l’offerta…', 'the wait is said once');
  release();
  await done;
  await flushAll();
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-offer-skeleton') === 'true').length, 0, 'the skeleton is gone');
  assert.equal(mount.findAll('span').filter((node) => node.getAttribute('data-skeleton') === 'true').length, 0, 'no bar left');
  assert.ok(mount.textContent.includes('Cucina per Giulia'));
});

test('d8175e1c3495: an offer that cannot be read replaces the skeleton with the honest line', async () => {
  const mount = createMount();
  const client = { request: () => Promise.reject(Object.assign(new Error('boom'), { status: 500, code: 'BOOM' })) };
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    await view.renderOfferDetail('off1');
  } finally {
    console.error = realError;
  }
  assert.equal(mount.findAll('span').filter((node) => node.getAttribute('data-skeleton') === 'true').length, 0, 'no skeleton over a failure');
  assert.match(mount.textContent, /Offerta non trovata o non leggibile/);
});

// backlog:96c7b56001ba (pilota 13/11): opened from the scheda the offer said
// «← Pipeline» and lit Pipeline in the sidebar; it goes back to the scheda.
test('96c7b56001ba: opened from a scheda the way back is that scheda, through every re-read of the page', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = pageClient();
  const view = createOfferDetail({ doc, mount, client, toast: () => {}, navigate: () => {} });
  const back = () => mount.findAll('a').find((node) => node.getAttribute('data-action') === 'offer-back');
  await view.renderOfferDetail('off1', { from: { resource: 'contact', subjectId: 'c1' } });
  assert.equal(back().textContent, '← Giulia Verdi', 'named after the customer it goes back to');
  assert.equal(back().getAttribute('href'), '#/customer-card/contact/c1');
  assert.equal(parseModuleRoute(back().getAttribute('href')).view, 'customer-card', 'the link is a real route');
  // Salva re-reads the page: the way back stays.
  const wrap = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  wrap.__edit();
  const form = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-edit');
  await form.__save();
  await flushAll();
  assert.equal(back().getAttribute('href'), '#/customer-card/contact/c1', 'Salva keeps the way back');
  // Another scheda (a company mate) is named plainly.
  await view.renderOfferDetail('off1', { from: { resource: 'company', subjectId: 'co9' } });
  assert.equal(back().textContent, '← Scheda cliente');
  assert.equal(back().getAttribute('href'), '#/customer-card/company/co9');
  // Opened again from the board: back to the board.
  await view.renderOfferDetail('off1', { from: null });
  assert.equal(back().textContent, '← Pipeline');
  assert.equal(back().getAttribute('href'), '#/pipelines/b2b-sales');
});

test('96c7b56001ba: the scheda hands its own address to the offer page, and the sidebar stays on Clienti', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /case 'offer-detail': return \{ id: target\.from \? 'clienti' : 'pipeline', label: 'Offerta' \};/,
    'an offer opened from a scheda keeps Clienti lit');
  assert.match(app, /offerDetail\.renderOfferDetail\(target\.offerId, \{ from: target\.from \?\? null \}\)/,
    'the router hands the page where it was opened from');
});

// backlog:96c7b56001ba: PREVENTIVO said «Ancora nessun preventivo per questa
// offerta.» for 0,3-1,1 s with neither the price book nor «Crea preventivo».
test('96c7b56001ba: the quotes section never shows an empty line that changes — the action comes with it', async () => {
  const base = pageClient();
  let releaseBooks = () => {};
  const booksHeld = new Promise((resolve) => { releaseBooks = resolve; });
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path.startsWith('/api/modules/price-book/records')) return booksHeld.then(() => base.request(path, options));
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll();
  assert.ok(mount.textContent.includes('Cucina per Giulia'), 'the offer is on screen while the price books read (review Muse #871)');
  assert.ok(!mount.textContent.includes('Ancora nessun preventivo'), 'no empty line while the price books read');
  assert.equal(button(mount, 'offer-create-quote'), undefined);
  const place = mount.findAll('div').find((node) => node.getAttribute('class') === 'offer-quote-create-wait');
  assert.ok(place && place.getAttribute('aria-busy') === 'true', 'grey bars hold the place of the empty line and the action');
  releaseBooks();
  await done;
  await flushAll();
  assert.ok(mount.textContent.includes('Ancora nessun preventivo per questa offerta.'));
  assert.ok(button(mount, 'offer-create-quote'), 'the empty line and «Crea preventivo» arrive together');
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-loading') === 'true').length, 0, 'no grey place left');
});

// Review Muse #871 giro 1 (P1): the price books and each quote's lines and
// versions are decoration — a slow one never holds the offer itself.
test('94eabbd4762f: a slow price book or quote line never holds the offer — title, facts and history paint first', async () => {
  const base = pageClient({ record: {} });
  const held = [];
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path.startsWith('/api/modules/quote/records?')) return Promise.resolve({ items: [QUOTE] });
      if (path.startsWith('/api/modules/price-book/records') || path.startsWith('/api/modules/quote-line/records')) {
        return new Promise((resolve) => { held.push(() => base.request(path, options).then(resolve)); });
      }
      if (path.startsWith('/api/audit')) return Promise.resolve({ items: AUDIT });
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  let complete = false;
  const done = view.renderOfferDetail('off1').then(() => { complete = true; });
  await flushAll();
  assert.ok(held.length >= 2, 'the price books and the lines are still reading');
  assert.equal(complete, false);
  const text = mount.textContent;
  assert.ok(text.includes('Cucina per Giulia'), 'the title is on screen');
  assert.ok(text.includes('27.500'), 'the value');
  assert.ok(text.includes('Referente') && text.includes('Cronologia'), 'the facts and the history');
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-offer-skeleton') === 'true').length, 0, 'the page skeleton is gone');
  const card = mount.findAll('div').find((node) => node.getAttribute('class') === 'offer-quote' && node.getAttribute('data-loading') === 'true');
  assert.ok(card, 'the quote card holds its place with grey bars');
  for (const go of held.splice(0)) go();
  await done;
  await flushAll();
  assert.ok(mount.findAll('div').some((node) => node.getAttribute('data-quote') === 'q1'), 'the card fills its place');
  assert.ok(button(mount, 'offer-create-quote') || mount.findAll('a').some((node) => node.getAttribute('data-action') === 'offer-open-quote'), 'the quote action arrives');
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-loading') === 'true').length, 0, 'no grey place left');
});

test('96c7b56001ba: unreadable price books say so in one honest line', async () => {
  const { mount } = await openPage({ books: Object.assign(new Error('boom'), { status: 500, code: 'BOOM' }) });
  assert.match(mount.textContent, /Listini non leggibili: crea il preventivo più tardi\./);
});

// backlog:f2d39e473e3a: the price books never wait for the schema, even
// when the schema is not cached (a direct link) and answers last.
test('f2d39e473e3a: the price books leave before the schema answers; without a commercial block their answer is unused', async () => {
  const base = pageClient();
  let releaseSchema = () => {};
  const schemaHeld = new Promise((resolve) => { releaseSchema = resolve; });
  const asked = [];
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      asked.push(path.split('?')[0]);
      if (path === '/api/schema') return schemaHeld.then(() => base.request(path, options));
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll();
  assert.ok(asked.includes('/api/modules/price-book/records'), 'asked while the schema still reads');
  releaseSchema();
  await done;
  assert.ok(button(mount, 'offer-create-quote'));

  const plain = await openPage({ schema: SCHEMA });
  assert.equal(button(plain.mount, 'offer-create-quote'), undefined, 'no commercial block, no action');
  assert.ok(!plain.mount.textContent.includes('listino'), 'and no word about price books');
});

// backlog:f2d39e473e3a: the crumb read «<spazio> / OFFERTA» with neither the
// customer nor the offer.
test('f2d39e473e3a: the crumb names the customer and the offer', async () => {
  const { offerCrumb } = await import('../apps/admin/public/admin-offer.js');
  assert.equal(offerCrumb(offerRecord({ contactId: 'c1' })), 'Offerta / Giulia Verdi / Cucina per Giulia');
  assert.equal(offerCrumb(offerRecord({ contactName: null, companyName: null })), 'Offerta / Cucina per Giulia', 'no customer, no empty part');
  assert.equal(offerCrumb({ name: '  ' }), 'Offerta');
  const titles = [];
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client: pageClient(), onTitle: (label) => titles.push(label) });
  await view.renderOfferDetail('off1');
  assert.deepEqual(titles, ['Offerta / Giulia Verdi / Cucina per Giulia']);
});

// Review Muse #881 giro 1: the shell keeps the crumb through a re-sync, and
// forgets it when the person leaves the offer page or the space changes.
// The shell's three writers, as app.js wires them — the router (`routed`),
// every re-sync (`label`, through customerCrumbLabel) and the page naming
// itself (`named`) — driven against the real offer page.
test('f2d39e473e3a: the crumb survives the shell re-sync and never outlives its offer or its space', async () => {
  const { createOfferCrumbs, customerCrumbLabel } = await import('../apps/admin/public/admin-navigation.js');
  const { parseModuleRoute } = await import('../apps/admin/public/admin-core.js');
  let space = 's1';
  let hash = '#/';
  let crumb = null;
  let routed = null;
  const crumbs = createOfferCrumbs({ space: () => space });
  const plain = (target) => (target.view === 'offer-detail' ? 'Offerta' : target.view === 'pipeline' ? 'Pipeline' : 'Vista');
  const syncShell = (target) => { crumb = customerCrumbLabel(target, crumbs.label(target) ?? plain(target), null); };
  const records = {
    offA: offerRecord({ id: 'offA', name: 'Cucina per Giulia', contactId: 'c1' }),
    offB: offerRecord({ id: 'offB', name: 'Bagno per Marco', contactName: 'Marco Neri', contactId: 'c2' }),
  };
  const client = {
    request(path, options = {}) {
      const id = /^\/api\/opportunities\/([^/?]+)$/.exec(path)?.[1];
      if (id && records[id]) return Promise.resolve({ ...records[id] });
      return pageClient().request(path, options);
    },
  };
  const view = createOfferDetail({
    doc: createFakeDocument(), mount: createMount(), client,
    onTitle: (label) => {
      if (routed?.view !== 'offer-detail') return;
      if (crumbs.named(parseModuleRoute(hash), label)) crumb = label;
    },
  });
  const go = async (next) => {
    hash = next;
    routed = parseModuleRoute(hash);
    crumbs.routed(routed);
    syncShell(routed);
    if (routed.view === 'offer-detail') await view.renderOfferDetail(routed.offerId, { from: null });
  };
  await go('#/offerte/offA');
  assert.equal(crumb, 'Offerta / Giulia Verdi / Cucina per Giulia', 'the page names the customer and the offer');
  syncShell(routed); // populateNav: the schema lands after the offer
  assert.equal(crumb, 'Offerta / Giulia Verdi / Cucina per Giulia', 'a re-sync keeps the crumb');
  await go('#/pipelines/b2b-sales');
  assert.equal(crumb, 'Pipeline');
  // Back to A after leaving it (renamed meanwhile, say): plain until A's
  // own read lands again, never the crumb of the previous visit.
  hash = '#/offerte/offA';
  routed = parseModuleRoute(hash);
  crumbs.routed(routed);
  syncShell(routed);
  assert.equal(crumb, 'Offerta', 'a crumb left behind is forgotten');
  await view.renderOfferDetail('offA', { from: null });
  assert.equal(crumb, 'Offerta / Giulia Verdi / Cucina per Giulia');
  await go('#/pipelines/b2b-sales');
  // Offer B, before its own read lands: never A's crumb.
  hash = '#/offerte/offB';
  routed = parseModuleRoute(hash);
  crumbs.routed(routed);
  syncShell(routed);
  assert.equal(crumb, 'Offerta', 'another offer never borrows the crumb');
  await view.renderOfferDetail('offB', { from: null });
  assert.equal(crumb, 'Offerta / Marco Neri / Bagno per Marco');
  // Another space: the crumb is not this space's.
  space = 's2';
  syncShell(routed);
  assert.equal(crumb, 'Offerta', 'the crumb belongs to its space');
});

test('f2d39e473e3a: app.js hands every crumb writer to the same keeper', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const wiring = /const offerDetail = createOfferDetail\(\{([\s\S]*?)\n\}\);/.exec(app);
  assert.ok(wiring && /offerCrumbs\.named\(targetForHash\(/.test(wiring[1]) && /mountGate\.isActive\('offer-detail'\)/.test(wiring[1]));
  assert.match(app, /screenLabel: customerCrumbLabel\(target, offerCrumbs\.label\(target\) \?\? /);
  const route = app.slice(app.indexOf('async function route()'), app.indexOf("if (targetForHash(hash).view === 'settings')"));
  assert.match(route, /offerCrumbs\.routed\(targetForHash\(hash\)\);/, 'every navigation, settings included');
});

// backlog:a762c28a646c: «Per <cliente>» opens a scheda that reads the name
// at once — the offer page remembers who it is for.
test('a762c28a646c: the offer page remembers its customer for the scheda', async () => {
  const { createKnownNames } = await import('../apps/admin/public/admin-known-names.js');
  const names = createKnownNames({ space: () => 's1' });
  const view = createOfferDetail({ doc: createFakeDocument(), mount: createMount(), client: pageClient(), knownNames: names });
  await view.renderOfferDetail('off1');
  assert.equal(names.get('contact', 'c1'), 'Giulia Verdi');
  const company = createKnownNames({ space: () => 's1' });
  const other = createOfferDetail({ doc: createFakeDocument(), mount: createMount(), client: pageClient({ record: { contactName: null, contactId: null, companyName: 'Palestra Sole' } }), knownNames: company });
  await other.renderOfferDetail('off1');
  assert.equal(company.get('company', 'co1'), 'Palestra Sole', 'without a contact, the company');
});

// backlog:a060a4aa65b6 (verifica 14/11 01:47Z): the title waited for the
// slowest read (memberships or quote records), 2,9-5,8 s from a direct link.
test('a060a4aa65b6: title, customer, amount and dates show the moment the offer is read', async () => {
  const base = pageClient();
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) return base.request(path, options);
      return held.then(() => base.request(path, options));
    },
  };
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  const done = view.renderOfferDetail('off1');
  await flushAll();
  const text = mount.textContent;
  assert.ok(text.includes('Cucina per Giulia'), 'the title');
  assert.ok(text.includes('Per Giulia Verdi'), 'who it is for');
  assert.ok(text.includes('27.500'), 'the amount');
  assert.ok(text.includes('20 nov 2026'), 'the expected close');
  assert.ok(!text.includes('Scoperta'), 'the stage waits for the schema');
  const page = mount.findAll('div').find((node) => node.getAttribute('data-offer-skeleton') === 'true');
  assert.equal(page?.getAttribute('aria-busy'), 'true', 'the rest is still reading');
  release();
  await done;
  await flushAll();
  assert.equal(mount.findAll('div').filter((node) => node.getAttribute('data-offer-skeleton') === 'true').length, 0);
  assert.ok(mount.textContent.includes('Cucina per Giulia'));
});

// backlog:a060a4aa65b6: every state move added «Offerta aggiornata · da …»
// (the card's order on the board, written beside a drag move), and the rows
// had the day without the hour.
test('a060a4aa65b6: one history row per state move, with the hour', async () => {
  const audit = [
    { action: 'opportunity.updated', actorType: 'user', actorId: 'maria', createdAt: '2026-11-13T21:39:05.000Z', data: { boardPosition: 1024, first: true } },
    { action: 'opportunity.updated', actorType: 'user', actorId: 'maria', createdAt: '2026-11-13T21:39:04.000Z', data: { pipelineStage: 'won', fromPipelineStage: 'discovery', stageEnteredAt: '2026-11-13T21:39:04.000Z' } },
    { action: 'opportunity.updated', actorType: 'user', actorId: 'maria', createdAt: '2026-11-12T10:00:00.000Z', data: { boardPosition: 2048, afterId: 'x', renumbered: 2 } },
    { action: 'opportunity.updated', actorType: 'user', actorId: 'maria', createdAt: '2026-11-11T10:00:00.000Z', data: { valueCents: 100 } },
  ];
  const client = stubClient({ audit });
  const mount = createMount();
  const view = createOfferDetail({ doc: createFakeDocument(), mount, client });
  await view.renderOfferDetail('off1');
  const rows = mount.findAll('p').filter((node) => node.getAttribute('class') === 'history-event').map((node) => node.textContent);
  assert.equal(rows.length, 2, 'the move and the commercial edit, never the board placements');
  assert.match(rows[0], /13 nov, 22:39/, 'the day and the hour, Rome time');
  assert.match(rows[0], /Cambio di stato · da Scoperta a Vinta/);
  assert.match(rows[1], /Offerta aggiornata/);
  const { isBoardPlacement } = await import('../apps/admin/public/admin-labels.js');
  assert.equal(isBoardPlacement(audit[0]), true);
  assert.equal(isBoardPlacement(audit[1]), false);
  assert.equal(isBoardPlacement({ action: 'opportunity.created', data: { boardPosition: 1 } }), false);
});

// backlog:a060a4aa65b6: the scheda read «qualificazione» for an offer in a
// Pipeline column — the core stage, when the pipelines were not readable.
test('a060a4aa65b6: a placed offer reads its column even when the pipelines are not readable', async () => {
  const { offerStageLabel } = await import('../apps/admin/public/admin-labels.js');
  const placed = { pipelineKey: 'accordo-sales', pipelineStage: 'richiesta-info', stage: 'qualification' };
  assert.equal(offerStageLabel([], placed), 'Richiesta info', 'the column, never «qualificazione»');
  assert.equal(offerStageLabel(null, { ...placed, pipelineStage: 'prova' }), 'Prova');
  assert.equal(offerStageLabel([], { stage: 'qualification' }), 'qualificazione', 'an offer outside any board keeps its core stage');
  assert.equal(offerStageLabel([], { pipelineStage: 'Strano Valore!', stage: 'qualification' }), 'qualificazione', 'never a raw odd key');
});
