import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteView, percentReason } from '../apps/admin/public/admin-quotes.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * The Quote builder renders from server state only — these tests drive it
 * against a stub client so lifecycle-dependent controls, server-authoritative
 * amounts, action payloads, XSS safety and stale-render protection are
 * asserted precisely. The full HTTP path is covered by
 * tests/commercial-e2e.test.js.
 */

const SCHEMA = {
  commercial: {
    commercialContract: 1,
    pricingContract: 1,
    chargeTypes: ['one_time', 'recurring'],
    pricingModels: ['flat_fee', 'per_unit', 'volume', 'graduated'],
    discountPolicies: [{ name: 'standard-sales-discount', version: 1, label: 'Standard', fingerprint: 'f'.repeat(64) }],
  },
};

/** A composite offer's server-calculated breakdown, as the action returns it. */
const BREAKDOWN = {
  components: [
    { componentId: 'c1', componentKey: 'ent-setup', label: 'Setup and migration', chargeType: 'one_time', pricingModel: 'flat_fee', interval: null, intervalCount: null, quantity: 0, tierBreakdown: [], listAmountCents: 500_000, discountAmountCents: 0, netAmountCents: 500_000 },
    { componentId: 'c2', componentKey: 'ent-platform', label: 'Platform fee', chargeType: 'recurring', pricingModel: 'flat_fee', interval: 'month', intervalCount: 1, quantity: 0, tierBreakdown: [], listAmountCents: 200_000, discountAmountCents: 0, netAmountCents: 200_000 },
    {
      componentId: 'c3', componentKey: 'ent-seats', label: 'Seats', chargeType: 'recurring', pricingModel: 'volume', interval: 'month', intervalCount: 1, quantity: 30,
      tierBreakdown: [{ position: 2, from: 1, to: 100, quantity: 30, unitAmountCents: 4000, flatAmountCents: 0, amountCents: 120_000 }],
      listAmountCents: 120_000, discountAmountCents: 0, netAmountCents: 120_000,
    },
  ],
};

const TOTALS = {
  oneTimeTotal: { currency: 'EUR', listAmountCents: 500_000, discountAmountCents: 0, netAmountCents: 500_000 },
  recurringTotals: [
    { currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 320_000, discountAmountCents: 0, netAmountCents: 320_000 },
    { currency: 'EUR', interval: 'year', intervalCount: 1, listAmountCents: 1_000_000, discountAmountCents: 50_000, netAmountCents: 950_000 },
  ],
};

function quote(overrides = {}) {
  return {
    id: 'q1',
    opportunityId: 'opp1',
    priceBookId: 'pb1',
    currency: 'EUR',
    status: 'draft',
    draftRevision: 3,
    totalsJson: JSON.stringify(TOTALS),
    oneTimeNetCents: 500_000,
    recurringGroupCount: 2,
    currentVersionId: null,
    currentVersionNumber: null,
    ...overrides,
  };
}

function stubClient({ quoteRecord = quote(), lines = [], entries = [], versions = [], failAction, opportunityRecord, failOpportunity = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return SCHEMA;
      if (options.method === 'POST') {
        if (failAction) throw Object.assign(new Error(failAction.message), failAction);
        return { ok: true, result: { quote: quoteRecord } };
      }
      if (path.startsWith('/api/modules/opportunity/records/')) {
        if (failOpportunity || opportunityRecord === undefined) throw Object.assign(new Error('Not Found'), { status: 404 });
        return opportunityRecord;
      }
      if (path.startsWith('/api/modules/quote/records/')) return quoteRecord;
      if (path.startsWith('/api/modules/quote-line/records')) return { items: lines };
      if (path.startsWith('/api/modules/offer/records')) return { items: entries };
      if (path.startsWith('/api/modules/quote-version/records')) return { items: versions };
      if (path.startsWith('/api/modules/quote/records')) return { items: [quoteRecord] };
      if (path.startsWith('/api/modules/price-book/records')) return { items: [{ id: 'pb1', name: 'Standard EUR', currency: 'EUR', active: true }] };
      return { items: [] };
    },
  };
}

const LINE = {
  id: 'l1',
  quoteId: 'q1',
  offerId: 'o1',
  offerLogicalKey: 'fixture:offer:enterprise',
  offerRevision: 1,
  offerName: 'Enterprise Plan',
  sku: 'PLATFORM',
  quantity: 30,
  discountBps: 500,
  componentCount: 3,
  breakdownJson: JSON.stringify(BREAKDOWN),
  listAmountCents: 820_000,
  discountAmountCents: 41_000,
  netAmountCents: 779_000,
  removed: false,
  position: 1,
};

const ENTRY = {
  id: 'o1',
  priceBookId: 'pb1',
  logicalKey: 'fixture:offer:enterprise',
  name: 'Enterprise Plan',
  currency: 'EUR',
  componentCount: 3,
  active: true,
  quoteEligible: true,
};

test('draft quotes show server-calculated totals and line/submit controls', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ lines: [LINE], entries: [ENTRY] });
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');

  const text = mount.textContent;
  // Grouped totals: one-time, monthly and annual are shown separately and are
  // never combined into a single grand total. Amounts use the Italian screen
  // form: dot for thousands, comma for cents, EUR as the € sign.
  assert.ok(text.includes('5.000 €'), `one-time total rendered (${text})`);
  assert.ok(text.includes('3.200 €'), 'monthly total rendered');
  assert.ok(text.includes('9.500 €'), 'annual total rendered');
  assert.ok(text.includes('Una tantum'), 'the one-time group is labelled');
  assert.ok(text.includes('Ricorrente ogni 1 mese'), 'the monthly group is labelled');
  assert.ok(text.includes('Ricorrente ogni 1 anno'), 'the annual group is labelled');
  assert.ok(!/ARR|MRR|TCV/.test(text), 'no ARR/MRR/TCV is implied');
  assert.ok(text.includes('non si sommano tra loro'), 'the grouping contract is disclosed');
  assert.ok(!text.includes('server'), 'voce ef92f728: no developer note about who computes the amounts');
  assert.ok(text.includes('5,00%'), 'basis points shown as a percentage');
  assert.ok(text.includes('Sconto in punti base'), 'the discount unit is explained');
  assert.ok(text.includes('le quote fisse si addebitano una volta'), 'quantity semantics disclosed');
  // Component breakdown with the tier band.
  const components = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '') === 'quote-component');
  assert.equal(components.length, 3, 'every component of the composite offer is shown');
  assert.ok(components[0].textContent.includes('una tantum'), 'charge type shown');
  assert.ok(components[1].textContent.includes('ogni 1 mese'), 'recurrence shown');
  const tiers = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '') === 'quote-tier');
  assert.equal(tiers.length, 1, 'the tier band is shown');
  assert.ok(tiers[0].textContent.includes('30 × 40 €'), `tier breakdown rendered (${tiers[0].textContent})`);
  // Draft controls exist; approval/revise controls do not.
  assert.ok(mount.findAll('div').some((node) => (node.getAttribute('class') ?? '') === 'quote-add-line'));
  assert.ok(mount.findAll('div').some((node) => (node.getAttribute('class') ?? '') === 'quote-submit'));
  assert.equal(mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-decide').length, 0);
  assert.equal(mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-revise').length, 0);
});

test('adding a line posts the server action with quantity, basis points and the draft revision', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ lines: [LINE], entries: [ENTRY] });
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');

  const addPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-add-line');
  addPanel.__quantity.value = '5';
  addPanel.__discountBps.value = '750';
  await addPanel.__add();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/modules/quote/records/q1/actions/add-line');
  assert.deepEqual(JSON.parse(post.body), {
    offerId: 'o1',
    quantity: 5,
    discountBps: 750,
    expectedRevision: 3,
  });
});

test('submitting posts the selected policy version; a failure shows the server message as text', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    lines: [LINE],
    entries: [ENTRY],
    failAction: { message: 'Stale draft revision: expected 3, quote is at 4', status: 409, code: 'STALE_REVISION' },
  });
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');

  const submitPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-submit');
  await submitPanel.__submit();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.deepEqual(JSON.parse(post.body), { policy: 'standard-sales-discount', version: 1, expectedRevision: 3 });
  const error = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error');
  assert.match(error.textContent, /Stale draft revision/);
});

test('pending approval shows human decision controls; approved and rejected show their own', async () => {
  const pending = createMount();
  const pendingClient = stubClient({ quoteRecord: quote({ status: 'pending_approval', currentApprovalId: 'a1' }), lines: [LINE] });
  await createQuoteView({ doc: createFakeDocument(), mount: pending, client: pendingClient }).renderQuoteDetail('q1');
  const decide = pending.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-decide');
  assert.ok(decide, 'decision panel rendered');
  // Voce ef92f728: no developer roadmap note on the owner's page.
  assert.ok(!pending.textContent.includes('Production Spine'), 'no internal milestone name on the page');
  assert.ok(!pending.textContent.includes('Admin'), 'no internal role name on the page');
  await decide.__reject();
  const rejectPost = pendingClient.calls.find((call) => call.method === 'POST');
  assert.equal(rejectPost.path, '/api/modules/quote/records/q1/actions/reject');
  // Draft editing controls are absent once pending.
  assert.equal(pending.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-add-line').length, 0);

  const rejected = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: rejected, client: stubClient({ quoteRecord: quote({ status: 'rejected' }) }) }).renderQuoteDetail('q1');
  assert.ok(rejected.findAll('div').some((node) => (node.getAttribute('class') ?? '') === 'quote-revise'), 'rejected quotes offer revise');

  const approved = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: approved, client: stubClient({ quoteRecord: quote({ status: 'approved', currentVersionId: 'v1' }) }) }).renderQuoteDetail('q1');
  assert.ok(approved.textContent.includes('in sola lettura'), 'the commercial content of an approved quote is read-only');
  assert.equal(approved.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-add-line').length, 0);
  assert.equal(approved.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-decide').length, 0);
  // The commercial view never invents a signature surface on its own: without
  // the ADR-017 schema block it degrades to a statement, not a control.
  assert.ok(approved.textContent.includes('La firma non è attiva in questo progetto.'));
  assert.equal(approved.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'signature-request').length, 0);
});

test('version history lists immutable versions with their policy decision', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const versions = [
    { id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'approval_required', decisionReason: 'max line discount 2000bps exceeds limit', totalsJson: JSON.stringify(TOTALS), currency: 'EUR' },
    { id: 'v2', quoteId: 'q1', versionNumber: 2, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: null, totalsJson: JSON.stringify(TOTALS), currency: 'EUR' },
  ];
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: quote({ status: 'approved' }), versions }) }).renderQuoteDetail('q1');
  const rows = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-version-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('data-version'), 'v2', 'newest version first');
  assert.ok(rows[1].textContent.includes('Richiede approvazione'));
  assert.ok(rows[1].textContent.includes('standard-sales-discount@1'), 'the row names the policy that decided it');
  assert.ok(rows[1].textContent.includes('una tantum 5.000 €'), 'versions show grouped periods');
  assert.ok(rows[1].textContent.includes('3.200 € ogni 1 mese'), 'recurring period shown per version');
});

test('8dc6d4a456e1: a subscription-only quote never paints a zero one-time total', async () => {
  const recurringOnly = {
    oneTimeTotal: { currency: 'EUR', listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
    recurringTotals: [
      { currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 320_000, discountAmountCents: 0, netAmountCents: 320_000 },
    ],
  };
  const record = quote({ totalsJson: JSON.stringify(recurringOnly) });
  const versions = [
    { id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: null, totalsJson: JSON.stringify(recurringOnly), currency: 'EUR' },
  ];
  const listMount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: listMount, client: stubClient({ quoteRecord: record }) }).renderQuoteList();
  const listText = listMount.textContent;
  assert.ok(listText.includes('3.200 € ogni 1 mese'), 'the list shows the recurring group with its period');
  assert.ok(!listText.includes('una tantum'), 'the list never shows a zero one-time total for a subscription-only quote');

  const doc = createFakeDocument();
  const mount = createMount();
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: record, versions }) }).renderQuoteDetail('q1');
  const text = mount.textContent;
  assert.ok(text.includes('3.200 €'), 'the valued recurring group leads the hero');
  assert.ok(!text.includes('una tantum 0'), 'the hero never shows a zero one-time total');
  assert.ok(text.includes('standard-sales-discount@1'), 'the history row names the deciding policy');
  assert.ok(text.includes('Versione 1 · Approvazione automatica · standard-sales-discount@1 · 3.200 € ogni 1 mese'), 'the history row keeps the recurring period');
});

test('bb833fab673a: the Totale panel hides zero-valued groups like hero and list', async () => {
  const recurringOnly = {
    oneTimeTotal: { currency: 'EUR', listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
    recurringTotals: [
      { currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 320_000, discountAmountCents: 0, netAmountCents: 320_000 },
      { currency: 'EUR', interval: 'year', intervalCount: 1, listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
    ],
  };
  const record = quote({ totalsJson: JSON.stringify(recurringOnly) });
  const versions = [
    { id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: null, totalsJson: JSON.stringify(recurringOnly), currency: 'EUR' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: record, versions }) }).renderQuoteDetail('q1');
  const totals = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-totals');
  assert.ok(totals, 'the detail paints a Totale panel');
  const rows = totals.findAll('p').filter((node) => node.getAttribute('data-total') !== null);
  const labels = rows.map((row) => row.getAttribute('data-total'));
  assert.ok(!labels.includes('Una tantum'), 'the Totale panel never shows a zero one-time total');
  assert.ok(!labels.some((label) => label.startsWith('Ricorrente')) || labels.length === 1, 'only valued groups get a row');
  assert.ok(labels.some((label) => label.startsWith('Ricorrente')), 'the valued recurring group keeps its row');
});

test('8dc6d4a456e1: a version with no valued group paints a dash like the header', async () => {
  const empty = {
    oneTimeTotal: { currency: 'EUR', listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 },
    recurringTotals: [],
  };
  const record = quote({ totalsJson: JSON.stringify(empty) });
  const versions = [
    { id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: null, totalsJson: JSON.stringify(empty), currency: 'EUR' },
  ];
  const doc = createFakeDocument();
  const mount = createMount();
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: record, versions }) }).renderQuoteDetail('q1');
  const text = mount.textContent;
  assert.ok(text.includes('Versione 1 · Approvazione automatica · standard-sales-discount@1 · —'), 'no value reads as a dash, like the header');
});

test('hostile catalog and quote values render as inert text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    lines: [{
      ...LINE,
      offerName: hostile,
      sku: hostile,
      breakdownJson: JSON.stringify({ components: [{ ...BREAKDOWN.components[0], label: hostile }] }),
    }],
    entries: [{ ...ENTRY, name: hostile }],
  });
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  const lineRow = mount.findAll('div').find((node) => node.getAttribute('data-line') === 'l1');
  assert.ok(lineRow.textContent.includes(hostile), 'hostile value present as text');
  assert.equal(lineRow.findAll('img').length, 0, 'no element parsed out of the hostile value');
});

test('cf340b571e98: the detail links back to the customer scheda', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    lines: [LINE],
    versions: [],
    opportunityRecord: {
      id: 'o1', companyId: 'co1', companyName: 'Palestra Esempio',
      contactId: 'c1', contactName: 'Ada Rossi',
      name: 'Proposta esempio — Pacchetto 10 PT', stage: 'proposal',
    },
  });
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  const back = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.ok(back, 'a back link to the scheda is shown');
  assert.equal(back.getAttribute('href'), '#/customer-card/contact/c1', 'the link returns to the customer card');
  assert.equal(back.textContent, '← Ada Rossi', 'the link names the customer');
  assert.equal(mount.childNodes[0], back, 'the back link paints above the detail');
  const text = mount.textContent;
  assert.ok(text.includes('Cosa include'), 'the detail still shows the lines');
  assert.ok(text.includes('5.000 €'), 'the detail still shows the total');
  assert.ok(mount.findAll('span').some((node) => String(node.getAttribute('class') ?? '').startsWith('quote-status ')), 'the detail still shows the state');
  assert.ok(text.includes('Storico') && text.includes('Ancora nessuna versione'), 'the detail still shows the history');
});

test('cf340b571e98: a quote without a resolvable customer still renders without the way back', async () => {
  const variants = [
    { name: 'no opportunity id', client: stubClient({ quoteRecord: quote({ opportunityId: null }) }) },
    { name: 'unreadable opportunity', client: stubClient({ quoteRecord: quote({ opportunityId: 'o-missing' }), failOpportunity: true }) },
    {
      name: 'nameless subject',
      client: stubClient({
        quoteRecord: quote({ opportunityId: 'o1' }),
        opportunityRecord: { id: 'o1', companyId: 'co1', companyName: '', contactId: null, contactName: null },
      }),
    },
  ];
  for (const variant of variants) {
    const mount = createMount();
    await createQuoteView({ doc: createFakeDocument(), mount, client: variant.client }).renderQuoteDetail('q1');
    assert.equal(mount.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'quote-back').length, 0,
      `${variant.name}: no back link`);
    assert.ok(mount.textContent.includes('Preventivo'), `${variant.name}: the detail still renders`);
    assert.ok(!/Quote q1/.test(mount.textContent), `${variant.name}: no technical id in the heading`);
    assert.ok(mount.textContent.includes('Totale'), `${variant.name}: the totals still render`);
  }
});

test('cf340b571e98: a company-only quote links back to the company card', async () => {
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    opportunityRecord: {
      id: 'o1', companyId: 'co1', companyName: 'Palestra Esempio',
      contactId: null, contactName: null,
    },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1');
  const back = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.ok(back, 'a back link is shown');
  assert.equal(back.getAttribute('href'), '#/customer-card/company/co1', 'the link returns to the company card');
  assert.equal(back.textContent, '← Palestra Esempio', 'the link names the company');
});

test('cf340b571e98: a hostile customer name stays inert text inside the back link', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    opportunityRecord: { id: 'o1', companyId: null, companyName: null, contactId: 'c1', contactName: hostile },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1');
  const back = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'quote-back');
  assert.ok(back, 'a back link is shown');
  assert.ok(back.textContent.includes(hostile), 'the hostile name is present as text');
  assert.equal(back.findAll('img').length, 0, 'no element parsed out of the hostile name');
});

test('quote routes parse canonically; hostile routes are invalid', () => {
  assert.deepEqual(parseModuleRoute('#/quotes'), { view: 'quotes' });
  // A trailing slash normalizes to the list view, exactly as module routes do.
  assert.deepEqual(parseModuleRoute('#/quotes/'), { view: 'quotes' });
  assert.deepEqual(parseModuleRoute('#/quotes/q1'), { view: 'quote-detail', quoteId: 'q1' });
  for (const bad of ['#/quotes//q1', '#/quotes/a/b', '#/quotes/a%2Fb', '#/quotes/%zz']) {
    assert.equal(parseModuleRoute(bad).view, 'invalid', `expected invalid for ${bad}`);
  }
  assert.equal(parseModuleRoute('#/modules/quote').view, 'list', 'module routes unchanged');
});

test('ef92f728: the quote detail shows no English and no technical id, amounts in Italian', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    lines: [LINE],
    versions: [],
    opportunityRecord: {
      id: 'o1', companyId: 'co1', companyName: 'Palestra Esempio',
      contactId: 'c1', contactName: 'Ada Rossi',
      name: 'Proposta esempio — Pacchetto 10 PT', stage: 'proposal',
    },
  });
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  const text = mount.textContent;
  const title = mount.findAll('h2').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-title');
  assert.equal(title?.textContent, 'Proposta esempio — Pacchetto 10 PT', 'the heading names the offer, never an id');
  assert.ok(text.includes('Preventivo'), 'the kicker says it is a quote');
  assert.ok(text.includes('Per Ada Rossi'), 'the quote names who it is for');
  for (const english of [
    'Quote ', 'Totals by', 'Loading', 'Status:', 'Currency', 'Draft revision',
    'Lines (', 'Versions (', 'Add line', 'Update', 'Remove', 'Submit', 'Approve',
    'Reject', 'Revise', 'Signature', 'Order', ' one-time ', 'every 1 month',
    'server-calculated', 'list ', 'discount ', 'net (', 'quantity ', 'flat',
  ]) {
    assert.ok(!text.includes(english), `no English UI text: ${english}`);
  }
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), 'no UUID in visible text');
  assert.ok(text.includes('5.000 €'), 'thousands use the dot separator');
  assert.ok(text.includes('7.790 €'), 'line totals use the dot separator');
  assert.ok(text.includes('5,00%'), 'percentages use the comma');
});

// Dan 05/11: the quote page speaks to the owner — no draft revision, no SKU
// or offer revision, no zero discount, no basis points in the reasons.
test('owner reading: status only, plain line, single-component breakdown hidden, reasons in percent', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const single = {
    ...LINE,
    discountBps: 0,
    discountAmountCents: 0,
    breakdownJson: JSON.stringify([{ componentKey: 'fee', label: 'Prezzo del pacchetto', pricingModel: 'flat', chargeType: 'one_time', listAmountCents: 35_000, netAmountCents: 35_000, tierBreakdown: [] }]),
  };
  const versions = [{ id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'presti-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: 'sconto massimo 0bps entro il limite 1000bps', totalsJson: JSON.stringify(TOTALS), currency: 'EUR' }];
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: quote({ status: 'approved' }), lines: [single], versions }) }).renderQuoteDetail('q1');
  const text = mount.textContent;
  assert.ok(!text.includes('Revisione bozza'), 'no draft revision');
  assert.ok(!text.includes('Valuta'), 'no currency code fact');
  assert.ok(!text.includes('(rev.'), 'no offer revision');
  assert.ok(!text.includes(single.sku + ' ·'), 'no SKU in the line');
  assert.ok(!text.includes('sconto 0,00%'), 'no zero discount on the line');
  assert.ok(!/bps/.test(text), 'no basis points anywhere on the approved quote');
  assert.ok(text.includes('sconto massimo 0% entro il limite 10%'), 'the reason reads in percent');
  const components = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-components');
  assert.equal(components.getAttribute('hidden'), '', 'a single fixed component is not repeated');
});

test('percentReason turns basis points into Italian percentages and keeps other text', () => {
  assert.equal(percentReason('max line discount 2000bps exceeds limit'), 'max line discount 20% exceeds limit');
  assert.equal(percentReason('sconto 1250 bps'), 'sconto 12,5%');
  assert.equal(percentReason(null), '');
});

test('Dan 06/11: the quote is issued by the space and reads as a document beside its workflow', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: quote({ status: 'approved' }), lines: [LINE] }), spaceName: () => 'Presti Group' }).renderQuoteDetail('q1');
  const kicker = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-kicker');
  assert.equal(kicker?.textContent, 'Preventivo · Presti Group', 'the issuing space personalises the quote');
  const page = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote');
  assert.ok(page, 'the detail renders inside the quote layout');
  const sheet = page.findAll('article').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-sheet');
  const side = page.findAll('aside').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-side');
  assert.ok(sheet.textContent.includes('Cosa include') && sheet.textContent.includes('Totale'), 'lines and totals live in the document');
  assert.ok(side.textContent.includes('in sola lettura'), 'the approval state lives in the side column');
  const amount = mount.findAll('span').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-amount');
  assert.equal(amount?.textContent, '5.000 €', 'the one-time total leads the document');
});
