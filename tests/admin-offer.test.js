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
      if (path.startsWith('/api/modules/opportunity/records/')) return { ...record };
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
  assert.deepEqual(select.findAll('option').map((node) => node.textContent), ['Listino (EUR)', 'Listino US (USD)'],
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
