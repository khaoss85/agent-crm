import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { POLICY, TERM, boot, project, signedOrder } from './helpers/contracts-project.js';

/**
 * Milestone 12 adversarial review: the regressions for the defects the review
 * found, each written as the behaviour that must hold.
 *
 *   1. Term provenance — the signed document carries no commercial term, so
 *      activation terms are operational metadata and must say so.
 *   2. Classification is two-dimensional — a recurring support fee is a
 *      subscription line AND a service obligation; one axis loses money.
 *   3. Activation state versus the business date — nothing is `active`
 *      before it starts.
 *   4. Auto-renew coherence, dimension-specific overrides, plan/activate
 *      TOCTOU, and the registry attacks.
 */

const TERMS_REASON = { termsReason: 'agreed by email with the customer after signature' };
const FULL = { ...POLICY, ...TERM, ...TERMS_REASON };

/** The business date the tests pin, so "future" and "past" are deterministic. */
const TODAY = '2026-09-01T09:00:00.000Z';
const clockOf = (iso) => () => iso;

test('activation terms are operational metadata, not signed terms', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'terms.sqlite'), { clock: clockOf(TODAY) });
  t.after(() => context.close());
  const { app, client } = context;
  const { order, versionId } = await signedOrder(root, app, { name: 'Terms Deal' });

  // The signed document package is the authority on what was signed. It
  // contains no term, no renewal clause and no notice period — which is
  // exactly why activation may not present its inputs as signed terms.
  const envelope = app.modules.get('signature-envelope').service.listWhere({ quoteVersionId: versionId })[0];
  const document = JSON.parse(envelope.documentJson ?? envelope.documentBytes ?? '{}');
  const signedText = JSON.stringify(document);
  for (const term of ['effectiveDate', 'termStartDate', 'termEndDate', 'autoRenew', 'renewalNoticeDays']) {
    assert.equal(signedText.includes(term), false, `the signed document must not appear to carry ${term}`);
  }

  // A term input therefore needs a human reason of its own, and the plan says
  // so before anything is created.
  const plan = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  assert.equal(plan.termsProvenance.source, 'post-signature-operational-activation');
  assert.match(plan.termsProvenance.note, /not part of the signed agreement/i);
  assert.ok(plan.requiredInputs.includes('termsReason'), JSON.stringify(plan.requiredInputs));

  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM }),
    (error) => error.status === 400 && /termsReason/.test(error.message),
    'a term supplied after signature needs a stated reason',
  );
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, ...TERM, termsReason: '   ' }),
    (error) => error.status === 400,
  );

  const activated = await client.module('order').action(order.id, 'activate-contract', FULL);
  assert.equal(activated.result.contract.termsSource, 'post-signature-operational-activation');
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
  assert.equal(contract.termsSource, 'post-signature-operational-activation');
  assert.equal(contract.termsReason, TERMS_REASON.termsReason);
  const version = app.modules.get('contract-version').service.listWhere({ contractId: contract.id })[0];
  assert.equal(version.termsSource, 'post-signature-operational-activation');
  const run = app.modules.get('contract-activation').service.listWhere({ orderId: order.id })[0];
  assert.equal(run.termsSource, 'post-signature-operational-activation');
  assert.equal(run.termsReason, TERMS_REASON.termsReason);

  // And the term can never be edited afterwards: every field is managed.
  const contracts = app.modules.get('commercial-contract');
  assert.deepEqual(contracts.capabilities, ['get', 'list']);
  assert.equal(contracts.service.update, undefined);
  const patch = await fetch(`${context.baseUrl}/api/modules/commercial-contract/records/${contract.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'e2e' },
    body: JSON.stringify({ termEndDate: '2030-01-01', autoRenew: false, renewalNoticeDays: 0 }),
  });
  assert.equal(patch.status, 404, 'no post-activation term edit exists at all');
  assert.equal(app.modules.get('commercial-contract').service.get(contract.id).termEndDate, TERM.termEndDate);

  // The schema states the provenance rather than implying a signed term.
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains.contracts.term.source, 'post-signature-operational-activation');
  assert.match(schema.domains.contracts.term.limitation, /not.*signed/i);
});

test('one component can be both a subscription line and a service obligation', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'axes.sqlite'), { clock: clockOf(TODAY) });
  t.after(() => context.close());
  const { app, client } = context;
  // enterprise (setup + platform + seats), annual support, monthly API.
  const { order } = await signedOrder(root, app, { name: 'Two Axis Deal' });

  const plan = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  const byKey = (key) => plan.components.find((component) => String(component.componentKey).endsWith(key));
  assert.deepEqual(byKey('ent-platform').obligations, [], 'a platform fee owes nothing beyond the money');
  assert.equal(byKey('ent-platform').commercialActivation, 'subscription');
  assert.equal(byKey('ent-seats').commercialActivation, 'subscription');
  assert.deepEqual(byKey('ent-setup').obligations, ['delivery']);
  assert.equal(byKey('ent-setup').commercialActivation, 'non_subscription');
  // The defect this test exists for: annual support is a recurring commercial
  // commitment AND a future service obligation. One axis loses one of them.
  assert.equal(byKey('support-fee').commercialActivation, 'subscription');
  assert.deepEqual(byKey('support-fee').obligations, ['service']);
  assert.equal(byKey('api-calls').commercialActivation, 'non_subscription');
  assert.deepEqual(byKey('api-calls').obligations, []);
  assert.deepEqual(plan.counts, {
    subscriptionLines: 3, delivery: 1, service: 1, noObligation: 3, ambiguous: 0,
  });

  const activated = await client.module('order').action(order.id, 'activate-contract', FULL);
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
  const lines = app.modules.get('contract-line').service.listWhere({ contractId: contract.id });
  assert.equal(lines.length, 5, 'every order component is still exactly one contract line');

  const subscription = app.modules.get('subscription').service.listWhere({ contractId: contract.id })[0];
  const subscriptionLines = app.modules.get('subscription-line').service.listWhere({ subscriptionId: subscription.id });
  assert.equal(subscriptionLines.length, 3, 'the annual support commitment is not lost');
  assert.ok(subscriptionLines.some((line) => String(line.componentKey).endsWith('support-fee')));
  assert.equal(subscription.lineCount, 3);
  // …and the same component is also a pending service obligation.
  const services = app.modules.get('service-obligation').service.listWhere({ contractId: contract.id });
  assert.equal(services.length, 1);
  assert.ok(String(services[0].componentKey).endsWith('support-fee'));
  const supportLine = lines.find((line) => String(line.componentKey).endsWith('support-fee'));
  assert.equal(services[0].contractLineId, supportLine.id, 'the obligation cites the same contract line');
  assert.equal(subscriptionLines.find((line) => String(line.componentKey).endsWith('support-fee')).contractLineId, supportLine.id);
  assert.equal(activated.result.counts.subscriptionLines, 3);

  // Exactly one obligation of each kind per component — never a duplicate.
  assert.equal(app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id }).length, 1);
  assert.equal(
    new Set(services.map((row) => row.orderComponentId)).size, services.length,
    'no duplicate service obligation',
  );
});

test('nothing is active before it starts, and nothing schedules it', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'future.sqlite'), { clock: clockOf(TODAY) });
  t.after(() => context.close());
  const { app, client } = context;

  // A term that starts in the future is *scheduled*, never active.
  const future = await signedOrder(root, app, { name: 'Future Deal' });
  const futureTerm = { effectiveDate: '2026-09-01', termStartDate: '2026-10-01', termEndDate: '2027-09-30' };
  const scheduled = await client.module('order').action(future.order.id, 'activate-contract', { ...POLICY, ...futureTerm, ...TERMS_REASON });
  assert.equal(scheduled.result.contract.status, 'scheduled');
  const scheduledContract = app.modules.get('commercial-contract').service.listWhere({ orderId: future.order.id })[0];
  assert.equal(scheduledContract.status, 'scheduled');
  assert.equal(app.modules.get('subscription').service.listWhere({ contractId: scheduledContract.id })[0].status, 'scheduled');
  // The framework is honest that nothing will flip it: there is no scheduler.
  const schema = await client.request('/api/schema');
  assert.match(schema.domains.contracts.activationState.limitation, /no scheduler/i);

  // A term that has already started is active.
  const current = await signedOrder(root, app, { name: 'Current Deal' });
  const started = await client.module('order').action(current.order.id, 'activate-contract', {
    ...POLICY, effectiveDate: '2026-08-01', termStartDate: '2026-08-15', termEndDate: '2027-08-14', ...TERMS_REASON,
  });
  assert.equal(started.result.contract.status, 'active');
  const currentContract = app.modules.get('commercial-contract').service.listWhere({ orderId: current.order.id })[0];
  assert.equal(app.modules.get('subscription').service.listWhere({ contractId: currentContract.id })[0].status, 'active');

  // A term that already ended is refused: activating a finished agreement is
  // an operational mistake, not a state to record.
  const expired = await signedOrder(root, app, { name: 'Expired Deal' });
  await assert.rejects(
    () => client.module('order').action(expired.order.id, 'activate-contract', {
      ...POLICY, effectiveDate: '2024-01-01', termStartDate: '2024-01-01', termEndDate: '2024-12-31', ...TERMS_REASON,
    }),
    (error) => error.status === 409 && error.code === 'TERM_ALREADY_ENDED',
  );
  assert.equal(app.modules.get('commercial-contract').service.listWhere({ orderId: expired.order.id }).length, 0);

  // The activation instant is a UTC timestamp from the injected clock, and the
  // term stays date-only.
  assert.equal(scheduledContract.activatedAt, TODAY);
  assert.equal(scheduledContract.termStartDate, '2026-10-01');
});

test('auto-renew and the notice period must be coherent', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'renew.sqlite'), { clock: clockOf(TODAY) });
  t.after(() => context.close());
  const { app, client } = context;
  const { order } = await signedOrder(root, app, { name: 'Renew Deal' });

  // A notice period is meaningless without auto-renewal: refuse rather than
  // silently record a clause that can never apply.
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...FULL, autoRenew: false, renewalNoticeDays: 30 }),
    (error) => error.status === 400 && /autoRenew/.test(error.message),
  );
  // A notice period longer than the term is refused too.
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', {
      ...POLICY, ...TERMS_REASON, effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2026-09-10',
      autoRenew: true, renewalNoticeDays: 90,
    }),
    (error) => error.status === 400 && /renewalNoticeDays/.test(error.message),
  );
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0);

  const activated = await client.module('order').action(order.id, 'activate-contract', { ...FULL, autoRenew: true, renewalNoticeDays: 30 });
  assert.equal(activated.result.contract.autoRenew, true);
  assert.equal(activated.result.contract.renewalNoticeDays, 30);
});

test('overrides are dimension-specific and bounded', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'overrides.sqlite'), { clock: clockOf(TODAY) });
  t.after(() => context.close());
  const { app, client, agentClient } = context;
  const { order } = await signedOrder(root, app, {
    name: 'Override Deal',
    offers: ['fixture:offer:enterprise', 'fixture:offer:storage-monthly'],
  });

  const plan = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  const ambiguous = plan.components.find((component) => component.requiresOverride);
  assert.deepEqual(ambiguous.ambiguousDimensions, ['commercial', 'obligations'], 'the plan names every undecided axis');

  // The whole override surface is attacked before the valid one is accepted.
  const target = ambiguous.orderComponentId;
  const bad = [
    [{ orderComponentId: target, dimension: 'commercial', value: 'subscription' }, /reason/],
    [{ orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: '  ' }, /reason/],
    [{ orderComponentId: target, dimension: 'commercial', value: 'ambiguous', reason: 'unsure' }, /value/],
    [{ orderComponentId: target, dimension: 'obligations', value: 'delivery', reason: 'x' }, /array/],
    [{ orderComponentId: target, dimension: 'obligations', value: ['delivery', 'delivery'], reason: 'x' }, /duplicate/],
    [{ orderComponentId: target, dimension: 'obligations', value: ['nonsense'], reason: 'x' }, /value/],
    [{ orderComponentId: target, dimension: 'nonsense', value: 'subscription', reason: 'x' }, /dimension/],
    [{ orderComponentId: 'not-of-this-order', dimension: 'commercial', value: 'subscription', reason: 'x' }, /another order/],
    [{ orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: `hidden${String.fromCharCode(0)}tail` }, /control characters/],
    [{ orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: 'x'.repeat(400) }, /reason/],
  ];
  for (const [override, expected] of bad) {
    await assert.rejects(
      () => client.module('order').action(order.id, 'activate-contract', { ...FULL, classificationOverrides: [override] }),
      expected,
      JSON.stringify(override),
    );
  }
  // Two overrides for the same component and dimension are a conflict.
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', {
      ...FULL,
      classificationOverrides: [
        { orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: 'a' },
        { orderComponentId: target, dimension: 'commercial', value: 'non_subscription', reason: 'b' },
      ],
    }),
    /duplicate/,
  );
  // An agent may not decide either.
  await assert.rejects(
    () => agentClient.module('order').action(order.id, 'activate-contract', {
      ...FULL, classificationOverrides: [{ orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: 'bot' }],
    }),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  assert.equal(app.modules.get('commercial-contract').service.list().length, 0);

  // A one-time component can never be overridden into a subscription line.
  const oneTime = plan.components.find((component) => component.chargeType === 'one_time');
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', {
      ...FULL,
      classificationOverrides: [
        { orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: 'storage recurs' },
        { orderComponentId: oneTime.orderComponentId, dimension: 'commercial', value: 'subscription', reason: 'wishful' },
      ],
    }),
    (error) => error.code === 'CLASSIFICATION_INCOHERENT',
  );

  // Both dimensions can be decided at once, and both are recorded separately.
  await client.module('order').action(order.id, 'activate-contract', {
    ...FULL,
    classificationOverrides: [
      { orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: 'storage is a recurring right' },
      { orderComponentId: target, dimension: 'obligations', value: ['delivery'], reason: 'the first load is migrated by us' },
    ],
  });
  const line = app.modules.get('contract-line').service.listWhere({ orderComponentId: target })[0];
  assert.equal(line.commercialActivation, 'subscription');
  assert.equal(line.policyCommercialActivation, 'ambiguous', 'the policy decision survives the override');
  assert.equal(line.commercialOverridden, true);
  assert.equal(line.commercialOverrideReason, 'storage is a recurring right');
  assert.deepEqual(JSON.parse(line.obligationsJson), ['delivery']);
  assert.equal(JSON.parse(line.policyObligationsJson), 'ambiguous', 'the policy admitted it could not decide this axis');
  assert.equal(line.obligationsOverridden, true);
  assert.equal(line.obligationsOverrideReason, 'the first load is migrated by us');
  assert.equal(line.overriddenBy, 'e2e');
  const run = app.modules.get('contract-activation').service.listWhere({ orderId: order.id })[0];
  assert.equal(run.overrideCount, 2, 'both dimension decisions are counted');
});

test('a stale plan is never an authorization token', async (t) => {
  const root = project(t);
  const context = await boot(root, join(root, 'data', 'toctou.sqlite'), { clock: clockOf(TODAY) });
  t.after(() => context.close());
  const { app, client } = context;
  const { order } = await signedOrder(root, app, {
    name: 'TOCTOU Deal',
    offers: ['fixture:offer:enterprise', 'fixture:offer:storage-monthly'],
  });

  // Planning with preview overrides shows an activatable plan…
  const target = (await client.module('order').action(order.id, 'plan-activation', POLICY))
    .result.plan.components.find((component) => component.requiresOverride).orderComponentId;
  const preview = (await client.module('order').action(order.id, 'plan-activation', {
    ...POLICY,
    classificationOverrides: [
      { orderComponentId: target, dimension: 'commercial', value: 'subscription', reason: 'preview' },
      { orderComponentId: target, dimension: 'obligations', value: [], reason: 'preview' },
    ],
  })).result.plan;
  assert.equal(preview.activatable, true, 'both axes decided makes the plan activatable');

  // …but activating without repeating the decision is still refused: the plan
  // is recomputed from the Order and carries no authority of its own.
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', FULL),
    (error) => error.code === 'CLASSIFICATION_AMBIGUOUS',
  );

  // A plan computed against one policy version does not authorize another.
  const v2Plan = (await client.module('order').action(order.id, 'plan-activation', { policy: POLICY.policy, policyVersion: 2 })).result.plan;
  assert.equal(v2Plan.activatable, true, 'policy v2 maps storage natively');
  assert.equal(v2Plan.policyVersion ?? 2, 2);
  // Activating with v1 still refuses, because v1 is what it recomputes with.
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', FULL),
    (error) => error.code === 'CLASSIFICATION_AMBIGUOUS',
  );

  // Planning is deterministic for the same inputs and writes nothing.
  const auditBefore = app.audit.list({ limit: 1000 }).length;
  const first = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  const second = (await client.module('order').action(order.id, 'plan-activation', POLICY)).result.plan;
  assert.deepEqual(first, second, 'the same order and policy produce the same plan');
  assert.equal(app.audit.list({ limit: 1000 }).length, auditBefore, 'planning writes no audit');

  // Once activated, the earlier plan does not authorize a second activation.
  await client.module('order').action(order.id, 'activate-contract', {
    ...POLICY, policyVersion: 2, ...TERM, ...TERMS_REASON,
  });
  await assert.rejects(
    () => client.module('order').action(order.id, 'activate-contract', { ...POLICY, policyVersion: 2, ...TERM, ...TERMS_REASON }),
    (error) => error.code === 'ORDER_ALREADY_ACTIVATED',
  );
  assert.equal(app.modules.get('commercial-contract').service.list().length, 1);
});
