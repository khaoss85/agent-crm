import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createAccordoAppAsync } from '../packages/app/src/index.js';
import { SCHEDULED_ASK_MIGRATION } from '../packages/core/src/domain-timers.js';
import { trustedSystemActor } from '../packages/core/index.js';

const OPERATOR = Object.freeze({ type: 'user', id: 'operations-operator' });
/**
 * A worker executes on the framework's behalf, so its actor must carry system
 * authority — and the composing application is the one that claims it, for a
 * reason it states. The framework adds no call site of its own for this: the
 * inventory of places it claims root does not grow because an application runs
 * a worker.
 */
const WORKER_ACTOR = trustedSystemActor('running the production operations this application started');
const TENANT = 'integration-tenant';
/** Far enough ahead to be scheduled, close enough that a started worker reaches it. */
const dueSoon = () => new Date(Date.now() + 120).toISOString();

/**
 * The slice under test composes six shipped contracts into one application. It
 * is therefore tested through the public async factory only: reaching into the
 * portable starter would prove the composition works where nobody composes.
 */
test('this file uses the public async factory, not the source-private portable starter', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*portable-app(?:\.js)?['"]/.test(source), false);
  assert.equal(/from ['"][^'"]*production-operations(?:\.js)?['"]/.test(source), false);
});

function bareGraph() {
  return { packageContract: 2, packages: [], actions: [], modules: [] };
}


/** What the provider package was actually asked to open. */
const opened = [];

/**
 * Two real packages, not doubles, and that distinction is the point.
 *
 * Under `packageContract: 2` the registry wraps every capability seam, so
 * resolving one returns a promise. A synchronous double hides that; a real
 * registry does not. This graph is minimal on purpose — it carries no storage,
 * no modules and no domain of its own — but the seam the timer crosses is the
 * real one.
 */
function askProviderPackage() {
  return {
    packageContract: 2,
    name: 'ask-provider',
    version: 1,
    label: 'ask-provider',
    actions: [],
    capabilities: [{
      name: 'follow-up',
      version: 1,
      capabilityContract: 2,
      description: 'Open exactly one follow-up for a business identity.',
      // Asynchronous, which `packageContract: 2` permits and the bundled packages
      // reach by another road: `selectPackageGraph` wraps a v1 capability into a
      // v2 one, and the wrapper is async. Either way the seam is a promise, and
      // that is precisely what the timer used to read synchronously.
      async create(context) {
        return Object.freeze({
          createFollowUp(request) {
            opened.push({ consumer: context.consumer, request });
            return { task: { id: `task-${opened.length}` } };
          },
        });
      },
    }],
  };
}

function askConsumerPackage() {
  return {
    packageContract: 2,
    name: 'ask-consumer',
    version: 1,
    label: 'ask-consumer',
    actions: [],
    capabilities: [],
    requires: [{ package: 'ask-provider', capability: 'follow-up', version: 1 }],
  };
}

function domainGraph() {
  return {
    packageContract: 2,
    packages: [askProviderPackage(), askConsumerPackage()],
    actions: [],
    modules: [],
  };
}

function timerComposition(overrides = {}) {
  return {
    actor: WORKER_ACTOR, tenantId: TENANT, timers: true,
    jobs: { pollIntervalMs: 25 },
    ...overrides,
  };
}

async function appWithTimers(t, extra = {}) {
  const app = await createAccordoAppAsync({
    dbPath: ':memory:',
    selected: domainGraph(),
    moduleMigrations: [SCHEDULED_ASK_MIGRATION],
    productionOperations: timerComposition(),
    ...extra,
  });
  t.after(() => app.close());
  return app;
}

// --- what the slice promises -------------------------------------------------

test('an application that composes no operations is indistinguishable from one built before the slice existed', async (t) => {
  const plain = await createAccordoAppAsync({ dbPath: ':memory:', selected: bareGraph() });
  t.after(() => plain.close());
  assert.equal('productionOperations' in plain, false);
  assert.equal(Object.hasOwn(plain, 'productionOperations'), false);
});

test('composing operations starts nothing: the key appears, the worker does not run', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;
  assert.notEqual(operations, undefined);

  const posture = await operations.status();
  assert.equal(posture.started, false);
  assert.equal(posture.worker.accepting, false);
  assert.equal(posture.worker.polling, false);
  assert.equal(posture.worker.inFlight, false);
  assert.equal(posture.composed.timers, true);
});

test('nothing runs on a clock: a due ask stays scheduled while the worker was never started', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;

  const scheduled = await operations.timers.schedule(OPERATOR, followUp());
  assert.equal(scheduled.state, 'scheduled');

  // Wait past the instant the ask was scheduled for. Time alone must move nothing:
  // the worker exists, it was never started, and no clock reaches it.
  await new Promise((resolve) => { setTimeout(resolve, 300); });
  const after = await operations.timers.read(scheduled.id);
  assert.equal(after.state, 'scheduled');

  const posture = await operations.status();
  assert.equal(posture.backlog.pending, 1);
  assert.equal(posture.backlog.succeeded, 0);
});

function followUp(overrides = {}) {
  return {
    kind: 'work-follow-up',
    consumerPackage: 'ask-consumer',
    capability: { name: 'follow-up', version: 1 },
    scheduledFor: dueSoon(),
    ask: {
      sourceKey: 'lifecycle-commercial-followup:integration-1',
      title: 'Call the customer about renewal',
      subject: { resource: 'commercial-contract', id: 'contract-1' },
    },
    ...overrides,
  };
}

// --- the boundary the factory owns ------------------------------------------

test('the factory owns the seam: a composition may not supply the database, adapter, tenant or telemetry', async () => {
  for (const key of ['database', 'adapter', 'telemetry', 'domains', 'modules']) {
    await assert.rejects(
      () => createAccordoAppAsync({
        dbPath: ':memory:',
        selected: bareGraph(),
        moduleMigrations: [SCHEDULED_ASK_MIGRATION],
        productionOperations: timerComposition({ [key]: {} }),
      }),
      (error) => error.code === 'PRODUCTION_OPERATIONS_INVALID' && /owns it/.test(error.message),
      `expected the factory to refuse a caller-supplied ${key}`,
    );
  }
});

test('a worker with no handler family is refused rather than started empty', async () => {
  await assert.rejects(
    () => createAccordoAppAsync({
      dbPath: ':memory:',
      selected: bareGraph(),
      productionOperations: { actor: WORKER_ACTOR, tenantId: TENANT },
    }),
    (error) => error.code === 'PRODUCTION_OPERATIONS_EMPTY',
  );
});

test('composed timers without their table refuse at the wiring, naming the migration that fixes it', async () => {
  await assert.rejects(
    () => createAccordoAppAsync({
      dbPath: ':memory:',
      selected: domainGraph(),
      productionOperations: timerComposition(),
    }),
    (error) => error.code === 'SCHEDULED_ASK_STORAGE_MISSING'
      && /moduleMigrations/.test(error.message),
  );
});

test('telemetry that could reach nobody is refused instead of accepted and dropped', async () => {
  await assert.rejects(
    () => createAccordoAppAsync({
      dbPath: ':memory:',
      selected: bareGraph(),
      telemetry: {},
    }),
    (error) => error.code === 'PRODUCTION_OPERATIONS_TELEMETRY_UNREACHABLE',
  );
});

test('an exporter passed where a sink belongs is refused, as it is one level down', async () => {
  await assert.rejects(
    () => createAccordoAppAsync({
      dbPath: ':memory:',
      selected: domainGraph(),
      moduleMigrations: [SCHEDULED_ASK_MIGRATION],
      productionOperations: timerComposition(),
      telemetry: { emitLog() {} },
    }),
    (error) => error.code === 'PRODUCTION_OPERATIONS_TELEMETRY_INVALID',
  );
});

// --- lifecycle ---------------------------------------------------------------

test('start runs what was composed, and the posture says so', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;
  const scheduled = await operations.timers.schedule(OPERATOR, followUp());

  const before = opened.length;
  operations.start();
  assert.equal((await operations.status()).started, true);

  const after = await settle(operations, scheduled.id);
  assert.equal(after.state, 'opened');

  // The ask reached the provider through the real registry, and the registry —
  // not the payload — named who was asking.
  assert.equal(opened.length, before + 1);
  const request = opened[opened.length - 1];
  assert.equal(request.consumer, 'ask-consumer');
  assert.equal(request.request.title, 'Call the customer about renewal');
  assert.equal(request.request.source.package, 'ask-consumer');
});

/**
 * Regression, and the defect integration exists to catch.
 *
 * Under `packageContract: 2` the registry wraps every capability seam, so
 * `capability()` returns a promise. Read without awaiting it is an object with
 * no `createFollowUp` on it, and the timer refused `SCHEDULED_ASK_CAPABILITY_INVALID`
 * against every real v2 composition — while passing against the synchronous
 * double its own unit tests used. No unit test on either side could see it: one
 * had the real registry and no timer, the other had the timer and no registry.
 */
test('the capability seam is asynchronous under contract 2, and the timer awaits it', async (t) => {
  const app = await appWithTimers(t);
  const seam = app.domains.capability({
    consumer: 'ask-consumer',
    capability: 'follow-up',
    version: 1,
    context: { modules: app.modules, actor: OPERATOR, now: () => new Date().toISOString() },
  });
  assert.equal(seam instanceof Promise, true, 'a v2 capability seam is a promise; reading it synchronously finds no interface');
  assert.equal(typeof (await seam).createFollowUp, 'function');
});

test('a consumer that never declared the capability cannot open an ask through it', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;
  const scheduled = await operations.timers.schedule(OPERATOR, followUp({
    consumerPackage: 'ask-provider',
    ask: {
      sourceKey: 'undeclared:1',
      title: 'Should never open',
      subject: { resource: 'commercial-contract', id: 'contract-9' },
    },
  }));
  const before = opened.length;
  operations.start();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    const [job] = await operations.jobs.list(5);
    if (job && job.state !== 'pending' && job.state !== 'claimed') break;
  }

  assert.equal(opened.length, before, 'nothing may be opened for a package that declared no requirement');
  assert.equal((await operations.timers.read(scheduled.id)).state, 'scheduled');
});

/** Wait for the started worker to reach the ask, without nudging it. */
async function settle(operations, askId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const record = await operations.timers.read(askId);
    if (record.state !== 'scheduled') return record;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return operations.timers.read(askId);
}

test('stop is terminal and says so rather than restarting silently', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;
  operations.start();
  const drained = await operations.stop({ timeoutMs: 1_000 });
  assert.equal(drained.drained, true);

  assert.throws(() => operations.start(), (error) => error.code === 'PRODUCTION_OPERATIONS_STOPPED');
  const posture = await operations.status();
  assert.equal(posture.stopped, true);
  assert.equal(posture.worker.closed, true);
});

test('drain is bounded and a drained handle starts again', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;
  operations.start();
  const drained = await operations.drain({ timeoutMs: 1_000 });
  assert.equal(drained.drained, true);
  assert.equal((await operations.status()).started, false);
  assert.doesNotThrow(() => operations.start());
});

test('closing the application stops the workers before the storage they poll', async (t) => {
  const app = await createAccordoAppAsync({
    dbPath: ':memory:',
    selected: domainGraph(),
    moduleMigrations: [SCHEDULED_ASK_MIGRATION],
    productionOperations: timerComposition(),
  });
  const operations = app.productionOperations;
  operations.start();
  await app.close();

  // Deliberately not `status()`: that reads the backlog, and a database closed
  // underneath a running worker is exactly the bug this ordering prevents. That
  // the handle refuses to restart proves `stop()` ran, and it proves it without
  // touching the storage.
  assert.throws(() => operations.start(), (error) => error.code === 'PRODUCTION_OPERATIONS_STOPPED');
  t.diagnostic('a worker that outlives its database is the one lifecycle bug this composition can introduce');
});

// --- the posture is bounded --------------------------------------------------

test('the posture carries counts, booleans and enums, and no identifier', async (t) => {
  const app = await appWithTimers(t);
  const operations = app.productionOperations;
  await operations.timers.schedule(OPERATOR, followUp());
  const posture = await operations.status();

  const serialised = JSON.stringify(posture);
  assert.equal(serialised.includes(TENANT), false, 'the tenant id must not appear in the posture');
  assert.equal(serialised.includes('contract-1'), false, 'no subject identifier may appear');
  assert.equal(serialised.includes('Call the customer'), false, 'no domain content may appear');

  assert.equal(posture.storage.adapter, 'sqlite');
  assert.equal(posture.backlog.capped, false);
  assert.equal(typeof posture.backlog.limit, 'number');
  assert.equal(Object.isFrozen(posture), true);
});
