import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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
  documentFormat: 'application/vnd.accordo.quote-package+json',
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
  mimeType: 'application/vnd.accordo.quote-package+json', sizeBytes: 2048,
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
      enforceAdminWriteGate(path, options);
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

  assert.ok(text.includes('Firma'), 'the signature section renders');
  assert.ok(text.includes('Richiedi firma'), 'the send control is offered');
  assert.ok(text.includes('parte davvero verso il firmatario'), 'the real external effect is stated in plain words');
  assert.ok(!text.includes('Production Spine'), 'no internal milestone name on the page');
  assert.ok(text.includes('Nessuna garanzia sull’identità dei firmatari'));
  assert.ok(text.includes('Tutti i firmatari devono firmare'), 'v1 signer semantics are stated');
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
  assert.ok(text.includes('Servizio di firma: Fixture signature provider'), 'the provider reads by its label');
  // Voce ef92f728: ids, hashes and references are evidence on the nodes,
  // never words on the owner's page.
  const envelopeNode = byClass(mount, 'div', 'signature-envelope');
  assert.equal(envelopeNode.getAttribute('data-provider-envelope'), 'env_abc123', 'provider envelope id kept as evidence');
  assert.equal(envelopeNode.getAttribute('data-document-hash'), 'd'.repeat(64), 'document hash kept as evidence');
  assert.ok(!text.includes('env_abc123') && !text.includes('d'.repeat(64)), 'no provider id nor hash in visible text');
  assert.ok(text.includes('Mario Rossi'), 'signer shown');
  assert.ok(text.includes('firmato'), 'signer status shown');
  const artifactNode = byClass(mount, 'div', 'signed-artifact');
  assert.equal(artifactNode.getAttribute('data-artifact-hash'), 'b'.repeat(64), 'artifact hash kept as evidence');
  assert.equal(artifactNode.getAttribute('data-storage-ref'), 'fixture://artifacts/env_abc123', 'artifact reference kept as evidence');
  assert.ok(!text.includes('b'.repeat(64)) && !text.includes('fixture://'), 'no artifact hash nor reference in visible text');
  assert.ok(text.includes('Firmato il: 5 ago 2026'), 'the signing day reads in Italian');
  assert.ok(text.includes('accettato il 5 ago 2026'), 'the order day reads in Italian');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), 'no raw ISO timestamp');
  assert.ok(text.includes('non è una firma legalmente qualificata'), 'the assurance limit is stated');
  assert.ok(text.includes('Nessuna garanzia di conservazione a lungo termine'));

  // The order and its grouped totals, never summed and never annualized.
  assert.equal(byClass(mount, 'div', 'quote-order').getAttribute('data-order'), 'ord1');
  assert.ok(text.includes('Una tantum: 4.750 € netto'), 'one-time order total');
  assert.ok(text.includes('Ricorrente ogni 1 mese: 2.850 € netto'), 'monthly order total');
  assert.ok(text.includes('mai ricalcolati dal listino attuale'));
  assert.ok(!/\b(ARR|MRR|TCV)\b/.test(text), 'no annualized figure is derived');

  // Everything here is evidence: no input, select or send control remains.
  assert.equal(anyByClass(mount, 'signature-request'), null, 'no second send control');
  assert.equal(anyByClass(mount, 'quote-add-line'), null, 'no line editing on an approved quote');
  assert.equal(mount.findAll('input').length, 0, 'evidence exposes no input');
  assert.equal(mount.findAll('button').length, 0, 'evidence exposes no control');
  assert.equal(mount.findAll('select').length, 0);
});

test('a failed envelope states its uncertainty honestly and offers reconciliation', async () => {
  // Unknown outcome: the provider may or may not hold it.
  const unknown = { ...ENVELOPE, status: 'failed', providerEnvelopeId: null, failureCode: 'PROVIDER_TIMEOUT', failurePhase: 'external' };
  const client = stubClient({ envelopes: [unknown], signers: [{ ...SIGNER, status: 'pending' }] });
  const mount = await render(client);
  assert.ok(mount.textContent.includes('L’invio per la firma non è andato a buon fine.'), mount.textContent);
  assert.ok(!mount.textContent.includes('PROVIDER_TIMEOUT') && !mount.textContent.includes('external'), 'phase and code stay out of the page');
  assert.equal(byClass(mount, 'div', 'signature-envelope').getAttribute('data-failure-code'), 'PROVIDER_TIMEOUT', 'the code stays on the node');
  assert.ok(mount.textContent.includes('Non si sa se il fornitore ha accettato'), 'an unknown provider outcome is never presented as known');
  assert.ok(mount.textContent.includes('mai chiedere una seconda firma'));
  assert.equal(anyByClass(mount, 'signature-request'), null, 'no second send control is ever offered');
  await byClass(mount, 'div', 'signature-envelope').__reconcile();
  assert.equal(client.calls.find((call) => call.method === 'POST').path, '/api/signature/envelopes/env1/reconcile');

  // Known acceptance: only the local step after it failed.
  const accepted = await render(stubClient({ envelopes: [{ ...unknown, providerEnvelopeId: 'env_abc123', failurePhase: 'finalize', failureCode: 'INJECTED' }] }));
  assert.ok(accepted.textContent.includes('HA accettato questa busta'), accepted.textContent);

  // Known absence: the provider never received it, and M11 has no resend.
  const absent = await render(stubClient({ envelopes: [{ ...unknown, failureCode: 'PROVIDER_ENVELOPE_ABSENT' }] }));
  assert.ok(absent.textContent.includes('non ha questa busta'), absent.textContent);
  assert.ok(absent.textContent.includes('non si può inviare di nuovo in questa fase'), 'the limitation is stated, not hidden');

  // A terminal envelope offers no reconcile control at all: there is nothing
  // left to reconcile, and the evidence is read-only.
  const terminal = await render(stubClient({ envelopes: [ENVELOPE], signers: [SIGNER], artifacts: [ARTIFACT], orders: [ORDER], orderTotals: ORDER_TOTALS }));
  assert.equal(terminal.findAll('button').length, 0, 'a completed envelope exposes no control');
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
      enforceAdminWriteGate(path, options);
      client.calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/schema') return { commercial: SCHEMA.commercial };
      if (path.startsWith('/api/modules/quote/records/')) return APPROVED_QUOTE;
      if (path.startsWith('/api/modules/price-book/records')) return { items: [] };
      return { items: [] };
    },
  };
  const mount = await render(client);
  assert.ok(mount.textContent.includes('La firma non è attiva in questo progetto.'));
  assert.equal(anyByClass(mount, 'signature-request'), null);
  assert.ok(!client.calls.some((call) => call.path.includes('signature-envelope')), 'no signature records are fetched');
});

/**
 * Voce ef92f728: the quote page speaks to the owner in every state it can
 * reach — pending approval, the signature request, a failed send, a signed
 * document with its order. The scan checks shapes, not only words: no UUID,
 * no raw ISO timestamp, no UPPER_SNAKE error code, no long hex hash, no
 * storage reference and no developer note in the visible text.
 */
test('ef92f728: no English, technical id or developer note in any quote state', async () => {
  const uuid = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const envelope = { ...ENVELOPE, id: uuid(1), providerEnvelopeId: uuid(2) };
  const states = {
    pending: stubClient({ quoteRecord: { ...APPROVED_QUOTE, status: 'pending_approval' } }),
    request: stubClient(),
    failed: stubClient({
      envelopes: [{ ...envelope, status: 'failed', providerEnvelopeId: null, failureCode: 'PROVIDER_TIMEOUT', failurePhase: 'external' }],
      signers: [{ ...SIGNER, envelopeId: envelope.id, signerKey: uuid(3), role: '', status: 'pending' }],
    }),
    signed: stubClient({
      envelopes: [envelope],
      signers: [{ ...SIGNER, envelopeId: envelope.id, signerKey: uuid(3) }],
      artifacts: [{ ...ARTIFACT, id: uuid(4), providerArtifactId: uuid(5), storageRef: `fixture://artifacts/${uuid(2)}` }],
      orders: [{ ...ORDER, id: uuid(6) }],
      orderTotals: ORDER_TOTALS.map((total) => ({ ...total, orderId: uuid(6) })),
    }),
  };
  for (const [name, client] of Object.entries(states)) {
    const text = (await render(client)).textContent;
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text), `${name}: no UUID`);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), `${name}: no raw ISO timestamp`);
    assert.ok(!/\b[A-Z]{3,}_[A-Z_]+\b/.test(text), `${name}: no error code`);
    assert.ok(!/[0-9a-f]{32,}/i.test(text), `${name}: no hash`);
    assert.ok(!text.includes('://'), `${name}: no storage reference`);
    assert.ok(!/\b(undefined|null)\b/.test(text), `${name}: no empty value leaks`);
    for (const word of ['Production Spine', 'Admin', 'server', 'external', 'Quote', 'Signature', 'Order', 'Totals', 'Request', 'hash', 'byte', 'artefatto', 'Impronta', 'Busta del fornitore']) {
      assert.ok(!text.includes(word), `${name}: no developer or English text: ${word}`);
    }
  }
});
