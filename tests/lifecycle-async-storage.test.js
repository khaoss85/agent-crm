// @ts-check

/**
 * The renewal path on asynchronous storage (accordo 1d5248b18761, follow-up of
 * #254 voice 105ba9846605, P3 of the Muse review on head 6b3e2a0).
 *
 * `contract-lifecycle-source@2` read storage synchronously (`get`/`listWhere`
 * without `await`) and the lifecycle index called
 * `termEvidence`/`listContractLines`/`listSubscriptionLines` without `await`.
 * On PostgreSQL `plan-renewal`, `record-renewal-decision` and
 * `request-commercial-followup` received Promises (always truthy): the
 * `if (!contract) return null` guard never fired, `contract.id` was
 * `undefined`, and the baseline sort threw `Promise.sort is not a function`.
 * The only exercised path was SQLite, whose reads settle synchronously.
 *
 * The journey below boots the real composed application, activates a real
 * contract, then wraps every record service so reads settle through a real
 * Promise — the exact seam where PostgreSQL differs (same proxy as
 * `tests/commercial-async-storage.test.js`). It then runs the three REAL
 * renewal actions against the REAL contract-2 twin opened with the
 * application's own modules view. Any record read consumed without `await` in
 * the exercised path throws instead of answering rows, so the journey fails
 * loudly rather than shipping a silent SQLite-only pass.
 *
 * Scope, stated plainly: the twin is opened directly rather than through a
 * fully contract-2-composed application, exactly like the commercial guard's
 * third test — composing the async application end to end needs the app
 * methods the portable async factory does not wire yet. Composition edges
 * (the V2 contracts graph offers the awaited twin, the V1 graph keeps the
 * synchronous factory) are pinned by the selection test below, and graph
 * uniformity generically by `tests/spine-v2-m3p-dual-bundled-graphs.test.js`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { types } from 'node:util';
import { join } from 'node:path';

import { activatedContract, boot, project, BUSINESS_NOW } from './helpers/contracts-project.js';
import {
  buildPlanRenewalAction,
  buildRecordRenewalDecisionAction,
  buildRequestCommercialFollowupAction,
  FOLLOWUP_OPEN,
} from '../packages/lifecycle/src/index.js';
import {
  createContractsDomain,
  createContractsDomainV2,
} from '../packages/contracts/src/index.js';
import {
  createContractLifecycleSourceAsyncCapability,
} from '../packages/contracts/src/lifecycle-capability.js';

/**
 * Wrap a record service so every method settles through a Promise, like the
 * asynchronous storage contract does. Synchronous storage answers values; a
 * caller that forgets `await` keeps working there and breaks in production.
 * Under this wrapper that caller gets a Promise and fails here instead.
 * (Same proxy as `tests/commercial-async-storage.test.js`.)
 */
function asyncRecordService(service) {
  return new Proxy(service, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...args) => Promise.resolve().then(() => value.apply(target, args));
    },
  });
}

/**
 * Apply the async-storage contract to every composed record module service.
 * Core services (`app.services`) stay untouched: the application's own health
 * readers consume them synchronously by design.
 */
function asyncStorage(app) {
  for (const module of app.modules.modules.values()) {
    if (module?.service) module.service = asyncRecordService(module.service);
  }
}

const ACTOR = { type: 'user', id: 'lifecycle-async-guard' };
const now = () => BUSINESS_NOW;

/**
 * Boot with Lifecycle, activate a real contract on synchronous services, then
 * switch storage to asynchronous. Returns the app, the contract row, and the
 * awaited twin opened with the application's own modules view — the same seam
 * PostgreSQL differs on.
 */
async function asyncRenewalSetup(t, file, name) {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name });
  asyncStorage(app);

  const offered = createContractsDomainV2().capabilities
    .find((entry) => entry.name === 'contract-lifecycle-source');
  assert.equal(offered?.version, 2, 'the contract-2 graph offers contract-lifecycle-source@2');
  const twin = await offered.create({ modules: app.modules, actor: ACTOR, now });
  assert.equal(twin.capabilityContract, 2, 'the awaitable graph declares capabilityContract 2');

  // The application's own domain registry, except `contract-lifecycle-source`
  // answers from the awaited twin — which is exactly what the contract-2
  // composition wires (pinned by the selection test below).
  const domains = new Proxy(app.domains, {
    get(target, prop, receiver) {
      if (prop === 'capability') {
        return async (request = {}) => {
          if (request?.capability === 'contract-lifecycle-source') return twin;
          return target.capability(request);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { app, contract, domains, twin };
}

test('plan-renewal settles every read on async storage', async (t) => {
  const { app, contract, domains } = await asyncRenewalSetup(t, 'lifecycle-async-plan.sqlite', 'Async Plan Deal');

  const plan = await buildPlanRenewalAction().execute({
    record: contract, input: { asOf: '2027-08-01' }, actor: ACTOR, modules: app.modules, domains, now,
  });

  assert.equal(plan.contractId, contract.id, 'the plan names the contract, never undefined');
  assert.equal(typeof plan.contractId, 'string', 'no Promise leaks into the answer');
  // Inclusive end date: 2027-08-31 is live ON the 31st, so 2027-08-01 is 30 days out.
  assert.deepEqual(plan.boundary, { daysToBoundary: 30, category: 'within_window', endDateIsInclusive: true });
  assert.equal(plan.term.endDate, '2027-08-31', 'the term evidence settles, never a Promise');
  assert.equal(plan.term.source, 'post-signature-operational-activation');
  assert.equal(plan.term.signed, false, 'an activation term is never presented as signed');
  assert.deepEqual(plan.evidenceGaps, []);
  assert.ok(Array.isArray(plan.baseline.groups) && plan.baseline.groups.length > 1,
    'the commercial baseline reads back through Promises and stays grouped');
  assert.equal(plan.baseline.contractLineCount, plan.baseline.groups
    .reduce((sum, group) => sum + group.lineCount, 0), 'every line is counted');
  assert.equal(typeof plan.baseline.subscriptionLineCount, 'number');
});

test('record-renewal-decision and request-commercial-followup settle on async storage', async (t) => {
  const { app, contract, domains } = await asyncRenewalSetup(t, 'lifecycle-async-decide.sqlite', 'Async Decide Deal');

  const decision = await buildRecordRenewalDecisionAction().execute({
    record: contract,
    input: { decision: 'pursue_renewal', reason: 'they are happy', asOf: '2027-08-01' },
    actor: ACTOR, modules: app.modules, domains, now,
  });
  assert.equal(decision.sourceKey, `renewal-decision:${contract.id}:2027-08-01`,
    'the key is (contract, calendar date) — derived from the ask, never from the clock');
  assert.equal(decision.termEndDate, '2027-08-31', 'the decision carries the settled term boundary');
  assert.equal(decision.termSource, 'post-signature-operational-activation');
  assert.equal(typeof decision.id, 'string', 'no Promise leaks into the stored row');

  const followup = await buildRequestCommercialFollowupAction().execute({
    record: contract,
    input: { intent: 'renewal', summary: 'they are happy, call them', decisionId: decision.id },
    actor: ACTOR, modules: app.modules, domains, now,
  });
  assert.equal(followup.status, FOLLOWUP_OPEN, 'the ask is open, not a Promise-shaped row');
  assert.equal(followup.contractId, contract.id);
  assert.equal(followup.decisionId, decision.id, 'the handoff names the recorded decision');
  assert.equal(followup.sourceKey, `commercial-followup:${contract.id}:renewal:1`);
  assert.ok(followup.baselineGroupCount >= 1, 'the baseline evidence travels with the ask');
});

test('a synchronous contract-1 consumer reads without await, unchanged', async (t) => {
  const root = project(t, { withLifecycle: true });
  const context = await boot(root, join(root, 'data', 'lifecycle-sync-consumer.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Sync Consumer Deal' });

  // The published contract, exactly as a custom package or admin tooling holds
  // it on main: no await anywhere, on synchronous storage.
  const sync = app.domains.capability({
    consumer: 'lifecycle', capability: 'contract-lifecycle-source', version: 2,
    context: { modules: app.modules },
  });
  assert.equal(sync.capabilityContract, 1, 'the synchronous interface stays contract 1');

  const evidence = sync.termEvidence(contract.id);
  assert.equal(typeof evidence?.then, 'undefined', 'termEvidence answers the row, never a Promise');
  assert.equal(evidence.contractId, contract.id);
  assert.equal(evidence.term.endDate, '2027-08-31');
  assert.equal(evidence.term.signed, false);

  const lines = sync.listContractLines(contract.id);
  assert.ok(Array.isArray(lines) && lines.length > 0, 'lines answer rows, never a Promise');
  assert.ok(lines.every((line) => typeof line.id === 'string' && Object.isFrozen(line)));

  const subscriptionLines = sync.listSubscriptionLines(contract.id);
  assert.ok(Array.isArray(subscriptionLines), 'subscription lines answer rows, never a Promise');

  assert.equal(sync.termEvidence('no-such-contract'), null, 'an unknown id is still null');
});

test('the contract-2 graph offers the awaited twin, the v1 graph the synchronous factory', () => {
  const syncEntry = createContractsDomain().capabilities
    .find((entry) => entry.name === 'contract-lifecycle-source');
  const asyncEntry = createContractsDomainV2().capabilities
    .find((entry) => entry.name === 'contract-lifecycle-source');

  assert.equal(syncEntry?.version, 2);
  assert.equal(asyncEntry?.version, 2, 'same name and version on both graphs');
  assert.equal(syncEntry?.capabilityContract ?? 1, 1, 'the v1 graph keeps the synchronous factory');
  assert.equal(types.isAsyncFunction(syncEntry.create), false, 'v1 create stays synchronous');
  assert.equal(types.isAsyncFunction(asyncEntry.create), true, 'v2 create is awaitable');
  assert.equal(asyncEntry.capabilityContract, 2, 'the twin declares capabilityContract 2');
  assert.notEqual(syncEntry.create, asyncEntry.create, 'the two graphs can never share the factory');
  assert.equal(createContractLifecycleSourceAsyncCapability.length, 1, 'same factory shape, one options argument');
});

test('the awaited twin refuses without the modules view, like the synchronous factory', async () => {
  const twinEntry = createContractsDomainV2().capabilities
    .find((entry) => entry.name === 'contract-lifecycle-source');
  await assert.rejects(
    () => twinEntry.create({}),
    (error) => error.code === 'CAPABILITY_CONTEXT_INVALID',
    'the fail-closed gate settles, never a sync throw',
  );
});
