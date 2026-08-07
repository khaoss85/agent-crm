import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Milestone 14b2 evidence battery: the properties a reader has to be able to
 * rely on, proved rather than argued.
 *
 * Fault injection after every business write · two connections racing every
 * decision · exact reads past the display bound · exact audit, event and trace
 * counts on both success and refusal · the acceptance scope frozen against
 * later mutation.
 */

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const WINDOW = { targetStartDate: '2026-09-20', targetEndDate: '2026-12-20' };
const PARTNER = { partnerRef: 'partner:abc', partnerName: 'ABC Consulting', reason: 'they run our migrations' };
const ACTOR = { type: 'user', id: 'e2e' };

/** Every M14b2 record, for counting what a failure must not leave behind. */
const M14B2_MODULES = [
  'delivery-change-request', 'delivery-plan-revision', 'delivery-commercial-change',
  'delivery-deliverable', 'delivery-acceptance-request', 'delivery-acceptance-evidence',
];

/**
 * One composed project root for the whole file, and a fresh database per test.
 *
 * Building the root is 4.2s — it copies the repository and applies forty-odd
 * manifests through the real CLI — while booting a new database on an existing
 * root is 250ms. Every test here needs its own *data*, not its own copy of the
 * framework, so rebuilding it eleven times spent about forty seconds of CI on
 * nothing. Nothing is written into the root after it is built, so sharing it
 * cannot couple two tests.
 */
let sharedRoot = null;
after(() => {
  if (sharedRoot) rmSync(sharedRoot, { recursive: true, force: true });
});

function composedRoot() {
  // `project` registers its cleanup on the test context it is handed; this root
  // outlives every test in the file, so the file disposes of it instead.
  if (!sharedRoot) sharedRoot = project({ after: () => {} }, { withDelivery: true });
  return sharedRoot;
}

async function running(t, file) {
  const root = composedRoot();
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { contract } = await activatedContract(root, context.app, { name: 'Evidence', offers: OFFERS });
  await context.client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
  });
  const app = context.app;
  const row = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  const workPackages = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: row.id });
  const milestones = app.modules.get('delivery-milestone').service.listWhere({ deliveryProjectId: row.id });
  await context.client.module('delivery-project').action(row.id, 'start-delivery-project', {});
  for (const wp of workPackages) {
    await context.client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  }
  return { root, context, contract, project: row, workPackages, milestones };
}

/** Drive a project to one completed deliverable on a milestone. */
async function withDeliverable(context, wp, milestoneId, key = 'd-1') {
  const planned = await context.client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: key, label: `Deliverable ${key}`, milestoneId,
  });
  if (context.app.modules.get('delivery-work-package').service.get(wp.id).status !== 'completed') {
    await context.client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  }
  await context.client.module('delivery-deliverable').action(planned.result.deliverable.id, 'complete-deliverable', {});
  return planned.result.deliverable;
}

test('every business write rolls back completely when it fails', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'fault.sqlite');
  const { app, client } = context;
  const wp = workPackages[0];
  const milestone = milestones[1];

  // Each case names the record whose write is sabotaged and the action that
  // reaches it. The intermediate writes matter most: a plan revision, a
  // commercial candidate and a decision update all happen inside one action,
  // and a failure in any of them must take the whole action with it.
  const cases = [
    ['delivery-change-request', 'createManaged', {
      module: 'delivery-project', action: 'propose-change-request', recordId: row.id, actor: ACTOR,
      input: { changeKey: 'f1', changeType: 'non_commercial_replan', title: 't', reason: 'r' },
    }],
    ['delivery-deliverable', 'createManaged', {
      module: 'delivery-work-package', action: 'plan-deliverable', recordId: wp.id, actor: ACTOR,
      input: { deliverableKey: 'f2', label: 'l', milestoneId: milestone.id },
    }],
  ];

  for (const [moduleName, method, request] of cases) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => {
      await real(...args);
      throw new Error(`injected failure after ${moduleName}.${method}`);
    };
    const auditBefore = app.audit.list({ entityType: moduleName }).length;
    await assert.rejects(() => app.runAction(request), /injected failure/, `${moduleName}.${method}`);
    service[method] = real;

    for (const module of M14B2_MODULES) {
      assert.equal(app.modules.get(module).service.countWhere({ deliveryProjectId: row.id }), 0,
        `${moduleName}.${method}: no ${module} row survives the rollback`);
    }
    assert.equal(app.audit.list({ entityType: moduleName }).length, auditBefore,
      `${moduleName}.${method}: no audit row claims a success that did not happen`);

    // The retry produces exactly one, which is the property that makes the
    // rollback usable rather than merely safe.
    await app.runAction(request);
    assert.equal(app.modules.get(moduleName).service.countWhere({ deliveryProjectId: row.id }), 1,
      `${moduleName}.${method}: the retry produced exactly one`);
    for (const module of M14B2_MODULES) app.database.raw.exec(`DELETE FROM ${app.modules.get(module).table};`);
  }

  // `complete-deliverable` is the seventh write in the graph and the only
  // single-write one that reaches storage through `applyManaged` rather than
  // `createManaged`. A graph with one uninjected write is not an injected graph.
  const forCompletion = await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'to-complete', label: 'Migrated set', milestoneId: milestone.id,
  });
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  {
    const service = app.modules.get('delivery-deliverable').service;
    const real = service.applyManaged.bind(service);
    service.applyManaged = async (...args) => { await real(...args); throw new Error('injected failure after applyManaged'); };
    const auditBefore = app.audit.list({ entityType: 'delivery-deliverable' }).length;
    await assert.rejects(() => app.runAction({
      module: 'delivery-deliverable', action: 'complete-deliverable',
      recordId: forCompletion.result.deliverable.id, actor: ACTOR, input: { completionEvidenceRef: 'ref' },
    }), /injected failure/);
    service.applyManaged = real;
    const after = app.modules.get('delivery-deliverable').service.get(forCompletion.result.deliverable.id);
    assert.equal(after.status, 'planned', 'a failed completion leaves the deliverable planned');
    assert.equal(after.completedBy, null, 'and claims nobody completed it');
    assert.equal(after.completionEvidenceRef, null);
    assert.equal(app.audit.list({ entityType: 'delivery-deliverable' }).length, auditBefore,
      'and no audit row claims a completion that did not happen');
    const done = await client.module('delivery-deliverable').action(forCompletion.result.deliverable.id, 'complete-deliverable', {
      completionEvidenceRef: 'ref',
    });
    assert.equal(done.result.deliverable.status, 'completed', 'the retry completes it exactly once');
    assert.equal(done.result.accepted, false, 'and still says completion is not acceptance');
  }
  for (const module of M14B2_MODULES) app.database.raw.exec(`DELETE FROM ${app.modules.get(module).table};`);

  // The multi-write actions, injected at each of their two writes in turn.
  const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'replan', changeType: 'non_commercial_replan', title: 't', reason: 'r',
  });
  const changeId = proposed.result.changeRequest.id;

  for (const [moduleName, method] of [['delivery-plan-revision', 'createManaged'], ['delivery-change-request', 'applyManaged']]) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => {
      await real(...args);
      throw new Error(`injected failure after ${moduleName}.${method}`);
    };
    await assert.rejects(() => app.runAction({
      module: 'delivery-change-request', action: 'decide-change-request', recordId: changeId, actor: ACTOR,
      input: { decision: 'approve', reason: 'agreed' },
    }), /injected failure/, `decide → ${moduleName}.${method}`);
    service[method] = real;

    assert.equal(app.modules.get('delivery-plan-revision').service.countWhere({ deliveryProjectId: row.id }), 0,
      `${method}: no orphan revision`);
    assert.equal(app.modules.get('delivery-change-request').service.get(changeId).status, 'proposed',
      `${method}: the source change is unchanged`);
  }

  const decided = await client.module('delivery-change-request').action(changeId, 'decide-change-request', {
    decision: 'approve', reason: 'agreed',
  });
  assert.equal(decided.result.changeRequest.status, 'approved', 'and the retry completes exactly once');
  assert.equal(app.modules.get('delivery-plan-revision').service.countWhere({ deliveryProjectId: row.id }), 1);
});

test('a commercial decision rolls back both of its writes together', async (t) => {
  const { context, project: row } = await running(t, 'fault-commercial.sqlite');
  const { app, client } = context;
  const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'money', changeType: 'commercial_change_required', title: 't', reason: 'r',
    commercialDeltaCents: 100_000, currency: 'EUR',
  });
  const changeId = proposed.result.changeRequest.id;

  for (const [moduleName, method] of [['delivery-commercial-change', 'createManaged'], ['delivery-change-request', 'applyManaged']]) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => {
      await real(...args);
      throw new Error('injected failure');
    };
    await assert.rejects(() => app.runAction({
      module: 'delivery-change-request', action: 'decide-change-request', recordId: changeId, actor: ACTOR,
      input: { decision: 'approve', reason: 'quote it' },
    }), /injected failure/);
    service[method] = real;
    assert.equal(app.modules.get('delivery-commercial-change').service.countWhere({ deliveryProjectId: row.id }), 0,
      `${method}: no orphan candidate — a half-raised commercial handoff is worse than none`);
    assert.equal(app.modules.get('delivery-change-request').service.get(changeId).status, 'proposed');
  }

  const done = await client.module('delivery-change-request').action(changeId, 'decide-change-request', {
    decision: 'approve', reason: 'quote it',
  });
  assert.equal(done.result.changeRequest.status, 'pending_commercial_followup');
  assert.equal(app.modules.get('delivery-commercial-change').service.countWhere({ deliveryProjectId: row.id }), 1);
});

test('acceptance writes roll back, and a failed record leaves the request pending', async (t) => {
  const { context, workPackages, milestones } = await running(t, 'fault-acceptance.sqlite');
  const { app, client } = context;
  const milestone = milestones[1];
  await withDeliverable(context, workPackages[0], milestone.id);

  for (const [moduleName, method] of [['delivery-acceptance-request', 'createManaged']]) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => { await real(...args); throw new Error('injected failure'); };
    await assert.rejects(() => app.runAction({
      module: 'delivery-milestone', action: 'request-acceptance', recordId: milestone.id, actor: ACTOR,
      input: { requestKey: 'a1', customerRef: 'customer:acme' },
    }), /injected failure/);
    service[method] = real;
    assert.equal(app.modules.get(moduleName).service.list().length, 0, `${method}: nothing survives`);
  }

  const requested = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a1', customerRef: 'customer:acme',
  });
  const requestId = requested.result.acceptanceRequest.id;

  for (const [moduleName, method] of [['delivery-acceptance-evidence', 'createManaged'], ['delivery-acceptance-request', 'applyManaged']]) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => { await real(...args); throw new Error('injected failure'); };
    await assert.rejects(() => app.runAction({
      module: 'delivery-acceptance-request', action: 'record-acceptance', recordId: requestId, actor: ACTOR,
      input: { outcome: 'accepted', assertedCustomerRef: 'customer:acme' },
    }), /injected failure/);
    service[method] = real;
    assert.equal(app.modules.get('delivery-acceptance-evidence').service.list().length, 0,
      `${method}: no evidence claims an answer nobody gave`);
    assert.equal(app.modules.get('delivery-acceptance-request').service.get(requestId).status, 'pending',
      `${method}: the question is still open`);
  }

  const recorded = await client.module('delivery-acceptance-request').action(requestId, 'record-acceptance', {
    outcome: 'accepted', assertedCustomerRef: 'customer:acme',
  });
  assert.equal(recorded.result.acceptanceEvidence.outcome, 'accepted');
  assert.equal(app.modules.get('delivery-acceptance-evidence').service.list().length, 1);
});

test('two connections racing every decision produce exactly one winner', async (t) => {
  const { root, context, project: row, workPackages, milestones } = await running(t, 'race.sqlite');
  const { app, client } = context;
  // Every HTTP call this test needs happens first: once a second connection is
  // open on the same file, the races below use the in-process action runtime on
  // both, which is what "two connections" actually means here.
  await client.module('delivery-work-package').action(workPackages[0].id, 'complete-work-package', {});
  const { createAgentCrmApp } = await import(`file://${join(root, 'packages/app/src/index.js')}`);
  // A short busy timeout on the second connection, because the loser must not
  // be *waited out* to prove the point. The default 5000ms made each contended
  // race sit on the SQLite lock for five seconds — around fifty seconds of CI
  // spent sleeping — and the outcome is identical at 5000ms, 250ms and 0ms: the
  // losing connection is refused with a typed `409 CONFLICT`, never a raw
  // SQLITE error. The races below are unchanged; only the waiting is gone.
  const second = createAgentCrmApp({
    dbPath: app.database.path, busyTimeoutMs: 250, clock: () => '2026-09-15T10:00:00.000Z',
  });
  t.after(() => second.close());

  /** Both apps run the same request; exactly one may succeed. */
  const race = async (request, label) => {
    const outcomes = await Promise.allSettled([app.runAction(request), second.runAction(request)]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled'
      && outcome.value?.result?.created !== false);
    for (const lost of outcomes.filter((outcome) => outcome.status === 'rejected')) {
      const message = String(lost.reason?.message ?? '');
      assert.equal(/SQLITE_|database is locked|constraint failed/i.test(message), false,
        `${label}: a raw SQLite error reached the caller — "${message}"`);
      assert.ok(Number.isInteger(lost.reason?.status), `${label}: the loser gets a typed error`);
    }
    return outcomes;
  };

  // 1. The same change-request key from both connections.
  await race({
    module: 'delivery-project', action: 'propose-change-request', recordId: row.id, actor: ACTOR,
    input: { changeKey: 'r1', changeType: 'non_commercial_replan', title: 't', reason: 'r' },
  }, 'propose');
  assert.equal(app.modules.get('delivery-change-request').service.countWhere({ deliveryProjectId: row.id }), 1,
    'exactly one change request exists');

  // 2. Approve and reject the same change at once: one decision, not two.
  const change = app.modules.get('delivery-change-request').service.listWhere({ deliveryProjectId: row.id })[0];
  const decisions = await Promise.allSettled([
    app.runAction({ module: 'delivery-change-request', action: 'decide-change-request', recordId: change.id, actor: ACTOR, input: { decision: 'approve', reason: 'yes' } }),
    second.runAction({ module: 'delivery-change-request', action: 'decide-change-request', recordId: change.id, actor: ACTOR, input: { decision: 'reject', reason: 'no' } }),
  ]);
  assert.equal(decisions.filter((outcome) => outcome.status === 'fulfilled').length, 1,
    'exactly one decision won');
  const settled = app.modules.get('delivery-change-request').service.get(change.id);
  assert.ok(['approved', 'rejected'].includes(settled.status));
  assert.equal(app.modules.get('delivery-plan-revision').service.countWhere({ deliveryProjectId: row.id }),
    settled.status === 'approved' ? 1 : 0, 'and the revision count matches the decision that won');

  // 3. Two connections allocating a plan-revision version at once.
  for (const key of ['r2', 'r3']) {
    await app.runAction({
      module: 'delivery-project', action: 'propose-change-request', recordId: row.id, actor: ACTOR,
      input: { changeKey: key, changeType: 'non_commercial_replan', title: key, reason: 'r' },
    });
  }
  const pending = app.modules.get('delivery-change-request').service
    .listWhere({ deliveryProjectId: row.id, status: 'proposed' });
  const versionRace = await Promise.allSettled(pending.map((entry, index) => (index % 2 === 0 ? app : second).runAction({
    module: 'delivery-change-request', action: 'decide-change-request', recordId: entry.id, actor: ACTOR,
    input: { decision: 'approve', reason: 'yes' },
  })));
  const revisions = app.modules.get('delivery-plan-revision').service.listWhere({ deliveryProjectId: row.id });
  const versions = revisions.map((entry) => entry.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [...new Set(versions)], 'no two revisions share a version');
  assert.equal(versions.length, new Set(revisions.map((entry) => entry.sourceKey)).size, 'and no two share a key');
  assert.ok(versionRace.length === 2);

  // 4. Deliverable planning and completion races.
  const wp = workPackages[0];
  await race({
    module: 'delivery-work-package', action: 'plan-deliverable', recordId: wp.id, actor: ACTOR,
    input: { deliverableKey: 'd1', label: 'Migrated set', milestoneId: milestones[1].id },
  }, 'plan-deliverable');
  assert.equal(app.modules.get('delivery-deliverable').service.countWhere({ deliveryProjectId: row.id }), 1);

  const deliverable = app.modules.get('delivery-deliverable').service.listWhere({ deliveryProjectId: row.id })[0];
  const completions = await Promise.allSettled([
    app.runAction({ module: 'delivery-deliverable', action: 'complete-deliverable', recordId: deliverable.id, actor: ACTOR, input: {} }),
    second.runAction({ module: 'delivery-deliverable', action: 'complete-deliverable', recordId: deliverable.id, actor: ACTOR, input: {} }),
  ]);
  assert.equal(completions.filter((outcome) => outcome.status === 'fulfilled').length, 1,
    'a deliverable completes once');

  // 5. Two connections requesting acceptance on the same milestone.
  await race({
    module: 'delivery-milestone', action: 'request-acceptance', recordId: milestones[1].id, actor: ACTOR,
    input: { requestKey: 'a1', customerRef: 'customer:acme' },
  }, 'request-acceptance');
  assert.equal(app.modules.get('delivery-acceptance-request').service.countWhere({ deliveryProjectId: row.id }), 1,
    'one open question, not two');

  // 6. Accepted and rejected recorded at the same instant.
  const request = app.modules.get('delivery-acceptance-request').service.listWhere({ deliveryProjectId: row.id })[0];
  const answers = await Promise.allSettled([
    app.runAction({ module: 'delivery-acceptance-request', action: 'record-acceptance', recordId: request.id, actor: ACTOR, input: { outcome: 'accepted', assertedCustomerRef: 'c' } }),
    second.runAction({ module: 'delivery-acceptance-request', action: 'record-acceptance', recordId: request.id, actor: ACTOR, input: { outcome: 'rejected', assertedCustomerRef: 'c' } }),
  ]);
  assert.equal(answers.filter((outcome) => outcome.status === 'fulfilled').length, 1,
    'a customer said one thing, and exactly one thing is recorded');
  assert.equal(app.modules.get('delivery-acceptance-evidence').service.countWhere({ deliveryProjectId: row.id }), 1);
});

test('exact reads stay exact past the display bound', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'bulk.sqlite');
  const { app, client } = context;
  const wp = workPackages[0];

  // 520 change requests, written through the action that owns them.
  for (let index = 0; index < 520; index += 1) {
    await app.runAction({
      module: 'delivery-project', action: 'propose-change-request', recordId: row.id, actor: ACTOR,
      input: { changeKey: `bulk-${index}`, changeType: 'non_commercial_replan', title: `Change ${index}`, reason: 'bulk' },
    });
  }
  const service = app.modules.get('delivery-change-request').service;
  assert.equal(service.countWhere({ deliveryProjectId: row.id }), 520, 'the exact count is exact');
  assert.equal(service.listWhere({ deliveryProjectId: row.id }).length, 520, 'and the exact read is complete');
  assert.equal(service.list().length, 100, 'while the paged list is a display bound, unchanged');
  assert.equal(service.list({ limit: 500 }).length, 500, 'capped where it always was');

  // The last one written is still found by its key, past every page bound.
  const last = service.listWhere({ sourceKey: `delivery-change-request:${row.id}:bulk-519` });
  assert.equal(last.length, 1, 'the 520th row is found by exact key, not by paging to it');

  // And the correctness path proves it: a divergent retry on row 519 is refused
  // even though that row is far outside any page.
  await assert.rejects(
    () => app.runAction({
      module: 'delivery-project', action: 'propose-change-request', recordId: row.id, actor: ACTOR,
      input: { changeKey: 'bulk-519', changeType: 'non_commercial_replan', title: 'Different', reason: 'bulk' },
    }),
    (error) => error.code === 'DELIVERY_EVIDENCE_CONFLICT',
    'idempotency does not degrade past the page bound',
  );

  // Deliverables past the bound, and the acceptance scope that must include
  // every one of them rather than the first page.
  await client.module('delivery-work-package').action(wp.id, 'block-work-package', { reason: 'bulk load' });
  await client.module('delivery-work-package').action(wp.id, 'resume-work-package', {});
  for (let index = 0; index < 510; index += 1) {
    await app.runAction({
      module: 'delivery-work-package', action: 'plan-deliverable', recordId: wp.id, actor: ACTOR,
      input: { deliverableKey: `d-${index}`, label: `Deliverable ${index}`, milestoneId: milestones[1].id },
    });
  }
  const deliverables = app.modules.get('delivery-deliverable').service;
  assert.equal(deliverables.countWhere({ deliveryMilestoneId: milestones[1].id }), 510);
  assert.equal(deliverables.list().length, 100, 'the display bound is still a display bound');

  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  for (const deliverable of deliverables.listWhere({ deliveryMilestoneId: milestones[1].id })) {
    await app.runAction({
      module: 'delivery-deliverable', action: 'complete-deliverable', recordId: deliverable.id, actor: ACTOR, input: {},
    });
  }
  const requested = await client.module('delivery-milestone').action(milestones[1].id, 'request-acceptance', {
    requestKey: 'bulk-acceptance', customerRef: 'customer:acme',
  });
  assert.equal(requested.result.acceptanceRequest.deliverableCount, 510,
    'the frozen scope contains every deliverable, not the first page of them');
  assert.equal(JSON.parse(requested.result.acceptanceRequest.frozenScope).deliverables.length, 510);
});

test('audit, event and trace counts are exact on success and on refusal', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'counts.sqlite');
  const { app, client } = context;
  const wp = workPackages[0];
  const milestone = milestones[1];

  // Two different records, kept apart deliberately:
  //   *events* are the record events a generated module publishes after commit
  //     (ADR-012), observed by subscribing because they are in-process;
  //   *trace steps* carry this milestone's business vocabulary, and land in
  //     `trace_spans` with the run that produced them.
  const emitted = [];
  const RECORD_EVENTS = M14B2_MODULES.flatMap((name) => [`${name}.created`, `${name}.updated`]);
  const FORBIDDEN_EVENTS = [
    'quote.amended', 'order.amended', 'contract.amended', 'commercial-contract.updated',
    'invoice.created', 'payment.received', 'billing.eligible',
    'customer.authenticated', 'customer.legally-accepted', 'service.activated',
    'subscription.updated', 'order.updated', 'quote-version.updated',
  ];
  for (const name of [...RECORD_EVENTS, ...FORBIDDEN_EVENTS]) {
    app.events.subscribe(name, () => emitted.push(name));
  }
  const since = (mark) => emitted.slice(mark);
  const audits = (entityType) => app.audit.list({ entityType }).length;
  const steps = (runFilter) => app.database.raw
    .prepare("SELECT name, status FROM trace_spans WHERE name LIKE 'delivery.%' ORDER BY rowid").all()
    .filter(runFilter ?? (() => true));

  // 1. Propose: one record, one audit, one record event, one business step.
  let mark = emitted.length;
  let stepMark = steps().length;
  const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'c1', changeType: 'non_commercial_replan', title: 't', reason: 'r',
  });
  assert.equal(audits('delivery-change-request'), 1, 'exactly one audit row');
  assert.deepEqual(since(mark), ['delivery-change-request.created'], 'exactly one record event');
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name),
    ['delivery.change-request.proposed'], 'exactly one business step, named truthfully');

  // 2. An idempotent repeat writes no audit and no record event.
  mark = emitted.length;
  await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'c1', changeType: 'non_commercial_replan', title: 't', reason: 'r',
  });
  assert.equal(audits('delivery-change-request'), 1, 'a repeat writes no audit');
  assert.deepEqual(since(mark), [], 'and no record event');

  // 3. A refused divergent retry writes no success evidence of any kind.
  mark = emitted.length;
  stepMark = steps().length;
  await assert.rejects(() => client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'c1', changeType: 'non_commercial_replan', title: 'DIFFERENT', reason: 'r',
  }), (error) => error.code === 'DELIVERY_EVIDENCE_CONFLICT');
  assert.equal(audits('delivery-change-request'), 1, 'a refusal writes no audit');
  assert.deepEqual(since(mark), [], 'no record event');
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name), [],
    'and no business step claims something happened');

  // 4. An approved replan: the revision is created and the change updated, in
  //    that order — the revision exists before the decision that cites it.
  mark = emitted.length;
  stepMark = steps().length;
  await client.module('delivery-change-request').action(proposed.result.changeRequest.id, 'decide-change-request', {
    decision: 'approve', reason: 'agreed',
  });
  assert.deepEqual(since(mark), ['delivery-plan-revision.created', 'delivery-change-request.updated']);
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name),
    ['delivery.plan-revision.created', 'delivery.change-request.decided']);
  assert.equal(audits('delivery-plan-revision'), 1, 'one audit for one revision');

  // 5. A commercial decision: candidate then decision, and nothing commercial.
  mark = emitted.length;
  stepMark = steps().length;
  const money = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'c2', changeType: 'commercial_change_required', title: 't2', reason: 'r2',
    commercialDeltaCents: 1_000, currency: 'EUR', milestoneIds: [milestones[0].id],
  });
  await client.module('delivery-change-request').action(money.result.changeRequest.id, 'decide-change-request', {
    decision: 'approve', reason: 'quote it',
  });
  assert.deepEqual(since(mark), [
    'delivery-change-request.created',
    'delivery-commercial-change.created',
    'delivery-change-request.updated',
  ]);
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name), [
    'delivery.change-request.proposed',
    'delivery.commercial-change.requested',
    'delivery.change-request.decided',
  ]);

  // 6. Deliverable and acceptance on a milestone that change does not name.
  //    The work package finishes first, so the marks below cover M14b2's own
  //    steps rather than M14a's completion in the middle of them.
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  mark = emitted.length;
  stepMark = steps().length;
  await withDeliverable(context, wp, milestone.id);
  assert.deepEqual(since(mark), ['delivery-deliverable.created', 'delivery-deliverable.updated']);
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name),
    ['delivery.deliverable.planned', 'delivery.deliverable.completed']);

  mark = emitted.length;
  stepMark = steps().length;
  const requested = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a1', customerRef: 'customer:acme',
  });
  await client.module('delivery-acceptance-request').action(requested.result.acceptanceRequest.id, 'record-acceptance', {
    outcome: 'accepted', assertedCustomerRef: 'customer:acme',
  });
  assert.deepEqual(since(mark), [
    'delivery-acceptance-request.created',
    'delivery-acceptance-evidence.created',
    'delivery-acceptance-request.updated',
  ]);
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name),
    ['delivery.acceptance.requested', 'delivery.acceptance.recorded']);

  // 7. A refusal emits nothing at all.
  mark = emitted.length;
  stepMark = steps().length;
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'a2', customerRef: 'customer:acme',
    }),
    (error) => error.code === 'DELIVERY_ACCEPTANCE_SCOPE_SETTLED',
  );
  assert.deepEqual(since(mark), [], 'a refusal emits no record event');
  assert.deepEqual(steps().slice(stepMark).map((entry) => entry.name), [], 'and no business step');
  // Two audit rows for one request: the creation, and the status update that
  // recorded its answer. Both are real writes to that record, and an audit
  // trail that hid the second would be the incomplete one.
  assert.equal(audits('delivery-acceptance-request'), 2,
    'the request was created and then answered — two writes, two audit rows, and the refusal added none');

  // Every business step this milestone ever emitted is one of its eight
  // declared names — nothing invented a vocabulary along the way.
  const DECLARED = new Set([
    'delivery.change-request.proposed', 'delivery.change-request.decided',
    'delivery.plan-revision.created', 'delivery.commercial-change.requested',
    'delivery.deliverable.planned', 'delivery.deliverable.completed',
    'delivery.acceptance.requested', 'delivery.acceptance.recorded',
    'delivery.change-request.already-proposed', 'delivery.deliverable.already-planned',
    'delivery.acceptance.already-requested', 'delivery.acceptance.already-recorded',
  ]);
  const m14b2Steps = steps().map((entry) => entry.name).filter((name) => DECLARED.has(name)
    || name.startsWith('delivery.change') || name.startsWith('delivery.plan-revision')
    || name.startsWith('delivery.commercial') || name.startsWith('delivery.deliverable')
    || name.startsWith('delivery.acceptance'));
  for (const name of new Set(m14b2Steps)) {
    assert.ok(DECLARED.has(name), `unexpected M14b2 business step "${name}"`);
  }

  // And not one of the names that would claim a thing this milestone must
  // never do was ever published.
  for (const forbidden of FORBIDDEN_EVENTS) {
    assert.equal(emitted.includes(forbidden), false, `"${forbidden}" must never be emitted`);
  }

  // The refused acceptance is traced as the failure it was, not as a success.
  const runs = app.database.raw
    .prepare("SELECT status FROM workflow_runs WHERE workflow_name LIKE '%request-acceptance%'").all();
  assert.ok(runs.some((run) => run.status !== 'completed'),
    'a refusal is an honest failed run, not a quiet success');
});

test('the acceptance scope is frozen, and an unchanged question is not re-asked', async (t) => {
  const { context, workPackages, milestones } = await running(t, 'scope.sqlite');
  const { app, client } = context;
  const wp = workPackages[0];
  const milestone = milestones[1];
  const first = await withDeliverable(context, wp, milestone.id, 'd-1');

  const requested = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a1', customerRef: 'customer:acme',
  });
  const request = requested.result.acceptanceRequest;
  assert.match(request.scopeFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(request.deliverableCount, 1);

  // While the question is open, the scope cannot change under it.
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
      deliverableKey: 'd-2', label: 'Snuck in later', milestoneId: milestone.id,
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_ACCEPTANCE_SCOPE_FROZEN',
    'a deliverable cannot be added to a milestone with a pending request',
  );

  // Reject it. Execution history stands; the request and its scope stand.
  await client.module('delivery-acceptance-request').action(request.id, 'record-acceptance', {
    outcome: 'rejected', assertedCustomerRef: 'customer:acme', note: 'two fields missing',
  });
  const stored = app.modules.get('delivery-acceptance-request').service.get(request.id);
  assert.equal(stored.scopeFingerprint, request.scopeFingerprint, 'the frozen scope did not move');
  assert.equal(stored.frozenScope, request.frozenScope);
  assert.equal(app.modules.get('delivery-deliverable').service.get(first.id).status, 'completed',
    'and the completed deliverable is still completed');

  // The evidence is bound to that exact scope, not merely to the request id.
  const evidence = app.modules.get('delivery-acceptance-evidence').service
    .listWhere({ deliveryAcceptanceRequestId: request.id })[0];
  assert.equal(evidence.scopeFingerprint, request.scopeFingerprint);

  // Asking the identical question again is refused: a "no" does not become a
  // "yes" by persistence.
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'a2', customerRef: 'customer:acme',
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_ACCEPTANCE_SCOPE_SETTLED'
      && error.details.outcome === 'rejected',
    'an unchanged scope is not a new question',
  );

  // And retyping the customer's name is not a replan. `customerRef` is an
  // unverified operator label; folding it into the fingerprint would have made
  // the rule bypassable by a single keystroke, with nothing in the record
  // saying the second question was over identical work.
  for (const relabelled of ['Customer:Acme', 'customer:acme ', ' customer:acme', 'customer:acme s.p.a.']) {
    await assert.rejects(
      () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
        requestKey: `relabel-${relabelled.trim().length}-${relabelled}`, customerRef: relabelled,
      }),
      (error) => error.status === 409 && error.code === 'DELIVERY_ACCEPTANCE_SCOPE_SETTLED',
      `"${relabelled}" must not buy a second answer over identical work`,
    );
  }
  // The label is still frozen and stored — it is part of the testimony. It just
  // does not decide whether the question may be asked again.
  assert.equal(JSON.parse(stored.frozenScope).customerRef, 'customer:acme',
    'the customer reference as it read then is still part of the frozen scope');
  assert.equal(JSON.parse(stored.frozenScope).deliverables.length, stored.deliverableCount);

  // Replan: a governed change, a new deliverable, a genuinely different scope.
  const change = await client.module('delivery-project').action(
    app.modules.get('delivery-project').service.get(request.deliveryProjectId).id,
    'propose-change-request',
    { changeKey: 'fix', changeType: 'non_commercial_replan', title: 'Add the missing fields', reason: 'the customer rejected the export' },
  );
  await client.module('delivery-change-request').action(change.result.changeRequest.id, 'decide-change-request', {
    decision: 'approve', reason: 'agreed to redo the export',
  });
  const second = await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'd-2', label: 'Export with the missing fields', milestoneId: milestone.id,
  });
  await client.module('delivery-deliverable').action(second.result.deliverable.id, 'complete-deliverable', {});

  const reasked = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a3', customerRef: 'customer:acme',
  });
  assert.notEqual(reasked.result.acceptanceRequest.scopeFingerprint, request.scopeFingerprint,
    'a replanned scope is a different question, and gets a different fingerprint');
  assert.equal(reasked.result.acceptanceRequest.deliverableCount, 2);

  // The original request is untouched by any of it.
  const original = app.modules.get('delivery-acceptance-request').service.get(request.id);
  assert.equal(original.status, 'rejected');
  assert.equal(original.deliverableCount, 1, 'the first question still covers exactly what it asked about');
});

test('an unresolved commercial change blocks acceptance over the scope it touches', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'gate.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];
  const milestone = milestones[1];
  await withDeliverable(context, wp, milestone.id);

  // A commercial change naming *another* milestone does not block this one.
  const elsewhere = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'elsewhere', changeType: 'commercial_change_required', title: 'Other scope', reason: 'r',
    milestoneIds: [milestones[0].id],
  });
  await client.module('delivery-change-request').action(elsewhere.result.changeRequest.id, 'decide-change-request', {
    decision: 'approve', reason: 'quote it',
  });
  const allowed = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'ok', customerRef: 'customer:acme',
  });
  assert.equal(allowed.result.acceptanceRequest.status, 'pending',
    'an unrelated commercial change does not freeze unrelated scope');

  // A change naming *this* milestone does block it.
  await client.module('delivery-acceptance-request').action(allowed.result.acceptanceRequest.id, 'record-acceptance', {
    outcome: 'accepted', assertedCustomerRef: 'customer:acme',
  });
  const here = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'here', changeType: 'commercial_change_required', title: 'This scope', reason: 'r',
    milestoneIds: [milestone.id],
  });
  await client.module('delivery-change-request').action(here.result.changeRequest.id, 'decide-change-request', {
    decision: 'approve', reason: 'quote it',
  });
  const other = workPackages[1];
  await client.module('delivery-work-package').action(other.id, 'complete-work-package', {});
  const extra = await client.module('delivery-work-package').action(other.id, 'plan-deliverable', {
    deliverableKey: 'd-extra', label: 'Second wave', milestoneId: milestone.id,
  });
  await client.module('delivery-deliverable').action(extra.result.deliverable.id, 'complete-deliverable', {});

  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'blocked', customerRef: 'customer:acme',
    }),
    (error) => error.status === 409 && error.code === 'DELIVERY_COMMERCIAL_CHANGE_UNRESOLVED'
      && error.details.changeRequests.includes(here.result.changeRequest.id),
    'commercially disputed scope is never silently treated as acceptable',
  );
  assert.equal(app.modules.get('delivery-acceptance-request').service.countWhere({ status: 'pending' }), 0,
    'and the refusal wrote nothing');

  // The block is not a dead end. Reading the change request's
  // `pending_commercial_followup` — which is terminal — would have made it one:
  // an approved commercial change would have stopped this project ever
  // recording acceptance again. The block reads the candidate, and a human can
  // record what the commercial follow-up concluded.
  const candidate = app.modules.get('delivery-commercial-change').service
    .listWhere({ deliveryChangeRequestId: here.result.changeRequest.id })[0];
  const resolved = await client.module('delivery-commercial-change').action(candidate.id, 'resolve-commercial-change', {
    resolution: 'resolved_externally', reason: 'quoted and signed as a separate order', evidenceRef: 'CRM-1234',
  });
  assert.equal(resolved.result.commercialChange.status, 'resolved_externally');
  assert.equal(resolved.result.amended, false, 'recording an outcome amends nothing');
  assert.equal(app.modules.get('delivery-change-request').service.get(here.result.changeRequest.id).status,
    'pending_commercial_followup', 'and the change request keeps the decision it was given');

  const unblocked = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'unblocked', customerRef: 'customer:acme',
  });
  assert.equal(unblocked.result.acceptanceRequest.status, 'pending',
    'acceptance is askable again once the commercial question is recorded as closed');

  // Resolved once, and only once.
  await assert.rejects(
    () => client.module('delivery-commercial-change').action(candidate.id, 'resolve-commercial-change', {
      resolution: 'withdrawn', reason: 'changed my mind',
    }),
    (error) => error.status === 409,
    'a recorded outcome is evidence, not a field somebody edits',
  );
  // And it is a human decision, like every other decision in this milestone.
  await assert.rejects(
    () => context.agentClient.module('delivery-commercial-change').action(candidate.id, 'resolve-commercial-change', {
      resolution: 'withdrawn', reason: 'the agent decided',
    }),
    (error) => error.status === 403 || error.status === 409,
    'an agent does not close a commercial question',
  );
});

test('a project-wide commercial change blocks every milestone, and is still recoverable', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'projectwide.sqlite');
  const { client, app } = context;
  await withDeliverable(context, workPackages[0], milestones[1].id);

  // A change naming nothing is read as project-wide: the safe reading of "we
  // have not decided what this project includes".
  const wide = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'wide', changeType: 'commercial_change_required', title: 'Rescope the engagement', reason: 'r',
    commercialDeltaCents: 500_00, currency: 'EUR',
  });
  const decided = await client.module('delivery-change-request').action(wide.result.changeRequest.id, 'decide-change-request', {
    decision: 'approve', reason: 'take it to commercial',
  });
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestones[1].id, 'request-acceptance', {
      requestKey: 'blocked', customerRef: 'customer:acme',
    }),
    (error) => error.code === 'DELIVERY_COMMERCIAL_CHANGE_UNRESOLVED'
      && error.details.commercialChanges.includes(decided.result.commercialChange.id),
    'a project-wide unresolved change covers this milestone too',
  );

  // Withdrawing it is the other honest outcome, and it unblocks the same way.
  const withdrawn = await client.module('delivery-commercial-change').action(decided.result.commercialChange.id, 'resolve-commercial-change', {
    resolution: 'withdrawn', reason: 'the customer dropped the request',
  });
  assert.equal(withdrawn.result.commercialChange.status, 'withdrawn');
  const asked = await client.module('delivery-milestone').action(milestones[1].id, 'request-acceptance', {
    requestKey: 'after', customerRef: 'customer:acme',
  });
  assert.equal(asked.result.acceptanceRequest.status, 'pending');

  // The capability offers the amendment milestone only what is still pending.
  assert.equal(app.modules.get('delivery-commercial-change').service
    .listWhere({ status: 'pending_commercial_followup' }).length, 0,
    'a resolved candidate is no longer offered as pending commercial work');
});

test('a divergent retry is refused on every write that takes a key', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'divergent.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];
  const milestone = milestones[1];

  // Change request.
  const change = await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'k', changeType: 'non_commercial_replan', title: 'A', reason: 'B',
  });
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'propose-change-request', {
      changeKey: 'k', changeType: 'non_commercial_replan', title: 'CHANGED', reason: 'B',
    }),
    (error) => error.code === 'DELIVERY_EVIDENCE_CONFLICT' && error.details.fields.includes('title'),
  );

  // Deliverable.
  const deliverable = await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'd', label: 'A', milestoneId: milestone.id,
  });
  await assert.rejects(
    () => client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
      deliverableKey: 'd', label: 'CHANGED', milestoneId: milestone.id,
    }),
    (error) => error.code === 'DELIVERY_EVIDENCE_CONFLICT' && error.details.fields.includes('label'),
  );

  // Acceptance request.
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  await client.module('delivery-deliverable').action(deliverable.result.deliverable.id, 'complete-deliverable', {});
  const request = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a', customerRef: 'customer:acme',
  });
  await assert.rejects(
    () => client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
      requestKey: 'a', customerRef: 'customer:OTHER',
    }),
    (error) => error.code === 'DELIVERY_EVIDENCE_CONFLICT' && error.details.fields.includes('customerRef'),
  );

  // Acceptance evidence — the worst possible silent absorb, so the one that
  // matters most: a retry must not turn "rejected" into "accepted".
  await client.module('delivery-acceptance-request').action(request.result.acceptanceRequest.id, 'record-acceptance', {
    outcome: 'rejected', assertedCustomerRef: 'customer:acme',
  });
  await assert.rejects(
    () => app.runAction({
      module: 'delivery-acceptance-request', action: 'record-acceptance',
      recordId: request.result.acceptanceRequest.id, actor: ACTOR,
      input: { outcome: 'accepted', assertedCustomerRef: 'customer:acme' },
    }),
    (error) => error.code === 'DELIVERY_EVIDENCE_CONFLICT' || error.code === 'INVALID_STATE',
    'a rejection never becomes an acceptance by retrying',
  );
  assert.equal(app.modules.get('delivery-acceptance-evidence').service.list()[0].outcome, 'rejected');
  assert.ok(change.result.changeRequest.id);
});


test('hostile input stays inert across every field, and forges nothing', async (t) => {
  const { context, project: row, workPackages, milestones } = await running(t, 'hostile.sqlite');
  const { client, app } = context;
  const wp = workPackages[0];
  const milestone = milestones[1];

  const HOSTILE = [
    '__proto__', 'constructor', 'prototype',
    '<img src=x onerror=alert(1)>', '<script>alert(1)</script>',
    '\'"`;--', '"; DROP TABLE delivery_change_requests; --',
    '${process.env.SECRET}', '{{7*7}}', '../../etc/passwd', '/etc/passwd',
  ];

  for (const [index, value] of HOSTILE.entries()) {
    const proposed = await client.module('delivery-project').action(row.id, 'propose-change-request', {
      changeKey: `h-${index}`, changeType: 'non_commercial_replan',
      title: value, reason: value, requestedScope: value, evidenceRef: value.slice(0, 190),
    });
    const stored = app.modules.get('delivery-change-request').service.get(proposed.result.changeRequest.id);
    assert.equal(stored.title, value, `"${value.slice(0, 20)}" is stored verbatim as inert text`);
    assert.equal(stored.reason, value);
  }
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
  assert.equal(app.modules.get('delivery-change-request').service.list({ limit: 500 }).length, HOSTILE.length,
    'the table still exists and holds exactly what was written');

  // Control characters and oversized values are refused, not stored.
  for (const [field, value] of [
    ['title', 'a\u0000b'], ['reason', 'a\u2028b'], ['requestedScope', 'x'.repeat(2_100)],
    ['title', 'x'.repeat(300)],
  ]) {
    await assert.rejects(
      () => client.module('delivery-project').action(row.id, 'propose-change-request', {
        changeKey: `bad-${field}-${value.length}`, changeType: 'non_commercial_replan',
        title: 'ok', reason: 'ok', [field]: value,
      }),
      (error) => error.status === 400,
      `${field} refuses ${value.length > 100 ? 'an oversized value' : 'a control character'}`,
    );
  }

  // A forged commercial delta or currency is refused rather than coerced.
  for (const [input, why] of [
    [{ commercialDeltaCents: 1.5, currency: 'EUR' }, 'a fractional minor unit'],
    [{ commercialDeltaCents: '1000', currency: 'EUR' }, 'a string amount'],
    [{ commercialDeltaCents: 1_000, currency: 'eur' }, 'a lowercase currency'],
    [{ commercialDeltaCents: 1_000, currency: 'EURO' }, 'a four-letter currency'],
    [{ currency: 'EUR' }, 'a currency with no amount'],
  ]) {
    await assert.rejects(
      () => client.module('delivery-project').action(row.id, 'propose-change-request', {
        changeKey: `forge-${JSON.stringify(input)}`, changeType: 'commercial_change_required',
        title: 'ok', reason: 'ok', ...input,
      }),
      (error) => error.status === 400,
      why,
    );
  }

  // A client cannot forge the acceptance scope fingerprint: it is derived, and
  // an input by that name is simply not part of the action's contract.
  await client.module('delivery-work-package').action(wp.id, 'plan-deliverable', {
    deliverableKey: 'd', label: 'Deliverable', milestoneId: milestone.id,
  });
  await client.module('delivery-work-package').action(wp.id, 'complete-work-package', {});
  const deliverable = app.modules.get('delivery-deliverable').service.list()[0];
  await client.module('delivery-deliverable').action(deliverable.id, 'complete-deliverable', {});
  const requested = await client.module('delivery-milestone').action(milestone.id, 'request-acceptance', {
    requestKey: 'a', customerRef: 'customer:acme',
    scopeFingerprint: '0'.repeat(64), frozenScope: '{"forged":true}', deliverableCount: 999,
    status: 'accepted', requestedBy: 'somebody-else',
  });
  const stored = requested.result.acceptanceRequest;
  assert.notEqual(stored.scopeFingerprint, '0'.repeat(64), 'the fingerprint is derived, never accepted from a client');
  assert.match(stored.scopeFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(stored.deliverableCount, 1, 'and so is the count');
  assert.equal(stored.status, 'pending', 'a client cannot declare its own request accepted');
  assert.equal(stored.requestedBy, 'e2e', 'nor claim somebody else asked');
  assert.equal(JSON.parse(stored.frozenScope).forged, undefined, 'nor supply the scope');

  // Nothing anywhere leaked a path, a stack or a source body into an error.
  await assert.rejects(
    () => client.module('delivery-project').action(row.id, 'propose-change-request', {
      changeKey: 'h-0', changeType: 'non_commercial_replan', title: 'DIVERGENT', reason: 'x',
    }),
    (error) => {
      const text = JSON.stringify(error.details ?? {}) + String(error.message);
      assert.equal(/\/home\/|\/tmp\/|at Object\.|node_modules/.test(text), false,
        'a refusal names fields, not filesystem paths or stack frames');
      return error.code === 'DELIVERY_EVIDENCE_CONFLICT';
    },
  );
  assert.ok(t);
});

test('a capability reads and never writes', async (t) => {
  const { context, project: row } = await running(t, 'capability.sqlite');
  const { app, client } = context;
  await client.module('delivery-project').action(row.id, 'propose-change-request', {
    changeKey: 'c', changeType: 'commercial_change_required', title: 't', reason: 'r',
    commercialDeltaCents: 500, currency: 'EUR',
  });

  // Built exactly as the kernel builds one for a consuming package: with the
  // caller's module handles and nothing else.
  const { createAcceptanceCapability, createChangeCapability } =
    await import('../packages/delivery/src/change-acceptance.js');
  const change = createChangeCapability().create({ modules: app.modules });
  const acceptance = createAcceptanceCapability().create({ modules: app.modules });
  assert.ok(change && acceptance, 'both capabilities construct');

  const view = change.forProject(row.id);
  assert.equal(view.changeRequests.length, 1);
  assert.deepEqual(Object.keys(view).sort(), ['changeRequests', 'commercialChanges', 'planRevisions']);

  const evidence = acceptance.forProject(row.id);
  assert.match(evidence.basis, /not an authenticated customer action/);
  assert.match(evidence.basis, /not authorization to bill/);

  for (const surface of [change, acceptance]) {
    assert.equal(Object.isFrozen(surface), true, 'the capability handle is frozen');
    for (const key of Object.keys(surface)) {
      assert.equal(typeof surface[key], 'function');
      assert.equal(/create|update|delete|decide|record|write/i.test(key), false,
        `"${key}" is a read, not a write`);
    }
  }
  assert.throws(() => change.forProject('no-such-project'), /not found/i);
});
