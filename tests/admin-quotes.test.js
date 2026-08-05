import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

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
    discountPolicies: [{ name: 'standard-sales-discount', version: 1, label: 'Standard', fingerprint: 'f'.repeat(64) }],
  },
};

function quote(overrides = {}) {
  return {
    id: 'q1',
    opportunityId: 'opp1',
    priceBookId: 'pb1',
    currency: 'EUR',
    status: 'draft',
    draftRevision: 3,
    subtotalCents: 1_800_000,
    discountCents: 30_000,
    totalCents: 1_770_000,
    currentVersionId: null,
    currentVersionNumber: null,
    ...overrides,
  };
}

function stubClient({ quoteRecord = quote(), lines = [], entries = [], versions = [], failAction } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return SCHEMA;
      if (options.method === 'POST') {
        if (failAction) throw Object.assign(new Error(failAction.message), failAction);
        return { ok: true, result: { quote: quoteRecord } };
      }
      if (path.startsWith('/api/modules/quote/records/')) return quoteRecord;
      if (path.startsWith('/api/modules/quote-line/records')) return { items: lines };
      if (path.startsWith('/api/modules/price-book-entry/records')) return { items: entries };
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
  sku: 'SEAT-A',
  name: 'User Seat — Annual',
  quantity: 20,
  discountBps: 500,
  listUnitAmountCents: 30_000,
  lineTotalCents: 570_000,
  removed: false,
  position: 1,
};

const ENTRY = {
  id: 'e1',
  priceBookId: 'pb1',
  logicalKey: 'fixture:entry:user-seat-eur',
  unitAmountCents: 30_000,
  currency: 'EUR',
  pricingMode: 'recurring',
  recurringInterval: 'year',
  active: true,
};

test('draft quotes show server-calculated totals and line/submit controls', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ lines: [LINE], entries: [ENTRY] });
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');

  const text = mount.textContent;
  assert.ok(text.includes('EUR 18,000.00'), `subtotal rendered under the 1/100 contract (${text})`);
  assert.ok(text.includes('EUR 17,700.00'), 'total rendered');
  assert.ok(text.includes('server-calculated'), 'the money contract is disclosed');
  assert.ok(text.includes('5.00%'), 'basis points shown as a percentage');
  assert.ok(text.includes('Discount in basis points'), 'the discount unit is explained');
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
    priceBookEntryId: 'e1',
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
  assert.ok(pending.textContent.includes('Production Spine'), 'the role-enforcement boundary is stated honestly');
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
  assert.ok(approved.textContent.includes('read-only'), 'approved quotes are read-only');
  assert.equal(approved.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-add-line').length, 0);
  assert.equal(approved.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-decide').length, 0);
  assert.ok(!approved.textContent.toLowerCase().includes('signature'), 'no signature UI in M10');
});

test('version history lists immutable versions with their policy decision', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const versions = [
    { id: 'v1', quoteId: 'q1', versionNumber: 1, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'approval_required', decisionReason: 'max line discount 2000bps exceeds limit', totalCents: 960_000, currency: 'EUR' },
    { id: 'v2', quoteId: 'q1', versionNumber: 2, policy: 'standard-sales-discount', policyVersion: 1, policyDecision: 'auto_approve', decisionReason: null, totalCents: 1_104_000, currency: 'EUR' },
  ];
  await createQuoteView({ doc, mount, client: stubClient({ quoteRecord: quote({ status: 'approved' }), versions }) }).renderQuoteDetail('q1');
  const rows = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '') === 'quote-version-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('data-version'), 'v2', 'newest version first');
  assert.ok(rows[1].textContent.includes('approval_required'));
  assert.ok(rows[1].textContent.includes('EUR 9,600.00'));
});

test('hostile catalog and quote values render as inert text', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    lines: [{ ...LINE, name: hostile, sku: hostile }],
    entries: [{ ...ENTRY, logicalKey: hostile }],
  });
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  const lineRow = mount.findAll('div').find((node) => node.getAttribute('data-line') === 'l1');
  assert.ok(lineRow.textContent.includes(hostile), 'hostile value present as text');
  assert.equal(lineRow.findAll('img').length, 0, 'no element parsed out of the hostile value');
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
