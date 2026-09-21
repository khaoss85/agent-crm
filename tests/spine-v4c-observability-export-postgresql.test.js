// @ts-check

/**
 * Hosted V4C evidence. Two of the three producer families only exist on
 * PostgreSQL — write outcomes and therefore the transactional outbox are
 * PostgreSQL-only by contract, and the writer lease has no SQLite analogue —
 * so their telemetry has to be proved against a real database rather than a
 * fixture.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { EventBus } from '../packages/core/src/event-bus.js';
import { createDurableJobStore } from '../packages/core/src/durable-jobs.js';
import { injectPostgresqlCommitFault } from '../packages/core/src/postgresql-storage.js';
import { bootstrapPostgresqlApplication } from '../packages/core/src/postgresql-bootstrap.js';
import { runWithAffineStorage } from '../packages/core/src/storage-runtime.js';
import { createTransactionalOutboxWorker } from '../packages/core/src/transactional-outbox.js';
import { runIdempotentWrite } from '../packages/core/src/write-outcome-runtime.js';
import {
  TELEMETRY_SIGNALS,
  createCaptureTelemetryExporter,
  createTelemetrySink,
} from '../packages/core/src/observability-export.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import { bootPostgresqlApp, openIsolatedPostgresqlPlanes } from './helpers/postgresql-application.js';
import { createTestVerifier } from './helpers/identity-verifier-fixture.mjs';
import { PG_TEST_URL } from './helpers/storage-contract-cases.js';

const actor = Object.freeze({ type: 'user', id: 'v4c-pg-operator' });
const PAYLOAD_SENTINEL = 'v4c-PG-PAYLOAD-SENTINEL-diagnosis';
const MESSAGE_SENTINEL = 'v4c duplicate key value violates unique constraint acme';

function blobOf(value) {
  return [
    inspect(value, { depth: 40, showHidden: true, getters: false }),
    (() => { try { return JSON.stringify(value); } catch { return ''; } })(),
  ].join('\n');
}

/**
 * The hosted leak scan compares against the real connection scalars, not only
 * planted strings. It deliberately does NOT compare the bare username
 * `postgres`, which legitimately occurs inside the adapter name `postgresql` —
 * that false positive already cost this repository one CI round in V4B.
 */
function assertNoHostedLeak(value, planes) {
  const blob = blobOf(value);
  const forbidden = [
    PG_TEST_URL, PAYLOAD_SENTINEL, MESSAGE_SENTINEL,
    planes.control.database, planes.data.database,
    `${planes.data.host}:${planes.data.port}`,
    ...(planes.data.password ? [planes.data.password] : []),
  ].filter((token) => typeof token === 'string' && token.length > 0);
  for (const token of forbidden) {
    assert.equal(blob.includes(token), false, `telemetry leaked ${token}\n${blob}`);
  }
}

function assertStructurallyBounded(records) {
  for (const record of records) {
    const declared = TELEMETRY_SIGNALS[record.signal];
    assert.ok(declared, `undeclared signal ${record.signal}`);
    for (const [key, value] of Object.entries(record.attributes)) {
      assert.ok(declared.attributes[key], `undeclared attribute ${record.signal}.${key}`);
      assert.notEqual(typeof value, 'object');
    }
  }
}

function databaseHandle(storage, tenantId) {
  const handle = {
    storage,
    tenantId,
    transactionAsync(fn) {
      return storage.transaction(async (tx) => runWithAffineStorage(handle, tx, () => fn(tx)));
    },
  };
  return handle;
}

function captureSink() {
  const capture = createCaptureTelemetryExporter();
  return { capture, sink: createTelemetrySink({ exporter: capture.exporter }) };
}

const withSignal = (capture, signal) => capture.records().filter((record) => record.signal === signal);

/**
 * Leave exactly one committed, undispatched outbox job by dropping the commit
 * acknowledgement — the V3B restart shape — so the dispatch that follows is
 * one this test owns and can instrument.
 */
async function pendingOutboxJob(t, { onEvent }) {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return null;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  events.subscribe('company.created', onEvent);
  const key = 'v1.20260901.cccccccccccccccccccccccccccccccc';
  injectPostgresqlCommitFault(storage, 'post-commit-ack-drop');
  await assert.rejects(
    runIdempotentWrite(database, events, {
      tenantId: booted.tenantId,
      idempotencyKey: key,
      actor,
      operation: 'company.create',
      input: { name: PAYLOAD_SENTINEL },
      now: () => '2026-09-01T09:00:00.000Z',
    }, async ({ emit }) => {
      await emit('company.created', { note: PAYLOAD_SENTINEL });
      return { note: PAYLOAD_SENTINEL };
    }),
    (error) => error.code === 'COMMIT_OUTCOME_UNKNOWN',
  );
  const jobs = createDurableJobStore({ storage, tenantId: booted.tenantId });
  const [job] = await jobs.list();
  assert.equal(job.state, 'pending');
  return { booted, database, events, job, jobs };
}

test('a committed outbox effect reports its own dispatch run, carrying no outcome, payload or tenant', { timeout: 90_000 }, async (t) => {
  const context = await pendingOutboxJob(t, { onEvent: () => {} });
  if (!context) return;
  const { capture, sink } = captureSink();
  const worker = createTransactionalOutboxWorker({
    database: context.database,
    events: context.events,
    tenantId: context.booted.tenantId,
    workerId: 'v4c-outbox',
    pollIntervalMs: 60_000,
    clock: () => '2026-09-01T09:00:00.000Z',
    telemetry: sink,
  });
  worker.start();
  const settled = await worker.run(context.job.id);
  await worker.close();
  await sink.close();
  assert.equal(settled.state, 'succeeded');

  const dispatches = withSignal(capture, 'accordo.transactional_outbox.dispatch');
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].kind, 'run');
  assert.deepEqual(dispatches[0].attributes, {
    attempt: 1, durationMs: 0, effect: 'internal-event-promotion', outcome: 'succeeded',
  });
  // The job-level signals stay distinct from the effect-level one.
  assert.deepEqual(
    withSignal(capture, 'accordo.durable_job.claimed')[0].attributes,
    { attempt: 1, handler: 'promote-write-outcome-events', kind: 'write-outcome-effect' },
  );
  assert.equal(withSignal(capture, 'accordo.durable_job.execution')[0].attributes.state, 'succeeded');
  assertStructurallyBounded(capture.records());
  assertNoHostedLeak(capture.records(), context.booted.planes);
});

test('a failing dispatch reports a failed effect with a bounded code and never the driver message', { timeout: 90_000 }, async (t) => {
  const context = await pendingOutboxJob(t, {
    onEvent: () => { throw new Error(MESSAGE_SENTINEL); },
  });
  if (!context) return;
  const { capture, sink } = captureSink();
  const worker = createTransactionalOutboxWorker({
    database: context.database,
    events: context.events,
    tenantId: context.booted.tenantId,
    workerId: 'v4c-outbox-failing',
    pollIntervalMs: 60_000,
    clock: () => '2026-09-01T09:00:00.000Z',
    telemetry: sink,
  });
  worker.start();
  const settled = await worker.run(context.job.id);
  await worker.close();
  await sink.close();
  assert.match(settled.state, /^failed_/);

  const [dispatch] = withSignal(capture, 'accordo.transactional_outbox.dispatch');
  assert.equal(dispatch.attributes.outcome, 'failed');
  assert.equal(dispatch.attributes.errorCode, 'JOB_HANDLER_TEMPORARY_UNAVAILABLE');
  const [execution] = withSignal(capture, 'accordo.durable_job.execution');
  assert.match(execution.attributes.state, /^failed_/);
  assert.equal(execution.attributes.errorCode, 'JOB_HANDLER_TEMPORARY_UNAVAILABLE');
  assertStructurallyBounded(capture.records());
  assertNoHostedLeak(capture.records(), context.booted.planes);
});

test('a real writer lease reports readiness once at boot, once when it expires, and never per refused write', { timeout: 90_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;
  const { capture, sink } = captureSink();
  let epoch = Date.parse('2026-09-01T09:00:00.000Z');
  const booted = await bootstrapPostgresqlApplication({
    control: planes.control,
    data: planes.data,
    tenantId: 'acme',
    identityVerifier: createTestVerifier({ tenantId: 'acme' }),
    moduleMigrations: [],
    clock: () => new Date(epoch).toISOString(),
    now: () => epoch,
    leaseTtlMs: 60_000,
    telemetry: sink,
  });
  t.after(() => booted.close());

  const boot = withSignal(capture, 'accordo.postgresql.readiness');
  assert.equal(boot.length, 1, 'bootstrap reports readiness exactly once');
  assert.deepEqual(boot[0].attributes, { adapter: 'postgresql', ready: true });
  const gauge = withSignal(capture, 'accordo.postgresql.writer_lease_remaining_ms');
  assert.equal(gauge[0].unit, 'ms');
  assert.equal(gauge[0].value, 60_000);

  assert.equal(booted.health().ready, true);
  assert.equal(booted.health().ready, true);
  assert.equal(
    withSignal(capture, 'accordo.postgresql.readiness').length, 1,
    'asking for health repeatedly emits nothing while readiness has not moved',
  );

  epoch = Date.parse('2026-09-01T09:05:00.000Z');
  assert.equal(booted.health().ready, false);
  // Every guarded write now refuses; the transition must still be one signal.
  for (let index = 0; index < 8; index += 1) {
    await assert.rejects(
      () => booted.dataStorage.transaction(async () => {}),
      (error) => typeof error.code === 'string',
    );
  }
  const transitions = withSignal(capture, 'accordo.postgresql.readiness');
  assert.deepEqual(transitions.map((record) => record.attributes), [
    { adapter: 'postgresql', ready: true },
    { adapter: 'postgresql', ready: false, reason: 'WRITER_LEASE_EXPIRED' },
  ]);
  await sink.close();
  assertStructurallyBounded(capture.records());
  assertNoHostedLeak(capture.records(), planes);
});
