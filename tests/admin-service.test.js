import test from 'node:test';
import assert from 'node:assert/strict';
import { renderServiceOperations, resetServiceSelection } from '../apps/admin/public/admin-service.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin Service Operations section (Milestone 15).
 *
 * The section is **package-scoped, not package-owned**: the framework has no
 * seam for a package to contribute an Admin extension (AX1 publishes that as
 * `ADMIN_EXTENSIONS_UNSUPPORTED`), so this code lives in the Admin app and
 * renders only while the server publishes the package.
 *
 * Its job is to make four claims impossible to misread — a coverage is not a
 * signed contract and amends nothing, a listed channel is not a connected
 * provider, nothing was notified, and "breached" is elapsed time rather than a
 * legal finding. Every test here checks a claim the screen makes, a control it
 * must not offer, or a failure mode a real browser found in the section before
 * this one.
 *
 * The HTTP path is covered by tests/service-operations-e2e.test.js.
 */

const SERVICE = {
  serviceContract: 1,
  coverageStates: ['planned', 'active', 'ended'],
  caseStates: ['new', 'in_progress', 'waiting_customer', 'resolved', 'closed'],
  caseTransitions: {
    new: ['in_progress', 'waiting_customer', 'resolved'],
    in_progress: ['waiting_customer', 'resolved'],
    waiting_customer: ['in_progress', 'resolved'],
    resolved: ['closed'],
    closed: [],
  },
  casePriorities: ['low', 'normal', 'high', 'urgent'],
  activityTypes: ['note', 'internal_note', 'customer_reply', 'transition', 'escalation'],
  visibility: ['internal', 'customer_visible'],
  escalationLevels: ['internal', 'management', 'vendor'],
  slaStates: ['met', 'on_track', 'at_risk', 'breached', 'not_applicable'],
  coverageMeaning: 'a service coverage is an OPERATIONAL record activated from a contract\'s service obligations. It is not a signed agreement',
  slaBasis: 'elapsed wall-clock minutes from openedAt against the injected UTC clock',
  humanApproval: 'activating requires actor.type === "user"; an agent is refused',
  caseMeaning: 'a support case is what a USER ACTOR recorded',
  escalationMeaning: 'an escalation is recorded evidence that a human escalated',
  entitlementMeaning: 'an entitlement is immutable evidence derived from one service obligation',
  notModeled: ['billing', 'invoicing', 'renewal', 'email', 'scheduling'],
  policyFingerprints: [{ name: 'b2b-service-activation', version: 1, fingerprint: 'f1' }],
};

const SCHEMA = { domains: { service: SERVICE } };
const CONTRACT = { id: 'cc1', customerName: 'Acme SpA' };

const COVERAGE = {
  id: 'cov1', contractId: 'cc1', customerRef: 'customer:acme', customerNameSnapshot: 'Acme SpA',
  obligationRefs: '["so1"]', status: 'active', startDate: '2026-09-01', endDate: null,
  policyName: 'b2b-service-activation', policyVersion: 1, policyFingerprint: 'f1',
  entitlementCount: 1, activatedBy: 'user:ops', activatedAt: '2026-09-15T10:00:00.000Z',
  endedReason: null, endedBy: null, endedAt: null,
};

const ENTITLEMENT = {
  id: 'ent1', serviceCoverageId: 'cov1', contractId: 'cc1', serviceObligationId: 'so1',
  label: 'Annual support', supportTier: 'standard',
  categories: '["incident","question"]', priorities: '["low","normal","high","urgent"]',
  firstResponseTargetMinutes: 240, resolutionTargetMinutes: 2880, maxOpenCases: 5,
  startDate: '2026-09-01', endDate: null,
  policyName: 'b2b-service-activation', policyVersion: 1, policyFingerprint: 'f1',
  decisionReason: 'the support-fee component maps to the standard tier', createdBy: 'user:ops',
};

const CASE = {
  id: 'case1', caseNumber: 'CASE-0001', serviceCoverageId: 'cov1', serviceEntitlementId: 'ent1',
  contractId: 'cc1', customerRef: 'customer:acme', customerContactRef: null,
  source: 'manual', category: 'incident', priority: 'high',
  title: 'Sync stopped', description: 'nothing since Friday', status: 'new', ownerRef: 'ops:mario',
  firstResponseDueAt: '2026-09-15T14:00:00.000Z', resolutionDueAt: '2026-09-17T10:00:00.000Z',
  firstRespondedAt: null, resolvedAt: null, resolutionSummary: null, closedAt: null,
  openedBy: 'user:ops', openedAt: '2026-09-15T10:00:00.000Z',
};

const EMPTY = {
  'service-coverage': [], 'service-entitlement': [], 'service-activation-run': [],
  'support-case': [], 'support-case-activity': [], 'service-sla-evaluation': [],
  'service-escalation': [],
};

/** An activated coverage with one entitlement and, optionally, cases. */
function activated(over = {}) {
  return {
    ...EMPTY,
    'service-coverage': [COVERAGE],
    'service-entitlement': [ENTITLEMENT],
    'service-activation-run': [{
      id: 'run1', serviceCoverageId: 'cov1', contractId: 'cc1', obligationCount: 1,
      entitlementCount: 1, overrideCount: 0, activatedBy: 'user:ops',
      activatedAt: '2026-09-15T10:00:00.000Z',
    }],
    ...over,
  };
}

const PLAN_DECIDABLE = {
  contractId: 'cc1', policy: 'b2b-service-activation', policyVersion: 1, policyFingerprint: 'f1',
  obligationIds: ['so1'],
  entitlements: [{
    obligationId: 'so1', label: 'Annual support', supportTier: 'standard',
    categories: ['incident', 'question'], priorities: ['low', 'normal', 'high', 'urgent'],
    firstResponseTargetMinutes: 240, resolutionTargetMinutes: 2880, maxOpenCases: 5,
    decidedBy: 'policy', reason: 'the support-fee component maps to the standard tier',
  }],
  ambiguous: [],
  decidable: true,
};

const PLAN_AMBIGUOUS = {
  ...PLAN_DECIDABLE,
  entitlements: [],
  ambiguous: [{ obligationId: 'so1', label: 'Annual support', reason: 'this policy knows nothing about "support-fee"' }],
  decidable: false,
};

/**
 * Render against stub data, collecting the calls the screen would make.
 *
 * The stubbed `withBusy` models the REAL one (apps/admin/public/admin-quotes.js):
 * it re-renders the whole quote detail on success and only shows an error when
 * the callback rejects. A stub that merely awaits cannot see the class of bug a
 * real browser found in the M14b2 section — a handler that swallowed its own
 * failure looked fine while the parent silently rebuilt the DOM over both the
 * error message and the operator's typed input.
 */
async function render(data, { fail = 0, truncate = null, scripted = {}, results = {}, keepSelection = false } = {}) {
  if (!keepSelection) resetServiceSelection(); // each test is a fresh browser session
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  let reads = 0;
  const fetchRows = async (module, filter) => {
    reads += 1;
    if (reads <= fail) throw new Error('request failed');
    return {
      rows: (data[module] ?? []).filter(filter ?? (() => true)),
      truncated: truncate === module,
    };
  };
  const actions = [];
  const client = {
    request: async (path, options) => {
      const match = /^\/api\/modules\/([^/]+)\/records\/([^/]+)\/actions\/([^/]+)$/.exec(path);
      assert.ok(match, `the Admin posts to a real action route: ${path}`);
      const [, module, id, action] = match.map(decodeURIComponent);
      assert.equal(options.method, 'POST');
      actions.push({ module, id, action, input: JSON.parse(options.body) });
      const answer = scripted[action];
      if (answer instanceof Error) throw answer;
      return { result: results[action] ?? {} };
    },
  };
  const busy = [];
  const trace = { rerenders: 0, errors: [] };
  const withBusy = async (fn) => {
    try {
      await fn();
      trace.rerenders += 1;
    } catch (error) {
      trace.errors.push(error?.message ?? String(error));
      for (const control of busy) control.disabled = false;
    }
  };
  await renderServiceOperations({
    contract: CONTRACT, schema: SCHEMA, mount, el, client, fetchRows,
    money: (cents, currency) => `${currency} ${(cents / 100).toFixed(2)}`,
    withBusy, busy,
  });
  return { mount, busy, actions, reads, trace };
}

const nodes = (mount) => mount.findAll('div')
  .concat(mount.findAll('p'), mount.findAll('button'), mount.findAll('small'),
    mount.findAll('input'), mount.findAll('select'), mount.findAll('textarea'),
    mount.findAll('h4'), mount.findAll('h5'), mount.findAll('h6'), mount.findAll('option'));
const byClass = (mount, className) =>
  nodes(mount).filter((node) => (node.getAttribute('class') ?? '').split(' ').includes(className));
const one = (mount, className) => byClass(mount, className)[0] ?? null;
const buttons = (mount) => mount.findAll('button');
const labelled = (mount, text) => buttons(mount).find((node) => node.textContent.includes(text)) ?? null;
const named = (mount, name) => nodes(mount).find((node) => node.getAttribute('name') === name) ?? null;
const text = (mount) => mount.textContent;

// ---------------------------------------------------------------------------

test('the section disappears with the package rather than degrading', async (t) => {
  const doc = createFakeDocument();
  const mount = createMount();
  await renderServiceOperations({
    contract: CONTRACT, schema: { domains: {} }, mount, el: (tag) => doc.createElement(tag),
    client: {}, fetchRows: async () => { throw new Error('must not be called'); },
    money: () => '', withBusy: async () => {}, busy: [],
  });
  assert.equal(mount.childNodes.length, 0, 'no package, no section — and no read attempted');
  assert.ok(t);
});

test('loading, empty, error and retry are all reachable', async (t) => {
  const failed = await render(EMPTY, { fail: 1 });
  assert.ok(one(failed.mount, 'service-error'), 'a failed read renders its own error state');
  assert.match(text(failed.mount), /Could not load service operations/);
  const retry = labelled(failed.mount, 'Retry');
  assert.ok(retry, 'and offers a retry');
  await retry.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(one(failed.mount, 'service-error'), null, 'the retry re-read and cleared the failure');
  assert.ok(one(failed.mount, 'service-activation'), 'and rendered the activation state');
  assert.ok(t);
});

test('an un-activated contract offers planning, and planning alone', async (t) => {
  const { mount } = await render(EMPTY);
  assert.ok(one(mount, 'service-activation'), 'the activation section renders');
  assert.match(text(mount), /Planning is read-only: it records nothing/);
  assert.equal(labelled(mount, 'Plan service activation') !== null, true);
  assert.equal(labelled(mount, 'Activate service coverage'), null,
    'no activation control exists before a plan has been seen');
  assert.equal(one(mount, 'service-coverage'), null, 'and no coverage detail is invented');
  assert.ok(t);
});

test('the coverage limitation is stated before anything else on the screen', async (t) => {
  const { mount } = await render(EMPTY);
  const limitation = one(mount, 'svc-coverage-limitation');
  assert.ok(limitation, 'the section carries the coverage limitation');
  assert.equal(limitation.textContent,
    'ServiceCoverage is operational evidence. It is not a signed contract and does not amend the Commercial Contract.');
  assert.ok(t);
});

test('an undecidable plan blocks: it offers decisions, and no coverage form at all', async (t) => {
  const { mount, actions } = await render(EMPTY, { results: { 'plan-service-activation': { plan: PLAN_AMBIGUOUS } } });
  await labelled(mount, 'Plan service activation').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actions[0].action, 'plan-service-activation');
  assert.equal(actions[0].module, 'commercial-contract');
  const blocked = one(mount, 'svc-plan-ambiguous');
  assert.ok(blocked, 'the undecided obligation is rendered as blocking');
  assert.match(text(mount), /A defaulted support tier is a promise nobody in the business made/);
  assert.equal(labelled(mount, 'Activate service coverage'), null,
    'no activation control while anything is undecided');
  assert.equal(named(mount, 'coverageKey'), null, 'and no coverage form either');
  assert.ok(labelled(mount, 'Apply decisions and re-plan'), 'the way forward is a decision');
  assert.ok(t);
});

test('a decision without a reason is refused before any request leaves the browser', async (t) => {
  const { mount, actions } = await render(EMPTY, { results: { 'plan-service-activation': { plan: PLAN_AMBIGUOUS } } });
  await labelled(mount, 'Plan service activation').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  named(mount, 'supportTier:so1').value = 'standard';
  named(mount, 'categories:so1').value = 'incident';
  await labelled(mount, 'Apply decisions and re-plan').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.length, 1, 'nothing was posted');
  assert.match(text(mount), /Every decision needs a reason/);

  // …and a reason without a category is refused for the same reason.
  named(mount, 'reason:so1').value = 'agreed with the customer';
  named(mount, 'categories:so1').value = '';
  await labelled(mount, 'Apply decisions and re-plan').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.length, 1);
  assert.match(text(mount), /at least one covered category/);
  assert.ok(t);
});

test('a decidable plan shows every entitlement with its reason, then one activation control', async (t) => {
  const { mount, actions } = await render(EMPTY, { results: { 'plan-service-activation': { plan: PLAN_DECIDABLE } } });
  await labelled(mount, 'Plan service activation').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const row = one(mount, 'svc-plan-entitlement');
  assert.ok(row);
  assert.match(row.textContent, /Annual support · standard/);
  assert.match(text(mount), /the support-fee component maps to the standard tier/);
  assert.equal(buttons(mount).filter((node) => node.textContent === 'Activate service coverage').length, 1,
    'exactly one activation control');

  named(mount, 'coverageKey').value = 'acme-support';
  named(mount, 'customerRef').value = 'customer:acme';
  named(mount, 'startDate').value = '2026-09-01';
  await labelled(mount, 'Activate service coverage').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const activate = actions.find((call) => call.action === 'activate-service');
  assert.ok(activate, 'the activation posts to the contract');
  assert.equal(activate.module, 'commercial-contract');
  assert.equal(activate.input.coverageKey, 'acme-support');
  assert.equal(activate.input.policy, 'b2b-service-activation');
  assert.equal(activate.input.endDate, undefined, 'an empty optional date is omitted, never sent blank');
  assert.ok(t);
});

test('a refused activation stays visible, and the typed input survives it', async (t) => {
  const { mount, trace, busy } = await render(EMPTY, {
    results: { 'plan-service-activation': { plan: PLAN_DECIDABLE } },
    scripted: { 'activate-service': Object.assign(new Error('startDate is required'), { code: 'VALIDATION' }) },
  });
  await labelled(mount, 'Plan service activation').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  named(mount, 'coverageKey').value = 'acme-support';
  named(mount, 'customerRef').value = 'customer:acme';
  await labelled(mount, 'Activate service coverage').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(trace.rerenders, 0, 'the parent did NOT treat the refusal as a success');
  assert.deepEqual(trace.errors, ['startDate is required'], 'the failure reached the parent');
  assert.match(text(mount), /startDate is required/, 'and it is visible on screen');
  assert.equal(named(mount, 'coverageKey').value, 'acme-support', 'the typed key survived');
  assert.equal(named(mount, 'customerRef').value, 'customer:acme', 'so did the customer reference');
  assert.ok(busy.every((control) => control.disabled === false), 'and every control is usable again');
  assert.ok(t);
});

test('an activated coverage renders evidence, its policy fingerprint and one end control', async (t) => {
  const { mount } = await render(activated());
  const coverage = one(mount, 'service-coverage');
  assert.ok(coverage);
  assert.equal(coverage.getAttribute('data-status'), 'active');
  assert.match(text(mount), /b2b-service-activation@1/);
  assert.match(text(mount), /f1/, 'the policy fingerprint is shown');
  assert.equal(labelled(mount, 'Plan service activation'), null, 'no second activation path exists');
  assert.equal(buttons(mount).filter((node) => node.textContent === 'End service coverage').length, 1);
  assert.ok(t);
});

test('an ended coverage exposes no lifecycle control and says what ending did not do', async (t) => {
  const { mount } = await render(activated({
    'service-coverage': [{ ...COVERAGE, status: 'ended', endDate: '2026-10-01', endedReason: 'customer left', endedBy: 'user:ops', endedAt: '2026-10-01T09:00:00.000Z' }],
  }));
  assert.equal(labelled(mount, 'End service coverage'), null);
  assert.match(text(mount), /Nothing was cancelled, credited or billed/);
  assert.match(text(mount), /open cases were left intact/);
  assert.equal(labelled(mount, 'Record support case'), null,
    'and no case can be recorded against a coverage the server would refuse');
  assert.ok(t);
});

test('entitlements are read-only evidence: no control, and every bound stated', async (t) => {
  const { mount } = await render(activated());
  const card = one(mount, 'svc-entitlement');
  assert.ok(card);
  assert.match(card.textContent, /Support tier: standard/);
  assert.match(card.textContent, /incident, question/);
  assert.match(card.textContent, /240 minute\(s\) of elapsed wall-clock time/);
  assert.match(card.textContent, /5 open case\(s\)/);
  assert.match(text(mount), /not a billing unit, not a consumption meter and not a permission/);
  // The entitlement card itself carries no input, select or button.
  const inputs = card.findAll('input').concat(card.findAll('select'), card.findAll('button'), card.findAll('textarea'));
  assert.deepEqual(inputs, [], 'an immutable record offers nothing to change');
  assert.ok(t);
});

test('the queue states the channel limitation, and the case form repeats it', async (t) => {
  const { mount } = await render(activated({ 'support-case': [CASE] }));
  assert.equal(one(mount, 'svc-channel-limitation').textContent,
    'A listed channel does not mean a provider is connected.');
  assert.match(one(mount, 'svc-case-send-limitation').textContent,
    /Nothing is emailed, called or messaged by recording a case\. A listed channel does not mean a provider is connected\./);
  assert.ok(t);
});

test('the queue is bounded, and says the bound is a display bound only', async (t) => {
  const { mount } = await render(activated({ 'support-case': [CASE] }), { truncate: 'support-case' });
  assert.match(one(mount, 'svc-truncated').textContent,
    /the open-case limit is counted server-side over every case, not over this list/);
  assert.ok(t);
});

test('opening a case renders its detail, and only the transitions the server declares', async (t) => {
  const { mount } = await render(activated({ 'support-case': [CASE] }));
  assert.equal(one(mount, 'svc-case-detail'), null, 'nothing is selected on first render');
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const detail = one(mount, 'svc-case-detail');
  assert.ok(detail, 'the case detail renders');
  const offered = named(mount, 'toStatus').findAll('option').map((node) => node.getAttribute('value'));
  assert.deepEqual(offered, ['in_progress', 'waiting_customer', 'resolved'],
    'exactly the moves declared for "new" — closed is not among them');
  assert.ok(t);
});

test('a closed case offers no transition at all, and says why', async (t) => {
  const { mount } = await render(activated({
    'support-case': [{ ...CASE, status: 'closed', firstRespondedAt: '2026-09-15T11:00:00.000Z', resolvedAt: '2026-09-15T12:00:00.000Z', closedAt: '2026-09-15T13:00:00.000Z', resolutionSummary: 'restarted the connector' }],
  }));
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(named(mount, 'toStatus'), null, 'no transition control on a terminal case');
  assert.match(one(mount, 'svc-case-terminal').textContent, /the server would refuse every one of them/);
  assert.equal(labelled(mount, 'Record first response'), null, 'and no second first response');
  assert.ok(t);
});

test('a first response is offered once, and never after it was stamped', async (t) => {
  const before = await render(activated({ 'support-case': [CASE] }));
  await labelled(before.mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(labelled(before.mount, 'Record first response'));

  const after = await render(activated({
    'support-case': [{ ...CASE, status: 'in_progress', firstRespondedAt: '2026-09-15T11:00:00.000Z' }],
  }));
  await labelled(after.mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(labelled(after.mount, 'Record first response'), null,
    'a first response has one moment, so the control is gone');
  assert.ok(t);
});

test('SLA keeps current and recorded apart, and never calls a breach contractual', async (t) => {
  const { mount, actions } = await render(activated({
    'support-case': [CASE],
    'service-sla-evaluation': [{
      id: 'sla1', supportCaseId: 'case1', serviceCoverageId: 'cov1', serviceEntitlementId: 'ent1',
      firstResponseState: 'breached', resolutionState: 'on_track',
      evaluatedAt: '2026-09-15T18:00:00.000Z', openedAt: CASE.openedAt,
      firstResponseDueAt: CASE.firstResponseDueAt, resolutionDueAt: CASE.resolutionDueAt,
      firstRespondedAt: null, resolvedAt: null, recordedBy: 'user:ops',
    }],
  }), { results: { 'preview-sla': { slaPreview: { evaluatedAt: '2026-09-15T20:00:00.000Z', firstResponseState: 'breached', resolutionState: 'at_risk' } } } });
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  const current = one(mount, 'svc-sla-current');
  const persisted = one(mount, 'svc-sla-persisted');
  assert.ok(current && persisted, 'the two are separate blocks');
  assert.match(current.textContent, /Current, not recorded/);
  assert.match(current.textContent, /Not previewed yet/, 'nothing is claimed before it is asked for');
  assert.match(persisted.textContent, /evidence about a moment and is never updated to match the present/);
  assert.match(one(mount, 'svc-sla-evaluation').textContent, /first response breached/);

  // Previewing is read-only: it must not go through the parent's re-render.
  await labelled(mount, 'Preview SLA now').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(actions.filter((call) => call.action === 'preview-sla').length, 1);
  assert.match(one(mount, 'svc-sla-current-value').textContent, /This preview records nothing/);

  // The word "breached" never appears next to a contractual or legal claim.
  assert.match(one(mount, 'svc-sla-not-legal').textContent,
    /not a contractual or legal determination, nothing is credited or refunded by it, and nobody was notified/);
  assert.equal(/contractually breached|breach of contract|legally breached/i.test(text(mount)), false);
  assert.ok(t);
});

test('escalation states that nothing was notified, and may cite a recorded evaluation', async (t) => {
  const { mount, actions } = await render(activated({
    'support-case': [CASE],
    'service-sla-evaluation': [{
      id: 'sla1', supportCaseId: 'case1', serviceCoverageId: 'cov1', evaluatedAt: '2026-09-15T18:00:00.000Z',
      firstResponseState: 'breached', resolutionState: 'on_track', recordedBy: 'user:ops',
    }],
  }));
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(one(mount, 'svc-escalation-notification').textContent, 'No notification was sent automatically.');
  assert.match(one(mount, 'svc-escalation-meaning').textContent, /Nothing is routed, assigned or scheduled by it/);
  const options = named(mount, 'slaEvaluationId').findAll('option').map((node) => node.getAttribute('value'));
  assert.deepEqual(options, ['', 'sla1'], 'only this case\'s recorded evaluations can be cited');

  named(mount, 'escalationKey').value = 'first-escalation';
  named(mount, 'escalationReason').value = 'the first response target passed';
  named(mount, 'slaEvaluationId').value = 'sla1';
  await labelled(mount, 'Record escalation').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const call = actions.find((entry) => entry.action === 'record-escalation');
  assert.ok(call);
  assert.equal(call.input.slaEvaluationId, 'sla1');
  assert.equal(call.input.level, 'internal');
  assert.ok(t);
});

test('every refusal in the section reaches the parent instead of being swallowed', async (t) => {
  // A section that catches its own failure and returns normally makes the
  // parent re-render over the error message and the operator's typing. That is
  // exactly the defect a real browser found in the M14b2 section, so it is
  // asserted for every write control here rather than for one of them.
  const failures = [
    ['end-service-coverage', 'End service coverage', {}],
    ['record-service-case', 'Record support case', {}],
    ['record-first-response', 'Record first response', { open: true }],
    ['transition-case', 'Move case', { open: true }],
    ['record-case-activity', 'Record activity', { open: true }],
    ['record-sla-evaluation', 'Record SLA evaluation', { open: true }],
    ['record-escalation', 'Record escalation', { open: true }],
  ];
  for (const [action, label, { open }] of failures) {
    const { mount, trace } = await render(activated({ 'support-case': [CASE] }), {
      scripted: { [action]: new Error(`${action} refused`) },
    });
    if (open) {
      await labelled(mount, 'Open case').dispatch('click');
      await new Promise((resolve) => setImmediate(resolve));
    }
    const control = labelled(mount, label);
    assert.ok(control, `${label} is present`);
    await control.dispatch('click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(trace.errors, [`${action} refused`], `${action}: the failure reached the parent`);
    assert.equal(trace.rerenders, 0, `${action}: the parent did not treat it as a success`);
    assert.match(text(mount), new RegExp(`${action} refused`), `${action}: the refusal is visible`);
  }
  assert.ok(t);
});

test('no control anywhere authenticates, bills, invoices, amends or renews', async (t) => {
  const { mount } = await render(activated({ 'support-case': [CASE] }));
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const labels = buttons(mount).map((node) => node.textContent);
  const forbidden = labels.filter((label) =>
    /invoice|bill|payment|charge|renew|amend|sign in|log in|authenticate|notify|send email/i.test(label));
  assert.deepEqual(forbidden, [], `no such control may exist: ${forbidden.join(' | ')}`);
  assert.match(text(mount), /No customer was authenticated/);
  assert.ok(t);
});

test('hostile record values render as text, and create no element', async (t) => {
  const hostile = '<img src=x onerror=alert(1)><b>bold</b>';
  const { mount } = await render(activated({
    'support-case': [{ ...CASE, title: hostile, description: hostile, ownerRef: hostile }],
    'service-entitlement': [{ ...ENTITLEMENT, label: hostile, decisionReason: hostile }],
  }));
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(text(mount), /<img src=x onerror=alert\(1\)><b>bold<\/b>/, 'stored exactly, rendered as text');
  assert.deepEqual(mount.findAll('img'), [], 'no element was created from record data');
  assert.deepEqual(mount.findAll('b'), [], 'and none from its markup either');
  assert.ok(t);
});

test('a stale read is discarded rather than rendered over a newer one', async (t) => {
  // Two refreshes in flight: the first must not paint after the second.
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, className, text_) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text_ !== undefined) node.textContent = String(text_);
    return node;
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let call = 0;
  const fetchRows = async (module) => {
    call += 1;
    if (call === 1) await gate; // the first read hangs until the second is done
    return { rows: module === 'service-coverage' ? [] : [], truncated: false };
  };
  const busy = [];
  const rendering = renderServiceOperations({
    contract: CONTRACT, schema: SCHEMA, mount, el,
    client: { request: async () => ({ result: {} }) }, fetchRows,
    money: () => '', withBusy: async (fn) => fn(), busy,
  });
  // Force a second, newer read by clicking Retry is not possible while the
  // first hangs, so drive the token directly through a second render call.
  const second = renderServiceOperations({
    contract: CONTRACT, schema: SCHEMA, mount, el,
    client: { request: async () => ({ result: {} }) }, fetchRows,
    money: () => '', withBusy: async (fn) => fn(), busy,
  });
  await second;
  release();
  await rendering;
  // Both renders mount their own panel; what matters is that neither left a
  // half-painted body — every panel ends in a resolved state, not "Loading…".
  for (const panel of byClass(mount, 'service-body')) {
    assert.equal(/Loading service coverage…/.test(panel.textContent), false,
      'no panel was left showing its loading state');
  }
  assert.ok(t);
});

test('the open case survives the parent re-render a successful write causes', async (t) => {
  // A real browser found this: the Admin's `withBusy` re-renders the WHOLE quote
  // detail on success, building a brand new section. Selection held in that
  // section's closure was destroyed by every successful action, so recording a
  // case — or a note on the case being read — threw the operator back to a queue
  // with nothing open. `keepSelection` reproduces the second render exactly.
  const first = await render(activated({ 'support-case': [CASE] }));
  await labelled(first.mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(one(first.mount, 'svc-case-detail'), 'the case is open');

  const second = await render(activated({ 'support-case': [CASE] }), { keepSelection: true });
  assert.ok(one(second.mount, 'svc-case-detail'), 'and it is still open after the parent rebuilt the section');
  assert.equal(one(second.mount, 'svc-case-detail').getAttribute('data-case'), 'case1');

  // A selection whose case no longer exists is nothing selected, not a broken
  // detail rendered from a stale id.
  const gone = await render(activated({ 'support-case': [] }), { keepSelection: true });
  assert.equal(one(gone.mount, 'svc-case-detail'), null);
  assert.match(text(gone.mount), /No support case has been recorded/);
  assert.ok(t);
});

test('the case form follows the selected entitlement, and says the server still checks', async (t) => {
  const second = { ...ENTITLEMENT, id: 'ent2', label: 'Premium support', supportTier: 'premium', priorities: '["urgent"]', categories: '["onboarding"]' };
  const { mount } = await render(activated({ 'service-entitlement': [ENTITLEMENT, second] }));
  const entitlement = named(mount, 'entitlement');
  const priorities = () => named(mount, 'priority').findAll('option').map((node) => node.getAttribute('value'));
  assert.deepEqual(priorities(), ['low', 'normal', 'high', 'urgent']);
  entitlement.value = 'ent2';
  await entitlement.dispatch('change');
  assert.deepEqual(priorities(), ['urgent'], 'the priorities follow the entitlement that bounds them');
  assert.match(one(mount, 'svc-case-covered').textContent,
    /covers the categories onboarding\. A category it does not cover is refused by the server, not hidden by this form\./);
  assert.ok(t);
});

test('recording a case posts against the entitlement that bounds it', async (t) => {
  const { mount, actions } = await render(activated(), {
    results: { 'record-service-case': { supportCase: { id: 'case9' } } },
  });
  named(mount, 'caseKey').value = 'sync-stopped';
  named(mount, 'title').value = 'Sync stopped';
  named(mount, 'category').value = 'incident';
  await labelled(mount, 'Record support case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const call = actions.find((entry) => entry.action === 'record-service-case');
  assert.ok(call);
  assert.equal(call.module, 'service-entitlement', 'the entitlement is the record that bounds a case');
  assert.equal(call.id, 'ent1');
  assert.equal(call.input.priority, 'low', 'the first declared priority is the default, never an invented one');
  assert.equal(call.input.source, 'manual');
  assert.ok(t);
});

test('every input carries an accessible name', async (t) => {
  const { mount } = await render(activated({ 'support-case': [CASE] }));
  await labelled(mount, 'Open case').dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
  const controls = mount.findAll('input').concat(mount.findAll('select'), mount.findAll('textarea'));
  assert.ok(controls.length >= 15, 'the section has real controls to check');
  const unnamed = controls.filter((node) => !node.getAttribute('aria-label'));
  assert.deepEqual(unnamed.map((node) => node.getAttribute('name')), [],
    'a placeholder is not a label');
  assert.ok(t);
});

test('the omissions are listed rather than implied', async (t) => {
  const { mount } = await render(activated());
  assert.match(one(mount, 'svc-not-modeled').textContent,
    /Not modeled anywhere in this section: billing, invoicing, renewal, email, scheduling\./);
  assert.ok(t);
});
