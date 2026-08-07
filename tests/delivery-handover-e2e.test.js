import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  ACTIVATION_INPUT, DELIVERY_MODULES, DELIVERY_POLICY, POLICY,
  activatedContract, boot, project, signedOrder,
} from './helpers/contracts-project.js';

/**
 * Milestone 13 e2e: an activated contract's pending delivery obligations
 * become a planned Delivery Project — proven in a clean throwaway project with
 * the real CLI/factory, HTTP server and SDK, across **two** domain packages
 * that reach each other only through a declared capability.
 *
 * The offer mix used throughout: the enterprise offer (setup → delivery
 * obligation), the setup offer (setup fee → internal, data migration →
 * partner) and annual support (a service obligation Delivery must ignore).
 */

/** The records the M13 handover itself writes — each carries a contractId. */
const HANDOVER_MODULES = [
  'delivery-handover-run', 'delivery-project', 'delivery-work-package',
  'delivery-milestone', 'delivery-partner-engagement',
];

const DELIVERY_OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const WINDOW = { targetStartDate: '2026-09-20', targetEndDate: '2026-12-20' };
const PARTNER = { partnerRef: 'partner:abc-consulting', partnerName: 'ABC Consulting', reason: 'they run our migrations' };

const setup = async (t, file, options = {}) => {
  const root = project(t, { withDelivery: true, ...options });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return { root, context };
};

test('an activated contract is planned and handed over to delivery', async (t) => {
  const { root, context } = await setup(t, 'handover.sqlite');
  const { app, client } = context;
  const { contract } = await activatedContract(root, app, { name: 'Handover Deal', offers: DELIVERY_OFFERS });

  // The schema publishes the package, its dependency and its limits.
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains.delivery.packageContract, 1);
  assert.deepEqual(schema.domains.delivery.requires, [
    { package: 'contracts', capability: 'delivery-obligations', version: 1 },
  ]);
  // Contracts provides two capabilities since M15; delivery declares and uses
  // exactly one of them, which is the boundary this asserts.
  assert.deepEqual(schema.domains.contracts.provides.map((entry) => `${entry.name}@${entry.version}`).sort(),
    ['delivery-obligations@1', 'service-obligations@1']);
  assert.deepEqual(schema.domains.delivery.actions, [
    'commercial-contract.create-delivery-handover', 'commercial-contract.plan-delivery-handover',
    // M14a: the execution transitions live in the same package.
    'delivery-acceptance-request.record-acceptance',
    'delivery-change-request.decide-change-request',
    'delivery-commercial-change.resolve-commercial-change',
    'delivery-deliverable.complete-deliverable',
    'delivery-milestone.complete-milestone', 'delivery-milestone.request-acceptance',
    'delivery-milestone.start-milestone',
    'delivery-project.complete-delivery-project', 'delivery-project.preview-delivery-economics',
    'delivery-project.propose-change-request',
    'delivery-project.publish-economic-plan', 'delivery-project.snapshot-delivery-economics',
    'delivery-project.start-delivery-project',
    'delivery-work-package.block-work-package', 'delivery-work-package.complete-work-package',
    'delivery-work-package.plan-deliverable',
    'delivery-work-package.record-delivery-expense', 'delivery-work-package.record-delivery-time',
    'delivery-work-package.resume-work-package', 'delivery-work-package.start-work-package',
  ]);
  assert.match(schema.domains.delivery.partner.limitation, /grants NO access/i);
  assert.match(schema.domains.delivery.dates.limitation, /not a customer commitment/i);
  assert.equal(JSON.stringify(schema.domains.delivery).includes('function'), false);

  // ---- plan: read-only, and an agent may prepare it ----
  const auditBefore = app.audit.list({ limit: 1000 }).length;
  const planned = await context.agentClient.module('commercial-contract').action(contract.id, 'plan-delivery-handover', DELIVERY_POLICY);
  const plan = planned.result.plan;
  assert.deepEqual(plan.counts, { workPackages: 3, internal: 2, partner: 1, ambiguous: 0 });
  assert.equal(plan.partnerRequired, true);
  assert.deepEqual(plan.requiredInputs, ['partner']);
  assert.deepEqual(plan.milestones.map((milestone) => milestone.key), ['kickoff', 'delivery', 'go-live']);
  assert.equal(plan.datesProvenance.source, 'post-sale-delivery-planning');
  for (const workPackage of plan.workPackages) assert.ok(workPackage.reason, `${workPackage.componentKey} carries a reason`);
  for (const module of DELIVERY_MODULES) {
    assert.equal(app.modules.get(module).service.list().length, 0, `${module} untouched by planning`);
  }
  assert.equal(app.audit.list({ limit: 1000 }).length, auditBefore, 'planning writes no audit');

  // ---- an agent may not commit it ----
  await assert.rejects(
    () => context.agentClient.module('commercial-contract').action(contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  // …and a partner-delivered work package cannot be handed over without one.
  await assert.rejects(
    () => client.module('commercial-contract').action(contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, ...WINDOW }),
    (error) => error.status === 409 && error.code === 'PARTNER_REQUIRED',
  );
  assert.equal(app.modules.get('delivery-project').service.list().length, 0);

  // ---- the human handover ----
  const created = await client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, projectName: 'Acme onboarding', partner: PARTNER,
  });
  assert.equal(created.result.obligationsHandedOver, 3);
  assert.deepEqual(created.result.counts, { workPackages: 3, internal: 2, partner: 1, ambiguous: 0 });

  const projects = app.modules.get('delivery-project').service;
  const deliveryProject = projects.listWhere({ contractId: contract.id })[0];
  assert.equal(deliveryProject.sourceKey, `delivery-project:contract:${contract.id}`);
  assert.equal(deliveryProject.status, 'pending_kickoff');
  assert.equal(deliveryProject.name, 'Acme onboarding');
  assert.equal(deliveryProject.customerName, contract.customerName, 'the project carries its own customer snapshot');
  assert.equal(deliveryProject.datesSource, 'post-sale-delivery-planning');
  assert.equal(deliveryProject.planDays, 92, 'the window is inclusive');

  const workPackages = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: deliveryProject.id });
  assert.equal(workPackages.length, 3);
  const byKey = (key) => workPackages.find((row) => String(row.componentKey).endsWith(key));
  assert.equal(byKey('ent-setup').deliveryMode, 'internal');
  assert.equal(byKey('setup-fee').deliveryMode, 'internal');
  assert.equal(byKey('migration-records').deliveryMode, 'partner');
  assert.equal(byKey('migration-records').partnerRef, PARTNER.partnerRef);
  assert.equal(byKey('ent-setup').partnerRef, null, 'internal work is not attributed to the partner');
  for (const workPackage of workPackages) {
    assert.equal(workPackage.status, 'planned');
    assert.equal(workPackage.modeOverridden, false);
    assert.ok(workPackage.netAmountCents > 0, 'the commercial amount is copied from the obligation');
    assert.equal(workPackage.currency, contract.currency);
  }

  const milestones = app.modules.get('delivery-milestone').service.listWhere({ deliveryProjectId: deliveryProject.id });
  assert.deepEqual(milestones.sort((a, b) => a.position - b.position).map((row) => row.milestoneKey), ['kickoff', 'delivery', 'go-live']);
  for (const milestone of milestones) {
    assert.equal(milestone.status, 'planned');
    assert.ok(Array.isArray(JSON.parse(milestone.workPackageIdsJson)));
  }

  const engagement = app.modules.get('delivery-partner-engagement').service.listWhere({ deliveryProjectId: deliveryProject.id })[0];
  assert.equal(engagement.partnerRef, PARTNER.partnerRef);
  assert.equal(engagement.partnerNameSnapshot, PARTNER.partnerName);
  assert.equal(engagement.role, 'delivery_partner');
  assert.equal(engagement.status, 'planned');
  assert.equal(engagement.workPackageCount, 1);
  assert.equal(engagement.assignedBy, 'e2e');

  // ---- the cross-package write: obligations are handed over exactly once ----
  const obligations = app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id });
  assert.equal(obligations.length, 3);
  for (const obligation of obligations) {
    assert.equal(obligation.status, 'handed_over');
    assert.equal(obligation.handoverRef, deliveryProject.id);
  }
  // The service obligation is not Delivery's business and was never touched.
  const services = app.modules.get('service-obligation').service.listWhere({ contractId: contract.id });
  assert.equal(services.length, 1);
  assert.equal(services[0].status, 'pending_activation');

  const run = app.modules.get('delivery-handover-run').service.listWhere({ contractId: contract.id })[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.deliveryProjectId, deliveryProject.id);
  assert.equal(run.handedOverCount, 3);
  assert.equal(run.partnerRef, PARTNER.partnerRef);
  assert.match(run.policyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(run.obligationIdsJson).length, 3);

  // ---- read-only surface ----
  for (const module of DELIVERY_MODULES) {
    const definition = app.modules.get(module);
    assert.deepEqual(definition.capabilities, ['get', 'list'], module);
    assert.equal(definition.service.create, undefined, `no public create on ${module}`);
    assert.equal(definition.service.update, undefined, `no public update on ${module}`);
    for (const [method, path, body] of [
      ['POST', `/api/modules/${module}/records`, JSON.stringify({ status: 'planned' })],
      ['PATCH', `/api/modules/${module}/records/${deliveryProject.id}`, JSON.stringify({ status: 'planned' })],
      ['DELETE', `/api/modules/${module}/records/${deliveryProject.id}`, undefined],
    ]) {
      const response = await fetch(`${context.baseUrl}${path}`, {
        method, headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'e2e' }, body,
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }

  // ---- a repeat is a stable refusal, and a restart changes nothing ----
  await assert.rejects(
    () => client.module('commercial-contract').action(contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER }),
    (error) => error.code === 'HANDOVER_ALREADY_EXISTS' && error.status === 409,
  );
  assert.equal(projects.list().length, 1);
});

test('the delivery package is optional, and its dependency is declared', async (t) => {
  // 1. Contracts without Delivery: M0–M12 is untouched.
  const withoutDelivery = project(t);
  const context = await boot(withoutDelivery, join(withoutDelivery, 'data', 'no-delivery.sqlite'));
  t.after(() => context.close());
  const { contract } = await activatedContract(withoutDelivery, context.app, { name: 'No Delivery Deal', offers: DELIVERY_OFFERS });
  const schema = await context.client.request('/api/schema');
  assert.equal(schema.domains.delivery, undefined, 'no delivery package, no schema block');
  assert.equal(schema.domains.contracts.packageContract, 1, 'the contracts package is unaffected');
  await assert.rejects(
    () => context.client.module('commercial-contract').action(contract.id, 'plan-delivery-handover', DELIVERY_POLICY),
    (error) => error.status === 404,
  );
  assert.equal(
    context.app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id })[0].status,
    'pending_handover',
    'obligations simply stay pending',
  );

  // 2. Delivery without contracts: the package refuses to register at all,
  //    naming the capability it cannot get. A missing dependency is a startup
  //    failure, never a runtime surprise inside a transaction.
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const orphan = project(t, { withDomain: false, withDelivery: true });
  writeFileSync(
    join(orphan, 'packages/domains/generated/index.js'),
    [
      "import { createDeliveryPackage } from '../../delivery/src/index.js';",
      "import { b2bDeliveryHandoverV1 } from '../../../examples/starters/b2b-lead-qualification/delivery.js';",
      'export const generatedDomains = [createDeliveryPackage({ policies: [b2bDeliveryHandoverV1] })];',
      '',
    ].join('\n'),
  );
  const probe = spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { createAgentCrmApp } = await import(${JSON.stringify(pathToFileURL(join(orphan, 'packages/app/src/index.js')).href)});
    createAgentCrmApp({ dbPath: ${JSON.stringify(join(orphan, 'data', 'orphan.sqlite'))} }).close();
  `], { encoding: 'utf8', cwd: orphan });
  assert.notEqual(probe.status, 0, 'the delivery package cannot register without its dependency');
  assert.match(probe.stderr, /requires package "contracts"/);
});

test('an undeclared reach across the package boundary is refused', async (t) => {
  const { root, context } = await setup(t, 'boundary.sqlite');
  const { app } = context;
  await activatedContract(root, app, { name: 'Boundary Deal', offers: DELIVERY_OFFERS });

  // The capability exists, but only a package that DECLARED the requirement
  // may open it: the dependency graph is the truth, not a comment.
  assert.throws(
    () => app.domains.capability({ consumer: 'contracts', capability: 'delivery-obligations', version: 1, context: { modules: app.modules } }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
  );
  assert.throws(
    () => app.domains.capability({ consumer: 'delivery', capability: 'delivery-obligations', version: 2, context: { modules: app.modules } }),
    (error) => error.code === 'CAPABILITY_NOT_DECLARED',
    'a version is always explicit',
  );
  assert.throws(
    () => app.domains.capability({ consumer: 'nonexistent', capability: 'delivery-obligations', version: 1 }),
    (error) => error.status === 404,
  );

  // What the capability exposes is bounded: it hands out obligations and one
  // write, not a service, a table or a query handle.
  const capability = app.domains.capability({
    consumer: 'delivery', capability: 'delivery-obligations', version: 1, context: { modules: app.modules },
  });
  assert.deepEqual(Object.keys(capability).sort(), ['capabilityContract', 'getContract', 'listPending', 'markHandedOver']);

  // The delivery package's own source never imports contracts or kernel
  // internals — the boundary is proven statically, not asserted.
  const { readFileSync, readdirSync } = await import('node:fs');
  const files = readdirSync(join(root, 'packages/delivery/src')).map((name) => join(root, 'packages/delivery/src', name));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/from '[^']*contracts\//.test(source), false, `${file} imports the contracts package`);
    assert.equal(/from '[^']*core\/src\//.test(source), false, `${file} imports a private kernel path`);
  }
});

test('the handover is atomic, idempotent and concurrency-safe', async (t) => {
  const { root, context } = await setup(t, 'atomic.sqlite');
  const { app } = context;
  const actor = { type: 'user', id: 'e2e' };
  const input = { ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER };
  const handover = (contractId, extra = {}) => app.runAction({
    module: 'commercial-contract', action: 'create-delivery-handover', recordId: contractId,
    input: { ...input, ...extra }, actor,
  });

  // ---- fault injection after every write, including the cross-package one ----
  for (const moduleName of ['delivery-handover-run', 'delivery-project', 'delivery-work-package', 'delivery-milestone', 'delivery-partner-engagement', 'delivery-obligation']) {
    const { contract } = await activatedContract(root, app, { name: `Fault ${moduleName}`, offers: DELIVERY_OFFERS });
    const service = app.modules.get(moduleName).service;
    const isCrossPackage = moduleName === 'delivery-obligation';
    const method = isCrossPackage ? 'applyManaged' : 'createManaged';
    const real = service[method].bind(service);
    let calls = 0;
    service[method] = async (...args) => {
      const result = await real(...args);
      calls += 1;
      if (calls >= 1) throw new Error(`injected failure after ${moduleName}.${method}`);
      return result;
    };
    await assert.rejects(() => handover(contract.id), /injected failure/, moduleName);
    service[method] = real;

    // Nothing partial survives, and the source obligations stay pending. Only
    // the records the handover itself writes carry a contractId; the M14b1
    // economics evidence is written by a different action against a project
    // that does not exist yet.
    for (const module of HANDOVER_MODULES) {
      assert.equal(
        app.modules.get(module).service.listWhere({ contractId: contract.id }).length, 0,
        `${moduleName} failure: no ${module} row survives`,
      );
    }
    for (const obligation of app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id })) {
      assert.equal(obligation.status, 'pending_handover', `${moduleName} failure: obligations stay pending`);
    }
    const failed = app.workflows.listRuns({ status: 'failed', workflowName: 'commercial-contract.create-delivery-handover', limit: 50 });
    assert.ok(failed.length > 0, 'the failure is an honest failed trace');

    // The retry succeeds exactly once and produces a complete handover.
    const retried = await handover(contract.id);
    assert.equal(retried.result.obligationsHandedOver, 3, `${moduleName}: retry completes`);
    assert.equal(app.modules.get('delivery-work-package').service.listWhere({ contractId: contract.id }).length, 3);
  }

  // ---- concurrency in one app ----
  const race = await activatedContract(root, app, { name: 'Race Handover', offers: DELIVERY_OFFERS });
  const results = await Promise.allSettled([handover(race.contract.id), handover(race.contract.id)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.reason?.code ?? r.status)));
  assert.equal(app.modules.get('delivery-project').service.listWhere({ contractId: race.contract.id }).length, 1);
  assert.equal(app.modules.get('delivery-work-package').service.listWhere({ contractId: race.contract.id }).length, 3);

  // ---- concurrency across two connections ----
  const sibling = await boot(root, join(root, 'data', 'atomic.sqlite'));
  t.after(() => sibling.close());
  const two = await activatedContract(root, app, { name: 'Two Connection Handover', offers: DELIVERY_OFFERS });
  const across = await Promise.allSettled([
    handover(two.contract.id),
    sibling.app.runAction({ module: 'commercial-contract', action: 'create-delivery-handover', recordId: two.contract.id, input, actor }),
  ]);
  assert.equal(across.filter((result) => result.status === 'fulfilled').length, 1, JSON.stringify(across.map((r) => r.reason?.code ?? r.status)));
  for (const failure of across.filter((result) => result.status === 'rejected')) {
    assert.ok(!/SQLITE|UNIQUE constraint/i.test(String(failure.reason?.message ?? '')), `raw SQLite error surfaced: ${failure.reason?.message}`);
  }
  assert.equal(app.modules.get('delivery-project').service.listWhere({ contractId: two.contract.id }).length, 1);
  assert.equal(
    app.modules.get('delivery-obligation').service.listWhere({ contractId: two.contract.id }).filter((row) => row.status === 'handed_over').length,
    3,
    'obligations are handed over exactly once',
  );
});

test('ambiguity blocks the handover until a human decides it', async (t) => {
  const { root, context } = await setup(t, 'ambiguous.sqlite');
  const { app, client, agentClient } = context;
  // The API add-on has no delivery mapping in the starter policy, and the
  // contracts policy classifies it with a delivery obligation only when a
  // human says so — here it arrives as an unmapped delivery obligation.
  // Storage is ambiguous for the contracts policy; a human files it as a
  // delivery obligation, which the delivery policy in turn cannot place.
  const signed = await signedOrder(root, app, {
    name: 'Ambiguous Handover',
    offers: ['fixture:offer:setup', 'fixture:offer:storage-monthly'],
  });
  const activationPlan = (await client.module('order').action(signed.order.id, 'plan-activation', POLICY)).result.plan;
  const storage = activationPlan.components.find((component) => component.requiresOverride);
  await client.module('order').action(signed.order.id, 'activate-contract', {
    ...POLICY, ...ACTIVATION_INPUT,
    classificationOverrides: [
      { orderComponentId: storage.orderComponentId, dimension: 'commercial', value: 'non_subscription', reason: 'sold as a one-off data load' },
      { orderComponentId: storage.orderComponentId, dimension: 'obligations', value: ['delivery'], reason: 'we load the data for them' },
    ],
  });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: signed.order.id })[0];

  const plan = (await client.module('commercial-contract').action(contract.id, 'plan-delivery-handover', DELIVERY_POLICY)).result.plan;
  assert.equal(plan.counts.ambiguous, 1);
  assert.equal(plan.plannable, false);
  assert.ok(plan.requiredInputs.includes('modeOverrides'));
  const undecided = plan.workPackages.find((workPackage) => workPackage.requiresDecision);
  assert.ok(undecided.reason.includes('not mapped by this policy version'));

  await assert.rejects(
    () => client.module('commercial-contract').action(contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER }),
    (error) => error.status === 409 && error.code === 'DELIVERY_MODE_AMBIGUOUS' && error.details.obligationIds.length === 1,
  );

  // The override surface is attacked before the valid decision is accepted.
  const bad = [
    [{ obligationId: undecided.obligationId, deliveryMode: 'internal' }, /reason is required/],
    [{ obligationId: undecided.obligationId, deliveryMode: 'ambiguous', reason: 'unsure' }, /deliveryMode must be one of/],
    [{ obligationId: undecided.obligationId, deliveryMode: 'nonsense', reason: 'x' }, /deliveryMode must be one of/],
    [{ obligationId: 'not-of-this-contract', deliveryMode: 'internal', reason: 'x' }, /another contract/],
    [{ obligationId: undecided.obligationId, deliveryMode: 'internal', reason: `a${String.fromCharCode(0)}b` }, /control characters/],
    [{ obligationId: undecided.obligationId, deliveryMode: 'internal', reason: 'x'.repeat(400) }, /reason is required/],
  ];
  for (const [override, expected] of bad) {
    await assert.rejects(
      () => client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
        ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER, modeOverrides: [override],
      }),
      expected,
      JSON.stringify(override),
    );
  }
  // An agent cannot decide it either.
  await assert.rejects(
    () => agentClient.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
      ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
      modeOverrides: [{ obligationId: undecided.obligationId, deliveryMode: 'internal', reason: 'bot decided' }],
    }),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED',
  );

  // The human decision is recorded next to what the policy said.
  await client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
    modeOverrides: [{ obligationId: undecided.obligationId, deliveryMode: 'internal', reason: 'our own team loads this data' }],
  });
  const workPackage = app.modules.get('delivery-work-package').service.listWhere({ obligationId: undecided.obligationId })[0];
  assert.equal(workPackage.deliveryMode, 'internal');
  assert.equal(workPackage.policyDeliveryMode, 'ambiguous', 'the policy decision survives the override');
  assert.equal(workPackage.modeOverridden, true);
  assert.equal(workPackage.modeOverrideReason, 'our own team loads this data');
  assert.equal(workPackage.overriddenBy, 'e2e');
  assert.equal(app.modules.get('delivery-handover-run').service.listWhere({ contractId: contract.id })[0].overrideCount, 1);
});

test('handover refusals, dates and independence hold', async (t) => {
  const { root, context } = await setup(t, 'refusals.sqlite');
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };

  // A contract with no delivery obligation produces no project at all.
  const noDelivery = await activatedContract(root, app, {
    name: 'No Obligation Deal', offers: ['fixture:offer:platform-monthly'],
  });
  await assert.rejects(
    () => client.module('commercial-contract').action(noDelivery.contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, ...WINDOW }),
    (error) => error.status === 409 && error.code === 'NO_DELIVERY_OBLIGATIONS',
  );
  assert.equal(app.modules.get('delivery-project').service.listWhere({ contractId: noDelivery.contract.id }).length, 0);

  // Planning dates: real calendar dates, supplied together, inside the term.
  const { contract } = await activatedContract(root, app, { name: 'Dates Deal', offers: DELIVERY_OFFERS });
  for (const [window, expected] of [
    [{ targetStartDate: '2026-09-20' }, /supplied together/],
    [{ targetEndDate: '2026-12-20' }, /supplied together/],
    [{ targetStartDate: '2026-02-30', targetEndDate: '2026-12-20' }, /not a real calendar date/],
    [{ targetStartDate: '2026-12-20', targetEndDate: '2026-09-20' }, /cannot precede/],
    [{ targetStartDate: '2026-08-01', targetEndDate: '2026-12-20' }, /before the contract is effective/],
    [{ targetStartDate: '2026-09-20', targetEndDate: '2030-12-20' }, /after the contract term ends/],
  ]) {
    await assert.rejects(
      () => client.module('commercial-contract').action(contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, ...window, partner: PARTNER }),
      expected,
      JSON.stringify(window),
    );
  }
  // A partner supplied when nothing needs one is refused rather than stored.
  // A partner supplied when nothing needs one is refused rather than stored —
  // and the capability must answer about THIS contract, never the first row it
  // finds.
  await assert.rejects(
    () => client.module('commercial-contract').action(noDelivery.contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, partner: PARTNER }),
    (error) => error.code === 'NO_DELIVERY_OBLIGATIONS',
  );

  // The window is optional: a handover can be planned before the schedule is.
  await client.module('commercial-contract').action(contract.id, 'create-delivery-handover', { ...DELIVERY_POLICY, partner: PARTNER });
  const project = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  assert.equal(project.targetStartDate, null);
  assert.equal(project.planDays, null);

  // ---- independent readability ----
  const before = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: project.id })
    .map((row) => `${row.componentKey}|${row.netAmountCents}|${row.deliveryMode}`).sort();
  app.database.raw.prepare('UPDATE offers SET active = 0').run();
  app.database.raw.prepare('UPDATE price_components SET unit_amount_cents = 1, flat_amount_cents = 1').run();
  app.database.raw.prepare('UPDATE companies SET name = ? WHERE id = ?').run('Renamed Holding SpA', project.companyId);
  await app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'v2' }, actor });

  const restarted = await boot(root, join(root, 'data', 'refusals.sqlite'));
  t.after(() => restarted.close());
  const after = restarted.app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: project.id })
    .map((row) => `${row.componentKey}|${row.netAmountCents}|${row.deliveryMode}`).sort();
  assert.deepEqual(after, before, 'the plan does not move when the catalog does');
  assert.equal(
    restarted.app.modules.get('delivery-project').service.get(project.id).customerName,
    project.customerName,
    'the customer snapshot survives the rename',
  );
});

test('audit, events and trace are exact, and reads stay exact past the list bound', async (t) => {
  const { root, context } = await setup(t, 'evidence.sqlite');
  const { app, client } = context;
  const actor = { type: 'user', id: 'e2e' };
  const { contract } = await activatedContract(root, app, { name: 'Evidence Handover', offers: DELIVERY_OFFERS });

  const auditFor = (module) => app.audit.list({ limit: 2000 }).filter((entry) => entry.entityType === module).length;
  const before = Object.fromEntries([...DELIVERY_MODULES, 'delivery-obligation'].map((module) => [module, auditFor(module)]));

  await client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
  });

  assert.equal(auditFor('delivery-handover-run') - before['delivery-handover-run'], 2, 'one creation plus its result link');
  assert.equal(auditFor('delivery-project') - before['delivery-project'], 1);
  assert.equal(auditFor('delivery-work-package') - before['delivery-work-package'], 3);
  assert.equal(auditFor('delivery-milestone') - before['delivery-milestone'], 3);
  assert.equal(auditFor('delivery-partner-engagement') - before['delivery-partner-engagement'], 1);
  assert.equal(auditFor('delivery-obligation') - before['delivery-obligation'], 3, 'exactly the obligations handed over');

  const run = app.workflows.getRun(
    app.workflows.listRuns({ workflowName: 'commercial-contract.create-delivery-handover', status: 'completed', limit: 5 })[0].id,
  );
  const spans = run.spans.map((span) => span.name);
  assert.ok(spans.includes('commercial-contract.create-delivery-handover'));
  assert.ok(spans.includes('delivery.handover.created'));
  const traceText = JSON.stringify(run);
  assert.ok(!/\bdocumentJson\b/.test(traceText), 'no signed document in the trace');
  assert.ok(!/not-a-secret/.test(traceText), 'no provider key in the trace');

  // Exact indexed reads stay exact past the paged list bound.
  const projects = app.modules.get('delivery-project').service;
  const project = projects.listWhere({ contractId: contract.id })[0];
  for (let index = 0; index < 520; index += 1) {
    await projects.createManaged({
      sourceKey: `delivery-project:bulk:${index}`, contractId: `bulk-${index}`, orderId: `bulk-order-${index}`,
      handoverRunId: 'bulk', customerName: 'Bulk', currency: 'EUR', name: 'Bulk', status: 'pending_kickoff',
      workPackageCount: 0, milestoneCount: 0, partnerCount: 0, datesSource: 'post-sale-delivery-planning',
      policy: 'p', policyVersion: 1, plannedAt: '2026-09-15T10:00:00.000Z',
    }, { actor });
  }
  assert.equal(projects.list({ limit: 500 }).length, 500, 'the paged list is bounded');
  assert.equal(projects.listWhere({ contractId: contract.id }).length, 1, 'the exact lookup still finds it');
  assert.equal(projects.listWhere({ contractId: 'bulk-517' })[0].sourceKey, 'delivery-project:bulk:517');
  assert.equal(app.modules.get('delivery-work-package').service.countWhere({ deliveryProjectId: project.id }), 3);
  assert.equal(app.modules.get('delivery-milestone').service.countWhere({ deliveryProjectId: project.id }), 3);
  assert.equal(app.modules.get('delivery-handover-run').service.listWhere({ contractId: contract.id }).length, 1);
});

test('hostile input stays inert data across the package boundary', async (t) => {
  const { root, context } = await setup(t, 'hostile.sqlite');
  const { app, client } = context;
  const { contract } = await activatedContract(root, app, { name: 'Hostile Handover', offers: DELIVERY_OFFERS });

  const nasty = '<img src=x onerror=alert(1)>${7*7}`;-- \' or 1=1';
  await client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, projectName: nasty,
    partner: { partnerRef: 'partner:abc', partnerName: nasty, reason: nasty },
  });
  const project = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  assert.equal(project.name, nasty, 'stored verbatim as text, never interpreted');
  const engagement = app.modules.get('delivery-partner-engagement').service.listWhere({ deliveryProjectId: project.id })[0];
  assert.equal(engagement.partnerNameSnapshot, nasty);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  // Prototype-shaped policy names and unknown versions resolve to nothing.
  const other = await activatedContract(root, app, { name: 'Hostile Policy Handover', offers: DELIVERY_OFFERS });
  for (const policy of ['__proto__', 'constructor', 'toString', 'unknown-policy']) {
    await assert.rejects(
      () => client.module('commercial-contract').action(other.contract.id, 'plan-delivery-handover', { policy, policyVersion: 1 }),
      (error) => error.status === 404 && error.code === 'NOT_FOUND',
      policy,
    );
  }
  // A NUL byte in a partner name would be truncated by storage, so it is refused.
  for (const suffix of [String.fromCharCode(0), String.fromCharCode(27)]) {
    await assert.rejects(
      () => client.module('commercial-contract').action(other.contract.id, 'create-delivery-handover', {
        ...DELIVERY_POLICY, ...WINDOW,
        partner: { partnerRef: 'partner:abc', partnerName: `ABC${suffix}tail` },
      }),
      (error) => error.status === 400,
      `control character ${suffix.charCodeAt(0)}`,
    );
  }
  assert.equal(app.modules.get('delivery-project').service.listWhere({ contractId: other.contract.id }).length, 0);

  // Errors never leak SQL, a stack or a path.
  const response = await fetch(`${context.baseUrl}/api/modules/commercial-contract/records/${other.contract.id}/actions/create-delivery-handover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'e2e' },
    body: JSON.stringify({ ...DELIVERY_POLICY, targetStartDate: '2026-02-30', targetEndDate: '2026-12-20', partner: PARTNER }),
  });
  assert.equal(response.status, 400);
  const body = JSON.stringify(await response.json());
  assert.ok(body.includes('not a real calendar date'));
  assert.ok(!/SELECT |INSERT |\/home\/|at Object\./.test(body), body);
});
