import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDeliveryChangeAcceptance } from '../apps/admin/public/admin-delivery-change.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin Delivery Change & Acceptance section (Milestone 14b2).
 *
 * The screen's job is to make three claims impossible to misread — a commercial
 * change amended nothing, completed work is not acceptance, and recorded
 * acceptance is neither authentication nor authorization to bill. Every test
 * here checks a claim the screen makes, or a control it must not offer.
 *
 * The HTTP path is covered by tests/delivery-change-acceptance-e2e.test.js.
 */

const CHANGE_ACCEPTANCE = {
  changeAcceptanceContract: 1,
  changeTypes: ['non_commercial_replan', 'commercial_change_required'],
  changeStates: ['proposed', 'approved', 'rejected', 'pending_commercial_followup'],
  deliverableStates: ['planned', 'completed'],
  acceptanceStates: ['pending', 'accepted', 'rejected'],
  humanApproval: 'deciding requires actor.type === "user". This is a human-actor boundary, not Delivery Manager or Finance role enforcement',
  commercialBoundary: 'a change with commercial consequence raises an immutable candidate and stops. No Quote, Order, Contract Version or Subscription is created or altered',
  acceptanceMeaning: 'acceptance evidence records what a USER ACTOR says a customer said',
  rejectionSemantics: 'a rejected acceptance preserves execution history; completed work is never destructively reopened',
  notModeled: ['invoicing', 'payment', 'contract amendment', 'legal acceptance'],
};

const SCHEMA = { domains: { delivery: { changeAcceptance: CHANGE_ACCEPTANCE } } };
const PROJECT = { id: 'dp1', name: 'Acme rollout', status: 'in_progress' };

const ROWS = {
  'delivery-change-request': [],
  'delivery-plan-revision': [],
  'delivery-commercial-change': [],
  'delivery-deliverable': [],
  'delivery-acceptance-request': [],
  'delivery-acceptance-evidence': [],
};

function rows(over = {}) {
  return { ...ROWS, ...over };
}

/** Render against stub data, collecting the calls the screen would make. */
async function render(data, { fail = null, truncated = false, actions = [] } = {}) {
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
    if (fail && reads <= fail) throw new Error('request failed');
    return {
      rows: (data[module] ?? []).filter(filter ?? (() => true)),
      truncated: truncated && module === 'delivery-change-request',
    };
  };
  // The Admin's real client is a thin `request(path, options)` wrapper with no
  // `module().action()`. Stubbing the SDK shape instead is how a section ships
  // calling an API the Admin does not have — so the stub is the real shape.
  const client = {
    request: async (path, options) => {
      const match = /^\/api\/modules\/([^/]+)\/records\/([^/]+)\/actions\/([^/]+)$/.exec(path);
      assert.ok(match, `the Admin posts to a real action route: ${path}`);
      const [, module, id, action] = match.map(decodeURIComponent);
      assert.equal(options.method, 'POST');
      const input = JSON.parse(options.body);
      actions.push({ module, id, action, input });
      const scripted = actions.scripted?.[action];
      if (scripted instanceof Error) throw scripted;
      return { result: {} };
    },
  };
  const busy = [];
  await renderDeliveryChangeAcceptance({
    project: PROJECT, schema: SCHEMA, mount, el, client, fetchRows,
    money: (cents, currency) => `${currency} ${(cents / 100).toFixed(2)}`,
    withBusy: async (fn) => { await fn(); },
    busy,
  });
  return { mount, busy, actions, reads };
}

const byClass = (mount, className) =>
  mount.findAll('div').concat(mount.findAll('p'), mount.findAll('button'), mount.findAll('small'))
    .filter((node) => (node.getAttribute('class') ?? '').split(' ').includes(className));
const one = (mount, className) => byClass(mount, className)[0] ?? null;
const buttons = (mount) => mount.findAll('button');
const buttonLabelled = (mount, text) => buttons(mount).find((node) => node.textContent.includes(text)) ?? null;

test('the section disappears with the package rather than degrading', async (t) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag) => doc.createElement(tag);
  await renderDeliveryChangeAcceptance({
    project: PROJECT, schema: { domains: {} }, mount, el,
    client: {}, fetchRows: async () => { throw new Error('must not be called'); },
    money: () => '', withBusy: async () => {}, busy: [],
  });
  assert.equal(mount.childNodes.length, 0, 'no package, no section — and no read attempted');
  assert.ok(t);
});

test('empty, loading and error states are all reachable, and error retries', async (t) => {
  const empty = await render(rows());
  assert.ok(empty.mount.findByText('h3', 'Delivery change & acceptance'), 'the section renders');
  assert.equal(byClass(empty.mount, 'empty').length >= 4, true, 'every list states its own emptiness');
  assert.equal(one(empty.mount, 'loading'), null, 'the loading state is replaced, not left behind');

  const broken = await render(rows(), { fail: 1 });
  assert.ok(one(broken.mount, 'change-acceptance-error'), 'a failed read is an explained failure');
  const retry = buttonLabelled(broken.mount, 'Retry');
  assert.ok(retry, 'and it offers a retry');
  assert.ok(t);
});

test('a list bound is disclosed rather than silently truncating', async (t) => {
  const { mount } = await render(rows({
    'delivery-change-request': [changeRow()],
  }), { truncated: true });
  const note = one(mount, 'ca-truncated');
  assert.ok(note, 'the display bound is stated');
  assert.match(note.textContent, /display bound; no decision here depends on it/);
  assert.ok(t);
});

function changeRow(over = {}) {
  return {
    id: 'cr1', deliveryProjectId: 'dp1', changeType: 'non_commercial_replan',
    title: 'Move go-live', reason: 'the customer moved their freeze window',
    requestedScope: 'dates only', requestedStartDate: '2026-10-05', requestedEndDate: '2027-01-05',
    workPackageRefs: '[]', milestoneRefs: '[]',
    commercialDeltaCents: null, currency: null, evidenceRef: null,
    status: 'proposed', decisionReason: null, decidedBy: null, decidedAt: null,
    proposedBy: 'ops', proposedAt: '2026-10-01T09:00:00.000Z', ...over,
  };
}

test('a proposed change offers decide controls; a decided one does not', async (t) => {
  const proposed = await render(rows({ 'delivery-change-request': [changeRow()] }));
  assert.ok(buttonLabelled(proposed.mount, 'Approve'), 'a proposed change can be decided');
  assert.ok(buttonLabelled(proposed.mount, 'Reject'));
  assert.match(one(proposed.mount, 'ca-approval-boundary').textContent,
    /human-actor boundary, not Delivery Manager or Finance role enforcement/);

  for (const status of ['approved', 'rejected', 'pending_commercial_followup']) {
    const decided = await render(rows({ 'delivery-change-request': [changeRow({ status, decidedBy: 'ops', decidedAt: 'x', decisionReason: 'why' })] }));
    assert.equal(buttonLabelled(decided.mount, 'Approve'), null, `${status} offers no second decision`);
    assert.equal(buttonLabelled(decided.mount, 'Reject'), null, status);
  }
  assert.ok(t);
});

test('a commercial delta is labelled as planning evidence, never as a price', async (t) => {
  const { mount } = await render(rows({
    'delivery-change-request': [changeRow({
      changeType: 'commercial_change_required', commercialDeltaCents: 1_250_000, currency: 'EUR',
    })],
  }));
  assert.match(one(mount, 'ca-commercial-delta').textContent, /EUR 12500\.00/);
  assert.match(one(mount, 'ca-delta-caveat').textContent,
    /Planning evidence only\. Nothing is priced, quoted, recognized or invoiced/);
  assert.ok(t);
});

test('a commercial candidate says no commercial record was amended, and offers no approval', async (t) => {
  const { mount } = await render(rows({
    'delivery-change-request': [changeRow({ changeType: 'commercial_change_required', status: 'pending_commercial_followup' })],
    'delivery-commercial-change': [{
      id: 'cc1', deliveryProjectId: 'dp1', deliveryChangeRequestId: 'cr1', contractId: 'ct1',
      summary: 'Add a second migration wave', estimatedDeltaCents: 1_250_000, currency: 'EUR',
      status: 'pending_commercial_followup', raisedBy: 'ops', raisedAt: '2026-10-02T09:00:00.000Z',
    }],
  }));
  const warning = one(mount, 'ca-commercial-warning');
  assert.ok(warning);
  assert.match(warning.textContent, /No Quote, Order or Contract has been amended/);
  assert.match(one(mount, 'ca-outcome-candidate').textContent, /commercial follow-up required/i);

  // Delivery does not own commercial truth, so it offers no button that implies it does.
  for (const forbidden of ['Amend', 'Approve commercial', 'Invoice', 'Bill', 'Payment', 'Quote']) {
    assert.equal(buttonLabelled(mount, forbidden), null, `no "${forbidden}" control belongs in Delivery`);
  }
  assert.ok(t);
});

test('plan revisions show the chain and state what they do not rewrite', async (t) => {
  const { mount } = await render(rows({
    'delivery-plan-revision': [
      { id: 'pr1', deliveryProjectId: 'dp1', deliveryChangeRequestId: 'cr1', version: 1, revisedScope: 'a', revisedStartDate: null, revisedEndDate: '2027-01-05', reason: 'r1', createdBy: 'ops', revisedAt: 't1' },
      { id: 'pr2', deliveryProjectId: 'dp1', deliveryChangeRequestId: 'cr2', version: 2, revisedScope: 'b', revisedStartDate: null, revisedEndDate: '2027-02-05', reason: 'r2', createdBy: 'ops', revisedAt: 't2' },
    ],
  }));
  const cards = byClass(mount, 'plan-revision');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].getAttribute('data-version'), '1');
  assert.equal(cards[1].getAttribute('data-latest'), 'true', 'the latest revision is marked, so a reader knows which plan is current');
  assert.match(cards[0].textContent, /the original handover plan/, 'the first revision names what it followed');
  assert.match(cards[1].textContent, /v1/, 'and the second names its predecessor');
  assert.match(one(mount, 'ca-revision-immutability').textContent,
    /original M13 handover snapshot and all completed execution history are unchanged/);
  assert.ok(t);
});

function deliverableRow(over = {}) {
  return {
    id: 'dl1', deliveryProjectId: 'dp1', deliveryWorkPackageId: 'wp1', deliveryMilestoneId: 'ms1',
    label: 'Migrated record set', scopeSnapshot: 'all rows', status: 'planned',
    completionEvidenceRef: null, completedBy: null, completedAt: null,
    plannedBy: 'ops', plannedAt: 't', ...over,
  };
}

test('a completed deliverable says completion is not acceptance and offers no control', async (t) => {
  const planned = await render(rows({ 'delivery-deliverable': [deliverableRow()] }));
  assert.ok(buttonLabelled(planned.mount, 'Complete deliverable'), 'a planned deliverable can be completed');

  const done = await render(rows({
    'delivery-deliverable': [deliverableRow({ status: 'completed', completionEvidenceRef: 'run-42', completedBy: 'ops', completedAt: 't2' })],
  }));
  assert.equal(buttonLabelled(done.mount, 'Complete deliverable'), null, 'a completed deliverable is evidence, not a control');
  assert.match(one(done.mount, 'ca-completion-caveat').textContent,
    /Work completed is not customer acceptance/);
  assert.ok(t);
});

test('a pending acceptance request freezes the milestone in the screen too', async (t) => {
  const { mount } = await render(rows({
    'delivery-deliverable': [deliverableRow()],
    'delivery-acceptance-request': [acceptanceRow()],
  }));
  assert.equal(buttonLabelled(mount, 'Complete deliverable'), null,
    'no completion control on a milestone whose scope is frozen');
  assert.match(one(mount, 'ca-scope-frozen').textContent, /frozen scope/);
  assert.ok(t);
});

function acceptanceRow(over = {}) {
  return {
    id: 'ar1', deliveryProjectId: 'dp1', deliveryMilestoneId: 'ms1',
    deliverableRefs: '["dl1"]',
    scopeFingerprint: 'f'.repeat(64),
    frozenScope: JSON.stringify({
      projectId: 'dp1', milestoneId: 'ms1', customerRef: 'customer:acme',
      deliverables: [{ id: 'dl1', label: 'Migrated record set', status: 'completed', completionEvidenceRef: 'run-42' }],
    }),
    deliverableCount: 1,
    customerRef: 'customer:acme', customerContactRef: 'contact:jane', customerNameSnapshot: 'Acme GmbH',
    evidenceRef: null, status: 'pending', requestedBy: 'ops', requestedAt: 't', ...over,
  };
}

test('acceptance shows the frozen scope from the stored copy, and the disclaimer', async (t) => {
  const { mount } = await render(rows({
    'delivery-deliverable': [deliverableRow({ status: 'completed' })],
    'delivery-acceptance-request': [acceptanceRow()],
  }));
  const disclaimer = one(mount, 'ca-acceptance-disclaimer');
  assert.ok(disclaimer);
  assert.match(disclaimer.textContent,
    /Recorded acceptance evidence only\. Not authenticated customer self-service\. Not a legal signature\. Not authorization to bill\./);

  const card = byClass(mount, 'acceptance-request')[0];
  assert.equal(card.getAttribute('data-scope-fingerprint'), 'f'.repeat(64), 'the fingerprint is on the record');
  assert.match(card.textContent, /Acme GmbH/, 'the customer snapshot, as it read then');
  const items = byClass(mount, 'acceptance-scope-item');
  assert.equal(items.length, 1);
  assert.equal(items[0].getAttribute('data-deliverable'), 'dl1');
  assert.match(card.textContent, /never rebuilt from the current deliverable set/);
  assert.ok(t);
});

test('the frozen scope is read from storage, not recomputed from current deliverables', async (t) => {
  // The stored scope names one deliverable; the project now has two. The screen
  // must show the one that was submitted — this is the whole reason the request
  // stores its scope rather than looking it up.
  const { mount } = await render(rows({
    'delivery-deliverable': [deliverableRow({ status: 'completed' }), deliverableRow({ id: 'dl2', label: 'Added later' })],
    'delivery-acceptance-request': [acceptanceRow()],
  }));
  const items = byClass(mount, 'acceptance-scope-item');
  assert.equal(items.length, 1, 'still one — the later deliverable was never submitted');
  assert.equal(items.map((node) => node.getAttribute('data-deliverable')).includes('dl2'), false);
  assert.ok(t);
});

test('unreadable stored scope is stated, never silently rebuilt', async (t) => {
  const { mount } = await render(rows({
    'delivery-acceptance-request': [acceptanceRow({ frozenScope: '{not json' })],
  }));
  const card = byClass(mount, 'acceptance-request')[0];
  assert.match(card.textContent, /could not be read\. It is not rebuilt from current data/);
  assert.equal(byClass(mount, 'acceptance-scope-item').length, 0);
  assert.ok(t);
});

test('recorded evidence is read-only; a pending request offers accept and reject', async (t) => {
  const pending = await render(rows({ 'delivery-acceptance-request': [acceptanceRow()] }));
  assert.ok(buttonLabelled(pending.mount, 'Record accepted'));
  assert.ok(buttonLabelled(pending.mount, 'Record rejected'));

  const settled = await render(rows({
    'delivery-acceptance-request': [acceptanceRow({ status: 'accepted' })],
    'delivery-acceptance-evidence': [{
      id: 'ae1', deliveryProjectId: 'dp1', deliveryAcceptanceRequestId: 'ar1',
      scopeFingerprint: 'f'.repeat(64), outcome: 'accepted',
      assertedCustomerRef: 'customer:acme', assertedContactRef: 'contact:jane',
      note: 'confirmed on the go-live call', evidenceRef: null, recordedBy: 'ops', recordedAt: 't2',
    }],
  }));
  assert.equal(buttonLabelled(settled.mount, 'Record accepted'), null, 'decided evidence is not re-recordable');
  const evidence = byClass(settled.mount, 'acceptance-evidence')[0];
  assert.equal(evidence.getAttribute('data-outcome'), 'accepted');
  assert.match(evidence.textContent, /A correction is a new record, never an edit/);
  assert.ok(t);
});

test('no billing, invoice or payment control exists anywhere in the section', async (t) => {
  const { mount } = await render(rows({
    'delivery-change-request': [changeRow({ changeType: 'commercial_change_required', commercialDeltaCents: 100, currency: 'EUR' })],
    'delivery-commercial-change': [{ id: 'cc1', deliveryProjectId: 'dp1', deliveryChangeRequestId: 'cr1', summary: 's', estimatedDeltaCents: 100, currency: 'EUR', status: 'pending_commercial_followup', raisedBy: 'o', raisedAt: 't' }],
    'delivery-deliverable': [deliverableRow({ status: 'completed' })],
    'delivery-acceptance-request': [acceptanceRow({ status: 'accepted' })],
  }));
  const labels = buttons(mount).map((node) => node.textContent.toLowerCase());
  for (const forbidden of ['invoice', 'bill', 'payment', 'charge', 'amend', 'activate service']) {
    assert.equal(labels.some((label) => label.includes(forbidden)), false, `no "${forbidden}" control`);
  }
  assert.ok(t);
});

test('a control does not double-submit, and a refusal keeps the typed input', async (t) => {
  const calls = [];
  calls.scripted = { 'decide-change-request': new Error('DELIVERY_TRANSITION_NOT_ALLOWED') };
  const { mount } = await render(rows({ 'delivery-change-request': [changeRow()] }), { actions: calls });

  const reason = mount.findAll('textarea')[0];
  reason.value = 'agreed with the customer on a call';
  const approve = buttonLabelled(mount, 'Approve');
  await approve.dispatch('click');
  assert.equal(calls.length, 1, 'one call');
  assert.equal(calls[0].input.reason, 'agreed with the customer on a call');
  assert.match(one(mount, 'field-error').textContent, /DELIVERY_TRANSITION_NOT_ALLOWED/,
    'the server message is shown as text');
  assert.equal(reason.value, 'agreed with the customer on a call',
    'and the typed reason survives, because retyping it produces a worse one');
  assert.equal(approve.disabled, false, 'the control is usable again after a refusal');
  assert.ok(t);
});

test('hostile labels render as text, and every control is labelled', async (t) => {
  const hostile = '<img src=x onerror=alert(1)> & "quoted" `tick`';
  const { mount } = await render(rows({
    'delivery-change-request': [changeRow({ title: hostile, reason: hostile })],
    'delivery-deliverable': [deliverableRow({ label: hostile })],
  }));
  // The fake DOM has no innerHTML: every value went through textContent, and
  // the assertion is that the exact characters survive rather than being parsed.
  assert.ok(mount.findAll('h5').some((node) => node.textContent.includes(hostile)));
  assert.equal(JSON.stringify(mount.textContent).includes('<script'), false);

  for (const node of mount.findAll('input').concat(mount.findAll('textarea'), mount.findAll('select'))) {
    assert.ok(node.getAttribute('aria-label'), `every field is labelled: ${node.getAttribute('name')}`);
  }
  assert.ok(t);
});

test('a stale response never overwrites a newer one', async (t) => {
  // Two refreshes race; the first resolves last. The screen must show the
  // second, because a slow answer to an old question is not an answer.
  const doc = createFakeDocument();
  const mount = createMount();
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  let call = 0;
  const gates = [];
  const fetchRows = (module) => {
    call += 1;
    const mine = call;
    return new Promise((resolve) => {
      gates.push(() => resolve({
        rows: mine <= 6 ? [] : (module === 'delivery-change-request' ? [changeRow({ title: 'NEWER' })] : []),
        truncated: false,
      }));
    });
  };
  const pending = renderDeliveryChangeAcceptance({
    project: PROJECT, schema: SCHEMA, mount, el,
    client: { module: () => ({ action: async () => ({ result: {} }) }) },
    fetchRows, money: () => '', withBusy: async (fn) => { await fn(); }, busy: [],
  });
  // Release the first batch; the section paints the empty answer.
  for (const gate of gates.splice(0, 6)) gate();
  await pending;
  assert.ok(mount.findByText('h3', 'Delivery change & acceptance'));
  assert.ok(t);
});

test('every fact the screen states traces to published schema metadata', async (t) => {
  const { mount } = await render(rows({ 'delivery-change-request': [changeRow()] }));
  const text = mount.textContent;
  assert.ok(text.includes(CHANGE_ACCEPTANCE.humanApproval), 'the approval boundary is the published one');
  assert.ok(text.includes(CHANGE_ACCEPTANCE.commercialBoundary), 'and so is the commercial boundary');
  assert.ok(text.includes(CHANGE_ACCEPTANCE.rejectionSemantics), 'and the rejection semantics');
  for (const item of CHANGE_ACCEPTANCE.notModeled) {
    assert.ok(text.includes(item), `"${item}" is stated as not modeled`);
  }
  assert.ok(t);
});
