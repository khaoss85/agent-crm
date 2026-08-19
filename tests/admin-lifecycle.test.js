import test from 'node:test';
import assert from 'node:assert/strict';
import { AMENDMENT_DISCLAIMERS, renderAmendment } from '../apps/admin/public/admin-lifecycle.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin renewal & amendment section (M16b, ADR-034).
 *
 * **Package-scoped, not package-owned**: the framework has no seam for a
 * package to contribute an Admin extension (AX1 publishes
 * `ADMIN_EXTENSIONS_UNSUPPORTED`), so this code lives in the Admin app and
 * renders only while the server publishes `domains.lifecycle.amendment`.
 *
 * Every test here checks a claim the screen makes, a control it must **not**
 * offer, or a failure mode a real browser found in an earlier section: a
 * swallowed refusal that the parent's `withBusy` re-renders over, a selection
 * held in a render closure that every successful write destroys, and a
 * browser-side filter that silently drops a subject's rows past the page bound.
 *
 * The HTTP path is covered by tests/lifecycle-amendment-execution-e2e.test.js.
 */

const LIFECYCLE = {
  lifecycleContract: 1,
  notModeled: ['billing', 'invoicing', 'customer notification', 'automatic or legal renewal'],
  amendment: {
    amendmentContract: 1,
    capability: 'contracts-successor-activation@1',
    states: ['planned', 'awaiting_signed_order', 'ready', 'executed', 'abandoned'],
    terminal: ['executed', 'abandoned'],
    transitions: { planned: ['awaiting_signed_order', 'ready', 'abandoned'], ready: ['executed', 'abandoned'], executed: [], abandoned: [] },
    authority: 'the recorded run state is an OBSERVATION of the evidence at readinessObservedAt, never an authorisation',
    rounds: 'identity is (contract, round); a round that EXECUTED closes the agreement to further rounds permanently',
    limitations: ['NO_SCHEDULER — nothing here fires on a date', 'NO_BILLING — no invoice follows from an execution'],
  },
};

const SCHEMA = {
  domains: {
    lifecycle: LIFECYCLE,
    contracts: { policies: [{ kind: 'order-activation-policy', name: 'b2b-saas-order-activation', version: 1, label: 'B2B SaaS' }] },
  },
};

const CONTRACT = { id: 'cc1', customerName: 'Acme SpA', currency: 'EUR' };

const SIGNED_TERM = {
  startDate: '2026-09-01', endDate: '2027-08-31', endDateIsInclusive: true, days: 365,
  autoRenew: true, renewalNoticeDays: 60, source: 'signed-order-terms', signed: true,
  signedBasis: 'DERIVED_FROM_DECLARED_TERM_SOURCE',
  provenanceNote: 'Signed commercial term: part of the canonical document the customer signed.',
};
const OPERATIONAL_TERM = {
  ...SIGNED_TERM, startDate: '2026-09-01', source: 'post-signature-operational-activation', signed: false,
  provenanceNote: 'these dates are post-signature OPERATIONAL metadata recorded at activation (M12).',
};
const UNCLASSIFIED_TERM = {
  ...SIGNED_TERM, source: 'something-nobody-classified', signed: null, signedBasis: 'UNCLASSIFIED_TERM_SOURCE',
  provenanceNote: 'this term names a provenance nobody classified.',
};

const DELTA = {
  lines: [
    {
      key: 'offer:a|seats', status: 'changed', label: 'Seats', changedFields: ['quantity', 'netAmountCents'],
      before: { quantity: 20, netAmountCents: 95_000, currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1 },
      after: { quantity: 30, netAmountCents: 114_000, currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1 },
      ambiguous: false,
    },
    {
      key: 'offer:b|api', status: 'added', label: '<img src=x onerror=alert(1)>API', changedFields: [],
      before: null, after: { quantity: 5, netAmountCents: 9_000, currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1 },
      ambiguous: false,
    },
  ],
  counts: { added: 1, removed: 0, changed: 1, unchanged: 0 },
  ambiguousKeys: [],
  baselineBefore: [], baselineAfter: [],
  baselineDelta: [{ currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1, beforeLineCount: 1, afterLineCount: 2, beforeNetAmountCents: 95_000, afterNetAmountCents: 123_000, netAmountCentsDelta: 28_000 }],
  baselineNote: 'grouped by currency, charge type, interval AND interval count. No MRR, ARR or TCV is computed anywhere.',
};

const COHERENT_PLAN = {
  successionContract: 1,
  writes: 'nothing — this is a read-only plan',
  coherent: true,
  refusals: [],
  source: { contractId: 'cc1', term: SIGNED_TERM },
  successor: {
    orderId: 'o2',
    term: { ...SIGNED_TERM, startDate: '2027-09-01', endDate: '2028-08-31', termsFingerprint: 'abc123' },
    termsProvenance: { source: 'signed-order-terms', signed: true, note: 'signed' },
  },
  termContinuity: { relation: 'contiguous', gapDays: 0, note: 'the successor term begins the day after the source term ends' },
  delta: DELTA,
  classification: 'expansion',
  classificationBasis: 'quantities only increased, and/or lines were only added',
  notModeled: ['billing'],
  limitations: ['NO_SCHEDULER'],
};

const BLOCKED_PLAN = {
  ...COHERENT_PLAN,
  coherent: false,
  classification: null,
  successor: {
    orderId: 'o2', term: null,
    termsProvenance: { source: null, signed: false, note: 'this order\'s signed document carried no commercial term.' },
  },
  refusals: [
    { code: 'SUCCESSOR_TERMS_NOT_SIGNED', message: 'The successor order carries no signed commercial term', status: 409, details: null, resolvableByMaturity: true },
    { code: 'SUCCESSOR_CUSTOMER_MISMATCH', message: 'The successor order belongs to a different customer', status: 409, details: null, resolvableByMaturity: false },
  ],
};

const RUN = {
  id: 'run1', sourceContractId: 'cc1', round: 1, state: 'ready', reason: 'annual renewal',
  successorOrderId: 'o2', readinessGapsJson: '[]', readinessObservedAt: '2026-09-15T10:00:00.000Z',
  observedClassification: 'expansion', openedBy: 'user:ops', openedAt: '2026-09-15T09:00:00.000Z',
};

const LINEAGE = {
  id: 'succ1', sourceContractId: 'cc1', successorContractId: 'cc2', successorOrderId: 'o2',
  successorSubscriptionId: 'sub2', classification: 'expansion',
  classificationBasis: 'quantities only increased', termContinuity: 'contiguous', termGapDays: 0,
  sourceTermStartDate: '2026-09-01', sourceTermEndDate: '2027-08-31', sourceTermsSource: 'signed-order-terms',
  successorTermStartDate: '2027-09-01', successorTermEndDate: '2028-08-31', successorTermsSource: 'signed-order-terms',
  documentHash: 'hash2', policy: 'b2b-saas-order-activation', policyVersion: 1, policyFingerprint: 'f1',
  executedBy: 'user:ops', executedAt: '2026-09-15T10:05:00.000Z',
};

/**
 * Render against stub data, collecting the calls the screen would make.
 *
 * The stubbed `withBusy` models the REAL one (`apps/admin/public/admin-quotes.js`):
 * it re-renders the whole detail on success and only shows an error when the
 * callback rejects. A stub that merely awaits cannot see the class of bug a real
 * browser found in the M14b2 section — a handler that swallowed its own failure
 * looked fine while the parent silently rebuilt the DOM over both the message
 * and the operator's typing.
 */
async function render({
  runs = [], successions = [], plan = COHERENT_PLAN, schema = SCHEMA, planError = null, listError = null,
} = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const requests = [];
  const actions = [];
  const client = {
    request: async (path, options) => {
      requests.push(path);
      const action = /^\/api\/modules\/([^/]+)\/records\/([^/]+)\/actions\/([^/]+)$/.exec(path);
      if (action) {
        const [, module, id, name] = action.map(decodeURIComponent);
        assert.equal(options.method, 'POST');
        actions.push({ module, id, action: name, input: JSON.parse(options.body) });
        if (name === 'plan-amendment') {
          if (planError) throw planError;
          return { result: { succession: plan } };
        }
        return { result: {} };
      }
      if (listError) throw listError;
      if (path.startsWith('/api/modules/amendment-run/records')) return { items: runs };
      if (path.startsWith('/api/modules/contract-succession/records')) return { items: successions };
      throw new Error(`unexpected read: ${path}`);
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
  await renderAmendment({
    contract: CONTRACT, schema, mount, el, client,
    money: (cents, currency) => `${currency} ${(cents / 100).toFixed(2)}`,
    withBusy, busy,
  });
  return { mount, busy, actions, requests, trace };
}

const nodes = (mount) => mount.findAll('div')
  .concat(mount.findAll('p'), mount.findAll('button'), mount.findAll('small'),
    mount.findAll('input'), mount.findAll('select'), mount.findAll('span'),
    mount.findAll('h3'), mount.findAll('h4'), mount.findAll('h5'), mount.findAll('option'));
const byClass = (mount, className) =>
  nodes(mount).filter((node) => (node.getAttribute('class') ?? '').split(' ').includes(className));
const byAttr = (mount, name, value) =>
  nodes(mount).filter((node) => node.getAttribute(name) === value);
const buttons = (mount) => mount.findAll('button');
const labelled = (mount, text) => buttons(mount).find((node) => node.textContent.includes(text)) ?? null;
const named = (mount, name) => nodes(mount).find((node) => node.getAttribute('name') === name) ?? null;

/**
 * Click, and wait for the handler the click started.
 *
 * The fake DOM's `dispatch` is synchronous while every handler here is async,
 * so a bare dispatch would assert against a screen the request had not reached
 * yet. One microtask turn is enough because the stub client resolves
 * immediately; anything more would be a sleep pretending to be a wait.
 */
async function click(control) {
  control.dispatch('click');
  await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------

test('the section disappears with the package rather than degrading', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  await renderAmendment({
    contract: CONTRACT, schema: { domains: {} }, mount,
    el: (tag) => doc.createElement(tag), client: { request: async () => assert.fail('no request may be made') },
    money: () => '', withBusy: async () => {}, busy: [],
  });
  assert.equal(mount.childNodes.length, 0, 'no package, no section, and no half-broken control');
  // …and an older server that publishes lifecycle WITHOUT the amendment block
  // gets nothing either, rather than a section whose actions 404.
  const { mount: older } = await render({ schema: { domains: { lifecycle: { lifecycleContract: 1 } } } });
  assert.equal(older.childNodes.length, 0);
});

test('every disclaimer renders verbatim, in every state', async () => {
  for (const state of [
    {},
    { runs: [{ ...RUN, state: 'planned', successorOrderId: null }] },
    { runs: [RUN] },
    { runs: [{ ...RUN, state: 'executed' }], successions: [LINEAGE] },
  ]) {
    const { mount } = await render(state);
    for (const sentence of AMENDMENT_DISCLAIMERS) {
      assert.ok(mount.textContent.includes(sentence), `missing disclaimer: ${sentence.slice(0, 40)}…`);
    }
  }
});

test('with no run there is exactly one control, and an empty reason is refused before any request leaves the browser', async () => {
  const { mount, actions, trace } = await render();
  assert.equal(byAttr(mount, 'data-state', 'none').length, 1);
  const open = labelled(mount, 'Open amendment run');
  assert.ok(open);
  assert.equal(buttons(mount).length, 1, 'exactly one control exists before a round is open');

  await click(open);
  assert.deepEqual(actions, [], 'nothing was posted');
  assert.equal(trace.rerenders, 0, 'the parent did not treat it as a success');
  assert.equal(trace.errors.length, 1, 'and the refusal is visible');
  assert.match(trace.errors[0], /reason is required/);

  named(mount, 'reason').value = 'annual renewal';
  await click(open);
  assert.deepEqual(actions, [{ module: 'commercial-contract', id: 'cc1', action: 'open-amendment-run', input: { reason: 'annual renewal' } }]);
});

test('the two signed-terms provenances render separately and never collapse into one badge', async () => {
  const { mount } = await render({ runs: [RUN] });
  const boxes = byClass(mount, 'amendment-provenance');
  assert.equal(boxes.length, 2, 'the source and the successor each keep their own');
  assert.deepEqual(boxes.map((box) => box.getAttribute('data-signed')), ['signed', 'signed']);
  // The package's own sentence, verbatim, on each.
  const notes = byClass(mount, 'amendment-provenance-note').map((node) => node.textContent);
  assert.ok(notes.some((note) => note.includes('canonical document the customer signed')));

  // Operational, unclassified and absent are three different answers.
  const operational = await render({
    runs: [RUN], plan: { ...COHERENT_PLAN, source: { contractId: 'cc1', term: OPERATIONAL_TERM } },
  });
  assert.equal(byClass(operational.mount, 'amendment-provenance')[0].getAttribute('data-signed'), 'operational');
  assert.ok(operational.mount.textContent.includes('post-signature operational metadata'));

  const unclassified = await render({
    runs: [RUN], plan: { ...COHERENT_PLAN, source: { contractId: 'cc1', term: UNCLASSIFIED_TERM } },
  });
  assert.equal(byClass(unclassified.mount, 'amendment-provenance')[0].getAttribute('data-signed'), 'unclassified',
    'a provenance nobody classified is never quietly rendered as "not signed"');

  const absent = await render({ runs: [RUN], plan: BLOCKED_PLAN });
  const successorBox = byClass(absent.mount, 'amendment-provenance')[1];
  assert.equal(successorBox.getAttribute('data-signed'), 'absent');
  assert.ok(absent.mount.textContent.includes('carried no commercial term'));
});

test('the classification is presented as derived, never as a choice, and no control can change it', async () => {
  const { mount } = await render({ runs: [RUN] });
  assert.ok(mount.textContent.includes('expansion'));
  assert.ok(mount.textContent.includes('quantities only increased'));
  assert.ok(byClass(mount, 'amendment-classification-note')[0].textContent.includes('never chosen here'));
  // No input, select or option anywhere offers a classification value.
  for (const value of ['renewal', 'expansion', 'contraction', 'mixed', 'commercial_change']) {
    assert.equal(
      nodes(mount).some((node) => node.getAttribute('value') === value),
      false, `${value} must never be selectable`,
    );
  }
});

test('the delta renders every line as text, and record text creates no element', async () => {
  const { mount } = await render({ runs: [RUN] });
  const lines = byClass(mount, 'amendment-delta-line');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.getAttribute('data-delta-status')), ['changed', 'added']);
  assert.ok(mount.textContent.includes('qty 20'));
  assert.ok(mount.textContent.includes('qty 30'));
  assert.ok(mount.textContent.includes('changed: quantity, netAmountCents'));
  // Hostile record text is text.
  assert.ok(mount.textContent.includes('<img src=x onerror=alert(1)>API'));
  assert.equal(mount.findAll('img').length, 0, 'no element was created from record data');
  assert.equal(mount.findAll('script').length, 0);
  // No derived revenue figure is shown, and the grouping note says so.
  assert.ok(byClass(mount, 'amendment-baseline-note')[0].textContent.includes('No MRR, ARR or TCV'));
});

test('the execute control exists only in ready, and only while the plan is coherent', async () => {
  const ready = await render({ runs: [RUN] });
  assert.ok(labelled(ready.mount, 'Execute renewal or amendment'), 'ready and coherent offers it');

  const blocked = await render({ runs: [{ ...RUN, state: 'awaiting_signed_order' }], plan: BLOCKED_PLAN });
  assert.equal(labelled(blocked.mount, 'Execute renewal or amendment'), null,
    'a control that only produces a refusal is a control that lies');
  assert.ok(byClass(blocked.mount, 'amendment-no-execute').length > 0, 'and the absence is explained');

  // A `ready` run whose plan went incoherent since attach shows no control
  // either: the screen follows the recomputation, not the recorded state.
  const stale = await render({ runs: [RUN], plan: BLOCKED_PLAN });
  assert.equal(labelled(stale.mount, 'Execute renewal or amendment'), null);

  const planned = await render({ runs: [{ ...RUN, state: 'planned', successorOrderId: null }] });
  assert.equal(labelled(planned.mount, 'Execute renewal or amendment'), null);
});

test('a blocked plan names each gap and says whether waiting can fix it', async () => {
  const { mount } = await render({ runs: [{ ...RUN, state: 'awaiting_signed_order' }], plan: BLOCKED_PLAN });
  const gaps = byClass(mount, 'amendment-gap');
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps.map((gap) => gap.getAttribute('data-gap')),
    ['SUCCESSOR_TERMS_NOT_SIGNED', 'SUCCESSOR_CUSTOMER_MISMATCH']);
  assert.ok(mount.textContent.includes('this can still resolve as the order matures'));
  assert.ok(mount.textContent.includes('waiting will not resolve this'));
});

test('an executed round shows immutable evidence and offers no control at all', async () => {
  const { mount, busy } = await render({ runs: [{ ...RUN, state: 'executed' }], successions: [LINEAGE] });
  assert.equal(byAttr(mount, 'data-state', 'executed').length, 1);
  assert.equal(buttons(mount).length, 0, 'evidence only: nothing to progress, bill, renew or cancel');
  assert.equal(busy.length, 0);
  assert.ok(mount.textContent.includes('cc2'));
  assert.ok(mount.textContent.includes('contiguous'));
  assert.ok(byClass(mount, 'amendment-immutable')[0].textContent.includes('rewrites nothing behind it'));
});

test('no amend-in-place, invoice, bill, payment, notify or cancel control exists anywhere in the section', async () => {
  for (const state of [{}, { runs: [{ ...RUN, state: 'planned' }] }, { runs: [RUN] },
    { runs: [{ ...RUN, state: 'executed' }], successions: [LINEAGE] }]) {
    const { mount } = await render(state);
    for (const control of buttons(mount).concat(nodes(mount).filter((node) => node.getAttribute('name')))) {
      const label = `${control.textContent ?? ''} ${control.getAttribute('name') ?? ''}`.toLowerCase();
      for (const forbidden of ['invoice', 'bill', 'payment', 'charge', 'notify', 'email', 'cancel', 'schedule']) {
        assert.equal(label.includes(forbidden), false, `a "${forbidden}" control exists: ${label}`);
      }
    }
  }
});

test('the run list is narrowed on the server, not filtered in the browser', async () => {
  const { requests } = await render({ runs: [RUN] });
  const listRead = requests.find((path) => path.startsWith('/api/modules/amendment-run/records'));
  assert.ok(listRead.includes('filter.sourceContractId=cc1'),
    'a browser-side filter drops a contract whose rounds are older than the page bound');
  const successionRead = requests.find((path) => path.startsWith('/api/modules/contract-succession/records'));
  assert.ok(successionRead.includes('filter.sourceContractId=cc1'));
});

test('another agreement\'s rows are never drawn, even if the server ignored the filter', async () => {
  const { mount } = await render({ runs: [{ ...RUN, id: 'other', sourceContractId: 'cc-other' }] });
  assert.equal(byAttr(mount, 'data-run', 'other').length, 0);
  assert.equal(byAttr(mount, 'data-state', 'none').length, 1, 'this contract has no round, and the screen says so');
});

test('every refusal is visible and the operator\'s typing survives it', async () => {
  const { mount, trace, actions } = await render({ runs: [{ ...RUN, state: 'planned', successorOrderId: null }] });
  const attach = labelled(mount, 'Attach successor order');
  named(mount, 'abandonReason').value = 'typed but not submitted';
  await click(attach);
  assert.equal(trace.errors.length, 1, 'the handler re-threw rather than swallowing it');
  assert.equal(trace.rerenders, 0);
  assert.deepEqual(actions.filter((entry) => entry.action === 'attach-successor-order'), []);
  assert.equal(named(mount, 'abandonReason').value, 'typed but not submitted',
    'a neighbouring input was not destroyed by the failure');
  // …and the controls are re-enabled so the operator can correct and retry.
  assert.equal(attach.disabled, false);
});

test('a failed load is explained on screen, and the limitations still render', async () => {
  const { mount } = await render({ listError: new Error('request failed') });
  assert.ok(mount.textContent.includes('request failed'));
  for (const sentence of AMENDMENT_DISCLAIMERS) {
    assert.ok(mount.textContent.includes(sentence), 'a broken read never hides what is not modeled');
  }
});

test('every control has an accessible name and every text input a durable aria-label', async () => {
  const { mount } = await render({ runs: [RUN] });
  for (const control of buttons(mount)) {
    assert.ok(String(control.textContent ?? '').trim().length > 0, 'a button with no name is unreachable');
  }
  for (const input of mount.findAll('input').concat(mount.findAll('select'))) {
    const label = input.getAttribute('aria-label');
    assert.ok(label && label.trim().length > 0, `${input.getAttribute('name')} needs a durable label, not a placeholder`);
  }
});

test('the recorded readiness is presented as an observation, with the package\'s own sentence', async () => {
  const { mount } = await render({ runs: [RUN] });
  assert.ok(byClass(mount, 'amendment-observation-note')[0].textContent.includes('never an authorisation'));
  assert.ok(mount.textContent.includes('authorises nothing'));
});
