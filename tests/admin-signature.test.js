import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin signature and order section (ADR-017) renders from server state
 * only: an approved quote offers exactly one write control (Request
 * signature), everything else is read-only evidence, provider and customer
 * text renders as text, and no payment/invoice/delivery control exists. The
 * full HTTP path is covered by tests/signature-order-e2e.test.js.
 */

const SCHEMA = {
  commercial: {
    commercialContract: 1,
    discountPolicies: [{ name: 'standard-sales-discount', version: 1, label: 'Standard', fingerprint: 'f'.repeat(64) }],
  },
  signature: {
    signatureContract: 1,
    envelopeStates: ['preparing', 'failed', 'sent', 'delivered', 'completed', 'declined', 'voided'],
    maxSigners: 5,
    providers: [{ name: 'fixture-signature', version: 1, label: 'Fixture signature provider', fingerprint: 'a'.repeat(64) }],
  },
};

const TOTALS = {
  oneTimeTotal: { currency: 'EUR', listAmountCents: 500_000, discountAmountCents: 25_000, netAmountCents: 475_000 },
  recurringTotals: [{ currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 300_000, discountAmountCents: 15_000, netAmountCents: 285_000 }],
};

const APPROVED_QUOTE = {
  id: 'q1',
  opportunityId: 'opp1',
  priceBookId: 'pb1',
  currency: 'EUR',
  status: 'approved',
  draftRevision: 4,
  currentVersionId: 'v1',
  currentVersionNumber: 1,
  totalsJson: JSON.stringify(TOTALS),
  oneTimeNetCents: 475_000,
  recurringGroupCount: 1,
};

const ENVELOPE = {
  id: 'env1',
  quoteId: 'q1',
  quoteVersionId: 'v1',
  provider: 'fixture-signature',
  providerVersion: 1,
  providerEnvelopeId: 'env_abc123',
  status: 'completed',
  documentHash: 'd'.repeat(64),
  documentFormat: 'application/vnd.agent-crm.quote-package+json',
  signerCount: 1,
  failureCode: null,
  failurePhase: null,
};

const SIGNER = {
  id: 's1', envelopeId: 'env1', signerKey: 's1', name: 'Mario Rossi',
  email: 'mario@example.com', role: 'customer', signingOrder: 1, status: 'signed',
};

const ARTIFACT = {
  id: 'a1', envelopeId: 'env1', quoteId: 'q1', quoteVersionId: 'v1',
  providerArtifactId: 'art_1', documentHash: 'd'.repeat(64), artifactHash: 'b'.repeat(64),
  mimeType: 'application/vnd.agent-crm.quote-package+json', sizeBytes: 2048,
  storageRef: 'fixture://artifacts/env_abc123', completedAt: '2026-08-05T12:00:00.000Z',
};

const ORDER = {
  id: 'ord1', quoteId: 'q1', quoteVersionId: 'v1', envelopeId: 'env1',
  status: 'accepted', currency: 'EUR', acceptedAt: '2026-08-05T12:00:00.000Z',
};

const ORDER_TOTALS = [
  { id: 't1', orderId: 'ord1', kind: 'one_time', currency: 'EUR', interval: null, intervalCount: null, netAmountCents: 475_000 },
  { id: 't2', orderId: 'ord1', kind: 'recurring', currency: 'EUR', interval: 'month', intervalCount: 1, netAmountCents: 285_000 },
];

function stubClient({ envelopes = [], signers = [], artifacts = [], orders = [], orderTotals = [], quoteRecord = APPROVED_QUOTE } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return SCHEMA;
      if (options.method === 'POST') return { ok: true, result: { envelope: envelopes[0] ?? ENVELOPE } };
      if (path.startsWith('/api/modules/quote/records/')) return quoteRecord;
      if (path.startsWith('/api/modules/signature-envelope/records')) return { items: envelopes };
      if (path.startsWith('/api/modules/signature-signer/records')) return { items: signers };
      if (path.startsWith('/api/modules/signed-artifact/records')) return { items: artifacts };
      if (path.startsWith('/api/modules/order-total/records')) return { items: orderTotals };
      if (path.startsWith('/api/modules/order/records')) return { items: orders };
      if (path.startsWith('/api/modules/price-book/records')) return { items: [{ id: 'pb1', name: 'Standard EUR', currency: 'EUR', active: true }] };
      return { items: [] };
    },
  };
}

const render = async (client) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createQuoteView({ doc, mount, client });
  await view.renderQuoteDetail('q1');
  return mount;
};

/** The fake DOM has no query engine: find by tag plus class/attribute. */
const byClass = (mount, tag, className) =>
  mount.findAll(tag).find((node) => (node.getAttribute('class') ?? '') === className) ?? null;
const anyByClass = (mount, className) =>
  ['div', 'p', 'input', 'button', 'select', 'small', 'a'].map((tag) => byClass(mount, tag, className)).find(Boolean) ?? null;

test('an approved quote with no envelope offers exactly one send control, with its caveat', async () => {
  const client = stubClient();
  const mount = await render(client);
  const text = mount.textContent;

  assert.ok(text.includes('Signature'), 'the signature section renders');
  assert.ok(text.includes('Request signature'), 'the send control is offered');
  assert.ok(text.includes('human user actor'), 'the human-actor requirement is stated');
  assert.ok(text.includes('not Sales or Legal role enforcement'), 'the boundary is not overclaimed');
  assert.ok(text.includes('Signer identity assurance is not claimed'));
  assert.ok(text.includes('All signers are required'), 'v1 signer semantics are stated');
  // No payment, invoice, delivery or fulfillment control exists anywhere.
  assert.ok(!/payment|invoice|billing|fulfil|delivery note/i.test(text), text);

  const form = byClass(mount, 'div', 'signature-request');
  form.__name.value = 'Mario Rossi';
  form.__email.value = 'mario@example.com';
  await form.__request();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/modules/quote/records/q1/actions/request-signature');
  const payload = JSON.parse(post.body);
  assert.deepEqual(payload.signers, [{ name: 'Mario Rossi', email: 'mario@example.com', order: 1 }]);
  assert.equal(payload.quoteVersionId, 'v1');
  assert.equal(payload.provider, 'fixture-signature');
  assert.equal(payload.providerVersion, 1);
  // The client never sends an amount, a hash or a status.
  assert.deepEqual(Object.keys(payload).sort(), ['provider', 'providerVersion', 'quoteVersionId', 'signers']);
});

test('a completed envelope renders evidence and the order, with no edit controls', async () => {
  const mount = await render(stubClient({
    envelopes: [ENVELOPE], signers: [SIGNER], artifacts: [ARTIFACT], orders: [ORDER], orderTotals: ORDER_TOTALS,
  }));
  const text = mount.textContent;

  assert.equal(byClass(mount, 'div', 'signature-envelope').getAttribute('data-status'), 'completed');
  assert.ok(text.includes('fixture-signature v1'), 'provider identity shown');
  assert.ok(text.includes('env_abc123'), 'provider envelope id shown');
  assert.ok(text.includes('d'.repeat(64)), 'document hash shown');
  assert.ok(text.includes('Mario Rossi'), 'signer shown');
  assert.ok(text.includes('signed'), 'signer status shown');
  assert.ok(text.includes('b'.repeat(64)), 'artifact hash shown');
  assert.ok(text.includes('fixture://artifacts/env_abc123'), 'artifact reference shown');
  assert.ok(text.includes('not a legally qualified signature'), 'the assurance limit is stated');
  assert.ok(text.includes('Long-term object-storage durability is not claimed'));

  // The order and its grouped totals, never summed and never annualized.
  assert.equal(byClass(mount, 'div', 'quote-order').getAttribute('data-order'), 'ord1');
  assert.ok(text.includes('EUR 4,750.00'), 'one-time order total');
  assert.ok(text.includes('EUR 2,850.00'), 'monthly order total');
  assert.ok(text.includes('never recalculated from the current catalog'));
  assert.ok(!/\b(ARR|MRR|TCV)\b/.test(text), 'no annualized figure is derived');

  // Everything here is evidence: no input, select or send control remains.
  assert.equal(anyByClass(mount, 'signature-request'), null, 'no second send control');
  assert.equal(anyByClass(mount, 'quote-add-line'), null, 'no line editing on an approved quote');
  assert.equal(mount.findAll('input').length, 0, 'evidence exposes no input');
  assert.equal(mount.findAll('button').length, 0, 'evidence exposes no control');
  assert.equal(mount.findAll('select').length, 0);
});

test('a failed envelope offers reconciliation, never a second signature request', async () => {
  const failed = { ...ENVELOPE, status: 'failed', providerEnvelopeId: null, failureCode: 'PROVIDER_TIMEOUT', failurePhase: 'external' };
  const client = stubClient({ envelopes: [failed], signers: [{ ...SIGNER, status: 'pending' }] });
  const mount = await render(client);
  const text = mount.textContent;

  assert.ok(text.includes('The external phase failed (PROVIDER_TIMEOUT)'), text);
  assert.ok(text.includes('may still hold this envelope'), 'the honest ambiguity is stated');
  assert.ok(text.includes('reconcile it rather than requesting a second signature'));
  assert.equal(anyByClass(mount, 'signature-request'), null, 'no second send control is ever offered');

  await byClass(mount, 'div', 'signature-envelope').__reconcile();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/signature/envelopes/env1/reconcile');
});

test('provider and customer text renders as text, never as markup', async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const mount = await render(stubClient({
    envelopes: [{ ...ENVELOPE, providerEnvelopeId: hostile }],
    signers: [{ ...SIGNER, name: hostile, email: `${hostile}@example.com` }],
    artifacts: [{ ...ARTIFACT, storageRef: hostile }],
    orders: [ORDER],
    orderTotals: ORDER_TOTALS,
  }));
  assert.equal(mount.findAll('img').length, 0, 'no parsed img from provider data');
  assert.equal(mount.findAll('script').length, 0, 'no parsed script from signer data');
  assert.ok(mount.textContent.includes(hostile), 'the hostile value is shown verbatim as text');
});

test('a project without signature enabled degrades to a clear message', async () => {
  const client = {
    calls: [],
    async request(path, options = {}) {
      client.calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/schema') return { commercial: SCHEMA.commercial };
      if (path.startsWith('/api/modules/quote/records/')) return APPROVED_QUOTE;
      if (path.startsWith('/api/modules/price-book/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = await render(client);
  assert.ok(mount.textContent.includes('Signature is not enabled in this project.'));
  assert.equal(anyByClass(mount, 'signature-request'), null);
  assert.ok(!client.calls.some((call) => call.path.includes('signature-envelope')), 'no signature records are fetched');
});
