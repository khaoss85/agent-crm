import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  BUSINESS_NOW, POLICY, boot, project, signedOrder,
} from './helpers/contracts-project.js';

/**
 * **M16b — renewal and amendment execution, against a running application.**
 *
 * Everything here is a claim about a real composed app: real manifests through
 * the real module factory, a real signed order produced by driving catalog →
 * quote → signed term → approval → signature → completion, and the real HTTP
 * surface where the claim is about a client.
 *
 * The claim these tests exist to hold is narrow and expensive to get wrong: a
 * successor commercial agreement is produced **only** from signed evidence,
 * the source agreement is never touched, and nothing is ever described as
 * signed when the evidence is post-signature operational.
 */

const ACTOR = { type: 'user', id: 'e2e' };
const AGENT = { type: 'agent', id: 'bot' };

/** The source agreement's signed term, and the successor's. */
const SOURCE_TERM = {
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};
const SUCCESSOR_TERM = {
  effectiveDate: '2027-09-01', termStartDate: '2027-09-01', termEndDate: '2028-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:support-annual'];

async function refusal(promise) {
  try {
    const value = await promise;
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      status: error.status ?? error.body?.error?.status ?? null,
      code: error.code ?? error.body?.error?.code ?? null,
      message: String(error.message ?? ''),
    };
  }
}

/**
 * The whole M16b fixture: a source agreement activated from signed terms, plus
 * a second signed Order for the same customer carrying its own signed term.
 */
async function scene(t, options = {}) {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', `m16b-${options.db ?? 'main'}.sqlite`), options.boot ?? {});
  t.after(() => context.close());
  const { app } = context;

  const source = await signedOrder(root, app, {
    name: options.name ?? 'M16b Source',
    offers: options.sourceOffers ?? OFFERS,
    term: SOURCE_TERM,
    quantities: options.sourceQuantities ?? {},
  });
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: source.order.id,
    input: { ...POLICY }, actor: ACTOR,
  });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];

  const successor = options.successor === false ? null : await signedOrder(root, app, {
    name: `${options.name ?? 'M16b Source'} Renewal`,
    offers: options.successorOffers ?? options.sourceOffers ?? OFFERS,
    term: options.successorTerm ?? SUCCESSOR_TERM,
    company: source.company,
    contact: source.contact,
    quantities: options.successorQuantities ?? {},
    ...(options.successorDiscountBps === undefined ? {} : { discountBps: options.successorDiscountBps }),
  });
  return { root, context, app, source, contract, successor };
}

/** Open a run, attach the order, and return the run row. */
async function readyRun(app, contract, successorOrder, actor = ACTOR) {
  const opened = await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'annual renewal cycle' }, actor,
  });
  const run = opened.result;
  const attached = await app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: run.id,
    input: { successorOrderId: successorOrder.id, ...POLICY }, actor,
  });
  return attached.result;
}

/* ------------------------------------------------------------------ paths */

test('a signed successor order becomes a governed successor agreement, and history is untouched', async (t) => {
  const { app, source, contract, successor } = await scene(t);

  // ── the plan writes nothing ──────────────────────────────────────────────
  const before = fingerprintCommercial(app);
  const planned = await app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contract.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: ACTOR,
  });
  const plan = planned.result;
  assert.equal(plan.writes, 'nothing — this is a read-only plan');
  assert.equal(plan.succession.coherent, true, JSON.stringify(plan.succession.refusals));
  assert.equal(plan.succession.classification, 'renewal');
  assert.equal(plan.succession.termContinuity.relation, 'contiguous');
  assert.equal(plan.succession.termContinuity.gapDays, 0);
  assert.deepEqual(fingerprintCommercial(app), before, 'planning wrote nothing at all');
  assert.equal(app.modules.get('amendment-run').service.listWhere({ sourceContractId: contract.id }).length, 0);

  // ── both provenances are reported, and neither collapses ────────────────
  assert.equal(plan.succession.source.term.signed, true);
  assert.equal(plan.succession.source.term.source, 'signed-order-terms');
  assert.equal(plan.succession.successor.term.signed, true);
  assert.match(plan.succession.successor.term.provenanceNote, /canonical document the customer signed/);

  // ── execute ─────────────────────────────────────────────────────────────
  const run = await readyRun(app, contract, successor.order);
  assert.equal(run.state, 'ready');
  assert.equal(run.observedClassification, 'renewal');

  const executed = (await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id,
    input: { ...POLICY }, actor: ACTOR,
  })).result;
  assert.equal(executed.replay, false);
  assert.equal(executed.classification, 'renewal');
  assert.equal(executed.termContinuity, 'contiguous');

  // ── the successor is an ordinary activated contract ─────────────────────
  const successorContract = app.modules.get('commercial-contract').service.get(executed.successorContractId);
  assert.equal(successorContract.orderId, successor.order.id);
  assert.equal(successorContract.termsSource, 'signed-order-terms');
  assert.equal(successorContract.termStartDate, '2027-09-01');
  assert.equal(successorContract.termEndDate, '2028-08-31');
  assert.equal(successorContract.status, 'scheduled', 'a future term is scheduled, and nothing transitions it');
  assert.equal(successorContract.companyId, contract.companyId, 'same customer, proven not assumed');
  const successorSubscription = app.modules.get('subscription').service.listWhere({ contractId: successorContract.id })[0];
  assert.ok(successorSubscription, 'the successor has its own subscription');
  assert.notEqual(successorSubscription.id, app.modules.get('subscription').service.listWhere({ contractId: contract.id })[0].id);

  // ── the lineage ─────────────────────────────────────────────────────────
  const lineage = app.modules.get('contract-succession').service.listWhere({ sourceContractId: contract.id })[0];
  assert.ok(lineage);
  assert.equal(lineage.successorContractId, successorContract.id);
  assert.equal(lineage.successorOrderId, successor.order.id);
  assert.equal(lineage.sourceOrderId, source.order.id);
  assert.equal(lineage.classification, 'renewal');
  assert.equal(lineage.termContinuity, 'contiguous');
  assert.equal(lineage.sourceTermSigned, true);
  assert.equal(lineage.executionRef, `amendment-run:${run.id}`);
  assert.equal(lineage.executedBy, 'e2e');

  // ── history is byte-identical ───────────────────────────────────────────
  const sourceAfter = app.modules.get('commercial-contract').service.get(contract.id);
  assert.deepEqual(sourceAfter, contract, 'the source agreement row is untouched, field for field');
  for (const module of ['contract-version', 'contract-line', 'subscription', 'subscription-line']) {
    const rows = app.modules.get(module).service.listWhere(
      module === 'contract-version' || module === 'contract-line' || module === 'subscription'
        ? { contractId: contract.id } : { contractId: contract.id },
    );
    for (const row of rows) {
      assert.ok(before.rows[`${module}:${row.id}`], `${module} ${row.id} existed before`);
      assert.equal(JSON.stringify(row), before.rows[`${module}:${row.id}`], `${module} ${row.id} is byte-identical`);
    }
  }
});

test('an order whose signed document carried no term cannot become a successor', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'm16b-unsigned.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const source = await signedOrder(root, app, { name: 'M16b Signed Source', offers: OFFERS, term: SOURCE_TERM });
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: source.order.id, input: { ...POLICY }, actor: ACTOR,
  });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];

  // The successor order is signed — but its signed document carried NO term.
  // Its activation dates would be post-signature operational metadata, and this
  // is the refusal the whole milestone exists for.
  const successor = await signedOrder(root, app, {
    name: 'M16b Operational Renewal', offers: OFFERS, company: source.company, contact: source.contact,
  });
  assert.equal(app.modules.get('order-term').service.listWhere({ orderId: successor.order.id }).length, 0);

  const plan = (await app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contract.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: ACTOR,
  })).result;
  assert.equal(plan.succession.coherent, false);
  const notSigned = plan.succession.refusals.find((entry) => entry.code === 'SUCCESSOR_TERMS_NOT_SIGNED');
  assert.ok(notSigned, 'the plan names the refusal before anybody attempts it');
  assert.match(notSigned.message, /never promoted to signed renewal terms/);
  assert.equal(plan.succession.successor.term, null, 'no term is invented for it');
  assert.equal(plan.succession.successor.termsProvenance.signed, false);

  // Attaching parks the run rather than refusing: an order can still gain a
  // signed term only by being re-quoted, but the gap is stated honestly.
  const run = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'renewal' }, actor: ACTOR,
  })).result;
  const attached = (await app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: run.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: ACTOR,
  })).result;
  assert.equal(attached.state, 'awaiting_signed_order');
  assert.ok(JSON.parse(attached.readinessGapsJson).some((gap) => gap.code === 'SUCCESSOR_TERMS_NOT_SIGNED'));

  // …and executing is refused, whatever the run says.
  const refused = await refusal(app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: attached.id,
    input: { ...POLICY }, actor: ACTOR,
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'AMENDMENT_RUN_NOT_READY');
  assert.equal(app.modules.get('contract-succession').service.list({ limit: 10 }).length, 0);
});

test('a stale ready authorises nothing: execution recomputes and refuses on the recomputation', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'stale' });
  const run = await readyRun(app, contract, successor.order);
  assert.equal(run.state, 'ready');

  // The evidence moves underneath the run: the very same signed Order is
  // activated standalone through M12's own action. The run still reads
  // "ready" — and execution refuses anyway, because it recomputes.
  await app.runAction({
    module: 'order', action: 'activate-contract', recordId: successor.order.id, input: { ...POLICY }, actor: ACTOR,
  });
  assert.equal(app.modules.get('amendment-run').service.get(run.id).state, 'ready', 'the recorded observation is stale on purpose');

  const refused = await refusal(app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ORDER_ALREADY_ACTIVATED');
  assert.equal(app.modules.get('contract-succession').service.list({ limit: 10 }).length, 0,
    'a refused execution wrote no lineage');
});

test('the classification is derived from the delta, and a price move is never called an expansion', async (t) => {
  // Same offers, one quantity raised: an expansion, derived.
  const expansion = await scene(t, {
    db: 'expansion', name: 'M16b Expansion',
    successorQuantities: { 'fixture:offer:enterprise': 30 },
  });
  const plan = (await expansion.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: expansion.contract.id,
    input: { successorOrderId: expansion.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(plan.classification, 'expansion');
  assert.match(plan.classificationBasis, /quantities only increased/);
  const changed = plan.delta.lines.filter((line) => line.status === 'changed');
  assert.ok(changed.length > 0);
  for (const line of changed) {
    assert.ok(line.changedFields.includes('quantity'));
    assert.ok(Number.isSafeInteger(line.before.quantity) && Number.isSafeInteger(line.after.quantity));
  }
  // Grouped, never summed into one number, and no MRR/ARR/TCV anywhere.
  assert.ok(Array.isArray(plan.delta.baselineDelta) && plan.delta.baselineDelta.length > 0);
  // No derived revenue figure exists anywhere in the payload. The scan is over
  // FIELD NAMES rather than the serialized text, because the disclosure prose
  // must be free to say "no MRR, ARR or TCV is computed" — a scan that forbade
  // the words would forbid the disclosure and reward silence.
  assert.ok(plan.notModeled.includes('MRR/ARR/TCV'), 'the omission is stated, not implied');
  for (const key of everyKey(plan)) {
    assert.equal(/mrr|\barr\b|tcv|annualrecurring|totalcontractvalue|annualvalue/i.test(key), false,
      `${key} is a derived revenue figure this milestone does not compute`);
  }
});

test('a contraction, a mixed change and a pure price move each get the label the evidence supports', async (t) => {
  const contraction = await scene(t, {
    db: 'contraction', name: 'M16b Contraction',
    successorQuantities: { 'fixture:offer:enterprise': 10, 'fixture:offer:support-annual': 20 },
  });
  const c = (await contraction.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contraction.contract.id,
    input: { successorOrderId: contraction.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(c.classification, 'contraction');

  // Two quantity-bearing components moving in opposite directions. The seat
  // component of the enterprise offer and the per-1k-call component of the API
  // offer are the two lines whose quantity is a real number on both sides; a
  // flat fee's quantity is 0 by construction, which is why the pure price case
  // below is deliberately not called a contraction.
  const mixed = await scene(t, {
    db: 'mixed', name: 'M16b Mixed',
    sourceOffers: ['fixture:offer:enterprise', 'fixture:offer:api-monthly'],
    successorQuantities: { 'fixture:offer:enterprise': 30, 'fixture:offer:api-monthly': 10 },
  });
  const m = (await mixed.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: mixed.contract.id,
    input: { successorOrderId: mixed.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(m.classification, 'mixed');
  assert.match(m.classificationBasis, /both directions/);

  // The case the milestone must NOT flatter: the same lines, the same
  // quantities, a different discount. Money moved and nothing expanded, so the
  // narrower label is left unclaimed and the exact delta travels anyway.
  const priced = await scene(t, {
    db: 'priced', name: 'M16b Priced', successorDiscountBps: 0,
  });
  const p = (await priced.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: priced.contract.id,
    input: { successorOrderId: priced.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(p.classification, 'commercial_change',
    'a price uplift at renewal is not an expansion: nothing about it expanded');
  assert.match(p.classificationBasis, /without changing quantity/);
  assert.ok(p.delta.lines.some((line) => line.status === 'changed' && line.changedFields.join() === 'netAmountCents'));
  assert.equal(p.coherent, true, 'and it is still executable — an unclaimable label never blocks');

  const added = await scene(t, {
    db: 'added', name: 'M16b Added',
    successorOffers: [...OFFERS, 'fixture:offer:api-monthly'],
  });
  const a = (await added.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: added.contract.id,
    input: { successorOrderId: added.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(a.classification, 'expansion');
  assert.ok(a.delta.lines.some((line) => line.status === 'added'));
});

test('the run state machine is explicit: terminal never regresses and a new round starts only after abandonment', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'states' });

  const run = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'first attempt' }, actor: ACTOR,
  })).result;
  assert.equal(run.state, 'planned');
  assert.equal(run.round, 1);

  // A second open on the same contract is refused, and an identical repeat
  // replays the run it already opened.
  const replayed = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'first attempt' }, actor: ACTOR,
  })).result;
  assert.equal(replayed.id, run.id, 'an identical repeat replays');
  const divergent = await refusal(app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'something else entirely' }, actor: ACTOR,
  }));
  assert.equal(divergent.code, 'AMENDMENT_RUN_ALREADY_OPEN');

  // Abandon → terminal. It moves nothing commercial.
  const abandoned = (await app.runAction({
    module: 'amendment-run', action: 'abandon-amendment-run', recordId: run.id,
    input: { reason: 'customer paused the conversation' }, actor: ACTOR,
  })).result;
  assert.equal(abandoned.state, 'abandoned');
  for (const action of ['attach-successor-order', 'abandon-amendment-run']) {
    const again = await refusal(app.runAction({
      module: 'amendment-run', action, recordId: run.id,
      input: action === 'attach-successor-order' ? { successorOrderId: successor.order.id } : { reason: 'again' },
      actor: ACTOR,
    }));
    assert.equal(again.code, 'AMENDMENT_RUN_TERMINAL', `${action} must not reopen a terminal run`);
  }

  // A second round may now begin, and it is round 2 — never a collapsed reuse.
  const second = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'second attempt' }, actor: ACTOR,
  })).result;
  assert.equal(second.round, 2);
  assert.equal(second.state, 'planned');

  // Execute it, and no third round may open on this agreement ever again.
  await app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: second.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: ACTOR,
  });
  await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: second.id, input: { ...POLICY }, actor: ACTOR,
  });
  const third = await refusal(app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'third attempt' }, actor: ACTOR,
  }));
  assert.equal(third.code, 'CONFLICTING_SUCCESSOR');
  assert.equal(app.modules.get('amendment-run').service.listWhere({ sourceContractId: contract.id }).length, 2);
});

test('a lost response replays; a repeat naming a different order is refused with what was recorded', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'replay' });
  const run = await readyRun(app, contract, successor.order);
  const first = (await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  })).result;

  const again = (await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  })).result;
  assert.equal(again.replay, true);
  assert.equal(again.successorContractId, first.successorContractId);
  assert.equal(app.modules.get('contract-succession').service.list({ limit: 50 }).length, 1,
    'a retry produced exactly one successor');
  assert.equal(app.modules.get('commercial-contract').service.list({ limit: 50 }).length, 2);

  const wrong = await refusal(app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id,
    input: { ...POLICY, successorOrderId: contract.orderId }, actor: ACTOR,
  }));
  assert.equal(wrong.code, 'AMENDMENT_RUN_TERMINAL');
});

test('every writing action refuses an agent actor, and the plan does not', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'actor' });

  // A read is open to an agent: preparing the answer is exactly what an agent
  // is for. Committing the business is not.
  const planned = await app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contract.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: AGENT,
  });
  assert.equal(planned.result.succession.coherent, true);

  const openRefused = await refusal(app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'agent tried' }, actor: AGENT,
  }));
  assert.equal(openRefused.status, 403);
  assert.equal(openRefused.code, 'HUMAN_APPROVAL_REQUIRED');

  const run = await readyRun(app, contract, successor.order);
  for (const [action, input] of [
    ['attach-successor-order', { successorOrderId: successor.order.id }],
    ['execute-amendment', { ...POLICY }],
    ['abandon-amendment-run', { reason: 'agent tried' }],
  ]) {
    const refused = await refusal(app.runAction({ module: 'amendment-run', action, recordId: run.id, input, actor: AGENT }));
    assert.equal(refused.status, 403, `${action} must refuse an agent`);
    assert.equal(refused.code, 'HUMAN_APPROVAL_REQUIRED');
  }
  assert.equal(app.modules.get('contract-succession').service.list({ limit: 10 }).length, 0);
});

test('a successor for another customer, for the source order itself, or preceding its source is refused', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'm16b-coherence.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  const source = await signedOrder(root, app, { name: 'M16b Coherent', offers: OFFERS, term: SOURCE_TERM });
  await app.runAction({ module: 'order', action: 'activate-contract', recordId: source.order.id, input: { ...POLICY }, actor: ACTOR });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];

  // A different customer entirely.
  const stranger = await signedOrder(root, app, { name: 'M16b Stranger', offers: OFFERS, term: SUCCESSOR_TERM });
  const wrongCustomer = (await app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contract.id,
    input: { successorOrderId: stranger.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.ok(wrongCustomer.refusals.some((entry) => entry.code === 'SUCCESSOR_CUSTOMER_MISMATCH'));

  // …and attaching it is refused outright, because waiting fixes nothing.
  const run = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'renewal' }, actor: ACTOR,
  })).result;
  const attachRefused = await refusal(app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: run.id,
    input: { successorOrderId: stranger.order.id }, actor: ACTOR,
  }));
  assert.equal(attachRefused.code, 'SUCCESSOR_CUSTOMER_MISMATCH');

  // An agreement cannot succeed itself.
  const itself = (await app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contract.id,
    input: { successorOrderId: source.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.ok(itself.refusals.some((entry) => entry.code === 'SUCCESSOR_ORDER_IS_SOURCE_ORDER'));

  // A successor term that starts before the source term started.
  const backwards = await signedOrder(root, app, {
    name: 'M16b Backwards', offers: OFFERS, company: source.company, contact: source.contact,
    term: { effectiveDate: '2026-01-01', termStartDate: '2026-01-01', termEndDate: '2026-12-31' },
  });
  const precedes = (await app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: contract.id,
    input: { successorOrderId: backwards.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.ok(precedes.refusals.some((entry) => entry.code === 'SUCCESSOR_TERM_PRECEDES_SOURCE'));
  assert.equal(app.modules.get('contract-succession').service.list({ limit: 10 }).length, 0);
});

test('a mid-term overlap and a lapse are recorded, never refused', async (t) => {
  const overlap = await scene(t, {
    db: 'overlap', name: 'M16b Overlap',
    successorTerm: { effectiveDate: '2027-03-01', termStartDate: '2027-03-01', termEndDate: '2028-02-29' },
  });
  const o = (await overlap.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: overlap.contract.id,
    input: { successorOrderId: overlap.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(o.coherent, true, JSON.stringify(o.refusals));
  assert.equal(o.termContinuity.relation, 'overlap');
  assert.ok(o.termContinuity.gapDays < 0);

  const gap = await scene(t, {
    db: 'gap', name: 'M16b Gap',
    successorTerm: { effectiveDate: '2027-10-01', termStartDate: '2027-10-01', termEndDate: '2028-09-30' },
  });
  const g = (await gap.app.runAction({
    module: 'commercial-contract', action: 'plan-amendment', recordId: gap.contract.id,
    input: { successorOrderId: gap.successor.order.id, ...POLICY }, actor: ACTOR,
  })).result.succession;
  assert.equal(g.coherent, true, JSON.stringify(g.refusals));
  assert.equal(g.termContinuity.relation, 'gap');
  assert.equal(g.termContinuity.gapDays, 30, '2027-09-01 .. 2027-09-30 are covered by neither');
});

test('audit, events and trace are exact, and no event name claims something M16b cannot honour', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'audit' });
  const auditBefore = app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  const run = await readyRun(app, contract, successor.order);
  await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  });

  const rows = app.database.raw.prepare('SELECT action FROM audit_events ORDER BY rowid').all()
    .slice(auditBefore).map((row) => row.action);
  // The successor is an ordinary activation: exactly the M12 record set, plus
  // the lineage row, plus the run's two moves.
  const counted = rows.reduce((total, action) => ({ ...total, [action]: (total[action] ?? 0) + 1 }), {});
  assert.equal(counted['contract-succession.created'], 1, 'exactly one lineage row');
  assert.equal(counted['commercial-contract.created'], 1, 'exactly one successor contract');
  assert.equal(counted['subscription.created'], 1);
  assert.equal(counted['amendment-run.updated'], 2, 'attach and execute, and nothing else');

  for (const forbidden of ['contract.renewed', 'contract.amended', 'subscription.cancelled', 'customer.churned', 'invoice.created', 'notification.sent']) {
    assert.equal(rows.includes(forbidden), false, `${forbidden} is a claim this milestone cannot honour`);
  }
  // A replay writes nothing at all.
  const auditAfterFirst = app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  });
  assert.equal(app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, auditAfterFirst,
    'a replay is not a second business event');
});

test('a failure after every write rolls the whole successor back, and the retry produces exactly one', async (t) => {
  const modules = ['contract-activation', 'commercial-contract', 'contract-version', 'contract-line',
    'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation', 'contract-succession'];
  for (const target of modules) {
    const { app, contract, successor } = await scene(t, { db: `fault-${target}` });
    const run = await readyRun(app, contract, successor.order);

    const service = app.modules.get(target).service;
    const original = service.createManaged.bind(service);
    let hit = 0;
    service.createManaged = async (...args) => {
      const created = await original(...args);
      hit += 1;
      throw new Error(`injected failure after ${target} write #${hit}`);
    };
    const failed = await refusal(app.runAction({
      module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
    }));
    service.createManaged = original;
    if (hit === 0) continue; // this module is not written for this fixture

    assert.equal(failed.ok, false, `${target}: the injected failure must surface`);
    assert.equal(app.modules.get('contract-succession').service.list({ limit: 10 }).length, 0,
      `${target}: no lineage survived the rollback`);
    assert.equal(app.modules.get('commercial-contract').service.list({ limit: 10 }).length, 1,
      `${target}: no partial successor contract survived`);
    assert.equal(app.modules.get('amendment-run').service.get(run.id).state, 'ready',
      `${target}: the run did not record an execution that rolled back`);

    // The retry, with nothing injected, produces exactly one complete result.
    const retried = (await app.runAction({
      module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
    })).result;
    assert.equal(retried.replay, false);
    assert.equal(app.modules.get('contract-succession').service.list({ limit: 10 }).length, 1, `${target}: exactly one`);
    assert.equal(app.modules.get('commercial-contract').service.list({ limit: 10 }).length, 2, `${target}: exactly one successor`);
  }
});

test('two connections race one execution: exactly one winner, no partial successor, no driver text', async (t) => {
  const root = project(t, { withLifecycle: true });
  const dbPath = join(root, 'data', 'm16b-race.sqlite');
  const first = await boot(root, dbPath);
  t.after(() => first.close());

  const source = await signedOrder(root, first.app, { name: 'M16b Race', offers: OFFERS, term: SOURCE_TERM });
  await first.app.runAction({ module: 'order', action: 'activate-contract', recordId: source.order.id, input: { ...POLICY }, actor: ACTOR });
  const contract = first.app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];
  const successor = await signedOrder(root, first.app, {
    name: 'M16b Race Renewal', offers: OFFERS, term: SUCCESSOR_TERM, company: source.company, contact: source.contact,
  });
  const run = await readyRun(first.app, contract, successor.order);

  // A genuinely separate application instance on the same database file.
  const second = await boot(root, dbPath);
  t.after(() => second.close());

  const results = await Promise.allSettled([
    first.app.runAction({ module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR }),
    second.app.runAction({ module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR }),
  ]);
  const fulfilled = results.filter((entry) => entry.status === 'fulfilled');
  const rejected = results.filter((entry) => entry.status === 'rejected');
  assert.ok(fulfilled.length >= 1, 'somebody won');
  for (const entry of rejected) {
    const message = String(entry.reason?.message ?? '');
    assert.equal(/SQLITE_|UNIQUE constraint failed|no such table/i.test(message), false,
      `a driver string reached the client: ${message}`);
    // CONFLICT is the framework's own normalized busy-database refusal — a
    // sentence, never a driver string — and it is as valid a "you lost" as the
    // business codes beside it.
    assert.ok(['ORDER_ALREADY_ACTIVATED', 'CONFLICTING_SUCCESSOR', 'AMENDMENT_RUN_TERMINAL',
      'SUCCESSOR_ORDER_ALREADY_CONSUMED', 'CONFLICT']
      .includes(entry.reason?.code ?? ''), `unexpected code ${entry.reason?.code}: ${message}`);
  }
  const lineage = first.app.modules.get('contract-succession').service.list({ limit: 10 });
  assert.equal(lineage.length, 1, 'exactly one successor exists');
  assert.equal(first.app.modules.get('commercial-contract').service.list({ limit: 10 }).length, 2);
});

test('every correctness read is exact past the 500-row page bound', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'bound' });

  // 600 abandoned runs on OTHER contracts, so a paged read of the run table
  // would answer the round guard from somebody else's rows.
  const runs = app.modules.get('amendment-run').service;
  for (let index = 0; index < 600; index += 1) {
    await runs.createManaged({
      sourceKey: `amendment-run:noise-${index}:1`,
      sourceContractId: `noise-${index}`,
      round: 1,
      state: 'abandoned',
      reason: 'noise',
      openedBy: 'e2e',
      openedAt: BUSINESS_NOW,
      abandonReason: 'noise',
      abandonedBy: 'e2e',
      abandonedAt: BUSINESS_NOW,
    }, { actor: ACTOR });
  }
  const opened = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: 'past the bound' }, actor: ACTOR,
  })).result;
  assert.equal(opened.round, 1, 'the round is counted from this contract\'s rows, not from a page of noise');

  // …and the succession guards past the bound too.
  const successions = app.modules.get('contract-succession').service;
  for (let index = 0; index < 600; index += 1) {
    await successions.createManaged({
      sourceKey: `contract-succession:noise-${index}`,
      sourceContractId: `noise-${index}`,
      successorContractId: `noise-successor-${index}`,
      successorOrderId: `noise-order-${index}`,
      executionRef: `amendment-run:noise-${index}`,
      classification: 'commercial_change',
      termContinuity: 'unknown',
      executedBy: 'e2e',
      executedAt: BUSINESS_NOW,
    }, { actor: ACTOR });
  }
  await app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: opened.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: ACTOR,
  });
  const executed = (await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: opened.id, input: { ...POLICY }, actor: ACTOR,
  })).result;
  assert.equal(executed.replay, false, 'the guards found this contract past 600 unrelated rows');
  assert.equal(successions.listWhere({ sourceContractId: contract.id }).length, 1);
});

test('hostile input is stored and returned as text, and pollutes nothing', async (t) => {
  const { app, contract, successor } = await scene(t, { db: 'hostile' });
  const hostile = '<img src=x onerror=alert(1)>${7*7} `x` __proto__ constructor';
  const run = (await app.runAction({
    module: 'commercial-contract', action: 'open-amendment-run', recordId: contract.id,
    input: { reason: hostile }, actor: ACTOR,
  })).result;
  assert.equal(run.reason, hostile, 'stored verbatim, interpreted nowhere');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  for (const bad of [' null byte', 'x'.repeat(400), '', '   ']) {
    const refused = await refusal(app.runAction({
      module: 'amendment-run', action: 'abandon-amendment-run', recordId: run.id, input: { reason: bad }, actor: ACTOR,
    }));
    assert.equal(refused.ok, false, `${JSON.stringify(bad.slice(0, 20))} must be refused`);
  }
  // A prototype-shaped override payload reaches no prototype.
  await app.runAction({
    module: 'amendment-run', action: 'attach-successor-order', recordId: run.id,
    input: { successorOrderId: successor.order.id, ...POLICY }, actor: ACTOR,
  });
  const poisoned = await refusal(app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id,
    input: { ...POLICY, classificationOverrides: JSON.parse('[{"orderComponentId":"__proto__","dimension":"commercial","value":"subscription","reason":"x"}]') },
    actor: ACTOR,
  }));
  assert.equal(poisoned.ok, false);
  assert.equal({}.orderComponentId, undefined);
});

test('the successor survives a restart, and an old M16a database upgrades in place', async (t) => {
  const root = project(t, { withLifecycle: true });
  const dbPath = join(root, 'data', 'm16b-restart.sqlite');
  const first = await boot(root, dbPath);
  const source = await signedOrder(root, first.app, { name: 'M16b Restart', offers: OFFERS, term: SOURCE_TERM });
  await first.app.runAction({ module: 'order', action: 'activate-contract', recordId: source.order.id, input: { ...POLICY }, actor: ACTOR });
  const contract = first.app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];
  const successor = await signedOrder(root, first.app, {
    name: 'M16b Restart Renewal', offers: OFFERS, term: SUCCESSOR_TERM, company: source.company, contact: source.contact,
  });
  const run = await readyRun(first.app, contract, successor.order);
  const executed = (await first.app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  })).result;
  await first.close();

  const second = await boot(root, dbPath);
  t.after(() => second.close());
  const lineage = second.app.modules.get('contract-succession').service.listWhere({ sourceContractId: contract.id })[0];
  assert.equal(lineage.successorContractId, executed.successorContractId);
  assert.equal(second.app.modules.get('amendment-run').service.get(run.id).state, 'executed');
  // A retry over rows a previous process wrote still replays rather than
  // producing a second successor.
  const again = (await second.app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  })).result;
  assert.equal(again.replay, true);
  assert.equal(second.app.modules.get('contract-succession').service.list({ limit: 10 }).length, 1);
});

test('the new evidence is read-only through every generic surface, over the real HTTP routes', async (t) => {
  const { app, context, contract, successor } = await scene(t, { db: 'boundary' });
  const { client, agentClient } = context;
  const run = await readyRun(app, contract, successor.order);
  const executed = (await app.runAction({
    module: 'amendment-run', action: 'execute-amendment', recordId: run.id, input: { ...POLICY }, actor: ACTOR,
  })).result;

  const refusedRoute = async (method, path, body) => {
    await assert.rejects(() => client.request(path, { method, body }), (error) => error.status === 404,
      `${method} ${path} must not be a route`);
  };
  for (const [module, id, forged] of [
    ['amendment-run', run.id, { state: 'ready', sourceContractId: 'forged', successorOrderId: 'forged' }],
    ['contract-succession', executed.succession.id, { classification: 'renewal', sourceContractId: 'forged' }],
  ]) {
    // Readable…
    assert.ok((await client.request(`/api/modules/${module}/records`)).items.length > 0);
    assert.ok((await client.request(`/api/modules/${module}/records/${id}`)).id);
    // …and not writable, not even with an empty body. A client that could set
    // `state` could authorise its own execution, and a client that could set
    // `classification` could label a change the evidence does not support —
    // which is the whole thing this milestone refuses to let anybody do.
    await refusedRoute('POST', `/api/modules/${module}/records`, {});
    await refusedRoute('POST', `/api/modules/${module}/records`, forged);
    await refusedRoute('PATCH', `/api/modules/${module}/records/${id}`, {});
    await refusedRoute('PATCH', `/api/modules/${module}/records/${id}`, forged);
    await refusedRoute('DELETE', `/api/modules/${module}/records/${id}`);
  }

  // The stored evidence is exactly what the server derived, after all of that.
  const lineage = app.modules.get('contract-succession').service.get(executed.succession.id);
  assert.equal(lineage.classification, 'renewal');
  assert.equal(lineage.sourceContractId, contract.id);
  assert.equal(app.modules.get('amendment-run').service.get(run.id).state, 'executed');

  // Every writing action is a human decision, over the real route.
  for (const [module, action, recordId, input] of [
    ['commercial-contract', 'open-amendment-run', contract.id, { reason: 'bot' }],
    ['amendment-run', 'attach-successor-order', run.id, { successorOrderId: successor.order.id }],
    ['amendment-run', 'execute-amendment', run.id, { ...POLICY }],
    ['amendment-run', 'abandon-amendment-run', run.id, { reason: 'bot' }],
  ]) {
    await assert.rejects(
      () => agentClient.request(`/api/modules/${module}/records/${recordId}/actions/${action}`, { method: 'POST', body: input }),
      (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
      `${module}.${action} must refuse an agent over HTTP`,
    );
  }
  assert.equal(app.modules.get('contract-succession').service.list({ limit: 50 }).length, 1,
    'the agent wrote nothing while being refused');

  // AX1 publishes the new edge and the new actions, function-free.
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains.lifecycle.amendment.amendmentContract, 1);
  assert.equal(schema.domains.contracts.succession.successionContract, 1);
  assert.ok(schema.domains.lifecycle.requires.some((entry) => entry.package === 'contracts'
    && entry.capability === 'contracts-successor-activation' && entry.version === 1));
  assert.ok(schema.domains.contracts.provides.some((entry) => entry.name === 'contracts-successor-activation'));
  assert.equal(JSON.stringify(schema.domains), JSON.stringify(JSON.parse(JSON.stringify(schema.domains))));
});

/* ----------------------------------------------------------------- helpers */

/** Every field name anywhere in a payload, however deeply nested. */
function everyKey(value, seen = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) everyKey(entry, seen);
    return seen;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      seen.add(key);
      everyKey(entry, seen);
    }
  }
  return seen;
}

/**
 * A whole-row fingerprint of every commercial record, so "history is untouched"
 * is a byte comparison rather than a spot check.
 */
function fingerprintCommercial(app) {
  const rows = {};
  const counts = {};
  for (const module of ['commercial-contract', 'contract-version', 'contract-line', 'contract-activation',
    'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
    'order', 'order-line', 'order-component', 'order-total', 'order-term',
    'quote', 'quote-version', 'contract-succession']) {
    let items = [];
    try { items = app.modules.get(module).service.list({ limit: 500 }); } catch { items = []; }
    counts[module] = items.length;
    for (const row of items) rows[`${module}:${row.id}`] = JSON.stringify(row);
  }
  return { counts, rows };
}
