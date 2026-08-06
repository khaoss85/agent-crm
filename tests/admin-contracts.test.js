import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteView } from '../apps/admin/public/admin-quotes.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin contract activation section (Milestone 12, ADR-018 domain
 * package). It proves the human path end to end against a stub server:
 * planning writes nothing, an ambiguous component blocks activation until a
 * human classifies it with a reason, the term is collected as calendar dates,
 * the activation control is single-use, and once activated the section is
 * evidence only — no billing, delivery or service control exists, and nothing
 * appears at all when the package is absent. The full HTTP path is covered by
 * tests/contracts-activation-e2e.test.js.
 */

const CONTRACTS_DOMAIN = {
  domainContract: 1,
  contractsContract: 1,
  label: 'Contracts and subscriptions',
  actions: ['order.activate-contract', 'order.plan-activation'],
  policies: [
    { kind: 'order-activation-policy', name: 'b2b-saas-order-activation', version: 1, label: 'B2B SaaS order activation', fingerprint: 'c'.repeat(64) },
    { kind: 'order-activation-policy', name: 'b2b-saas-order-activation', version: 2, label: 'B2B SaaS order activation (storage mapped)', fingerprint: 'd'.repeat(64) },
  ],
  classificationTypes: ['subscription', 'delivery', 'service', 'other', 'ambiguous'],
  overridableTypes: ['subscription', 'delivery', 'service', 'other'],
  term: { format: 'YYYY-MM-DD calendar dates; termEndDate is inclusive', renewalNotice: 'recorded only — no scheduler exists, so nothing fires on it' },
  notModeled: [
    'billing', 'invoicing', 'payment', 'usage rating', 'proration', 'tax', 'FX',
    'revenue recognition', 'MRR/ARR/TCV', 'amendments', 'seat changes', 'renewal',
    'cancellation', 'delivery execution', 'service activation', 'entitlements', 'SLA',
  ],
};

const SCHEMA = {
  commercial: { commercialContract: 1, discountPolicies: [] },
  signature: { signatureContract: 1, providers: [{ name: 'fixture-signature', version: 1, label: 'Fixture', fingerprint: 'a'.repeat(64) }] },
  domains: { contracts: CONTRACTS_DOMAIN },
};

const QUOTE = {
  id: 'q1', opportunityId: 'opp1', priceBookId: 'pb1', currency: 'EUR', status: 'approved',
  draftRevision: 3, currentVersionId: 'v1', totalsJson: JSON.stringify({ oneTimeTotal: null, recurringTotals: [] }),
};

const ENVELOPE = {
  id: 'env1', quoteId: 'q1', quoteVersionId: 'v1', provider: 'fixture-signature', providerVersion: 1,
  providerEnvelopeId: 'env_1', status: 'completed', documentHash: 'd'.repeat(64),
  documentFormat: 'application/vnd.agent-crm.quote-package+json', failureCode: null, failurePhase: null,
};
const ARTIFACT = { id: 'a1', envelopeId: 'env1', quoteId: 'q1', documentHash: 'd'.repeat(64), artifactHash: 'b'.repeat(64) };
const ORDER = { id: 'ord1', quoteId: 'q1', quoteVersionId: 'v1', envelopeId: 'env1', status: 'accepted', currency: 'EUR', contractId: null, activatedAt: null };

const PLAN_COMPONENTS = [
  {
    orderComponentId: 'oc1', componentKey: 'fixture:offer:enterprise:1:ent-platform', label: 'Platform fee', sku: 'ENT',
    chargeType: 'recurring', interval: 'month', intervalCount: 1, quantity: 1, netAmountCents: 285_000,
    classification: 'subscription', reason: 'component "ent-platform" is mapped to subscription', overridden: false, requiresOverride: false,
  },
  {
    orderComponentId: 'oc2', componentKey: 'fixture:offer:enterprise:1:ent-setup', label: 'Onboarding', sku: 'ENT',
    chargeType: 'one_time', interval: null, intervalCount: null, quantity: 1, netAmountCents: 475_000,
    classification: 'delivery', reason: 'component "ent-setup" is mapped to delivery', overridden: false, requiresOverride: false,
  },
  {
    orderComponentId: 'oc3', componentKey: 'fixture:offer:storage-monthly:1:storage-gb', label: 'Storage', sku: 'STORAGE',
    chargeType: 'recurring', interval: 'month', intervalCount: 1, quantity: 100, netAmountCents: 10_000,
    classification: 'ambiguous', reason: 'component "storage-gb" (SKU "STORAGE") is not mapped by this policy version',
    overridden: false, requiresOverride: true,
  },
];

const planPayload = (components, counts) => ({
  orderId: 'ord1', currency: 'EUR', customerName: 'Acme SpA', quoteVersionId: 'v1',
  signature: { envelopeId: 'env1', signedArtifactId: 'a1', documentHash: 'd'.repeat(64) },
  alreadyActivated: false, contractId: null, activatable: counts.ambiguous === 0,
  requiredInputs: ['effectiveDate', 'termStartDate', 'termEndDate'],
  counts, components,
  totals: [{ kind: 'recurring', currency: 'EUR', interval: 'month', intervalCount: 1, netAmountCents: 295_000 }],
  notModeled: ['billing', 'invoicing', 'payment'],
});

const AMBIGUOUS_PLAN = planPayload(PLAN_COMPONENTS, { subscription: 1, delivery: 1, service: 0, other: 0, ambiguous: 1 });
const RESOLVED_PLAN = planPayload(
  PLAN_COMPONENTS.map((component) => component.orderComponentId === 'oc3'
    ? { ...component, classification: 'subscription', reason: 'storage is sold as a recurring right', overridden: true, requiresOverride: false }
    : component),
  { subscription: 2, delivery: 1, service: 0, other: 0, ambiguous: 0 },
);

const CONTRACT = {
  id: 'ct1', orderId: 'ord1', status: 'active', customerName: 'Acme SpA', currency: 'EUR',
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31', termDays: 365,
  autoRenew: true, renewalNoticeDays: 30, currentVersionId: 'cv1',
  policy: 'b2b-saas-order-activation', policyVersion: 1, policyFingerprint: 'c'.repeat(64),
  documentHash: 'd'.repeat(64), activatedAt: '2026-08-06T09:00:00.000Z',
};
const CONTRACT_VERSION = { id: 'cv1', contractId: 'ct1', versionNumber: 1, lineCount: 3 };
const CONTRACT_LINES = [
  {
    id: 'cl1', contractId: 'ct1', orderId: 'ord1', position: 1, componentKey: 'ent-platform', label: 'Platform fee', sku: 'ENT',
    chargeType: 'recurring', interval: 'month', intervalCount: 1, netAmountCents: 285_000, currency: 'EUR',
    classification: 'subscription', classificationReason: 'component "ent-platform" is mapped to subscription',
    classificationPolicy: 'b2b-saas-order-activation', classificationPolicyVersion: 1,
    policyClassification: 'subscription', overridden: false, overrideReason: null, overriddenBy: null,
  },
  {
    id: 'cl2', contractId: 'ct1', orderId: 'ord1', position: 2, componentKey: 'ent-setup', label: 'Onboarding', sku: 'ENT',
    chargeType: 'one_time', interval: null, intervalCount: null, netAmountCents: 475_000, currency: 'EUR',
    classification: 'delivery', classificationReason: 'component "ent-setup" is mapped to delivery',
    classificationPolicy: 'b2b-saas-order-activation', classificationPolicyVersion: 1,
    policyClassification: 'delivery', overridden: false, overrideReason: null, overriddenBy: null,
  },
  {
    id: 'cl3', contractId: 'ct1', orderId: 'ord1', position: 3, componentKey: 'storage-gb', label: 'Storage', sku: 'STORAGE',
    chargeType: 'recurring', interval: 'month', intervalCount: 1, netAmountCents: 10_000, currency: 'EUR',
    classification: 'subscription', classificationReason: 'storage is sold as a recurring right',
    classificationPolicy: 'b2b-saas-order-activation', classificationPolicyVersion: 1,
    policyClassification: 'ambiguous', overridden: true, overrideReason: 'storage is sold as a recurring right', overriddenBy: 'admin',
  },
];
const SUBSCRIPTION = {
  id: 'sub1', contractId: 'ct1', orderId: 'ord1', status: 'active', currency: 'EUR',
  startDate: '2026-09-01', endDate: '2027-08-31', lineCount: 2,
};
const SUBSCRIPTION_LINES = [
  { id: 'sl1', subscriptionId: 'sub1', componentKey: 'ent-platform', label: 'Platform fee', interval: 'month', intervalCount: 1, quantity: 1, netAmountCents: 285_000, currency: 'EUR' },
  { id: 'sl2', subscriptionId: 'sub1', componentKey: 'storage-gb', label: 'Storage', interval: 'month', intervalCount: 1, quantity: 100, netAmountCents: 10_000, currency: 'EUR' },
];
const DELIVERY = { id: 'do1', contractId: 'ct1', orderId: 'ord1', status: 'pending_handover', label: 'Onboarding', componentKey: 'ent-setup', sku: 'ENT', netAmountCents: 475_000, currency: 'EUR' };

/**
 * A stub server that answers the exact reads the view performs. `plans` is a
 * queue: each plan-activation POST takes the next entry, so a re-plan with
 * overrides returns the resolved plan.
 */
function stubClient({ order = ORDER, plans = [AMBIGUOUS_PLAN], schema = SCHEMA, rows = {}, planError = null } = {}) {
  const calls = [];
  const queue = [...plans];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return schema;
      if (options.method === 'POST' && path.endsWith('/actions/plan-activation')) {
        if (planError) throw Object.assign(new Error(planError), { status: 409 });
        return { ok: true, result: { plan: queue.length > 1 ? queue.shift() : queue[0] } };
      }
      if (options.method === 'POST') return { ok: true, result: {} };
      if (path.startsWith('/api/modules/quote/records/')) return QUOTE;
      const module = /\/api\/modules\/([^/]+)\/records/.exec(path)?.[1];
      const table = {
        'signature-envelope': [ENVELOPE], 'signed-artifact': [ARTIFACT], order: [order],
        'signature-signer': [], 'order-total': [], 'price-book': [], offer: [], 'quote-line': [], 'quote-version': [],
        ...rows,
      };
      return { items: table[module] ?? [] };
    },
  };
}

const render = async (client) => {
  const doc = createFakeDocument();
  const mount = createMount();
  await createQuoteView({ doc, mount, client }).renderQuoteDetail('q1');
  return mount;
};

const byClass = (mount, tag, className) =>
  mount.findAll(tag).find((node) => (node.getAttribute('class') ?? '') === className) ?? null;
const anyByClass = (mount, className) =>
  ['div', 'p', 'input', 'button', 'select', 'small', 'a'].map((tag) => byClass(mount, tag, className)).find(Boolean) ?? null;

const ACTIVATED_ROWS = {
  'commercial-contract': [CONTRACT], 'contract-version': [CONTRACT_VERSION], 'contract-line': CONTRACT_LINES,
  subscription: [SUBSCRIPTION], 'subscription-line': SUBSCRIPTION_LINES, 'delivery-obligation': [DELIVERY], 'service-obligation': [],
};

test('planning is read-only, and every classification arrives with its reason', async () => {
  const client = stubClient();
  const mount = await render(client);

  const form = byClass(mount, 'div', 'activation-plan');
  assert.ok(form, 'the activation section renders on a signed order');
  assert.ok(mount.textContent.includes('Planning is read-only'), 'the plan is described as writing nothing');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'rendering alone posts nothing');

  await form.__plan();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/modules/order/records/ord1/actions/plan-activation');
  assert.deepEqual(JSON.parse(post.body), { policy: 'b2b-saas-order-activation', policyVersion: 1 });

  const text = mount.textContent;
  assert.ok(text.includes('1 subscription line(s)'), text);
  assert.ok(text.includes('1 delivery obligation(s)'));
  assert.ok(text.includes('is mapped to subscription'), 'each decision shows the policy reason');
  assert.ok(text.includes('EUR 2,850.00 net'), 'the server amount is displayed, never recomputed');
  assert.equal(byClass(mount, 'div', 'activation-component').getAttribute('data-classification'), 'subscription');
  // The amount is server-side: nothing in the payload carries money, product or hash.
  assert.equal(/amount|Cents|documentHash|productId/.test(post.body), false, post.body);
});

test('an ambiguous component blocks activation until a human decides it, with a reason', async () => {
  const client = stubClient({ plans: [AMBIGUOUS_PLAN, RESOLVED_PLAN] });
  const mount = await render(client);
  await byClass(mount, 'div', 'activation-plan').__plan();

  const summary = byClass(mount, 'div', 'activation-summary');
  assert.equal(summary.getAttribute('data-activatable'), 'false');
  assert.equal(summary.getAttribute('data-ambiguous'), '1');
  const flagged = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'activation-component needs-decision');
  assert.equal(flagged.getAttribute('data-component'), 'oc3', 'the unclassifiable component is highlighted');
  assert.ok(mount.textContent.includes('will not guess'), 'the refusal to guess is stated, not hidden');

  // No activation control exists while anything is ambiguous.
  assert.equal(anyByClass(mount, 'activation-activate'), null, 'nothing can be activated yet');
  assert.equal(anyByClass(mount, 'activation-term'), null, 'the term is not even collected yet');

  // An override without a reason is refused locally — before any request.
  const result = byClass(mount, 'div', 'activation-result');
  const postsBefore = client.calls.filter((call) => call.method === 'POST').length;
  await result.__preview();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, postsBefore, 'no request without a reason');
  assert.ok(mount.textContent.includes('Every override needs a reason'));

  flagged.__type.value = 'subscription';
  flagged.__reason.value = 'storage is sold as a recurring right';
  await result.__preview();
  const replan = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.deepEqual(JSON.parse(replan.body).classificationOverrides, [
    { orderComponentId: 'oc3', type: 'subscription', reason: 'storage is sold as a recurring right' },
  ]);

  // The resolved plan shows the decision as a human override, and only now
  // does the term form and the single activation control appear.
  const text = mount.textContent;
  assert.ok(text.includes('(human override)'), text);
  assert.ok(text.includes('2 subscription line(s)'));
  assert.ok(byClass(mount, 'div', 'activation-term'), 'the term is collected only when activation is possible');
  assert.ok(byClass(mount, 'div', 'activation-activate'));

  // The decision the human saw applied must reach the activation itself: the
  // server recomputes the plan from the Order and would otherwise refuse the
  // component as ambiguous again.
  const resolved = byClass(mount, 'div', 'activation-result');
  resolved.__effectiveDate.value = '2026-09-01';
  resolved.__termStartDate.value = '2026-09-01';
  resolved.__termEndDate.value = '2027-08-31';
  await resolved.__activate();
  const activate = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(activate.path, '/api/modules/order/records/ord1/actions/activate-contract');
  assert.deepEqual(JSON.parse(activate.body).classificationOverrides, [
    { orderComponentId: 'oc3', type: 'subscription', reason: 'storage is sold as a recurring right' },
  ]);
});

test('the term is collected as calendar dates and the activation control is single-use', async () => {
  const client = stubClient({ plans: [RESOLVED_PLAN] });
  const mount = await render(client);
  await byClass(mount, 'div', 'activation-plan').__plan();
  const result = byClass(mount, 'div', 'activation-result');

  const text = mount.textContent;
  assert.ok(text.includes('end date is inclusive'), 'inclusivity is stated, not assumed');
  assert.ok(text.includes('recorded only'), 'auto-renew and notice days are honestly labelled');
  assert.ok(text.includes('nothing in this milestone schedules, bills or renews anything'));
  assert.ok(text.includes('requires a signed-in user actor'), 'the human-actor boundary is stated');
  assert.ok(text.includes('not Finance or Legal role enforcement'), 'the boundary is not overclaimed');
  for (const input of ['effectiveDate', 'termStartDate', 'termEndDate']) {
    const control = mount.findAll('input').find((node) => node.getAttribute('name') === input);
    assert.equal(control.getAttribute('type'), 'date', `${input} is a calendar date`);
  }

  result.__effectiveDate.value = '2026-09-01';
  result.__termStartDate.value = '2026-09-01';
  result.__termEndDate.value = '2027-08-31';
  result.__autoRenew.checked = true;
  result.__noticeDays.value = '30';
  await result.__activate();

  const activate = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(activate.path, '/api/modules/order/records/ord1/actions/activate-contract');
  assert.deepEqual(JSON.parse(activate.body), {
    policy: 'b2b-saas-order-activation', policyVersion: 1,
    effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
    autoRenew: true, renewalNoticeDays: 30,
  });
  // The button disabled itself: a second click cannot double-activate.
  assert.equal(result.__activateButton.disabled, true, 'the activation control does not allow a second submit');
});

test('a refused plan states the server reason and offers no activation', async () => {
  const client = stubClient({ planError: 'The order is draft, not accepted' });
  const mount = await render(client);
  await byClass(mount, 'div', 'activation-plan').__plan();
  assert.ok(mount.textContent.includes('The order is draft, not accepted'), mount.textContent);
  assert.equal(anyByClass(mount, 'activation-activate'), null, 'a failed plan offers no activation');
  assert.equal(anyByClass(mount, 'activation-summary'), null);
});

test('an activated order shows evidence only — no obligation, billing or renewal control', async () => {
  const client = stubClient({ order: { ...ORDER, contractId: 'ct1', activatedAt: '2026-08-06T09:00:00.000Z' }, rows: ACTIVATED_ROWS });
  const mount = await render(client);
  const text = mount.textContent;

  assert.equal(byClass(mount, 'div', 'contract-facts').getAttribute('data-contract'), 'ct1');
  assert.ok(text.includes('2026-09-01 → 2027-08-31 (inclusive, 365 day(s))'), text);
  assert.ok(text.includes('b2b-saas-order-activation@1'), 'the deciding policy version is evidence');
  assert.ok(text.includes('c'.repeat(64)), 'the policy fingerprint is shown');
  assert.ok(text.includes('Human override by admin: the policy said "ambiguous"'), 'the override and the policy decision both survive');
  assert.ok(text.includes('EUR 2,850.00 net per period'), 'subscription lines show the per-period amount');
  assert.ok(text.includes('pending_handover'), 'the delivery obligation is a pending marker');
  assert.ok(text.includes('Nothing executes, schedules, staffs or completes them'));
  // Those words exist only inside the "not modeled" disclosure — never as a
  // figure the Admin derived from the signed periods.
  assert.ok(!/\b(ARR|MRR|TCV)\b/.test(text.split('Not modeled:')[0]), 'no annualized figure is derived');
  assert.ok(text.includes('MRR/ARR/TCV'), 'and the omission is disclosed rather than left implied');

  // Evidence is evidence: the activation section offers no control at all.
  const panel = byClass(mount, 'div', 'contract-activation');
  assert.equal(panel.findAll('button').length, 0, 'no control on an activated contract');
  assert.equal(panel.findAll('input').length, 0);
  assert.equal(panel.findAll('select').length, 0);
  assert.equal(anyByClass(mount, 'activation-plan'), null, 'no second activation path');
});

test('hostile server text renders as text, and the section disappears without the package', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const hostilePlan = planPayload(
    [{ ...PLAN_COMPONENTS[0], label: nasty, reason: `${nasty} mapped` }],
    { subscription: 1, delivery: 0, service: 0, other: 0, ambiguous: 0 },
  );
  const mount = await render(stubClient({ plans: [hostilePlan] }));
  await byClass(mount, 'div', 'activation-plan').__plan();
  const head = byClass(mount, 'p', 'activation-component-head');
  assert.ok(head.textContent.includes(nasty), 'the hostile value is present as text');
  assert.equal(head.childNodes.length, 0, 'and never parsed into child nodes');

  // Without the domain package the schema has no `contracts` block: the Admin
  // shows nothing rather than a control the server cannot serve.
  const without = await render(stubClient({ schema: { ...SCHEMA, domains: {} } }));
  assert.equal(anyByClass(without, 'contract-activation'), null, 'no section without the package');
  assert.ok(!without.textContent.includes('Contract activation'));
});
