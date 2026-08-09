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

/** The occurrence ordinal a transition's source key carries. */
const ordinal = (sourceKey) => Number(/:system:transition:(\d+):/.exec(sourceKey)?.[1] ?? -1);

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
  const { createAccordoApp } = await import(`file://${join(root, 'packages/app/src/index.js')}`);
  // A short busy timeout: the loser must not be *waited out* to prove the point,
  // and the outcome is identical at 5000ms and 250ms — a typed 409 either way.
  const second = createAccordoApp({
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

  // 5. Two connections making the SAME move at once. Racing two *different*
  // targets is decided by the state machine; racing the same one is decided by
  // whether the record the second connection is judging is the committed one.
  const sameMove = app.modules.get('support-case').service
    .listWhere({ serviceEntitlementId: entitlement.id }).find((row) => row.status === 'new');
  const identical = await Promise.allSettled([
    app.runAction({ module: 'support-case', action: 'transition-case', recordId: sameMove.id, actor: ACTOR, input: { toStatus: 'in_progress' } }),
    second.runAction({ module: 'support-case', action: 'transition-case', recordId: sameMove.id, actor: ACTOR, input: { toStatus: 'in_progress' } }),
  ]);
  assert.equal(identical.filter((outcome) => outcome.status === 'fulfilled').length, 1,
    'the same move applied twice at once lands exactly once');
  const loser = identical.find((outcome) => outcome.status === 'rejected')?.reason;
  // Two outcomes are legitimate: the loser lost the write lock at
  // `BEGIN IMMEDIATE` and is told to retry, or it got the lock second, re-read
  // the committed record and was refused by the state machine. What must NEVER
  // happen is that it passed both and was stopped only by a unique index —
  // that is a correctness rule enforced by accident.
  assert.ok(loser.status === 409, 'the loser gets a typed 409');
  assert.equal(/sourceKey|already exists/i.test(String(loser.message)), false,
    `the loser was stopped by a storage key collision: "${loser.message}"`);
  assert.ok(loser.code === 'SERVICE_TRANSITION_NOT_ALLOWED' || loser.code === 'CONFLICT',
    `unexpected refusal ${loser.code}`);
  assert.equal(app.modules.get('support-case-activity').service
    .listWhere({ supportCaseId: sameMove.id }).filter((row) => row.type === 'transition').length, 1,
    'one move, one piece of evidence');

  // 6. Two connections ending the coverage at once.
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

test('the ordinary support loop can be walked more than once', async (t) => {
  // Found in review. A transition's evidence was keyed `transition:<from>:<to>`,
  // which is not unique — `in_progress ↔ waiting_customer` is the loop a support
  // team walks every day, and its fourth move collided with its own earlier
  // evidence. The case was then stuck in `in_progress` with no way back, on
  // append-only records that can never be corrected. No hostile input was
  // needed: the milestone's own state machine could not be exercised twice.
  const { context, entitlement } = await covered(t, 'loop.sqlite');
  const { app, client } = context;
  const supportCase = (await openCase(client, entitlement.id, 'loop')).result.supportCase;
  const move = (toStatus, extra = {}) =>
    client.module('support-case').action(supportCase.id, 'transition-case', { toStatus, ...extra });

  for (const target of ['in_progress', 'waiting_customer', 'in_progress', 'waiting_customer', 'in_progress']) {
    const moved = await move(target);
    assert.equal(moved.result.supportCase.status, target, `the case reaches ${target} every time`);
  }
  await move('resolved', { resolutionSummary: 'the connector was restarted' });
  const closed = await move('closed');
  assert.equal(closed.result.supportCase.status, 'closed');

  // Every move left exactly one piece of evidence, in order, and none was lost
  // to a key collision.
  const transitions = app.modules.get('support-case-activity').service
    .listWhere({ supportCaseId: supportCase.id })
    .filter((row) => row.type === 'transition')
    // The ordinal in the source key IS the order the moves happened in; the
    // clock is injected and fixed, so it cannot order them.
    .sort((a, b) => ordinal(a.sourceKey) - ordinal(b.sourceKey));
  assert.equal(transitions.length, 7, 'seven moves, seven activity rows');
  assert.equal(new Set(transitions.map((row) => row.sourceKey)).size, 7, 'and seven distinct keys');
  assert.deepEqual(transitions.map((row) => `${row.fromStatus}→${row.toStatus}`), [
    'new→in_progress', 'in_progress→waiting_customer', 'waiting_customer→in_progress',
    'in_progress→waiting_customer', 'waiting_customer→in_progress',
    'in_progress→resolved', 'resolved→closed',
  ]);
});

test('a caller cannot seize a key the framework writes itself', async (t) => {
  // Found in review. The caller's `activityKey` and the framework's own keys
  // shared one namespace on a `unique` source key, so recording a note under
  // "first-response" or "transition:resolved:closed" permanently blocked the
  // action that owns it — an unrecoverable block on evidence, reachable through
  // the ordinary API.
  const { context, entitlement } = await covered(t, 'squat.sqlite');
  const { app, client } = context;
  const activities = app.modules.get('support-case-activity').service;

  const squat = async (key, caseKey) => {
    const supportCase = (await openCase(client, entitlement.id, caseKey)).result.supportCase;
    await client.module('support-case').action(supportCase.id, 'record-case-activity', {
      activityKey: key, type: 'note', body: `a note filed under "${key}"`,
    });
    return supportCase;
  };

  // 1 · the first response still records, and still stamps the case.
  const first = await squat('first-response', 'squat-first');
  const responded = await client.module('support-case').action(first.id, 'record-first-response', { note: 'we answered' });
  assert.ok(responded.result.supportCase.firstRespondedAt, 'the first response was recorded anyway');
  assert.equal(responded.result.supportCase.status, 'in_progress');

  // 2 · the only route to `closed` stays open.
  const closing = await squat('transition:resolved:closed', 'squat-close');
  await client.module('support-case').action(closing.id, 'transition-case', {
    toStatus: 'resolved', resolutionSummary: 'fixed',
  });
  const closed = await client.module('support-case').action(closing.id, 'transition-case', { toStatus: 'closed' });
  assert.equal(closed.result.supportCase.status, 'closed', 'the case is still closable');

  // 3 · an escalation under a seized key still records.
  const escalating = await squat('escalation:urgent', 'squat-escalate');
  const escalated = await client.module('support-case').action(escalating.id, 'record-escalation', {
    escalationKey: 'urgent', level: 'management', reason: 'the customer called their sponsor',
  });
  assert.equal(escalated.result.created, true);

  // The two namespaces are visible in the evidence and never overlap.
  const keys = activities.list({ limit: 500 }).map((row) => row.sourceKey);
  const caller = keys.filter((key) => key.includes(':user:'));
  const system = keys.filter((key) => key.includes(':system:'));
  assert.equal(caller.length, 3, 'three caller-supplied activities');
  assert.ok(system.length >= 4, 'and the framework wrote its own');
  assert.equal(caller.some((key) => system.includes(key)), false, 'the namespaces never overlap');
});

test('a retry that names a different activation policy is refused, not answered from storage', async (t) => {
  // Found in review. `activate-service` answered any repeat of the coverage key
  // from storage, so a retry that named a DIFFERENT policy came back
  // `created: false` carrying the first policy's decision — a divergent retry
  // reported as if it had been honoured.
  const { context, contract } = await covered(t, 'divergent-policy.sqlite');
  const { client } = context;
  const same = { coverageKey: 'main', customerRef: 'customer:acme', startDate: '2026-09-01' };

  await assert.rejects(
    () => client.module('commercial-contract').action(contract.id, 'activate-service', {
      ...same, policy: 'b2b-service-activation-premium-only', policyVersion: 1,
    }),
    (error) => {
      assert.equal(error.code, 'SERVICE_EVIDENCE_CONFLICT');
      assert.match(error.message, /policyName/);
      return true;
    },
  );

  // A retry that names the policy that was actually used is still idempotent…
  const honest = await client.module('commercial-contract').action(contract.id, 'activate-service', {
    ...same, policy: 'b2b-service-activation', policyVersion: 1,
  });
  assert.equal(honest.result.created, false);
  // …and so is one that names none at all: it asked for whatever was recorded.
  const silent = await client.module('commercial-contract').action(contract.id, 'activate-service', same);
  assert.equal(silent.result.created, false);
  assert.equal(silent.result.serviceCoverage.policyName, 'b2b-service-activation');
});

test('every one of the ten actions has its whole write graph fault-injected', async (t) => {
  // Found in review: the fault-injection battery covered eight of the ten
  // actions' writes. `end-service-coverage`, `transition-case`,
  // `record-case-activity` and the activity write inside `record-escalation`
  // were never injected, so "a failure after any write rolls back completely"
  // was an argument for four of them rather than a proof.
  //
  // The table below IS the write graph, and it is checked against the actions
  // the package actually registers — so a future action cannot be added
  // without appearing here.
  const { context, coverage, entitlement } = await covered(t, 'graph.sqlite');
  const { app, client } = context;

  const supportCase = (await openCase(client, entitlement.id, 'graph')).result.supportCase;

  /** action → the modules and methods it writes through, in order. */
  const WRITE_GRAPH = {
    'commercial-contract.plan-service-activation': [],
    'commercial-contract.activate-service': [
      ['service-coverage', 'createManaged'], ['service-entitlement', 'createManaged'],
      ['service-obligation', 'applyManaged'], ['service-activation-run', 'createManaged'],
    ],
    'service-coverage.end-service-coverage': [['service-coverage', 'applyManaged']],
    'service-entitlement.record-service-case': [['support-case', 'createManaged']],
    'support-case.record-first-response': [['support-case', 'applyManaged'], ['support-case-activity', 'createManaged']],
    'support-case.transition-case': [['support-case', 'applyManaged'], ['support-case-activity', 'createManaged']],
    'support-case.record-case-activity': [['support-case-activity', 'createManaged']],
    'support-case.preview-sla': [],
    'support-case.record-sla-evaluation': [['service-sla-evaluation', 'createManaged']],
    'support-case.record-escalation': [['service-escalation', 'createManaged'], ['support-case-activity', 'createManaged']],
  };

  // The graph is complete by construction, not by hope.
  const registered = ['commercial-contract', 'service-coverage', 'service-entitlement', 'support-case']
    .flatMap((module) => app.actions.listForModule(module).map((entry) => `${module}.${entry.name}`))
    .sort();
  assert.deepEqual(registered, Object.keys(WRITE_GRAPH).sort(),
    'every registered Service action appears in the write graph, and nothing else does');

  // The four graphs the battery did not reach, injected at every write in turn.
  const REQUESTS = {
    'service-coverage.end-service-coverage': {
      module: 'service-coverage', action: 'end-service-coverage', recordId: coverage.id, actor: ACTOR,
      input: { reason: 'the customer moved to another provider' },
    },
    'support-case.transition-case': {
      module: 'support-case', action: 'transition-case', recordId: supportCase.id, actor: ACTOR,
      input: { toStatus: 'in_progress' },
    },
    'support-case.record-case-activity': {
      module: 'support-case', action: 'record-case-activity', recordId: supportCase.id, actor: ACTOR,
      input: { activityKey: 'g1', type: 'note', body: 'a note' },
    },
    'support-case.record-escalation': {
      module: 'support-case', action: 'record-escalation', recordId: supportCase.id, actor: ACTOR,
      input: { escalationKey: 'g1', level: 'internal', reason: 'nobody has looked at it' },
    },
  };

  for (const [action, request] of Object.entries(REQUESTS)) {
    for (const [moduleName, method] of WRITE_GRAPH[action]) {
      const service = app.modules.get(moduleName).service;
      const real = service[method].bind(service);
      const before = {
        coverage: app.modules.get('service-coverage').service.get(coverage.id).status,
        status: app.modules.get('support-case').service.get(supportCase.id).status,
        activities: app.modules.get('support-case-activity').service.countWhere({ supportCaseId: supportCase.id }),
        escalations: app.modules.get('service-escalation').service.countWhere({ supportCaseId: supportCase.id }),
        audit: app.audit.list({ entityType: moduleName }).length,
      };
      service[method] = async (...args) => { await real(...args); throw new Error('injected failure'); };
      await assert.rejects(() => app.runAction(request), /injected failure/, `${action} @ ${moduleName}.${method}`);
      service[method] = real;

      const after = {
        coverage: app.modules.get('service-coverage').service.get(coverage.id).status,
        status: app.modules.get('support-case').service.get(supportCase.id).status,
        activities: app.modules.get('support-case-activity').service.countWhere({ supportCaseId: supportCase.id }),
        escalations: app.modules.get('service-escalation').service.countWhere({ supportCaseId: supportCase.id }),
        audit: app.audit.list({ entityType: moduleName }).length,
      };
      assert.deepEqual(after, before, `${action} @ ${moduleName}.${method}: nothing survived, and no audit row claims a success`);
    }
    // …and the retry, after the injection is removed, succeeds exactly once.
    const recovered = await app.runAction(request);
    assert.ok(recovered.result, `${action}: the retry succeeded`);
    // A second identical call never duplicates. Which way it declines depends
    // on the action: a keyed record answers from storage with `created: false`,
    // a state transition is refused by the state machine.
    let repeated = null;
    try { repeated = await app.runAction(request); } catch (error) { repeated = error; }
    const declined = repeated?.status === 409
      || repeated?.result?.created === false
      || repeated?.result?.serviceCoverage?.status === 'ended';
    assert.ok(declined, `${action}: a second identical call neither duplicates nor pretends to be new`);
  }

  assert.equal(app.modules.get('service-escalation').service.countWhere({ supportCaseId: supportCase.id }), 1);
  assert.equal(app.modules.get('service-coverage').service.get(coverage.id).status, 'ended');
});
