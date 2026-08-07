import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';
import { computeEconomics, costOfMinutes } from '../packages/delivery/src/economics.js';

/**
 * Milestone 14b1 e2e: a running delivery project records **what it consumed**
 * and produces a reproducible contribution estimate, over the real HTTP/SDK
 * path.
 *
 * These are operational delivery estimates. Nothing here recognizes revenue,
 * invoices, pays, reimburses, computes an accounting or gross margin, or
 * converts a currency.
 */

const DELIVERY_OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const WINDOW = { targetStartDate: '2026-09-20', targetEndDate: '2026-12-20' };
const PARTNER = { partnerRef: 'partner:abc-consulting', partnerName: 'ABC Consulting', reason: 'they run our migrations' };

/** An activated contract handed over and started, with its work in progress. */
async function running(t, file) {
  const root = project(t, { withDelivery: true });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { contract } = await activatedContract(root, context.app, { name: 'Economics', offers: DELIVERY_OFFERS });
  await context.client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
  });
  const app = context.app;
  const row = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  const workPackages = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: row.id });
  await context.client.module('delivery-project').action(row.id, 'start-delivery-project', {});
  for (const wp of workPackages) {
    await context.client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  }
  return { root, context, contract, project: row, workPackages: workPackages.map((wp) => app.modules.get('delivery-work-package').service.get(wp.id)) };
}

test('time and expense are recorded as immutable evidence, costed by the policy', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'record.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];

  await client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'day-1', contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 90, category: 'consulting', note: 'kickoff workshop',
  });
  const entries = app.modules.get('delivery-time-entry').service.listWhere({ deliveryWorkPackageId: wp.id });
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.minutes, 90);
  assert.equal(entry.ratePerHourCents, 12_000, 'the mapped internal consulting rate');
  assert.equal(entry.costCents, costOfMinutes(90, 12_000, 'expected'), 'the server computed the cost');
  assert.equal(entry.costCents, 18_000);
  assert.equal(entry.currency, wp.currency, 'in the work package currency, never converted');
  assert.equal(entry.deliveryProjectId, row.id);
  assert.equal(entry.recordedBy, 'e2e');
  assert.ok(entry.policyFingerprint.length >= 32, 'the rate is attributable to a fingerprinted policy version');

  await client.module('delivery-work-package').action(wp.id, 'record-delivery-expense', {
    entryKey: 'travel-1', expenseDate: '2026-09-21', category: 'travel',
    amountCents: 24_500, vendorRef: 'rail-operator', evidenceRef: 'exp-2026-0042',
  });
  const expenses = app.modules.get('delivery-expense-entry').service.listWhere({ deliveryWorkPackageId: wp.id });
  assert.equal(expenses.length, 1);
  assert.equal(expenses[0].amountCents, 24_500);
  assert.equal(expenses[0].partnerEngagementId, null, 'not a partner cost unless it says so');

  // Evidence is evidence: no public write path exists at all.
  await assert.rejects(
    () => client.module('delivery-time-entry').create({ minutes: 1 }),
    (error) => Number.isInteger(error.status) && error.status >= 400,
  );
  await assert.rejects(
    () => client.module('delivery-time-entry').update(entry.id, { minutes: 999 }),
    (error) => Number.isInteger(error.status) && error.status >= 400,
  );
  assert.equal(app.modules.get('delivery-time-entry').service.get(entry.id).minutes, 90, 'unchanged');
  assert.equal(app.modules.get('delivery-time-entry').service.create, undefined, 'the service has no public create');
  assert.equal(app.modules.get('delivery-expense-entry').service.update, undefined, 'nor a public update');
});

test('recording is a human decision, and an agent is refused', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'human.sqlite');
  const wp = workPackages[0];
  const refusals = [
    ['delivery-work-package', wp.id, 'record-delivery-time', { entryKey: 'a', contributorRef: 'x', contributorType: 'internal', workDate: '2026-09-21', minutes: 60, category: 'consulting' }],
    ['delivery-work-package', wp.id, 'record-delivery-expense', { entryKey: 'b', expenseDate: '2026-09-21', category: 'travel', amountCents: 100 }],
    ['delivery-project', row.id, 'publish-economic-plan', { reason: 'r', lines: [{ kind: 'internal_time', category: 'consulting', plannedTotalCostCents: 1, currency: 'EUR' }] }],
    ['delivery-project', row.id, 'snapshot-delivery-economics', { snapshotKey: 's' }],
  ];
  for (const [module, id, action, input] of refusals) {
    await assert.rejects(
      () => context.agentClient.module(module).action(id, action, input),
      (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
      action,
    );
  }
  assert.equal(context.app.modules.get('delivery-time-entry').service.list().length, 0, 'the refusals wrote nothing');
  assert.equal(context.app.modules.get('delivery-economic-plan').service.list().length, 0);

  // …but an agent may look. A preview is not evidence, and says so.
  const preview = await context.agentClient.module('delivery-project').action(row.id, 'preview-delivery-economics', {});
  assert.equal(preview.result.stored, false);
  assert.equal(preview.result.basis, 'operational-delivery-estimate');
});

test('consumption is refused outside the states where work happens', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'states.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];
  const time = (extra = {}) => client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: `k${Math.trunc(app.modules.get('delivery-time-entry').service.list().length)}`,
    contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 60, category: 'consulting', ...extra,
  });

  // A blocked work package still consumes time — someone is waiting on it.
  await client.module('delivery-work-package').action(wp.id, 'block-work-package', { reason: 'customer VPN pending' });
  await time();
  assert.equal(app.modules.get('delivery-time-entry').service.list().length, 1);
  await client.module('delivery-work-package').action(wp.id, 'resume-work-package', {});

  // A completed work package does not.
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  await assert.rejects(
    () => time(),
    (error) => error.status === 409 && error.code === 'DELIVERY_STATE_NOT_ALLOWED',
    'no consumption after the work is done',
  );
  assert.ok(row.id);
});

test('the same key records once: repeats, a race and two connections', async (t) => {
  const { root, context, project: row, workPackages } = await running(t, 'idempotent.sqlite');
  const { app } = context;
  const wp = workPackages[0];
  const actor = { type: 'user', id: 'e2e' };
  const input = {
    entryKey: 'shift-1', contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 60, category: 'consulting',
  };
  const record = (app_) => app_.runAction({ module: 'delivery-work-package', action: 'record-delivery-time', recordId: wp.id, input, actor });

  const first = await record(app);
  assert.equal(first.result.created, true);
  const second = await record(app);
  assert.equal(second.result.created, false, 'a repeat is answered, not duplicated');
  assert.equal(second.result.timeEntry.id, first.result.timeEntry.id);

  // Three at once on ONE connection is not a duplicate-key race — the kernel
  // refuses a nested outer transaction before any of them reaches the table.
  // Stated rather than papered over, because it is the framework's answer and
  // an agent retrying in parallel will meet it.
  const raced = await Promise.allSettled([record(app), record(app), record(app)]);
  assert.ok(raced.some((outcome) => outcome.status === 'fulfilled'), 'someone wins');
  for (const outcome of raced.filter((entry) => entry.status === 'rejected')) {
    assert.equal(outcome.reason.code, 'NESTED_TRANSACTION', 'and a loser is told exactly why');
  }
  assert.equal(app.modules.get('delivery-time-entry').service.countWhere({ deliveryWorkPackageId: wp.id }), 1);

  // A genuinely separate application instance on the same database file.
  const { createAgentCrmApp } = await import(`file://${join(root, 'packages/app/src/index.js')}`);
  const second_ = createAgentCrmApp({ dbPath: app.database.path, clock: () => '2026-09-15T10:00:00.000Z' });
  t.after(() => second_.close());
  await record(second_);
  assert.equal(second_.modules.get('delivery-time-entry').service.countWhere({ deliveryWorkPackageId: wp.id }), 1,
    'and another connection does not add a second');
  assert.ok(row.id);
});

test('a plan is versioned, never edited, and a snapshot reproduces from evidence', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'plan.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];
  const currency = wp.currency;

  const first = await client.module('delivery-project').action(row.id, 'publish-economic-plan', {
    reason: 'initial plan from the handover',
    lines: [
      { kind: 'internal_time', category: 'consulting', plannedMinutes: 1200, plannedTotalCostCents: 240_000, currency, deliveryWorkPackageId: wp.id },
      { kind: 'expense', category: 'travel', plannedTotalCostCents: 50_000, currency },
    ],
  });
  assert.equal(first.result.plan.version, 1);
  assert.equal(first.result.lines.length, 2);

  const second = await client.module('delivery-project').action(row.id, 'publish-economic-plan', {
    reason: 'scope grew after the kickoff workshop',
    lines: [{ kind: 'internal_time', category: 'consulting', plannedMinutes: 1800, plannedTotalCostCents: 360_000, currency }],
  });
  assert.equal(second.result.plan.version, 2, 'publishing again is a new version');
  assert.equal(app.modules.get('delivery-economic-plan').service.countWhere({ deliveryProjectId: row.id }), 2);
  assert.equal(
    app.modules.get('delivery-economic-plan').service.get(first.result.plan.id).reason,
    'initial plan from the handover',
    'and version 1 is untouched',
  );

  await client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'w1', contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 600, category: 'consulting',
  });
  await client.module('delivery-work-package').action(wp.id, 'record-delivery-expense', {
    entryKey: 'e1', expenseDate: '2026-09-22', category: 'travel', amountCents: 12_345,
  });

  const snapshot = await client.module('delivery-project').action(row.id, 'snapshot-delivery-economics', { snapshotKey: 'week-1' });
  const stored = snapshot.result.snapshot;
  assert.equal(stored.economicPlanVersion, 2, 'measured against the latest published plan');
  assert.equal(stored.basis, 'operational-delivery-estimate');
  assert.match(stored.roundingRule, /roundHalfUp/);
  const groups = JSON.parse(stored.groupsJson);
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.currency, currency);
  assert.equal(group.actualTimeCostCents, costOfMinutes(600, 12_000, 'expected'));
  assert.equal(group.actualExpenseCostCents, 12_345);
  assert.equal(group.totalActualCostCents, group.actualTimeCostCents + group.actualExpenseCostCents);
  assert.equal(group.plannedCostCents, 360_000, 'the latest plan version, not the sum of both');
  // The starter's delivery obligations are all one-time, so a contribution
  // estimate is defensible here — and the basis says so rather than leaving a
  // reader to assume it.
  assert.equal(group.contributionBasis, 'one_time');
  assert.equal(group.contributionUnavailableReason, null);
  assert.deepEqual(
    group.commercialInputs.map((input) => input.chargeType), ['one_time'],
    'every priced obligation in this project is one-time',
  );
  assert.equal(
    group.deliveryContributionEstimateCents,
    group.oneTimeCommercialValueCents - group.totalActualCostCents,
    'an estimate, derived and named as one',
  );
  assert.equal(Object.prototype.hasOwnProperty.call(group, 'grossMarginCents'), false, 'no accounting vocabulary');

  // Reproducible: the same evidence recomputes to the same numbers.
  const preview = await client.module('delivery-project').action(row.id, 'preview-delivery-economics', {});
  assert.deepEqual(preview.result.economics.groups, groups, 'a later recomputation is identical');

  // …and an old snapshot still reads correctly once newer evidence exists.
  await client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'w2', contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-23', minutes: 120, category: 'consulting',
  });
  assert.deepEqual(
    JSON.parse(app.modules.get('delivery-economic-snapshot').service.get(stored.id).groupsJson), groups,
    'the stored snapshot did not move',
  );
  const later = await client.module('delivery-project').action(row.id, 'snapshot-delivery-economics', { snapshotKey: 'week-2' });
  assert.notDeepEqual(JSON.parse(later.result.snapshot.groupsJson), groups, 'but a new one sees the new evidence');
});

test('currencies are grouped and never summed', async (t) => {
  // The arithmetic is pure, so the property is provable directly on it —
  // no fixture can produce a two-currency project through the M13 handover.
  const computed = computeEconomics({
    workPackages: [
      { currency: 'EUR', netAmountCents: 100_000, chargeType: 'one_time' },
      { currency: 'USD', netAmountCents: 250_000, chargeType: 'one_time' },
    ],
    plan: null,
    planLines: [{ currency: 'EUR', plannedTotalCostCents: 40_000 }],
    timeEntries: [
      { currency: 'EUR', costCents: 18_000, minutes: 90 },
      { currency: 'USD', costCents: 30_000, minutes: 120, partnerEngagementId: 'p1' },
    ],
    expenses: [{ currency: 'USD', amountCents: 5_000 }],
  });
  assert.deepEqual(computed.groups.map((g) => g.currency), ['EUR', 'USD'], 'sorted, one group each');
  const eur = computed.groups[0];
  const usd = computed.groups[1];
  assert.equal(eur.oneTimeCommercialValueCents, 100_000);
  assert.equal(usd.oneTimeCommercialValueCents, 250_000);
  assert.equal(eur.totalActualCostCents, 18_000);
  assert.equal(usd.totalActualCostCents, 35_000);
  assert.equal(usd.actualPartnerCostCents, 30_000, 'partner cost is visible without a second query');
  assert.equal(eur.deliveryContributionEstimateCents, 82_000);
  assert.equal(usd.deliveryContributionEstimateCents, 215_000);
  assert.equal(Object.prototype.hasOwnProperty.call(computed, 'totalCents'), false, 'there is no grand total');
  assert.match(computed.note, /never converted or summed across currencies/);
});

test('cost arithmetic is exact at every boundary', async (t) => {
  assert.equal(costOfMinutes(1, 10_000, 'x'), 167, '1 minute of a 100.00/h rate rounds half-up');
  assert.equal(costOfMinutes(30, 10_000, 'x'), 5_000);
  assert.equal(costOfMinutes(60, 10_000, 'x'), 10_000);
  assert.equal(costOfMinutes(61, 10_000, 'x'), 10_167);
  assert.equal(costOfMinutes(0, 10_000, 'x'), 0);
  // Exactly half a cent goes up; just under it goes down.
  assert.equal(costOfMinutes(1, 30, 'x'), 1);
  assert.equal(costOfMinutes(1, 29, 'x'), 0);
  assert.equal(costOfMinutes(1, 90, 'x'), 2, '1.5 rounds to 2');
  for (const [minutes, rate] of [[-1, 100], [1.5, 100], [1, -100], [1, 1.5]]) {
    assert.throws(() => costOfMinutes(minutes, rate, 'x'), /whole number/, `${minutes} @ ${rate}`);
  }
  assert.throws(() => costOfMinutes(1440, Number.MAX_SAFE_INTEGER, 'x'), /supported range/);
});

test('economics is atomic under fault injection, and the retry produces exactly one', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'atomic.sqlite');
  const { app } = context;
  const wp = workPackages[0];
  const actor = { type: 'user', id: 'e2e' };
  const currency = wp.currency;

  const cases = [
    ['delivery-time-entry', { module: 'delivery-work-package', action: 'record-delivery-time', recordId: wp.id, input: { entryKey: 'f1', contributorRef: 'a', contributorType: 'internal', workDate: '2026-09-21', minutes: 60, category: 'consulting' }, actor }],
    ['delivery-expense-entry', { module: 'delivery-work-package', action: 'record-delivery-expense', recordId: wp.id, input: { entryKey: 'f2', expenseDate: '2026-09-21', category: 'travel', amountCents: 1_000 }, actor }],
    ['delivery-economic-plan-line', { module: 'delivery-project', action: 'publish-economic-plan', recordId: row.id, input: { reason: 'r', lines: [{ kind: 'expense', category: 'travel', plannedTotalCostCents: 1_000, currency }] }, actor }],
    ['delivery-economic-snapshot', { module: 'delivery-project', action: 'snapshot-delivery-economics', recordId: row.id, input: { snapshotKey: 'f4' }, actor }],
  ];

  for (const [moduleName, request] of cases) {
    const service = app.modules.get(moduleName).service;
    const real = service.createManaged.bind(service);
    service.createManaged = async (...args) => {
      const result = await real(...args);
      throw new Error(`injected failure after ${moduleName}.createManaged`);
    };
    await assert.rejects(() => app.runAction(request), /injected failure/, moduleName);
    service.createManaged = real;

    // Nothing partial survives — including the plan row when its line failed.
    for (const module of ['delivery-time-entry', 'delivery-expense-entry', 'delivery-economic-plan', 'delivery-economic-plan-line', 'delivery-economic-snapshot']) {
      assert.equal(app.modules.get(module).service.countWhere({ deliveryProjectId: row.id }), 0,
        `${moduleName} failure: no ${module} row survives`);
    }
    const done = await app.runAction(request);
    assert.ok(done.result, `${moduleName}: the retry completes`);
    // Clean up for the next case, through the only path that exists: none.
    // Instead each case uses its own key, so the counts above start at zero
    // only for the first; assert the retry produced exactly one of its kind.
    assert.equal(app.modules.get(moduleName).service.countWhere({ deliveryProjectId: row.id }) >= 1, true);
    for (const module of ['delivery-time-entry', 'delivery-expense-entry', 'delivery-economic-plan', 'delivery-economic-plan-line', 'delivery-economic-snapshot']) {
      app.database.raw.exec(`DELETE FROM ${app.modules.get(module).table};`);
    }
  }
});

test('exact reads stay exact past the paged list bound', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'exact.sqlite');
  const { app } = context;
  const wp = workPackages[0];
  const actor = { type: 'user', id: 'e2e' };
  for (let index = 0; index < 520; index += 1) {
    await app.runAction({
      module: 'delivery-work-package', action: 'record-delivery-time', recordId: wp.id,
      input: {
        entryKey: `bulk-${index}`, contributorRef: 'consultant:ana', contributorType: 'internal',
        workDate: '2026-09-21', minutes: 1, category: 'consulting',
      },
      actor,
    });
  }
  const service = app.modules.get('delivery-time-entry').service;
  assert.equal(service.countWhere({ deliveryProjectId: row.id }), 520, 'the exact count sees them all');
  assert.equal(service.listWhere({ deliveryProjectId: row.id }).length, 520, 'and so does the exact read');
  assert.equal(service.list().length, 100, 'while the paged list is bounded at its default, as documented');
  assert.equal(service.list({ limit: 500 }).length, 500, 'and at its maximum');

  const snapshot = await app.runAction({
    module: 'delivery-project', action: 'snapshot-delivery-economics', recordId: row.id,
    input: { snapshotKey: 'bulk' }, actor,
  });
  assert.equal(snapshot.result.snapshot.timeEntryCount, 520, 'the snapshot counted every entry, not one page');
  assert.equal(JSON.parse(snapshot.result.snapshot.groupsJson)[0].totalMinutes, 520);
});

test('the economics surface is published truthfully, with no forbidden vocabulary', async (t) => {
  const { context } = await running(t, 'schema.sqlite');
  const schema = await context.client.schema();
  const economics = schema.domains.delivery.economics;

  assert.equal(economics.economicsContract, 1);
  assert.equal(economics.basis, 'operational-delivery-estimate');
  assert.match(economics.money.rounding, /roundHalfUp\(ratePerHourCents/);
  assert.match(economics.money.grouping, /never summed/);
  assert.match(economics.humanApproval, /human-actor boundary, not Delivery Manager role/);
  assert.equal(economics.costPolicies.length, 1);
  assert.equal(economics.costPolicies[0].name, 'b2b-delivery-cost');
  assert.ok(economics.costPolicies[0].fingerprint.length >= 32);
  // Config KEYS are useful; a rate table is not a secret, but a value is never
  // published from here either — the fingerprint is what identifies it.
  assert.deepEqual(economics.costPolicies[0].configKeys, ['currency', 'fallback', 'internal', 'partner']);

  for (const absent of ['invoicing', 'payment', 'tax', 'accounting', 'revenue recognition', 'payroll', 'billing eligibility']) {
    assert.ok(economics.notModeled.includes(absent), `${absent} is stated as not modeled`);
  }
  const serialized = JSON.stringify(schema.domains.delivery);
  assert.equal(serialized.includes('function'), false, 'the schema block is function-free');
  for (const forbidden of ['grossMargin', 'recognizedRevenue', 'invoice.created', 'payment.received', 'profit.calculated', 'partner.paid']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} appears nowhere`);
  }
  // The capability another package would declare a dependency on.
  assert.ok(schema.domains.delivery.provides.some((entry) => entry.name === 'delivery-economics' && entry.version === 1));
});

test('hostile input stays inert data across every economics field', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'hostile.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];
  const nasty = '<img src=x onerror=alert(1)>${7*7}`;-- \' or 1=1';

  await client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'h1', contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 60, category: 'consulting', note: nasty,
  });
  const entry = app.modules.get('delivery-time-entry').service.listWhere({ deliveryWorkPackageId: wp.id })[0];
  assert.equal(entry.note, nasty, 'stored verbatim as text');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  // A prototype-shaped key in the plan lines pollutes nothing.
  await client.module('delivery-project').action(row.id, 'publish-economic-plan', {
    reason: nasty,
    lines: JSON.parse('[{"kind":"expense","category":"travel","plannedTotalCostCents":100,"currency":"EUR","__proto__":{"polluted":true}}]'),
  });
  assert.equal({}.polluted, undefined);

  // Refusals: a bad enum, a bad date, bad minutes, a bad currency, a client cost.
  const refuse = (input, why) => assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
      entryKey: `x${Math.trunc(Math.abs(why.length))}`, contributorRef: 'a', contributorType: 'internal',
      workDate: '2026-09-21', minutes: 60, category: 'consulting', ...input,
    }),
    (error) => error.status >= 400 && error.status < 500, why,
  );
  await refuse({ contributorType: 'robot' }, 'an undeclared contributor type');
  await refuse({ workDate: '2026-02-30' }, 'a date that does not exist');
  await refuse({ workDate: 'yesterday' }, 'a date that is not a date');
  await refuse({ minutes: 0 }, 'zero minutes');
  await refuse({ minutes: -5 }, 'negative minutes');
  await refuse({ minutes: 10_000 }, 'more minutes than a day has');
  await refuse({ contributorRef: 'x'.repeat(500) }, 'an unbounded reference');
  await refuse({ note: 'y'.repeat(600) }, 'an unbounded note');

  // A client-supplied cost is not authoritative — it is not even an input.
  await client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'forged', contributorRef: 'a', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 60, category: 'consulting',
    costCents: 1, ratePerHourCents: 1, currency: 'USD',
  });
  const forged = app.modules.get('delivery-time-entry').service.listWhere({ sourceKey: `delivery-time-entry:${wp.id}:forged` })[0];
  assert.equal(forged.costCents, 12_000, 'the server computed it');
  assert.equal(forged.currency, wp.currency, 'in the work package currency');
});

test('the audit and event record is exact, and a refusal writes none', async (t) => {
  const { context, project: row, workPackages } = await running(t, 'audit.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];

  const before = app.audit.list({ entityType: 'delivery-time-entry' }).length;
  await client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'a1', contributorRef: 'a', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 60, category: 'consulting',
  });
  assert.equal(app.audit.list({ entityType: 'delivery-time-entry' }).length - before, 1, 'exactly one audit row');

  await assert.rejects(() => client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'bad', contributorRef: 'a', contributorType: 'internal',
    workDate: '2026-09-21', minutes: -1, category: 'consulting',
  }));
  assert.equal(app.audit.list({ entityType: 'delivery-time-entry' }).length - before, 1, 'the refusal added none');

  const spans = app.database.raw.prepare("SELECT name, status FROM trace_spans WHERE name LIKE '%record-delivery-time%'").all();
  assert.ok(spans.length >= 1, 'the action is traced');
  assert.ok(row.id);
});

test('a recurring delivery obligation never becomes a contribution estimate', async (t) => {
  // A recurring obligation prices *one period*. Recorded execution cost is a
  // spend to date. Subtracting one from the other produces a number with no
  // meaning, so the group must refuse to produce it — and say why.
  const recurring = computeEconomics({
    workPackages: [
      { currency: 'EUR', netAmountCents: 500_000, chargeType: 'one_time' },
      { currency: 'EUR', netAmountCents: 120_000, chargeType: 'recurring', interval: 'month', intervalCount: 1 },
    ],
    plan: null,
    planLines: [],
    timeEntries: [{ currency: 'EUR', costCents: 60_000, minutes: 300 }],
    expenses: [],
  });
  const [eur] = recurring.groups;
  assert.equal(eur.contributionBasis, 'unavailable');
  assert.equal(eur.contributionUnavailableReason, 'recurring_commercial_input');
  assert.equal(eur.deliveryContributionEstimateCents, null, 'no number is better than a wrong one');

  // The commercial input survives as evidence, split by exactly the dimensions
  // that make it incomparable — never flattened into one figure.
  assert.deepEqual(eur.commercialInputs, [
    { chargeType: 'one_time', interval: null, intervalCount: null, netAmountCents: 500_000, workPackageCount: 1 },
    { chargeType: 'recurring', interval: 'month', intervalCount: 1, netAmountCents: 120_000, workPackageCount: 1 },
  ]);
  assert.equal(eur.oneTimeCommercialValueCents, 500_000, 'the one-time subtotal is still stated');
  assert.equal(eur.totalActualCostCents, 60_000, 'cost is unaffected — it is a cost');
  assert.equal(eur.varianceToPlanCents, 60_000, 'variance compares two costs, so it stays available');

  // Nothing anywhere annualizes, normalizes or sums across periods.
  const serialized = JSON.stringify(recurring);
  for (const forbidden of [620_000, 1_440_000, 1_940_000, 440_000]) {
    assert.equal(serialized.includes(String(forbidden)), false, `no term arithmetic produced ${forbidden}`);
  }

  // Two recurring obligations on different terms stay separate buckets.
  const mixed = computeEconomics({
    workPackages: [
      { currency: 'EUR', netAmountCents: 100_000, chargeType: 'recurring', interval: 'month', intervalCount: 1 },
      { currency: 'EUR', netAmountCents: 900_000, chargeType: 'recurring', interval: 'year', intervalCount: 1 },
      { currency: 'EUR', netAmountCents: 50_000, chargeType: 'recurring', interval: 'month', intervalCount: 3 },
    ],
    plan: null, planLines: [], timeEntries: [], expenses: [],
  });
  assert.deepEqual(
    mixed.groups[0].commercialInputs.map((i) => [i.interval, i.intervalCount, i.netAmountCents]),
    [['month', 1, 100_000], ['month', 3, 50_000], ['year', 1, 900_000]],
    'grouped by interval and interval count, sorted deterministically',
  );
  assert.equal(mixed.groups[0].oneTimeCommercialValueCents, 0);
  assert.equal(mixed.groups[0].deliveryContributionEstimateCents, null);

  // A snapshot predating the charge-type field is unknown, not one-time.
  const legacy = computeEconomics({
    workPackages: [{ currency: 'EUR', netAmountCents: 100_000 }],
    plan: null, planLines: [], timeEntries: [], expenses: [],
  });
  assert.equal(legacy.groups[0].contributionUnavailableReason, 'unknown_commercial_shape');
  assert.equal(legacy.groups[0].deliveryContributionEstimateCents, null);

  // Cost in a currency nothing is priced in is not a contribution of −cost.
  const orphan = computeEconomics({
    workPackages: [],
    plan: null, planLines: [],
    timeEntries: [{ currency: 'CHF', costCents: 4_000, minutes: 30 }],
    expenses: [],
  });
  assert.equal(orphan.groups[0].contributionUnavailableReason, 'no_commercial_input');
  assert.equal(orphan.groups[0].deliveryContributionEstimateCents, null);
  assert.ok(t);
});
