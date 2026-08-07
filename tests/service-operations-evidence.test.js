import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Milestone 15 evidence battery: the properties a reader has to be able to rely
 * on, proved rather than argued.
 *
 * Fault injection after every business write · two connections racing every
 * decision · exact reads past the display bound · exact audit, event and trace
 * counts · the SLA arithmetic at its exact boundaries · hostile input.
 */

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const ACTOR = { type: 'user', id: 'e2e' };
const SERVICE_MODULES = [
  'service-coverage', 'service-entitlement', 'service-activation-run',
  'support-case', 'support-case-activity', 'service-sla-evaluation', 'service-escalation',
];

/**
 * One composed root for the file, a fresh database per test. Building the root
 * copies the repository and applies fifty-odd manifests through the real CLI;
 * every test here needs its own data, not its own copy of the framework.
 */
let sharedRoot = null;
after(() => { if (sharedRoot) rmSync(sharedRoot, { recursive: true, force: true }); });
function composedRoot() {
  if (!sharedRoot) sharedRoot = project({ after: () => {} }, { withService: true });
  return sharedRoot;
}

async function covered(t, file) {
  const root = composedRoot();
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { contract } = await activatedContract(root, context.app, { name: 'Evidence', offers: OFFERS });
  const activated = await context.client.module('commercial-contract').action(contract.id, 'activate-service', {
    coverageKey: 'main', customerRef: 'customer:acme', startDate: '2026-09-01',
  });
  return {
    root, context, contract,
    coverage: activated.result.serviceCoverage,
    entitlement: activated.result.entitlements[0],
  };
}

const openCase = (client, entitlementId, key, over = {}) =>
  client.module('service-entitlement').action(entitlementId, 'record-service-case', {
    caseKey: key, title: `Case ${key}`, category: 'bug', priority: 'normal', ...over,
  });

test('every business write rolls back completely when it fails', async (t) => {
  const { context, contract } = await covered(t, 'fault.sqlite');
  const { app, client } = context;
  const entitlement = app.modules.get('service-entitlement').service.list()[0];

  const cases = [
    ['support-case', 'createManaged', {
      module: 'service-entitlement', action: 'record-service-case', recordId: entitlement.id, actor: ACTOR,
      input: { caseKey: 'f1', title: 't', category: 'bug', priority: 'normal' },
    }],
  ];
  for (const [moduleName, method, request] of cases) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => { await real(...args); throw new Error('injected failure'); };
    const auditBefore = app.audit.list({ entityType: moduleName }).length;
    await assert.rejects(() => app.runAction(request), /injected failure/);
    service[method] = real;
    assert.equal(app.modules.get(moduleName).service.list().length, 0, `${moduleName}: nothing survives`);
    assert.equal(app.audit.list({ entityType: moduleName }).length, auditBefore,
      `${moduleName}: no audit row claims a success that did not happen`);
    await app.runAction(request);
    assert.equal(app.modules.get(moduleName).service.list().length, 1, 'the retry produced exactly one');
  }

  const supportCase = app.modules.get('support-case').service.list()[0];

  // The multi-write actions, injected at each of their writes in turn.
  for (const [moduleName, method, request, check] of [
    ['support-case-activity', 'createManaged', {
      module: 'support-case', action: 'record-first-response', recordId: supportCase.id, actor: ACTOR, input: {},
    }, () => assert.equal(app.modules.get('support-case').service.get(supportCase.id).firstRespondedAt, null,
      'a failed first response leaves the case unanswered')],
    ['support-case', 'applyManaged', {
      module: 'support-case', action: 'record-first-response', recordId: supportCase.id, actor: ACTOR, input: {},
    }, () => assert.equal(app.modules.get('support-case-activity').service.list().length, 0,
      'and writes no orphan activity')],
    ['service-escalation', 'createManaged', {
      module: 'support-case', action: 'record-escalation', recordId: supportCase.id, actor: ACTOR,
      input: { escalationKey: 'x', level: 'management', reason: 'r' },
    }, () => assert.equal(app.modules.get('service-escalation').service.list().length, 0, 'no orphan escalation')],
    ['service-sla-evaluation', 'createManaged', {
      module: 'support-case', action: 'record-sla-evaluation', recordId: supportCase.id, actor: ACTOR,
      input: { evaluationKey: 'e' },
    }, () => assert.equal(app.modules.get('service-sla-evaluation').service.list().length, 0, 'no orphan evaluation')],
  ]) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => { await real(...args); throw new Error('injected failure'); };
    await assert.rejects(() => app.runAction(request), /injected failure/, `${moduleName}.${method}`);
    service[method] = real;
    check();
  }

  // Activation is the widest: coverage, entitlements, the capability write and
  // the run, all in one transaction.
  const second = await activatedContract(context.root ?? composedRoot(), app, { name: 'Fault2', offers: OFFERS });
  for (const [moduleName, method] of [
    ['service-coverage', 'createManaged'], ['service-entitlement', 'createManaged'],
    ['service-activation-run', 'createManaged'], ['service-obligation', 'applyManaged'],
  ]) {
    const service = app.modules.get(moduleName).service;
    const real = service[method].bind(service);
    service[method] = async (...args) => { await real(...args); throw new Error('injected failure'); };
    await assert.rejects(() => app.runAction({
      module: 'commercial-contract', action: 'activate-service', recordId: second.contract.id, actor: ACTOR,
      input: { coverageKey: 'f', customerRef: 'c', startDate: '2026-09-01' },
    }), /injected failure/, `${moduleName}.${method}`);
    service[method] = real;
    assert.equal(app.modules.get('service-coverage').service.countWhere({ contractId: second.contract.id }), 0,
      `${moduleName}.${method}: no orphan coverage`);
    assert.equal(app.modules.get('service-obligation').service
      .listWhere({ contractId: second.contract.id, status: 'activated' }).length, 0,
      `${moduleName}.${method}: the obligation was not consumed by a failed activation`);
  }
  const recovered = await client.module('commercial-contract').action(second.contract.id, 'activate-service', {
    coverageKey: 'f', customerRef: 'c', startDate: '2026-09-01',
  });
  assert.equal(recovered.result.created, true, 'and the retry activates exactly once');
});

test('two connections racing every decision produce exactly one winner', async (t) => {
  const { root, context, coverage, entitlement } = await covered(t, 'race.sqlite');
  const { app, client } = context;
  const { createAgentCrmApp } = await import(`file://${join(root, 'packages/app/src/index.js')}`);
  // A short busy timeout: the loser must not be *waited out* to prove the point,
  // and the outcome is identical at 5000ms and 250ms — a typed 409 either way.
  const second = createAgentCrmApp({
    dbPath: app.database.path, busyTimeoutMs: 250, clock: () => '2026-09-15T10:00:00.000Z',
  });
  t.after(() => second.close());

  const settle = (promise) => promise.then(() => 'ok', (error) => {
    assert.equal(/SQLITE_|database is locked|constraint failed/i.test(String(error?.message)), false,
      `a raw SQLite error reached the caller — "${error?.message}"`);
    assert.ok(Number.isInteger(error?.status), 'the loser gets a typed error');
    return `refused ${error.code}`;
  });

  // 1. The same case key from both connections.
  const request = {
    module: 'service-entitlement', action: 'record-service-case', recordId: entitlement.id, actor: ACTOR,
    input: { caseKey: 'r1', title: 't', category: 'bug', priority: 'normal' },
  };
  await Promise.all([settle(app.runAction(request)), settle(second.runAction(request))]);
  assert.equal(app.modules.get('support-case').service.countWhere({ serviceEntitlementId: entitlement.id }), 1,
    'exactly one case exists');

  // 2. Two connections stamping the first response at once.
  const supportCase = app.modules.get('support-case').service.list()[0];
  const responses = await Promise.allSettled([
    app.runAction({ module: 'support-case', action: 'record-first-response', recordId: supportCase.id, actor: ACTOR, input: {} }),
    second.runAction({ module: 'support-case', action: 'record-first-response', recordId: supportCase.id, actor: ACTOR, input: {} }),
  ]);
  assert.equal(responses.filter((outcome) => outcome.status === 'fulfilled').length, 1,
    'a first response has exactly one moment');

  // 3. Two connections moving the same case at once.
  const moves = await Promise.allSettled([
    app.runAction({ module: 'support-case', action: 'transition-case', recordId: supportCase.id, actor: ACTOR, input: { toStatus: 'waiting_customer' } }),
    second.runAction({ module: 'support-case', action: 'transition-case', recordId: supportCase.id, actor: ACTOR, input: { toStatus: 'resolved', resolutionSummary: 'done' } }),
  ]);
  assert.equal(moves.filter((outcome) => outcome.status === 'fulfilled').length, 1, 'one move won');

  // 4. Two connections racing the last open-case slot.
  const limited = app.modules.get('service-entitlement').service.get(entitlement.id);
  const open = () => app.modules.get('support-case').service
    .listWhere({ serviceEntitlementId: entitlement.id }).filter((row) => row.status !== 'closed').length;
  while (open() < limited.maxOpenCases - 1) {
    await openCase(client, entitlement.id, `fill-${open()}`);
  }
  const lastSlot = await Promise.allSettled([
    app.runAction({ module: 'service-entitlement', action: 'record-service-case', recordId: entitlement.id, actor: ACTOR, input: { caseKey: 'slot-a', title: 'a', category: 'bug', priority: 'normal' } }),
    second.runAction({ module: 'service-entitlement', action: 'record-service-case', recordId: entitlement.id, actor: ACTOR, input: { caseKey: 'slot-b', title: 'b', category: 'bug', priority: 'normal' } }),
  ]);
  assert.equal(lastSlot.filter((outcome) => outcome.status === 'fulfilled').length, 1,
    'the last slot is taken once — a limit that both connections could pass is not a limit');
  assert.equal(open(), limited.maxOpenCases);

  // 5. Two connections ending the coverage at once.
  const ends = await Promise.allSettled([
    app.runAction({ module: 'service-coverage', action: 'end-service-coverage', recordId: coverage.id, actor: ACTOR, input: { reason: 'a' } }),
    second.runAction({ module: 'service-coverage', action: 'end-service-coverage', recordId: coverage.id, actor: ACTOR, input: { reason: 'b' } }),
  ]);
  assert.equal(ends.filter((outcome) => outcome.status === 'fulfilled').length, 1, 'a coverage ends once');
});

test('exact reads stay exact past the display bound', async (t) => {
  const { context, coverage, entitlement } = await covered(t, 'bulk.sqlite');
  const { app, client } = context;

  // The open-case limit would stop us at ten, so this entitlement's cases are
  // resolved as they are created: the scale being proved is the *read*, not the
  // limit, and the limit has its own test.
  for (let index = 0; index < 520; index += 1) {
    const created = await app.runAction({
      module: 'service-entitlement', action: 'record-service-case', recordId: entitlement.id, actor: ACTOR,
      input: { caseKey: `bulk-${index}`, title: `Case ${index}`, category: 'bug', priority: 'normal' },
    });
    await app.runAction({
      module: 'support-case', action: 'transition-case', recordId: created.result.supportCase.id, actor: ACTOR,
      input: { toStatus: 'resolved', resolutionSummary: 'bulk' },
    });
    await app.runAction({
      module: 'support-case', action: 'transition-case', recordId: created.result.supportCase.id, actor: ACTOR,
      input: { toStatus: 'closed' },
    });
  }
  const cases = app.modules.get('support-case').service;
  assert.equal(cases.countWhere({ serviceCoverageId: coverage.id }), 520, 'the exact count is exact');
  assert.equal(cases.listWhere({ serviceCoverageId: coverage.id }).length, 520, 'and the exact read is complete');
  assert.equal(cases.list().length, 100, 'while the paged list is a display bound, unchanged');
  assert.equal(cases.list({ limit: 500 }).length, 500, 'capped where it always was');

  // The 520th is found by its key, past every page bound.
  const last = cases.listWhere({ sourceKey: `support-case:${entitlement.id}:bulk-519` });
  assert.equal(last.length, 1, 'the 520th row is found by exact key, not by paging to it');

  // And the correctness path proves it: a divergent retry on row 519 is refused
  // even though that row is far outside any page.
  await assert.rejects(
    () => openCase(client, entitlement.id, 'bulk-519', { title: 'Different' }),
    (error) => error.code === 'SERVICE_EVIDENCE_CONFLICT',
    'idempotency does not degrade past the page bound',
  );

  // The open-case limit counts the exact open set, not a page of it: 520 closed
  // cases must not make the eleventh open one look like the 521st.
  const fresh = await openCase(client, entitlement.id, 'after-bulk');
  assert.equal(fresh.result.created, true, 'closed cases do not consume the limit');

  // Activity is append-only and read exactly too.
  assert.ok(app.modules.get('support-case-activity').service
    .countWhere({ serviceCoverageId: coverage.id }) >= 1040, 'two transitions per case, at least');
});

test('SLA arithmetic is exact at its boundaries, and claims nothing more', async (t) => {
  const { context, entitlement } = await covered(t, 'sla.sqlite');
  const { app } = context;
  const { evaluateSla } = await import('../packages/service/src/index.js');

  const opened = '2026-09-15T10:00:00.000Z';
  const base = {
    openedAt: opened,
    firstResponseDueAt: '2026-09-15T14:00:00.000Z',
    resolutionDueAt: '2026-09-17T10:00:00.000Z',
    firstRespondedAt: null, resolvedAt: null, closedAt: null,
  };
  // The window is four hours; at_risk begins at the last quarter of it.
  assert.equal(evaluateSla(base, '2026-09-15T10:00:00.000Z').firstResponseState, 'on_track');
  assert.equal(evaluateSla(base, '2026-09-15T12:59:59.000Z').firstResponseState, 'on_track');
  assert.equal(evaluateSla(base, '2026-09-15T13:00:00.000Z').firstResponseState, 'at_risk',
    'exactly one quarter of the window left is at risk');
  assert.equal(evaluateSla(base, '2026-09-15T13:59:59.000Z').firstResponseState, 'at_risk');
  assert.equal(evaluateSla(base, '2026-09-15T14:00:00.000Z').firstResponseState, 'at_risk',
    'exactly at the target is not yet a breach');
  assert.equal(evaluateSla(base, '2026-09-15T14:00:00.001Z').firstResponseState, 'breached',
    'one millisecond past it is');

  // Answered before the target is met; answered after it is breached, forever.
  assert.equal(evaluateSla({ ...base, firstRespondedAt: '2026-09-15T13:59:00.000Z' }, '2026-09-20T00:00:00.000Z').firstResponseState, 'met');
  assert.equal(evaluateSla({ ...base, firstRespondedAt: '2026-09-15T14:00:01.000Z' }, '2026-09-15T14:00:02.000Z').firstResponseState, 'breached');

  // No target is not_applicable, never "met" and never "breached".
  assert.equal(evaluateSla({ ...base, firstResponseDueAt: null }, opened).firstResponseState, 'not_applicable');

  // waiting_customer does NOT stop the clock, and the basis says so.
  const waiting = evaluateSla({ ...base, status: 'waiting_customer' }, '2026-09-15T14:30:00.000Z');
  assert.equal(waiting.firstResponseState, 'breached',
    'the clock does not pause: a half-implemented pause understates a breach');
  assert.match(waiting.basis, /no paused clock/);
  assert.match(waiting.basis, /no contractual SLA interpretation/);

  // A recorded evaluation stores the inputs it used, so it can never be read as
  // current truth.
  const opened2 = await app.runAction({
    module: 'service-entitlement', action: 'record-service-case', recordId: entitlement.id, actor: ACTOR,
    input: { caseKey: 's1', title: 't', category: 'bug', priority: 'normal' },
  });
  const recorded = await app.runAction({
    module: 'support-case', action: 'record-sla-evaluation', recordId: opened2.result.supportCase.id,
    actor: ACTOR, input: { evaluationKey: 'e1' },
  });
  const evaluation = recorded.result.slaEvaluation;
  assert.equal(evaluation.openedAt, opened2.result.supportCase.openedAt);
  assert.equal(evaluation.firstResponseDueAt, opened2.result.supportCase.firstResponseDueAt);
  assert.ok(evaluation.evaluatedAt);
  assert.match(evaluation.basis, /elapsed wall-clock minutes/);
});

test('audit, event and trace counts are exact, and no forbidden claim is published', async (t) => {
  const { context, entitlement } = await covered(t, 'counts.sqlite');
  const { app, client } = context;

  const emitted = [];
  for (const module of SERVICE_MODULES) {
    for (const suffix of ['created', 'updated']) {
      app.events.subscribe(`${module}.${suffix}`, () => emitted.push(`${module}.${suffix}`));
    }
  }
  // The kernel writes an action-level span per run; the business steps this
  // milestone declares are the `service.*` ones, and those are what is counted.
  const steps = () => app.database.raw.prepare('SELECT name FROM trace_spans ORDER BY rowid').all()
    .filter((row) => row.name.startsWith('service.'));
  const audits = (entityType) => app.audit.list({ entityType }).length;

  let mark = emitted.length;
  let stepMark = steps().length;
  const opened = await openCase(client, entitlement.id, 'c1');
  assert.deepEqual(emitted.slice(mark), ['support-case.created'], 'one case, one event');
  assert.deepEqual(steps().slice(stepMark).map((row) => row.name), ['service.case.recorded']);
  assert.equal(audits('support-case'), 1);

  // A first response writes the case and its activity: two records, two events.
  mark = emitted.length; stepMark = steps().length;
  await client.module('support-case').action(opened.result.supportCase.id, 'record-first-response', { note: 'ack' });
  assert.deepEqual(emitted.slice(mark).sort(), ['support-case-activity.created', 'support-case.updated']);
  assert.deepEqual(steps().slice(stepMark).map((row) => row.name), ['service.case.first-response-recorded']);

  // A refusal emits nothing at all.
  mark = emitted.length; stepMark = steps().length;
  await assert.rejects(
    () => client.module('support-case').action(opened.result.supportCase.id, 'record-first-response', {}),
    (error) => error.status === 409,
  );
  assert.deepEqual(emitted.slice(mark), [], 'a refusal emits no record event');
  assert.deepEqual(steps().slice(stepMark), [], 'and no business step');

  // Previewing is read-only: no event, no audit, no record.
  mark = emitted.length;
  const auditBefore = app.audit.list({}).length;
  await client.module('support-case').action(opened.result.supportCase.id, 'preview-sla', {});
  assert.deepEqual(emitted.slice(mark), []);
  assert.equal(app.audit.list({}).length, auditBefore, 'a preview writes no audit row');

  // Nothing this milestone must never claim was ever published.
  const forbidden = [
    'email.sent', 'customer.authenticated', 'sla.contractually-breached',
    'invoice.created', 'payment.received', 'renewal.created', 'customer-success.assigned',
  ];
  for (const name of forbidden) {
    assert.equal(emitted.includes(name), false, `"${name}" must never be emitted`);
  }
  // And no such record type exists at all.
  for (const module of ['invoice', 'payment', 'billing-eligibility', 'service-contract', 'renewal']) {
    assert.throws(() => app.modules.get(module), /Module not found/, `"${module}" must not exist`);
  }
});

test('hostile input stays inert across every field, and forges nothing', async (t) => {
  const { context, entitlement } = await covered(t, 'hostile.sqlite');
  const { app, client } = context;

  const HOSTILE = [
    '__proto__', 'constructor', 'prototype',
    '<script>alert(1)</script>', '"; DROP TABLE support_case; --',
    '${process.env.SECRET}', '`whoami`', "' OR '1'='1",
    '../../etc/passwd', 'a'.repeat(300),
  ];
  const recorded = [];
  for (const [index, value] of HOSTILE.entries()) {
    const created = await openCase(client, entitlement.id, `h-${index}`, {
      title: value.slice(0, 200), description: value,
    });
    recorded.push(created.result.supportCase);
    // Stored as text, unchanged and un-evaluated.
    assert.equal(created.result.supportCase.description, value);
    if (index < 8) await client.module('support-case').action(created.result.supportCase.id, 'transition-case', {
      toStatus: 'resolved', resolutionSummary: value.slice(0, 200),
    });
  }
  assert.equal({}.polluted, undefined, 'no prototype pollution');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(app.modules.get('support-case').service.countWhere({ serviceEntitlementId: entitlement.id }), HOSTILE.length);

  // Control characters are refused at the boundary, in every text field.
  // The whole hostile loop above already filled this entitlement's open-case
  // limit, so these refusals need their own room: they must be refused for the
  // reason under test, not because the entitlement is full.
  for (const supportCase of app.modules.get('support-case').service.listWhere({ serviceEntitlementId: entitlement.id })) {
    if (supportCase.status === 'resolved') {
      await client.module('support-case').action(supportCase.id, 'transition-case', { toStatus: 'closed' });
    }
  }
  for (const [field, value, expectation] of [
    ['title', `A${String.fromCharCode(0)}B`, 'a NUL is refused'],
    ['title', 'A\nB', 'a title is one line'],
    ['description', `A${String.fromCharCode(0x2028)}B`, 'a line separator is refused'],
  ]) {
    await assert.rejects(
      () => openCase(client, entitlement.id, `ctl-${field}-${value.charCodeAt(1)}`, { [field]: value }),
      (error) => new RegExp(`${field} must (not contain control characters|be a single line)`).test(String(error.message)),
      `${field}: ${expectation}`,
    );
  }

  // A category or priority that is not a string is refused, not coerced.
  for (const input of [{ category: 42 }, { category: null }, { priority: ['high'] }, { priority: {} }]) {
    await assert.rejects(
      () => openCase(client, entitlement.id, `coerce-${JSON.stringify(input)}`, input),
      (error) => error.status === 400 || error.code === 'VALIDATION_ERROR',
    );
  }

  // An override list is validated as strictly as a policy decision.
  const { contract } = await activatedContract(composedRoot(), app, { name: 'Hostile2', offers: OFFERS });
  for (const overrides of [
    'not-an-array',
    [{ serviceObligationId: 'x' }],
    [{ serviceObligationId: 'x', supportTier: 't', categories: [] }],
    [{ serviceObligationId: 'x', supportTier: 't', categories: ['c'] }],
  ]) {
    await assert.rejects(
      () => client.module('commercial-contract').action(contract.id, 'activate-service', {
        coverageKey: 'h', customerRef: 'c', startDate: '2026-09-01',
        policy: 'b2b-service-activation-premium-only', overrides,
      }),
      (error) => error.status === 400 || error.status === 409,
      `overrides ${JSON.stringify(overrides)} is refused`,
    );
  }

  // No error message leaks a path, a stack or a source line.
  try {
    await openCase(client, entitlement.id, 'leak', { category: 'not-covered' });
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(/\/home\/|\.js:\d+|at Object\./.test(String(error.message)), false,
      'a refusal names the rule, never the machine');
  }
});

test('a capability reads and never writes', async (t) => {
  const { context, coverage, contract } = await covered(t, 'capability.sqlite');
  const { app } = context;
  const { createCaseManagementCapability, createCoverageCapability, createSlaEvidenceCapability } =
    await import('../packages/service/src/capabilities.js');
  const open = (factory) => factory().create({ modules: app.modules, actor: ACTOR });

  // The registry refuses an undeclared consumer — proved separately. Here the
  // capabilities are opened directly, with the caller's handles, which is the
  // shape a consuming package gets.
  await assert.rejects(async () => app.domains.capability({
    consumer: 'service', capability: 'service-coverage', version: 1,
    context: { modules: app.modules, actor: ACTOR },
  }), 'a package may not reach a capability it does not declare');

  const coverageView = open(createCoverageCapability);
  const forContract = coverageView.forContract(contract.id);
  assert.equal(forContract.coverages.length, 1);
  assert.equal(forContract.entitlements.length, 1);
  assert.match(forContract.basis, /not a signed agreement/);
  assert.equal(coverageView.activeCoverages().length, 1);

  const caseView = open(createCaseManagementCapability);
  const forCoverage = caseView.forCoverage(coverage.id);
  assert.deepEqual(Object.keys(forCoverage).sort(), ['activity', 'basis', 'cases']);
  assert.match(forCoverage.basis, /no customer is authenticated/);

  const slaView = open(createSlaEvidenceCapability);
  assert.match(slaView.forCoverage(coverage.id).basis, /no contractual SLA interpretation/);

  // Every returned view is read-only: no capability offers a writer.
  for (const view of [coverageView, caseView, slaView]) {
    assert.ok(Object.isFrozen(view));
    for (const key of Object.keys(view)) {
      if (key === 'capabilityContract') continue;
      assert.equal(/create|update|delete|write|apply|record|activate(?!Coverages)|end/i.test(key), false,
        `capability method "${key}" must not imply a write`);
    }
  }
});
