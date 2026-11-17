import test from 'node:test';
import assert from 'node:assert/strict';
import { bpsToPercentText, createQuoteView, percentReason, percentToBps } from '../apps/admin/public/admin-quotes.js';
import { parseModuleRoute, italianDay } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * The Quote builder renders from server state only — these tests drive it
 * against a stub client so lifecycle-dependent controls, server-authoritative
 * amounts, action payloads, XSS safety and stale-render protection are
 * asserted precisely. The full HTTP path is covered by
 * tests/commercial-e2e.test.js.
 */

/** The non-breaking space the quote view keeps with its number (backlog:cf270ae1f808). */
const NBSP = String.fromCharCode(160);

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

function stubClient({ quoteRecord = quote(), lines = [], entries = [], versions = [], failAction, opportunityRecord, failOpportunity = false, opportunities = [], failOffers = false } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return SCHEMA;
      if (path.startsWith('/api/opportunities?')) {
        if (failOffers) throw Object.assign(new Error('Service Unavailable'), { status: 503 });
        return { items: opportunities };
      }
      if (options.method === 'POST') {
        if (failAction) throw Object.assign(new Error(failAction.message), failAction);
        return { ok: true, result: { quote: quoteRecord } };
      }
      if (path.startsWith('/api/modules/opportunity/records/')) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (/^\/api\/opportunities\/[^/?]+$/.test(path)) {
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
  assert.ok(text.includes('5.000' + NBSP + '€'), `one-time total rendered (${text})`);
  assert.ok(text.includes('3.200' + NBSP + '€'), 'monthly total rendered');
  assert.ok(text.includes('9.500' + NBSP + '€'), 'annual total rendered');
  assert.ok(text.includes('Una tantum'), 'the one-time group is labelled');
  assert.ok(text.includes('Ricorrente ogni 1 mese'), 'the monthly group is labelled');
  assert.ok(text.includes('Ricorrente ogni 1 anno'), 'the annual group is labelled');
  assert.ok(!/ARR|MRR|TCV/.test(text), 'no ARR/MRR/TCV is implied');
  assert.ok(text.includes('non si sommano tra loro'), 'the grouping contract is disclosed');
  assert.ok(!text.includes('server'), 'voce ef92f728: no developer note about who computes the amounts');
  assert.ok(text.includes('5,00%'), 'basis points shown as a percentage');
  assert.ok(text.includes('Lo sconto è in percentuale'), 'the discount unit is explained in percent (backlog:a2ea75f705fd)');
  assert.ok(!/punti base/i.test(text), 'never «punti base»');
  assert.ok(text.includes('le quote fisse si addebitano una volta'), 'quantity semantics disclosed');
  // Component breakdown with the tier band.
  const components = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '') === 'quote-component');
  assert.equal(components.length, 3, 'every component of the composite offer is shown');
  assert.ok(components[0].textContent.includes('una tantum'), 'charge type shown');
  assert.ok(components[1].textContent.includes('ogni 1 mese'), 'recurrence shown');
  const tiers = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '') === 'quote-tier');
  assert.equal(tiers.length, 1, 'the tier band is shown');
  assert.ok(tiers[0].textContent.includes('30 × 40' + NBSP + '€'), `tier breakdown rendered (${tiers[0].textContent})`);
  // Draft controls exist; approval/revise controls do not.
  assert.ok(mount.findAll('div').some((node) => (node.getAttribute('class') ?? '') === 'quote-add-line'));
  assert.ok(mount.findAll('div').some((node) => (node.getAttribute('class') ?? '') === 'quote-submit'));
  assert.equal(mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-decide').length, 0);
  assert.equal(mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-revise').length, 0);
});

test('adding a line posts the server action with quantity, the percent as basis points and the draft revision', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ lines: [LINE], entries: [ENTRY] });
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');

  const addPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-add-line');
  addPanel.__quantity.value = '5';
  addPanel.__discount.value = '7,5';
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
  assert.ok(rows[1].textContent.includes('una tantum 5.000' + NBSP + '€'), 'versions show grouped periods');
  assert.ok(rows[1].textContent.includes('3.200' + NBSP + '€ ogni 1 mese'), 'recurring period shown per version');
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
  assert.ok(listText.includes('3.200' + NBSP + '€ ogni 1 mese'), 'the list shows the recurring group with its period');
  assert.ok(!listText.includes('una tantum'), 'the list never shows a zero one-time total for a subscription-only quote');

  const doc = createFakeDocument();
  const mount = createMount();
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: record, versions }) }).renderQuoteDetail('q1');
  const text = mount.textContent;
  assert.ok(text.includes('3.200' + NBSP + '€'), 'the valued recurring group leads the hero');
  assert.ok(!text.includes('una tantum 0'), 'the hero never shows a zero one-time total');
  assert.ok(text.includes('standard-sales-discount@1'), 'the history row names the deciding policy');
  assert.ok(text.includes('Versione 1 · Approvazione automatica · standard-sales-discount@1 · 3.200' + NBSP + '€ ogni 1 mese'), 'the history row keeps the recurring period');
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
  assert.ok(text.includes('5.000' + NBSP + '€'), 'the detail still shows the total');
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
  assert.equal(title?.textContent, 'Preventivo · Ada Rossi — Proposta esempio — Pacchetto 10 PT', 'backlog:cf270ae1f808: the heading names the customer and the offer, never an id');
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
  assert.ok(text.includes('5.000' + NBSP + '€'), 'thousands use the dot separator');
  assert.ok(text.includes('7.790' + NBSP + '€'), 'line totals use the dot separator');
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
  assert.equal(amount?.textContent, '5.000' + NBSP + '€', 'the one-time total leads the document');
});


// backlog:a2ea75f705fd (verifica 12/11, pilota 62654a1): the quote reads
// its discount in percent or euro, never «punti base»; an empty rule menu
// never shows; the way back reads the offer on its own route.
test('a2ea75f705fd: the discount is written and read in percent, never «punti base»', async () => {
  assert.equal(percentToBps('7,5'), 750);
  assert.equal(percentToBps('10'), 1000);
  assert.equal(percentToBps(' 12.25 % '), 1225);
  assert.equal(percentToBps(''), 0, 'empty is no discount');
  for (const bad of ['abc', '101', '7,555', '-5', '1e2']) assert.equal(percentToBps(bad), null, bad);
  assert.equal(bpsToPercentText(750), '7,5');
  assert.equal(bpsToPercentText(1000), '10');
  assert.equal(bpsToPercentText(0), '0');

  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ lines: [{ ...LINE, discountAmountCents: 60000 }], entries: [ENTRY] });
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  const text = mount.textContent;
  assert.ok(!/punti base/i.test(text), 'no «punti base» anywhere');
  assert.ok(text.includes('Sconto (%)'), 'the field says percent');
  assert.ok(text.includes('sconto 5,00% (−600' + NBSP + '€)'), 'the line reads the discount in percent and in euro');
  const row = mount.findAll('div').find((node) => node.getAttribute('data-line') === LINE.id);
  assert.equal(row.__discount.value, '5', 'the line field shows its percent, not 500');

  const addPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-add-line');
  addPanel.__discount.value = 'tanto';
  await addPanel.__add();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'a malformed discount sends nothing');
  const error = mount.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error');
  assert.match(error.textContent, /Scrivi lo sconto in percentuale, da 0 a 100/);
});

test('a2ea75f705fd: the discount rule shows only when there is a choice; none means no empty menu', async () => {
  const one = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: one, client: stubClient({ lines: [LINE], entries: [ENTRY] }) }).renderQuoteDetail('q1');
  assert.ok(!one.textContent.includes('Regola di sconto'), 'one rule is applied, never a menu of one');
  assert.ok(one.findAll('button').some((node) => node.textContent === 'Invia'), 'the send stays');

  const policies = [
    { name: 'standard-sales-discount', version: 1, label: 'Standard', fingerprint: 'f'.repeat(64) },
    { name: 'standard-sales-discount', version: 2, label: 'Standard', fingerprint: 'e'.repeat(64) },
  ];
  const withSchema = (schema) => {
    const base = stubClient({ lines: [LINE], entries: [ENTRY] });
    return { calls: base.calls, request: (path, options) => (path === '/api/schema' ? Promise.resolve(schema) : base.request(path, options)) };
  };
  const two = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: two, client: withSchema({ ...SCHEMA, commercial: { ...SCHEMA.commercial, discountPolicies: policies } }) }).renderQuoteDetail('q1');
  assert.ok(two.textContent.includes('Regola di sconto'), 'two rules are a choice');

  const none = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: none, client: withSchema({ ...SCHEMA, commercial: { ...SCHEMA.commercial, discountPolicies: [] } }) }).renderQuoteDetail('q1');
  assert.ok(!none.textContent.includes('Regola di sconto'), 'no empty rule menu');
  assert.ok(!none.findAll('button').some((node) => node.textContent === 'Invia'), 'no send that cannot work');
  assert.ok(none.textContent.includes('L’invio per l’approvazione non è ancora disponibile in questo spazio.'));
});

test('a2ea75f705fd: the way back reads the offer on its own route, never a generic read that 404s', async () => {
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    lines: [LINE],
    opportunityRecord: { id: 'o1', contactId: 'c1', contactName: 'Ada Rossi', name: 'Proposta esempio' },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1');
  const paths = client.calls.map((call) => call.path);
  assert.ok(paths.includes('/api/opportunities/o1'));
  assert.ok(!paths.some((path) => path.startsWith('/api/modules/opportunity/records/')), 'no read on the generic surface');
});


test('a2ea75f705fd: the quote links to its offer page; with no rule, «Invia» is not there at all', async () => {
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'draft', opportunityId: 'o1' }),
    lines: [LINE],
    entries: [ENTRY],
    opportunityRecord: { id: 'o1', contactId: 'c1', contactName: 'Ada Rossi', name: 'Proposta esempio' },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1');
  const offer = mount.findAll('a').find((node) => node.getAttribute('data-action') === 'quote-open-offer');
  assert.ok(offer, 'the quote names the way to its offer');
  assert.equal(offer.getAttribute('href'), '#/offerte/o1');
  const noCustomer = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: noCustomer, client: stubClient({
    quoteRecord: quote({ status: 'draft', opportunityId: 'o1' }), lines: [LINE], entries: [ENTRY],
    opportunityRecord: { id: 'o1', name: 'Senza cliente' },
  }) }).renderQuoteDetail('q1');
  assert.ok(noCustomer.findAll('a').some((node) => node.getAttribute('href') === '#/offerte/o1'), 'the offer link stays even without a customer to go back to');

  const base = stubClient({ lines: [LINE], entries: [ENTRY] });
  const noRules = { calls: base.calls, request: (path, options) => (path === '/api/schema' ? Promise.resolve({ ...SCHEMA, commercial: { ...SCHEMA.commercial, discountPolicies: [] } }) : base.request(path, options)) };
  const none = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount: none, client: noRules }).renderQuoteDetail('q1');
  const submitPanel = none.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-submit');
  assert.equal(submitPanel.findAll('button').length, 0, 'no «Invia» that could send without a rule');
  assert.equal(submitPanel.findAll('select').length, 0, 'no empty rule menu');
});

function listView(overrides = {}, navigate) {
  const navigated = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createQuoteView({
    doc, mount,
    client: stubClient(overrides),
    navigate: navigate ?? ((hash) => navigated.push(hash)),
  });
  return { doc, mount, navigated, view, render: () => view.renderQuoteList() };
}

test('47b89e19: the list has no manual id field; quotes are created from the offer', async () => {
  const { mount, render } = listView();
  await render();
  assert.equal(mount.findAll('input').length, 0, 'no field to type an id by hand');
  assert.equal(mount.findAll('select').length, 0, 'no price-book menu on the list');
  assert.equal(mount.findAll('button').length, 0, 'no create button on the list');
  assert.ok(!mount.textContent.includes('ID offerta'), 'no «ID offerta» placeholder');
  assert.ok(mount.textContent.includes('si creano dall’offerta'), 'the list says where quotes are created');
});

test('47b89e19: each row shows stato, importo and the linked offer like the offer page', async () => {
  const { mount, render } = listView({
    opportunities: [{ id: 'opp1', name: 'Pacchetto 10 PT' }],
  });
  await render();
  const rows = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'offer-quote');
  assert.equal(rows.length, 1, 'one row per quote');
  const row = rows[0];
  assert.equal(row.getAttribute('data-quote'), 'q1');
  const pill = row.findAll('span').find((node) => String(node.getAttribute('class') ?? '').startsWith('quote-status '));
  assert.ok(pill, 'the stato pill is there');
  assert.equal(pill.textContent, 'Bozza', 'the stato reads Italian, never the raw status');
  assert.ok(row.textContent.includes('5.000' + NBSP + '€'), 'the importo is the server total');
  assert.ok(row.textContent.includes('Offerta:'), 'the linked offer is named');
  assert.ok(row.textContent.includes('Pacchetto 10 PT'), 'the offer reads by name, never a bare id');
  const open = row.findAll('a').find((node) => (node.getAttribute('class') ?? '') === 'offer-quote-open');
  assert.ok(open, 'the open link uses the offer-page component');
  assert.equal(open.getAttribute('href'), '#/quotes/q1');
  const opens = row.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'offer-quote-open');
  assert.equal(opens.length, 1, 'one quote link per row');
  const offerLinks = row.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'quote-offer-link');
  assert.equal(offerLinks.length, 1, 'one offer link per row, with its own class');
  assert.equal(offerLinks[0].getAttribute('href'), '#/offerte/opp1');
  assert.equal(offerLinks[0].textContent, 'Pacchetto 10 PT');
});

test('47b89e19: a linked offer missing from the map reads as plain text, without a link', async () => {
  const { mount, render } = listView({ opportunities: [] });
  await render();
  const row = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-quote');
  assert.ok(row.textContent.includes('Offerta non leggibile'), 'no link to an offer that may not exist');
  assert.equal(row.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'quote-offer-link').length, 0);
  assert.equal(row.findAll('a').filter((node) => (node.getAttribute('class') ?? '') === 'offer-quote-open').length, 1, 'the quote still opens');
});

test('47b89e19: opening a quote from the list stays in the router, without a reload', async () => {
  const { mount, navigated, render } = listView({
    opportunities: [{ id: 'opp1', name: 'Pacchetto 10 PT' }],
  });
  await render();
  const row = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-quote');
  for (const link of row.findAll('a')) {
    let prevented = false;
    link.listeners.click[0]({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented, `the default navigation is stopped for ${link.getAttribute('href')}`);
  }
  assert.deepEqual(navigated, ['#/quotes/q1', '#/offerte/opp1'], 'both links go through navigate(), setting only the hash');
});

test('47b89e19: unreadable linked offers degrade to an honest line, rows stay', async () => {
  const { mount, render } = listView({ failOffers: true });
  await render();
  assert.ok(mount.textContent.includes('Offerte collegate non leggibili'), 'the missing offers read plainly');
  const rows = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'offer-quote');
  assert.equal(rows.length, 1, 'righe, stato and importo still render');
  assert.ok(rows[0].textContent.includes('Bozza'), 'the stato stays');
  assert.ok(rows[0].textContent.includes('5.000' + NBSP + '€'), 'the importo stays');
});

test('47b89e19: the detail links stay in the router too (offer, scheda, version)', async () => {
  const mount = createMount();
  const navigated = [];
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    lines: [LINE],
    versions: [
      { id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: null, totalsJson: JSON.stringify(TOTALS), currency: 'EUR' },
    ],
    opportunityRecord: {
      id: 'o1', companyId: 'co1', companyName: 'Palestra Esempio',
      contactId: 'c1', contactName: 'Ada Rossi',
      name: 'Proposta esempio — Pacchetto 10 PT', stage: 'proposal',
    },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client, navigate: (hash) => navigated.push(hash) }).renderQuoteDetail('q1');
  const links = mount.findAll('a').filter((node) =>
    ['quote-offer-link', 'quote-back', 'quote-version-open'].includes(node.getAttribute('class')));
  assert.equal(links.length, 3, 'offer, back and version links are all present');
  for (const link of links) {
    let prevented = false;
    link.listeners.click[0]({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented, `the default navigation is stopped for ${link.getAttribute('href')}`);
  }
  assert.deepEqual(navigated, ['#/customer-card/contact/c1', '#/offerte/o1', '#/modules/quote-version/v1'],
    'every link goes through navigate(), setting only the hash');
});

test('cf270ae1f808: each list row shows cliente and data beside stato and importo', async () => {
  const { mount, render } = listView({
    quoteRecord: quote({ createdAt: '2026-11-10' }),
    opportunities: [{ id: 'opp1', name: 'Pacchetto 10 PT', contactName: 'Ada Rossi' }],
  });
  await render();
  const row = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'offer-quote');
  assert.ok(row.textContent.includes('Cliente: Ada Rossi'), 'the row names the customer');
  assert.ok(row.textContent.includes(italianDay('2026-11-10')), 'the row shows the date');
});

test('cf270ae1f808 review giro 1 P2: the title keeps both names when both are known', async () => {
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    lines: [LINE],
    versions: [],
    opportunityRecord: {
      id: 'o1', contactId: 'c1', contactName: 'Ada Rossi',
      name: 'Proposta esempio — Pacchetto 10 PT',
    },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1');
  const title = mount.findAll('h2').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-title');
  assert.equal(title?.textContent, 'Preventivo · Ada Rossi — Proposta esempio — Pacchetto 10 PT',
    'two quotes for the same customer from different offers never share a title');
});

test('cf270ae1f808: the title keeps the customer when the offer name is missing', async () => {
  const mount = createMount();
  const client = stubClient({
    quoteRecord: quote({ status: 'approved', opportunityId: 'o1' }),
    lines: [LINE],
    versions: [],
    opportunityRecord: { id: 'o1', contactId: 'c1', contactName: 'Ada Rossi' },
  });
  await createQuoteView({ doc: createFakeDocument(), mount, client }).renderQuoteDetail('q1');
  const title = mount.findAll('h2').find((node) => (node.getAttribute('class') ?? '') === 'bo-quote-title');
  assert.equal(title?.textContent, 'Preventivo · Ada Rossi', 'customer in the title, never a bare «Preventivo»');
});

test('cf270ae1f808: the euro sign never wraps away from its number', async () => {
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client: stubClient({ lines: [LINE], entries: [ENTRY] }) }).renderQuoteDetail('q1');
  assert.ok(mount.textContent.includes('5.000' + NBSP + '€'), 'amount and sign stay together');
  assert.ok(!mount.textContent.includes('5.000 €'), 'no breaking space before the sign');
});

test('cf270ae1f808: the detail paints at once, never a blank page', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inner = stubClient({ lines: [LINE], entries: [ENTRY] });
  const client = { calls: inner.calls, request: (path, options) => gate.then(() => inner.request(path, options)) };
  const pending = createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  assert.ok(mount.textContent.includes('Preventivo'), 'the heading paints before any read lands');
  // backlog:d56122ee2844 (merged as #941): the wait is a skeleton with one
  // spoken line, not the old «Caricamento…» status.
  assert.ok(mount.textContent.includes('Carico il preventivo'), 'the wait is announced while the reads are in flight');
  assert.ok(mount.findAll('span').some((node) => node.getAttribute('data-skeleton') === 'true'), 'skeleton bars paint at once');
  release();
  await pending;
  assert.ok(mount.textContent.includes('Cosa include'), 'the content replaces the wait');
});

test('b9b7912320f8: a flat-fee line reads «Quota fissa» with its quantity locked', async () => {
  const flatLine = {
    ...LINE,
    id: 'l2',
    offerName: 'Lezione di prova',
    quantity: 2,
    discountBps: 0,
    discountAmountCents: 0,
    breakdownJson: JSON.stringify({ components: [{ componentId: 'f1', componentKey: 'trial', label: 'Lezione di prova', pricingModel: 'flat_fee', chargeType: 'one_time', listAmountCents: 3000, netAmountCents: 3000, tierBreakdown: [] }] }),
    listAmountCents: 3000,
    netAmountCents: 3000,
  };
  const mount = createMount();
  await createQuoteView({ doc: createFakeDocument(), mount, client: stubClient({ lines: [LINE, flatLine], entries: [ENTRY] }) }).renderQuoteDetail('q1');
  const rows = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-line');
  assert.equal(rows.length, 2, 'both lines render');
  const mixed = rows.find((node) => node.getAttribute('data-line') === 'l1');
  assert.ok(mixed.textContent.includes('Quantità 30'), 'a mixed line still offers its quantity');
  assert.equal(mixed.__quantity.disabled, false, 'a mixed line quantity stays editable');
  const flat = rows.find((node) => node.getAttribute('data-line') === 'l2');
  assert.ok(flat.textContent.includes('Quota fissa'), 'a flat-fee line reads «Quota fissa»');
  assert.ok(!flat.textContent.includes('Quantità 2'), 'never a quantity that changes nothing');
  assert.equal(flat.__quantity.disabled, true, 'the flat quantity is locked');
  assert.ok(flat.textContent.includes('la quantità non cambia il prezzo'), 'the lock explains itself');
});

test('d56122ee2844: the detail paints a skeleton at once and reads in parallel', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let active = 0;
  let peak = 0;
  const inner = stubClient({ lines: [LINE], entries: [ENTRY] });
  const client = {
    calls: inner.calls,
    async request(path, options = {}) {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await inner.request(path, options);
      } finally {
        active--;
      }
    },
  };
  const view = createQuoteView({ doc, mount, client });
  const pending = view.renderQuoteDetail('q1');
  const bars = mount.findAll('span').filter((node) => node.getAttribute('data-skeleton') === 'true');
  assert.ok(bars.length > 0, 'skeleton bars paint before any read lands');
  assert.ok(mount.textContent.includes('Carico il preventivo'), 'the wait is announced once to assistive tech');
  await pending;
  assert.ok(peak >= 2, `reads overlap instead of queuing (peak ${peak})`);
  assert.ok(!mount.textContent.includes('Carico il preventivo'), 'the skeleton is replaced by the content');
  assert.ok(mount.textContent.includes('Cosa include'), 'lines paint');
  assert.ok(mount.textContent.includes('Totale'), 'totals paint');
});

test('d56122ee2844: after adding a line the old page stays while the rewrite reads', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient({ lines: [LINE], entries: [ENTRY] });
  let slow = false;
  const client = {
    calls: inner.calls,
    request(path, options = {}) {
      if (slow && (options.method ?? 'GET') === 'GET') {
        return new Promise((resolve) => setTimeout(() => resolve(inner.request(path, options)), 30));
      }
      return inner.request(path, options);
    },
  };
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');
  assert.ok(mount.textContent.includes('Enterprise Plan'), 'the line is on the page');
  slow = true;
  const addPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-add-line');
  const reload = addPanel.__add();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(mount.textContent.includes('Enterprise Plan'), 'the old page stays visible while the rewrite reads');
  await reload;
  assert.ok(mount.textContent.includes('Enterprise Plan'), 'the new paint lands');
  assert.ok(client.calls.some((call) => call.method === 'POST'), 'the write went out');
});

test('d56122ee2844 review giro 1 P1: router entry on a pre-painted mount still paints the skeleton', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  // The router pre-paints its generic loading line before the view runs
  // (paintScreenLoading): the mount is never empty on a real navigation.
  const loading = doc.createElement('p');
  loading.setAttribute('class', 'muted');
  loading.textContent = 'Carico …';
  mount.appendChild(loading);
  const inner = stubClient({ lines: [LINE], entries: [ENTRY] });
  const client = {
    calls: inner.calls,
    request(path, options = {}) {
      return new Promise((resolve, reject) => setTimeout(() => {
        inner.request(path, options).then(resolve, reject);
      }, 20));
    },
  };
  const view = createQuoteView({ doc, mount, client });
  const pending = view.renderQuoteDetail('q1');
  const bars = mount.findAll('span').filter((node) => node.getAttribute('data-skeleton') === 'true');
  assert.ok(bars.length > 0, 'the skeleton replaces the router loading line at once');
  assert.ok(mount.textContent.includes('Carico il preventivo'), 'the wait is announced once to assistive tech');
  await pending;
  assert.ok(mount.textContent.includes('Cosa include'), 'lines paint');
});

test('d56122ee2844 review giro 1 P1: a failed read after navigation paints the honest error, never a hanging line', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const loading = doc.createElement('p');
  loading.setAttribute('class', 'muted');
  loading.textContent = 'Carico …';
  mount.appendChild(loading);
  const client = {
    async request() { throw Object.assign(new Error('Service Unavailable'), { status: 500 }); },
  };
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  assert.ok(mount.textContent.includes('Preventivo non leggibile'), 'the honest error replaces the loading line');
  assert.ok(!mount.textContent.includes('Carico …'), 'no loading line hangs forever');
});

test('d56122ee2844 review giro 1 P1: a failed re-read keeps the painted page with the honest message', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient({ lines: [LINE], entries: [ENTRY] });
  let failReads = false;
  const client = {
    calls: inner.calls,
    async request(path, options = {}) {
      if (failReads && (options.method ?? 'GET') === 'GET') {
        throw Object.assign(new Error('boom'), { status: 500 });
      }
      return inner.request(path, options);
    },
  };
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');
  assert.ok(mount.textContent.includes('Enterprise Plan'), 'the detail painted');
  failReads = true;
  // Arbitrato giro 2: la rilettura keep:true fallita disegna l'errore E
  // rilancia, così il chiamante (withBusy) riattiva i controlli.
  await assert.rejects(view.renderQuoteDetail('q1', { keep: true }), 'the failed keep re-read reports to its caller');
  assert.ok(mount.textContent.includes('Enterprise Plan'), 'the old page stays');
  const errorLine = mount.querySelector('.field-error');
  assert.ok(errorLine, 'the painted page keeps its error line');
  assert.ok(errorLine.textContent.includes('Preventivo non leggibile'), 'the honest message lands on the existing page');
});

test('d56122ee2844 arbitrato giro 2 P1: a failed keep re-read re-enables every edit control', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const inner = stubClient({ lines: [LINE], entries: [ENTRY] });
  let failReads = false;
  const client = {
    calls: inner.calls,
    async request(path, options = {}) {
      if (failReads && (options.method ?? 'GET') === 'GET') {
        throw Object.assign(new Error('boom'), { status: 500 });
      }
      return inner.request(path, options);
    },
  };
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');
  assert.ok(mount.textContent.includes('Enterprise Plan'), 'the detail painted');
  const addPanel = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'quote-add-line');
  assert.ok(addPanel && typeof addPanel.__add === 'function', 'the add-line hook is exposed');
  failReads = true;
  await addPanel.__add();
  const errorLine = mount.querySelector('.field-error');
  assert.ok(errorLine && errorLine.textContent.includes('Preventivo non leggibile'), 'the honest message lands on the existing page');
  const buttons = mount.findAll('button');
  assert.ok(buttons.length > 0, 'edit controls exist');
  for (const button of buttons) {
    assert.equal(button.disabled, false, `control «${button.textContent}» is enabled again`);
  }
});
