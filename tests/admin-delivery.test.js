import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDeliveryHandover } from '../apps/admin/public/admin-delivery.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin delivery handover section (Milestone 13). It proves the human path
 * against a stub server: planning writes nothing, an undecided delivery mode
 * blocks the handover until a human chooses with a reason, the partner is
 * required exactly when partner work exists and is never described as access,
 * and an existing project is evidence only. The HTTP path is covered by
 * tests/delivery-handover-e2e.test.js.
 */

const DELIVERY_DOMAIN = {
  packageContract: 1,
  version: 1,
  label: 'Delivery handover',
  deliveryContract: 1,
  actions: ['commercial-contract.create-delivery-handover', 'commercial-contract.plan-delivery-handover'],
  requires: [{ package: 'contracts', capability: 'delivery-obligations', version: 1 }],
  resources: ['delivery-project', 'delivery-work-package', 'delivery-milestone', 'delivery-partner-engagement', 'delivery-handover-run'],
  policies: [{ kind: 'delivery-handover-policy', name: 'b2b-delivery-handover', version: 1, label: 'B2B delivery handover', fingerprint: 'e'.repeat(64) }],
  deliveryModes: ['internal', 'partner', 'ambiguous'],
  overridableDeliveryModes: ['internal', 'partner'],
  dates: { source: 'post-sale-delivery-planning', limitation: 'Delivery target dates are post-sale planning data. They were not signed and nothing fires on them.' },
  partner: {
    maxPartners: 1,
    limitation: 'a partner engagement grants NO access of any kind: no account, no login, no portal, no invitation, no permission and no SLA',
  },
  notModeled: ['delivery execution', 'progress', 'time tracking', 'cost', 'margin', 'customer acceptance', 'SLA'],
};

const SCHEMA = { domains: { delivery: DELIVERY_DOMAIN } };
const CONTRACT = { id: 'ct1', customerName: 'Acme SpA', currency: 'EUR' };

const workPackage = (over = {}) => ({
  obligationId: 'ob1', componentKey: 'fixture:offer:setup:1:setup-fee', label: 'Setup', sku: 'SERVICES',
  quantity: 1, netAmountCents: 500_000, currency: 'EUR', chargeType: 'one_time',
  deliveryMode: 'internal', policyDeliveryMode: 'internal', overridden: false,
  reason: 'component "setup-fee" is delivered internally', requiresDecision: false, position: 1, ...over,
});

const planPayload = (workPackages, counts) => ({
  contractId: 'ct1', currency: 'EUR', customerName: 'Acme SpA',
  policy: 'b2b-delivery-handover', policyVersion: 1, policyFingerprint: 'e'.repeat(64),
  alreadyHandedOver: false, deliveryProjectId: null, plannable: counts.ambiguous === 0,
  requiredInputs: [...(counts.ambiguous > 0 ? ['modeOverrides'] : []), ...(counts.partner > 0 ? ['partner'] : [])],
  optionalInputs: ['targetStartDate', 'targetEndDate'],
  datesProvenance: { source: 'post-sale-delivery-planning', note: 'Delivery target dates are post-sale planning data entered by the delivery team. They were not signed, they are not a customer commitment, and nothing schedules or fires on them.' },
  partnerRequired: counts.partner > 0,
  counts,
  workPackages,
  milestones: [{ key: 'kickoff', position: 1 }, { key: 'delivery', position: 2 }, { key: 'go-live', position: 3 }],
  notModeled: ['delivery execution', 'cost', 'margin'],
});

const INTERNAL_PLAN = planPayload([workPackage()], { workPackages: 1, internal: 1, partner: 0, ambiguous: 0 });
const PARTNER_PLAN = planPayload(
  [workPackage(), workPackage({ obligationId: 'ob2', label: 'Data migration', deliveryMode: 'partner', policyDeliveryMode: 'partner', position: 2 })],
  { workPackages: 2, internal: 1, partner: 1, ambiguous: 0 },
);
const AMBIGUOUS_PLAN = planPayload(
  [workPackage(), workPackage({
    obligationId: 'ob3', label: 'Storage load', deliveryMode: 'ambiguous', policyDeliveryMode: 'ambiguous',
    reason: 'component "storage-gb" (SKU "STORAGE") is not mapped by this policy version', requiresDecision: true, position: 2,
  })],
  { workPackages: 2, internal: 1, partner: 0, ambiguous: 1 },
);
const RESOLVED_PLAN = planPayload(
  [workPackage(), workPackage({
    obligationId: 'ob3', label: 'Storage load', deliveryMode: 'partner', policyDeliveryMode: 'ambiguous',
    overridden: true, reason: 'their team loads the data', requiresDecision: false, position: 2,
  })],
  { workPackages: 2, internal: 1, partner: 1, ambiguous: 0 },
);

const PROJECT = {
  id: 'dp1', contractId: 'ct1', name: 'Acme onboarding', status: 'pending_kickoff', customerName: 'Acme SpA',
  targetStartDate: '2026-09-20', targetEndDate: '2026-12-20', planDays: 92, datesSource: 'post-sale-delivery-planning',
  policy: 'b2b-delivery-handover', policyVersion: 1, policyFingerprint: 'e'.repeat(64), plannedAt: '2026-09-15T10:00:00.000Z',
};
const PROJECT_ROWS = {
  'delivery-project': [PROJECT],
  'delivery-work-package': [
    { id: 'wp1', deliveryProjectId: 'dp1', label: 'Setup', sku: 'SERVICES', netAmountCents: 500_000, currency: 'EUR', deliveryMode: 'internal', policyDeliveryMode: 'internal', modeOverridden: false, modeReason: 'mapped internally', policy: 'b2b-delivery-handover', policyVersion: 1, status: 'planned', position: 1 },
    { id: 'wp2', deliveryProjectId: 'dp1', label: 'Data migration', sku: 'SERVICES', netAmountCents: 250_000, currency: 'EUR', deliveryMode: 'partner', policyDeliveryMode: 'ambiguous', modeOverridden: true, modeOverrideReason: 'their team loads the data', overriddenBy: 'admin', policy: 'b2b-delivery-handover', policyVersion: 1, status: 'planned', position: 2 },
  ],
  'delivery-milestone': [
    { id: 'm1', deliveryProjectId: 'dp1', milestoneKey: 'kickoff', label: 'kickoff', position: 1, status: 'planned', targetDate: null },
    { id: 'm2', deliveryProjectId: 'dp1', milestoneKey: 'go-live', label: 'go live', position: 2, status: 'planned', targetDate: null },
  ],
  'delivery-partner-engagement': [
    { id: 'pe1', deliveryProjectId: 'dp1', partnerRef: 'partner:abc', partnerNameSnapshot: 'ABC Consulting', role: 'delivery_partner', status: 'planned', workPackageCount: 1, assignmentReason: 'they run our migrations' },
  ],
};

function stubClient({ plans = [INTERNAL_PLAN], rows = {}, planError = null } = {}) {
  const calls = [];
  const queue = [...plans];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (options.method === 'POST' && path.endsWith('/actions/plan-delivery-handover')) {
        if (planError) throw Object.assign(new Error(planError), { status: 409 });
        return { ok: true, result: { plan: queue.length > 1 ? queue.shift() : queue[0] } };
      }
      if (options.method === 'POST') return { ok: true, result: {} };
      const module = /\/api\/modules\/([^/]+)\/records/.exec(path)?.[1];
      return { items: { ...PROJECT_ROWS, 'delivery-project': [], ...rows }[module] ?? [] };
    },
  };
}

async function render(client, { schema = SCHEMA } = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const fetchRows = async (module, filter) => {
    const result = await client.request(`/api/modules/${module}/records?limit=200`);
    return { rows: (result.items ?? []).filter(filter ?? (() => true)), truncated: false };
  };
  await renderDeliveryHandover({
    contract: CONTRACT, schema, mount, el, client, fetchRows,
    money: (cents, currency) => `${currency} ${(cents / 100).toFixed(2)}`,
    withBusy: async (fn) => { await fn(); },
    busy: [],
  });
  return mount;
}

const byClass = (mount, tag, className) =>
  mount.findAll(tag).find((node) => (node.getAttribute('class') ?? '') === className) ?? null;
const anyByClass = (mount, className) =>
  ['div', 'p', 'input', 'button', 'select', 'small', 'a', 'h4'].map((tag) => byClass(mount, tag, className)).find(Boolean) ?? null;

test('planning is read-only and shows who delivers each obligation, with the reason', async () => {
  const client = stubClient();
  const mount = await render(client);
  const form = byClass(mount, 'div', 'handover-plan');
  assert.ok(form, 'the handover section renders on an activated contract');
  assert.ok(mount.textContent.includes('Planning is read-only'));
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'rendering alone posts nothing');

  await form.__plan();
  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/modules/commercial-contract/records/ct1/actions/plan-delivery-handover');
  assert.deepEqual(JSON.parse(post.body), { policy: 'b2b-delivery-handover', policyVersion: 1 });

  const text = mount.textContent;
  assert.ok(text.includes('1 work package(s)'), text);
  assert.ok(text.includes('delivered internally'));
  assert.ok(text.includes('is delivered internally'), 'the policy reason is shown');
  assert.ok(text.includes('kickoff → delivery → go-live'), 'the milestone plan is visible');
  assert.ok(text.includes('No work package is delivered by a partner'), 'no partner is invented');
  assert.equal(/amount|Cents/.test(post.body), false, post.body);
});

test('an undecided delivery mode blocks the handover until a human chooses', async () => {
  const client = stubClient({ plans: [AMBIGUOUS_PLAN, RESOLVED_PLAN] });
  const mount = await render(client);
  await byClass(mount, 'div', 'handover-plan').__plan();

  const summary = byClass(mount, 'div', 'handover-summary');
  assert.equal(summary.getAttribute('data-plannable'), 'false');
  assert.equal(summary.getAttribute('data-ambiguous'), '1');
  const flagged = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'handover-work-package needs-decision');
  assert.equal(flagged.getAttribute('data-obligation'), 'ob3');
  assert.ok(mount.textContent.includes('will not guess'));
  assert.equal(anyByClass(mount, 'handover-create'), null, 'nothing can be handed over yet');
  assert.equal(anyByClass(mount, 'handover-window'), null, 'the window is not even collected yet');

  // A decision without a reason never leaves the browser.
  const result = byClass(mount, 'div', 'handover-result');
  const postsBefore = client.calls.filter((call) => call.method === 'POST').length;
  await result.__preview();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, postsBefore);
  assert.ok(mount.textContent.includes('Every decision needs a reason'));

  flagged.__mode.value = 'partner';
  flagged.__reason.value = 'their team loads the data';
  await result.__preview();
  const replan = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.deepEqual(JSON.parse(replan.body).modeOverrides, [
    { obligationId: 'ob3', deliveryMode: 'partner', reason: 'their team loads the data' },
  ]);
  assert.ok(mount.textContent.includes('(human decision)'));
  assert.ok(byClass(mount, 'div', 'handover-window'), 'now the window is collected');
});

test('a partner is required exactly when partner work exists, and grants nothing', async () => {
  const client = stubClient({ plans: [PARTNER_PLAN] });
  const mount = await render(client);
  await byClass(mount, 'div', 'handover-plan').__plan();
  const text = mount.textContent;

  assert.ok(text.includes('Delivery partner (required)'), text);
  assert.ok(text.includes('grants NO access of any kind'), 'the limitation is stated where the partner is entered');
  assert.ok(text.includes('post-sale planning data'), 'the dates are not presented as a commitment');
  assert.ok(text.includes('there is no scheduler in this milestone'));
  assert.ok(text.includes('requires a signed-in user actor'));
  assert.ok(text.includes('not Delivery Manager role enforcement'), 'the boundary is not overclaimed');

  const result = byClass(mount, 'div', 'handover-result');
  result.__targetStartDate.value = '2026-09-20';
  result.__targetEndDate.value = '2026-12-20';
  result.__projectName.value = 'Acme onboarding';
  result.__partnerRef.value = 'partner:abc';
  result.__partnerName.value = 'ABC Consulting';
  await result.__handover();

  const created = client.calls.filter((call) => call.method === 'POST').at(-1);
  assert.equal(created.path, '/api/modules/commercial-contract/records/ct1/actions/create-delivery-handover');
  assert.deepEqual(JSON.parse(created.body), {
    policy: 'b2b-delivery-handover', policyVersion: 1, projectName: 'Acme onboarding',
    targetStartDate: '2026-09-20', targetEndDate: '2026-12-20',
    partner: { partnerRef: 'partner:abc', partnerName: 'ABC Consulting' },
  });
  assert.equal(result.__handoverButton.disabled, true, 'the handover control does not allow a second submit');
});

test('an existing delivery project is evidence only', async () => {
  const mount = await render(stubClient({ rows: { 'delivery-project': [PROJECT] } }));
  const text = mount.textContent;

  assert.equal(byClass(mount, 'div', 'delivery-project-facts').getAttribute('data-project'), 'dp1');
  assert.ok(text.includes('Acme onboarding · pending_kickoff'), text);
  assert.ok(text.includes('2026-09-20 → 2026-12-20 (92 day(s))'));
  assert.ok(text.includes('post-sale-delivery-planning'));
  assert.ok(text.includes('Human decision by admin (the policy said "ambiguous")'), 'the override and the policy answer both survive');
  assert.ok(text.includes('ABC Consulting (partner:abc)'));
  assert.ok(text.includes('not a contractual or billing milestone'));
  assert.ok(text.includes('grants NO access of any kind'));
  assert.ok(!/time tracking control|start delivery|complete milestone/i.test(text), 'no execution control exists');

  const panel = byClass(mount, 'div', 'delivery-handover');
  assert.equal(panel.findAll('button').length, 0, 'no control on a planned project');
  assert.equal(panel.findAll('input').length, 0);
  assert.equal(panel.findAll('select').length, 0);
  assert.equal(anyByClass(mount, 'handover-plan'), null, 'no second handover path');
});

test('hostile text renders as text, and the section disappears without the package', async () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const hostile = planPayload([workPackage({ label: nasty, reason: `${nasty} mapped` })], { workPackages: 1, internal: 1, partner: 0, ambiguous: 0 });
  const mount = await render(stubClient({ plans: [hostile] }));
  await byClass(mount, 'div', 'handover-plan').__plan();
  const head = byClass(mount, 'p', 'handover-work-package-head');
  assert.ok(head.textContent.includes(nasty), 'the hostile value is present as text');
  assert.equal(head.childNodes.length, 0, 'and never parsed into child nodes');

  const without = await render(stubClient(), { schema: { domains: {} } });
  assert.equal(anyByClass(without, 'delivery-handover'), null, 'no section without the package');
  assert.ok(!without.textContent.includes('Delivery handover'));
});
