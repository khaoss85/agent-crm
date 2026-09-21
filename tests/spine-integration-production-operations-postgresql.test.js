import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCaptureTelemetryExporter,
  createTelemetrySink,
  scheduledAskMigration,
  trustedSystemActor,
} from '../packages/core/index.js';
import { bootPostgresqlApp } from './helpers/postgresql-application.js';

/**
 * The SQLite suite proves what the composition promises. This one exists
 * because three of those claims are PostgreSQL claims, and reading the code
 * that implements them is not the same question as running it. The campaign
 * this slice closes learned that six times; the backup lane learned it hardest,
 * where a hosted path had never restored anything and every review had read it.
 */

const PG_MIGRATION = scheduledAskMigration({ dialect: 'postgresql' });
const OPERATOR = Object.freeze({ type: 'user', id: 'pg-operations-operator' });
const WORKER_ACTOR = trustedSystemActor('running the production operations this application started');

/** Two real packages: the seam a scheduled ask crosses is the registry's, not a double's. */
const opened = [];

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

const SELECTED = Object.freeze({
  packageContract: 2,
  packages: [askProviderPackage(), askConsumerPackage()],
  actions: [],
  modules: [],
});

function followUp(index) {
  return {
    kind: 'work-follow-up',
    consumerPackage: 'ask-consumer',
    capability: { name: 'follow-up', version: 1 },
    scheduledFor: new Date(Date.now() + 120).toISOString(),
    ask: {
      sourceKey: `pg-integration:${index}`,
      title: `Follow up on contract ${index}`,
      subject: { resource: 'commercial-contract', id: `contract-${index}` },
    },
  };
}

function operationsComposition(tenantId) {
  return {
    actor: WORKER_ACTOR,
    timers: true,
    jobs: { pollIntervalMs: 25 },
    // No tenantId: on PostgreSQL the bound tenant is the factory's, and passing
    // one is refused. That asymmetry with SQLite is the tenant binding itself.
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}

test('composed timers run end to end on PostgreSQL when the migration is applied', async (t) => {
  const booted = await bootPostgresqlApp(t, {
    selected: SELECTED,
    moduleMigrations: [PG_MIGRATION],
    productionOperations: operationsComposition(),
  });
  if (!booted) return;
  const operations = booted.app.productionOperations;

  const posture = await operations.status();
  assert.equal(posture.storage.adapter, 'postgresql');
  assert.equal(posture.started, false);
  assert.equal(posture.worker.accepting, false);

  const scheduled = await operations.timers.schedule(OPERATOR, followUp(1));
  assert.equal(scheduled.state, 'scheduled');

  const before = opened.length;
  operations.start();

  let settled = scheduled;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    settled = await operations.timers.read(scheduled.id);
    if (settled.state !== 'scheduled') break;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  assert.equal(settled.state, 'opened');
  assert.equal(opened.length, before + 1);
  assert.equal(opened[opened.length - 1].consumer, 'ask-consumer');

  await operations.stop({ timeoutMs: 2_000 });
});

/**
 * The refusal, and the honest limit of what it can say here.
 *
 * On SQLite the adapter says `no such table` and the composition refuses
 * `SCHEDULED_ASK_STORAGE_MISSING`. On PostgreSQL every storage failure arrives
 * as `STORAGE_UNAVAILABLE` with no cause and no code, so a missing relation and
 * an unreachable database are indistinguishable — and the refusal says exactly
 * that rather than sending a reader to run a migration while their database is
 * down. It still names the migration, and it still fails at the wiring instead
 * of at the first poll.
 */
test('composed timers without their table refuse at the wiring, naming what this adapter cannot tell apart', async (t) => {
  // `moduleMigrations: []` and not "omitted": the helper substitutes a default,
  // and a test that let it through would prove nothing about the missing table.
  const attempt = bootPostgresqlApp(t, {
    selected: SELECTED,
    moduleMigrations: [],
    productionOperations: operationsComposition(),
  });
  await assert.rejects(
    () => attempt,
    (error) => error.code === 'SCHEDULED_ASK_STORAGE_UNREADABLE'
      && /unreachable database/.test(error.message)
      && /scheduledAskMigration\(\{ dialect: 'postgresql' \}\)/.test(error.message),
  ).catch(async (assertionError) => {
    // A skipped suite resolves to null rather than rejecting; that is not a failure.
    if ((await attempt.catch(() => 'rejected')) === null) return;
    throw assertionError;
  });
});

test('the bound tenant is the factory\'s: a composition may not supply one', async (t) => {
  const attempt = bootPostgresqlApp(t, {
    selected: SELECTED,
    moduleMigrations: [PG_MIGRATION],
    productionOperations: operationsComposition('some-other-tenant'),
  });
  await assert.rejects(
    () => attempt,
    (error) => error.code === 'PRODUCTION_OPERATIONS_INVALID' && /owns it/.test(error.message),
  ).catch(async (assertionError) => {
    if ((await attempt.catch(() => 'rejected')) === null) return;
    throw assertionError;
  });
});

/**
 * The finding this file exists for.
 *
 * `startPostgresqlLifecycle` built a closed option list that did not carry
 * `telemetry`, so the writer-readiness observer — implemented, exported and
 * covered by a hosted test that called the bootstrap directly — was unreachable
 * from every supported composition. Only running it proves the hop is closed.
 */
test('the PostgreSQL readiness signal reaches a sink the application composed', async (t) => {
  const capture = createCaptureTelemetryExporter({ limit: 64 });
  const sink = createTelemetrySink({ exporter: capture.exporter });
  const booted = await bootPostgresqlApp(t, {
    selected: SELECTED,
    moduleMigrations: [PG_MIGRATION],
    telemetry: sink,
    productionOperations: operationsComposition(),
  });
  if (!booted) return;

  await sink.flush();
  const signals = capture.signals();
  assert.ok(
    signals.includes('accordo.postgresql.readiness'),
    `expected a readiness signal from the composed bootstrap, saw: ${JSON.stringify(signals)}`,
  );

  const readiness = capture.records().find((record) => record.signal === 'accordo.postgresql.readiness');
  const serialised = JSON.stringify(readiness);
  assert.equal(serialised.includes(booted.tenantId), false, 'no tenant id may be exported');
  assert.equal(/postgres:\/\//.test(serialised), false, 'no connection locator may be exported');

  await booted.app.productionOperations.stop({ timeoutMs: 2_000 });
  await sink.close();
});
