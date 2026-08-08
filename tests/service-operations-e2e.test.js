import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Milestone 15 — the paths a reader has to be able to walk: a contract's
 * pending service obligations become an operational coverage with entitlements,
 * a case is recorded against one, it is answered, moved, evaluated, escalated,
 * resolved and closed — and nothing commercial moves the entire time.
 */

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const ACTOR = { type: 'user', id: 'e2e' };

async function serviceProject(t, file) {
  const root = project(t, { withService: true });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { contract } = await activatedContract(root, context.app, { name: 'Service', offers: OFFERS });
  return { root, context, contract };
}

/** Every commercial row, as bytes, so "nothing was amended" is proved not argued. */
const COMMERCIAL = ['quote', 'quote-version', 'order', 'order-line', 'order-component',
  'commercial-contract', 'contract-version', 'contract-line', 'subscription', 'subscription-line'];
const commercialFingerprint = (app) =>
  JSON.stringify(COMMERCIAL.map((module) => app.modules.get(module).service.list({ limit: 500 })));

test('planning writes nothing at all', async (t) => {
  const { context, contract } = await serviceProject(t, 'plan.sqlite');
  const { app, client, agentClient } = context;

  const before = commercialFingerprint(app);
  const auditBefore = app.audit.list({}).length;
  const planned = await client.module('commercial-contract').action(contract.id, 'plan-service-activation', {});

  assert.equal(planned.result.plan.decidable, true, 'the default policy knows this contract\'s support component');
  assert.equal(planned.result.plan.entitlements.length, 1);
  assert.equal(planned.result.plan.entitlements[0].supportTier, 'standard');
  assert.deepEqual(planned.result.plan.ambiguous, []);
  assert.match(planned.result.plan.policyFingerprint, /^[0-9a-f]{64}$/);

  // The stricter policy cannot decide the same obligation, and says so rather
  // than defaulting: a plan that hides an ambiguity is worse than one that
  // states it.
  const strict = await client.module('commercial-contract').action(contract.id, 'plan-service-activation', {
    policy: 'b2b-service-activation-premium-only',
  });
  assert.equal(strict.result.plan.decidable, false);
  assert.equal(strict.result.plan.ambiguous.length, 1);
  assert.match(strict.result.plan.ambiguous[0].reason, /covers premium support only/);
  assert.notEqual(strict.result.plan.policyFingerprint, planned.result.plan.policyFingerprint,
    'two policies are two fingerprints');

  for (const module of ['service-coverage', 'service-entitlement', 'service-activation-run',
    'support-case', 'support-case-activity', 'service-sla-evaluation', 'service-escalation']) {
    assert.equal(app.modules.get(module).service.list().length, 0, `${module}: planning wrote nothing`);
  }
  assert.equal(app.audit.list({}).length, auditBefore, 'planning wrote no audit row');
  assert.equal(commercialFingerprint(app), before, 'and moved no commercial row');

  // An agent may plan: reading what a human would decide changes nothing.
  const byAgent = await agentClient.module('commercial-contract').action(contract.id, 'plan-service-activation', {});
  assert.deepEqual(byAgent.result.plan.obligationIds, planned.result.plan.obligationIds);
  assert.equal(app.modules.get('service-coverage').service.list().length, 0);
});

test('a human activates service coverage; an agent cannot', async (t) => {
  const { context, contract } = await serviceProject(t, 'activate.sqlite');
  const { app, client, agentClient } = context;
  const before = commercialFingerprint(app);

  const pending = app.modules.get('service-obligation').service
    .listWhere({ contractId: contract.id, status: 'pending_activation' });
  assert.equal(pending.length, 1, 'the fixture contract raises exactly one service obligation');

  // Ambiguity refuses rather than guesses — proved with the strict policy.
  await assert.rejects(
    () => client.module('commercial-contract').action(contract.id, 'activate-service', {
      coverageKey: 'go', customerRef: 'customer:acme', startDate: '2026-09-01',
      policy: 'b2b-service-activation-premium-only',
    }),
    (error) => error.status === 409 && error.code === 'SERVICE_ACTIVATION_AMBIGUOUS'
      && error.details.ambiguous.includes(pending[0].id),
    'an obligation the policy cannot decide is never silently defaulted',
  );
  assert.equal(app.modules.get('service-coverage').service.list().length, 0, 'and that refusal wrote nothing');

  // A human override with a stated reason resolves it under the same policy.
  const overrides = [{
    serviceObligationId: pending[0].id,
    supportTier: 'standard',
    categories: ['bug', 'how-to'],
    priorities: ['normal', 'high'],
    firstResponseTargetMinutes: 480,
    resolutionTargetMinutes: 2880,
    reason: 'annual support is sold at the standard tier even under the premium-only policy',
  }];
  const overridden = await client.module('commercial-contract').action(contract.id, 'plan-service-activation', {
    policy: 'b2b-service-activation-premium-only', overrides,
  });
  assert.equal(overridden.result.plan.decidable, true);
  assert.equal(overridden.result.plan.entitlements[0].decidedBy, 'human-override');

  await assert.rejects(
    () => agentClient.module('commercial-contract').action(contract.id, 'activate-service', {
      coverageKey: 'go', customerRef: 'customer:acme', startDate: '2026-09-01',
    }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
    'an agent does not activate service',
  );
  assert.equal(app.modules.get('service-coverage').service.list().length, 0, 'and the refusal wrote nothing');

  const activated = await client.module('commercial-contract').action(contract.id, 'activate-service', {
    coverageKey: 'go', customerRef: 'customer:acme', startDate: '2026-09-01',
  });
  const coverage = activated.result.serviceCoverage;
  assert.equal(coverage.status, 'active');
  assert.equal(activated.result.amendedCommercialRecord, false);
  assert.equal(activated.result.entitlements.length, pending.length);
  assert.equal(coverage.entitlementCount, pending.length);
  assert.match(coverage.policyFingerprint, /^[0-9a-f]{64}$/);

  // The obligations are consumed through the capability, in the same transaction.
  assert.equal(app.modules.get('service-obligation').service
    .listWhere({ contractId: contract.id, status: 'pending_activation' }).length, 0);
  for (const row of app.modules.get('service-obligation').service.listWhere({ contractId: contract.id })) {
    assert.equal(row.status, 'activated');
    assert.equal(row.coverageRef, coverage.id);
  }

  // One activation run records what was consumed, under which policy.
  const runs = app.modules.get('service-activation-run').service.listWhere({ serviceCoverageId: coverage.id });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].overrideCount, 0, 'the default policy decided it, so no human override was needed');
  assert.equal(runs[0].obligationCount, pending.length);
  assert.equal(runs[0].policyName, 'b2b-service-activation');

  assert.equal(commercialFingerprint(app), before,
    'not one commercial row moved: no Contract, Version, Line or Subscription was altered');

  // A second activation is refused, and a repeat with the same key is idempotent.
  await assert.rejects(
    () => client.module('commercial-contract').action(contract.id, 'activate-service', {
      coverageKey: 'second', customerRef: 'customer:acme', startDate: '2026-09-01',
    }),
    (error) => error.code === 'SERVICE_NOTHING_TO_ACTIVATE',
    'the obligations are gone, so there is nothing left to activate',
  );
  const repeat = await client.module('commercial-contract').action(contract.id, 'activate-service', {
    coverageKey: 'go', customerRef: 'customer:acme', startDate: '2026-09-01',
  });
  assert.equal(repeat.result.created, false);
  assert.equal(repeat.result.serviceCoverage.id, coverage.id);
  assert.equal(app.modules.get('service-coverage').service.list().length, 1);
});

test('a support case is recorded, answered, moved, evaluated, escalated and closed', async (t) => {
  const { context, contract } = await serviceProject(t, 'case.sqlite');
  const { app, client, agentClient } = context;
  const before = commercialFingerprint(app);
  const { entitlement } = await activateCoverage(client, app, contract);

  const opened = await client.module('service-entitlement').action(entitlement.id, 'record-service-case', {
    caseKey: 'c-1', title: 'Sync fails after upgrade', description: 'It stopped last night.',
    category: 'bug', priority: 'high', customerContactRef: 'contact:jane',
  });
  const supportCase = opened.result.supportCase;
  assert.equal(supportCase.status, 'new');
  assert.equal(opened.result.customerAuthenticated, false);
  // The two elapsed-time targets, computed from the injected clock.
  assert.equal(Date.parse(supportCase.firstResponseDueAt) - Date.parse(supportCase.openedAt),
    entitlement.firstResponseTargetMinutes * 60_000);
  assert.equal(Date.parse(supportCase.resolutionDueAt) - Date.parse(supportCase.openedAt),
    entitlement.resolutionTargetMinutes * 60_000);

  // An agent may look and may not touch.
  const preview = await agentClient.module('support-case').action(supportCase.id, 'preview-sla', {});
  assert.equal(preview.result.persisted, false);
  assert.ok(['on_track', 'at_risk', 'breached'].includes(preview.result.slaPreview.firstResponseState));
  await assert.rejects(
    () => agentClient.module('support-case').action(supportCase.id, 'record-first-response', {}),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );

  const responded = await client.module('support-case').action(supportCase.id, 'record-first-response', {
    note: 'Acknowledged; reproducing now.',
  });
  assert.equal(responded.result.supportCase.status, 'in_progress');
  assert.ok(responded.result.supportCase.firstRespondedAt);
  assert.equal(responded.result.sent, false);

  // A first response has one moment.
  await assert.rejects(
    () => client.module('support-case').action(supportCase.id, 'record-first-response', {}),
    (error) => error.status === 409,
    'a first response is stamped exactly once',
  );

  await client.module('support-case').action(supportCase.id, 'record-case-activity', {
    activityKey: 'a-1', type: 'customer_reply', body: 'They sent a log excerpt.', visibility: 'internal',
  });
  await client.module('support-case').action(supportCase.id, 'transition-case', {
    toStatus: 'waiting_customer', note: 'Asked for the full log.',
  });
  await client.module('support-case').action(supportCase.id, 'transition-case', {
    toStatus: 'in_progress', note: 'Log received.',
  });

  const evaluated = await client.module('support-case').action(supportCase.id, 'record-sla-evaluation', {
    evaluationKey: 'e-1',
  });
  assert.equal(evaluated.result.contractualBreach, false);
  assert.match(evaluated.result.slaEvaluation.basis, /no business hours/);
  assert.ok(SLA_VALUES.includes(evaluated.result.slaEvaluation.firstResponseState));

  const escalated = await client.module('support-case').action(supportCase.id, 'record-escalation', {
    escalationKey: 'x-1', level: 'management', reason: 'the customer asked for a call',
    targetRef: 'team:support-leads', slaEvaluationId: evaluated.result.slaEvaluation.id,
  });
  assert.equal(escalated.result.routed, false);
  assert.equal(escalated.result.notified, false);

  await assert.rejects(
    () => client.module('support-case').action(supportCase.id, 'transition-case', { toStatus: 'closed' }),
    (error) => error.code === 'SERVICE_TRANSITION_NOT_ALLOWED',
    'a case closes from resolved, never straight from in_progress',
  );
  const resolved = await client.module('support-case').action(supportCase.id, 'transition-case', {
    toStatus: 'resolved', resolutionSummary: 'A schema migration was missing; applied and verified.',
  });
  assert.ok(resolved.result.supportCase.resolvedAt);
  assert.equal(resolved.result.customerAccepted, false, 'resolved is not customer acceptance');
  assert.equal(resolved.result.billed, false);

  const closed = await client.module('support-case').action(supportCase.id, 'transition-case', { toStatus: 'closed' });
  assert.equal(closed.result.supportCase.status, 'closed');
  await assert.rejects(
    () => client.module('support-case').action(supportCase.id, 'transition-case', { toStatus: 'in_progress' }),
    (error) => error.status === 409,
    'closed is terminal',
  );

  // Every activity is append-only evidence, and the transitions are in it.
  const activity = app.modules.get('support-case-activity').service.listWhere({ supportCaseId: supportCase.id });
  assert.ok(activity.length >= 6);
  assert.equal(activity.filter((row) => row.type === 'transition').length, 4);
  assert.equal(activity.filter((row) => row.type === 'escalation').length, 1);

  assert.equal(commercialFingerprint(app), before, 'and the commercial record never moved');
});

const SLA_VALUES = ['met', 'on_track', 'at_risk', 'breached', 'not_applicable'];

test('entitlement enforcement is server-side, not a UI filter', async (t) => {
  const { context, contract } = await serviceProject(t, 'enforce.sqlite');
  const { app, client } = context;
  const { coverage, entitlement } = await activateCoverage(client, app, contract);

  for (const [what, input, code] of [
    ['an uncovered category', { caseKey: 'x1', title: 't', category: 'billing', priority: 'normal' }, 'SERVICE_CATEGORY_NOT_COVERED'],
    ['an uncovered priority', { caseKey: 'x2', title: 't', category: 'bug', priority: 'urgent' }, 'SERVICE_PRIORITY_NOT_COVERED'],
    ['an unknown priority value', { caseKey: 'x3', title: 't', category: 'bug', priority: 'critical' }, 'VALIDATION_ERROR'],
  ]) {
    await assert.rejects(
      () => client.module('service-entitlement').action(entitlement.id, 'record-service-case', input),
      (error) => error.code === code, `${what} is refused with ${code}`,
    );
  }
  assert.equal(app.modules.get('support-case').service.list().length, 0, 'and no refusal wrote a case');

  // A case cannot be recorded against an entitlement whose coverage has ended.
  await client.module('service-coverage').action(coverage.id, 'end-service-coverage', {
    reason: 'the customer did not renew support',
  });
  await assert.rejects(
    () => client.module('service-entitlement').action(entitlement.id, 'record-service-case', {
      caseKey: 'x4', title: 't', category: 'bug', priority: 'normal',
    }),
    (error) => error.code === 'SERVICE_STATE_NOT_ALLOWED',
    'an ended coverage takes no new cases',
  );
});

test('the open-case limit is exact, and exceeding it bills nothing', async (t) => {
  const { context, contract } = await serviceProject(t, 'limit.sqlite');
  const { app, client } = context;
  const { entitlement } = await activateCoverage(client, app, contract);
  const limit = entitlement.maxOpenCases;
  assert.ok(limit >= 1, 'the fixture entitlement declares a limit');

  const opened = [];
  for (let index = 0; index < limit; index += 1) {
    const created = await client.module('service-entitlement').action(entitlement.id, 'record-service-case', {
      caseKey: `l-${index}`, title: `Case ${index}`, category: 'bug', priority: 'normal',
    });
    opened.push(created.result.supportCase);
  }
  await assert.rejects(
    () => client.module('service-entitlement').action(entitlement.id, 'record-service-case', {
      caseKey: 'over', title: 'One too many', category: 'bug', priority: 'normal',
    }),
    (error) => error.code === 'SERVICE_OPEN_CASE_LIMIT_REACHED' && error.details.limit === limit,
    'the limit is enforced server-side, and the case is refused rather than charged for',
  );
  assert.equal(app.modules.get('support-case').service.countWhere({ serviceEntitlementId: entitlement.id }), limit);

  // Closing one frees a slot: the limit counts open cases, not lifetime cases.
  await client.module('support-case').action(opened[0].id, 'transition-case', {
    toStatus: 'resolved', resolutionSummary: 'done',
  });
  await client.module('support-case').action(opened[0].id, 'transition-case', { toStatus: 'closed' });
  const after = await client.module('service-entitlement').action(entitlement.id, 'record-service-case', {
    caseKey: 'after', title: 'Fits now', category: 'bug', priority: 'normal',
  });
  assert.equal(after.result.created, true);
});

test('the package is optional, and its dependency is declared', async (t) => {
  const withoutService = project(t, { withDelivery: false });
  const context = await boot(withoutService, join(withoutService, 'data', 'absent.sqlite'));
  t.after(() => context.close());
  const schema = await context.client.request('/api/schema');
  assert.equal(schema.domains.service, undefined, 'no package, no service block');
  for (const module of ['service-coverage', 'support-case']) {
    assert.throws(() => context.app.modules.get(module), /Module not found/);
  }

  const withService = project(t, { withService: true });
  const second = await boot(withService, join(withService, 'data', 'present.sqlite'));
  t.after(() => second.close());
  const full = await second.client.request('/api/schema');
  assert.equal(full.domains.service.packageContract, 1);
  assert.deepEqual(full.domains.service.requires, [
    { package: 'contracts', capability: 'service-obligations', version: 1 },
  ]);
  assert.deepEqual(full.domains.service.provides.map((entry) => `${entry.name}@${entry.version}`).sort(),
    ['service-case-management@1', 'service-coverage@1', 'service-sla-evidence@1']);
  assert.equal(full.domains.service.serviceContract, 1);
  assert.match(full.domains.service.coverageMeaning, /not a signed agreement/);
  assert.match(full.domains.service.slaBasis, /no business-hours calendar/);
});

/** Activate the recurring-support obligation and return its entitlement. */
async function activateCoverage(client, app, contract) {
  const pending = app.modules.get('service-obligation').service
    .listWhere({ contractId: contract.id, status: 'pending_activation' });
  assert.ok(pending.length >= 1);
  const activated = await client.module('commercial-contract').action(contract.id, 'activate-service', {
    coverageKey: 'main', customerRef: 'customer:acme', startDate: '2026-09-01',
  });
  const coverage = activated.result.serviceCoverage;
  const entitlement = activated.result.entitlements
    .find((row) => row.supportTier === 'standard' && JSON.parse(row.categories).includes('bug'));
  assert.ok(entitlement, 'the recurring support obligation produced a standard-tier entitlement');
  return { coverage, entitlement };
}
