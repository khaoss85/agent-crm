// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';

import { createDatabase } from '../packages/core/src/database.js';
import { AppError } from '../packages/core/src/errors.js';
import {
  DURABLE_JOB_STATES,
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
import {
  TELEMETRY_EXPORT_CONTRACT,
  TELEMETRY_RUN_STATES,
  TELEMETRY_SIGNALS,
  createCaptureTelemetryExporter,
  createJsonStderrTelemetryExporter,
  createNoopTelemetryExporter,
  createTelemetrySink,
  createWriterReadinessObserver,
  defineTelemetryExporter,
  reportBackupOperation,
  telemetryErrorCode,
  telemetryVocabulary,
} from '../packages/core/src/observability-export.js';
import { describeWriterHealth } from '../packages/core/src/postgresql-bootstrap.js';
import * as publicCore from '../packages/core/index.js';
import {
  BACKUP_SENTINELS,
  backupFixture,
} from './helpers/v4c-backup-fixture.js';

// ─────────────────────────────────────────────────────────────── sentinels
//
// Every one of these is a value the exporter must NEVER carry. They are not
// only secrets: a tenant id, a fingerprint, an idempotency root and a record
// id are all deliberately excluded by the v1 contract, so each gets a sentinel
// and each is asserted against everything an exporter ever received.

const SENTINELS = Object.freeze({
  password: 'v4c-PGPASSWORD-SENTINEL-never-export',
  databaseUrl: 'postgresql://operator:hunter2@db.internal.invalid:5432/accordo',
  host: 'db.internal.invalid',
  secretReference: 'vault://accordo/prod/postgres#current',
  tenantId: 'tenant-v4c-sentinel-acme-health',
  tenantFingerprint: 'f'.repeat(64),
  idempotencyRoot: 'root-v4c-patient-42@example.invalid',
  outcomeReference: 'outcome-v4c-sentinel-reference',
  workerId: 'worker-v4c-sentinel-write-outcome-run',
  payloadValue: 'v4c-PAYLOAD-SENTINEL-diagnosis-text',
  errorMessage: 'v4c duplicate key value violates unique constraint on tenant-v4c-sentinel-acme-health',
  path: '/private/var/accordo/backups/v4c-sentinel-bundle',
});

/** Recursively serialize anything an exporter saw, then prove no sentinel survives. */
function blobOf(value) {
  return [
    inspect(value, { depth: 40, showHidden: true, getters: false }),
    (() => { try { return JSON.stringify(value); } catch { return ''; } })(),
  ].join('\n');
}

function assertNoSentinel(value, label) {
  const blob = blobOf(value);
  for (const [name, sentinel] of Object.entries({ ...SENTINELS, ...BACKUP_SENTINELS })) {
    assert.equal(
      blob.includes(sentinel),
      false,
      `${label}: exported material contains the ${name} sentinel\n${blob}`,
    );
  }
}

/**
 * Structural half of the scan: every key and every value of every captured
 * record must be declared and of a declared kind. A sentinel scan alone would
 * pass on a leak nobody thought to write a sentinel for.
 */
function assertStructurallyBounded(records) {
  for (const record of records) {
    assert.deepEqual(
      Object.keys(record).sort(),
      record.kind === 'metric'
        ? ['attributes', 'contract', 'kind', 'signal', 'unit', 'value']
        : ['attributes', 'contract', 'kind', 'signal'],
      'a record carries a key the contract does not declare',
    );
    assert.equal(record.contract, TELEMETRY_EXPORT_CONTRACT);
    const declared = TELEMETRY_SIGNALS[record.signal];
    assert.ok(declared, `undeclared signal ${record.signal}`);
    for (const [key, value] of Object.entries(record.attributes)) {
      assert.ok(declared.attributes[key], `undeclared attribute ${record.signal}.${key}`);
      const kind = declared.attributes[key].kind;
      if (kind === 'code') assert.match(value, /^[A-Z][A-Z0-9_]{0,63}$/);
      else if (kind === 'name') assert.match(value, /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/);
      else if (kind === 'enum') assert.ok(declared.attributes[key].values.includes(value));
      else if (kind === 'number') assert.ok(Number.isSafeInteger(value));
      else if (kind === 'boolean') assert.equal(typeof value, 'boolean');
      else assert.fail(`unknown attribute kind ${kind}`);
      // No attribute may be a container: there is no recursive path at all.
      assert.notEqual(typeof value, 'object');
    }
  }
}

function captureSink(options = {}) {
  const capture = createCaptureTelemetryExporter();
  return { capture, sink: createTelemetrySink({ exporter: capture.exporter, ...options }) };
}

const withSignal = (capture, signal) => capture.records().filter((record) => record.signal === signal);

// ───────────────────────────────────────────────────────────── the contract

test('V4C publishes one closed contract, claims no OpenTelemetry support, and cannot drift from V3A states', () => {
  assert.equal(TELEMETRY_EXPORT_CONTRACT, 1);
  assert.equal(publicCore.TELEMETRY_EXPORT_CONTRACT, 1);
  const vocabulary = telemetryVocabulary();
  assert.deepEqual(vocabulary.operations, ['emitLog', 'emitMetric', 'emitRun', 'flush', 'close']);
  assert.deepEqual(vocabulary.exporters, ['capture', 'json-stderr', 'noop']);
  assert.equal(vocabulary.openTelemetry, false, 'no OTLP/OpenTelemetry support is implemented or claimed');
  assert.deepEqual(vocabulary.signals, Object.keys(TELEMETRY_SIGNALS).sort());

  // The duplicated state list in observability-export.js may not drift from
  // the V3A state machine it classifies.
  for (const state of TELEMETRY_RUN_STATES) {
    assert.ok(DURABLE_JOB_STATES.includes(state), `${state} is not a durable-job state`);
  }
  assert.deepEqual(
    DURABLE_JOB_STATES.filter((state) => state !== 'pending' && state !== 'claimed'),
    [...TELEMETRY_RUN_STATES],
    'every settled durable-job state must be reportable',
  );

  // Nothing in the registry may declare an identifier-shaped attribute.
  const forbidden = ['tenantId', 'tenantFingerprint', 'jobId', 'id', 'runId', 'workerId',
    'idempotencyRoot', 'outcomeReference', 'payload', 'bundlePath', 'path', 'host',
    'connection', 'url', 'message', 'error', 'resourceFingerprint'];
  for (const [signal, declared] of Object.entries(TELEMETRY_SIGNALS)) {
    for (const key of Object.keys(declared.attributes)) {
      assert.equal(forbidden.includes(key), false, `${signal} declares the forbidden attribute ${key}`);
    }
  }
});

test('an exporter is exactly the five contract operations and nothing else', () => {
  assert.throws(() => defineTelemetryExporter({
    name: 'wide', contract: 1, emitLog() {}, emitMetric() {}, emitRun() {}, sendEverything() {},
  }), /unsupported field "sendEverything"/);
  assert.throws(() => defineTelemetryExporter({ name: 'Bad Name', contract: 1, emitLog() {}, emitMetric() {}, emitRun() {} }));
  assert.throws(() => defineTelemetryExporter({ name: 'v2', contract: 2, emitLog() {}, emitMetric() {}, emitRun() {} }));
  assert.throws(() => defineTelemetryExporter({ name: 'partial', contract: 1, emitLog() {}, emitMetric() {} }));
  const noop = createNoopTelemetryExporter();
  assert.equal(noop.name, 'noop');
  assert.equal(noop.flush, undefined, 'a no-op exporter invents no lifecycle');
});

// ───────────────────────────────────────────────────── the redaction fence

test('the allowlist refuses the whole record for anything it did not declare', () => {
  const { capture, sink } = captureSink();
  const good = { signal: 'accordo.durable_job.claimed', attributes: { kind: 'write-outcome-effect', handler: 'promote-write-outcome-events', attempt: 1 } };
  assert.equal(sink.emitLog(good), true);

  const refusals = [
    ['unknown signal', () => sink.emitLog({ signal: 'accordo.anything.else', attributes: {} })],
    ['undeclared attribute key', () => sink.emitLog({
      signal: 'accordo.durable_job.claimed',
      attributes: { ...good.attributes, tenantId: SENTINELS.tenantId },
    })],
    ['missing required attribute', () => sink.emitLog({ signal: 'accordo.durable_job.claimed', attributes: { kind: 'k' } })],
    ['nested attribute value', () => sink.emitLog({
      signal: 'accordo.durable_job.claimed',
      attributes: { kind: { evil: SENTINELS.payloadValue }, handler: 'h', attempt: 1 },
    })],
    ['array attribute value', () => sink.emitLog({
      signal: 'accordo.durable_job.claimed',
      attributes: { kind: [SENTINELS.payloadValue], handler: 'h', attempt: 1 },
    })],
    ['name attribute that is a locator', () => sink.emitLog({
      signal: 'accordo.durable_job.claimed',
      attributes: { kind: SENTINELS.databaseUrl, handler: 'h', attempt: 1 },
    })],
    ['code attribute that is a message', () => sink.emitLog({
      signal: 'accordo.durable_job.worker_error', attributes: { errorCode: SENTINELS.errorMessage },
    })],
    ['code attribute that is a path', () => sink.emitLog({
      signal: 'accordo.durable_job.worker_error', attributes: { errorCode: SENTINELS.path },
    })],
    ['enum attribute outside the closed set', () => sink.emitRun({
      signal: 'accordo.backup.operation',
      attributes: { operation: 'exfiltrate', outcome: 'succeeded', durationMs: 1 },
    })],
    ['number attribute that is a string', () => sink.emitLog({
      signal: 'accordo.durable_job.claimed', attributes: { kind: 'k', handler: 'h', attempt: '1' },
    })],
    ['unbounded number', () => sink.emitLog({
      signal: 'accordo.durable_job.claimed', attributes: { kind: 'k', handler: 'h', attempt: 2 ** 60 },
    })],
    ['a log emitted through the run channel', () => sink.emitRun(good)],
    ['a run emitted through the log channel', () => sink.emitLog({
      signal: 'accordo.durable_job.execution',
      attributes: { kind: 'k', handler: 'h', state: 'succeeded', attempt: 1, durationMs: 2 },
    })],
    ['a metric with no value', () => sink.emitMetric({ signal: 'accordo.telemetry.dropped', attributes: {} })],
    ['a non-object emission', () => sink.emitLog('accordo.durable_job.claimed')],
    ['a top-level field outside the envelope', () => sink.emitLog({ ...good, tenantId: SENTINELS.tenantId })],
    ['a prototype-polluting emission', () => sink.emitLog(Object.assign(Object.create({ signal: 'accordo.durable_job.claimed' }), {}))],
  ];
  for (const [label, attempt] of refusals) {
    assert.equal(attempt(), false, `${label} must be refused`);
  }

  assert.equal(capture.records().length, 1, 'exactly one record survived the fence');
  assert.equal(sink.status().rejected, refusals.length);
  assertNoSentinel(capture.records(), 'allowlist refusals');
  assertStructurallyBounded(capture.records());
});

test('a caught error contributes only a charset-valid code, and a junk code costs the signal nothing', () => {
  const withCode = (code) => Object.assign(new Error(SENTINELS.errorMessage), { code });
  assert.equal(telemetryErrorCode(withCode('BACKUP_TARGET_NOT_EMPTY')), 'BACKUP_TARGET_NOT_EMPTY');
  for (const junk of [
    SENTINELS.databaseUrl, SENTINELS.path, SENTINELS.secretReference, SENTINELS.errorMessage,
    'lowercase_code', 'A'.repeat(65), '', 42, null,
  ]) {
    assert.equal(telemetryErrorCode(withCode(junk)), null, `${String(junk)} is not a code`);
  }
  assert.equal(telemetryErrorCode(new Error(SENTINELS.errorMessage)), null, 'no code, no attribute');
  assert.equal(telemetryErrorCode(SENTINELS.databaseUrl), null);

  // The consequence of returning null rather than the raw value: the run is
  // still reported, minus its error code, instead of being refused whole by
  // the fence and losing the operational signal along with the leak.
  const { capture, sink } = captureSink();
  reportBackupOperation(sink, {
    operation: 'restore',
    outcome: 'refused',
    durationMs: 4,
    errorCode: telemetryErrorCode(withCode(SENTINELS.databaseUrl)),
  });
  assert.equal(capture.records().length, 1, 'the signal survives a junk code');
  assert.equal(capture.records()[0].attributes.errorCode, undefined);
  assert.equal(sink.status().rejected, 0);
  assertStructurallyBounded(capture.records());
  assertNoSentinel(capture.records(), 'junk error code');
});

// ───────────────────────────────────────────── producer 1: durable jobs

const jobActor = Object.freeze({ type: 'system', id: 'v4c-worker' });

function jobFixture(t, telemetry) {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => { try { database.close(); } catch { /* already closed */ } });
  let instant = Date.parse('2026-09-01T09:00:00.000Z');
  const clock = () => new Date(instant).toISOString();
  const store = createDurableJobStore({
    storage: database.storage, tenantId: SENTINELS.tenantId, clock,
  });
  const registry = createDurableJobHandlerRegistry();
  const worker = createDurableJobWorker({
    store, registry, workerId: SENTINELS.workerId, actor: jobActor, clock, telemetry,
  });
  return { database, store, registry, worker, advance(ms) { instant += ms; } };
}

const jobInput = Object.freeze({
  kind: 'named-action',
  handler: { name: 'run-follow-up', contract: 1, version: 1 },
  payload: { note: SENTINELS.payloadValue },
  idempotencyRoot: SENTINELS.idempotencyRoot,
});

test('a durable job reports claimed, succeeded and terminal failure without exporting one identifier', async (t) => {
  const { capture, sink } = captureSink();
  const fixture = jobFixture(t, sink);
  fixture.registry.register({
    name: 'run-follow-up', version: 1, kind: 'named-action',
    async execute() { fixture.advance(120); return { outcomeReference: SENTINELS.outcomeReference }; },
  });
  await fixture.store.enqueue(jobInput, { actor: { type: 'user', id: 'v4c-operator' } });
  fixture.worker.start();
  const settled = await fixture.worker.poll();
  assert.equal(settled.state, 'succeeded');

  const claimed = withSignal(capture, 'accordo.durable_job.claimed');
  assert.equal(claimed.length, 1);
  assert.deepEqual(claimed[0].attributes, { attempt: 1, handler: 'run-follow-up', kind: 'named-action' });
  const executions = withSignal(capture, 'accordo.durable_job.execution');
  assert.equal(executions.length, 1);
  assert.equal(executions[0].kind, 'run');
  assert.deepEqual(executions[0].attributes, {
    attempt: 1, durationMs: 120, handler: 'run-follow-up', kind: 'named-action', state: 'succeeded',
  });

  // Terminal failure: no handler registered for a second kind.
  await fixture.store.enqueue({
    ...jobInput, kind: 'unregistered-kind', idempotencyRoot: `${SENTINELS.idempotencyRoot}-2`,
  }, { actor: { type: 'user', id: 'v4c-operator' } });
  const failed = await fixture.worker.poll();
  assert.equal(failed.state, 'failed_terminal');
  const failures = withSignal(capture, 'accordo.durable_job.execution')
    .filter((record) => record.attributes.state === 'failed_terminal');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].attributes.errorCode, 'JOB_HANDLER_NOT_REGISTERED');
  assert.equal(failures[0].attributes.kind, 'unregistered-kind');

  await fixture.worker.close();
  assertStructurallyBounded(capture.records());
  assertNoSentinel(capture.records(), 'durable job telemetry');
  assert.equal(sink.status().rejected, 0, 'no producer emitted a signal the fence had to refuse');
});

test('a worker with no telemetry behaves identically and a rejecting sink cannot change a job outcome', async (t) => {
  const plain = jobFixture(t, undefined);
  plain.registry.register({ name: 'run-follow-up', version: 1, kind: 'named-action', async execute() { return {}; } });
  await plain.store.enqueue(jobInput, { actor: { type: 'user', id: 'v4c-operator' } });
  plain.worker.start();
  assert.equal((await plain.worker.poll()).state, 'succeeded');
  await plain.worker.close();

  // A sink whose exporter throws on every call must not reach the job path.
  const hostile = defineTelemetryExporter({
    name: 'hostile', contract: 1,
    emitLog() { throw new AppError('exporter down', { code: 'EXPORTER_DOWN', status: 500 }); },
    emitMetric() { throw new Error('exporter down'); },
    emitRun() { throw new Error('exporter down'); },
  });
  const sink = createTelemetrySink({ exporter: hostile });
  const instrumented = jobFixture(t, sink);
  instrumented.registry.register({ name: 'run-follow-up', version: 1, kind: 'named-action', async execute() { return {}; } });
  await instrumented.store.enqueue(jobInput, { actor: { type: 'user', id: 'v4c-operator' } });
  instrumented.worker.start();
  const settled = await instrumented.worker.poll();
  assert.equal(settled.state, 'succeeded', 'a failing exporter never changes a business outcome');
  await instrumented.worker.close();
  assert.ok(sink.status().failed >= 2, 'every exporter throw is counted');
  assert.equal(sink.status().dropped, 0);
});

// Producer 2, the transactional outbox, is PostgreSQL-only by contract: write
// outcomes refuse SQLite, so there is no committed effect to dispatch here.
// Its dispatch telemetry is proved in
// `tests/spine-v4c-observability-export-postgresql.test.js`.

// ─────────────────────────── producer 3: PostgreSQL lease and readiness

test('writer readiness reports transitions only, and reports the lease as a bounded remaining duration', () => {
  const { capture, sink } = captureSink();
  const observer = createWriterReadinessObserver(sink);
  const lease = { expiresAt: '2026-09-01T09:01:00.000Z' };
  const held = describeWriterHealth(lease, () => Date.parse('2026-09-01T09:00:00.000Z'), false);
  assert.equal(held.ready, true);

  assert.equal(observer.observe(held, { ...lease, now: '2026-09-01T09:00:00.000Z' }), true);
  assert.equal(observer.observe(held, { ...lease, now: '2026-09-01T09:00:10.000Z' }), false,
    'an unchanged readiness emits nothing, however often it is asked');
  assert.equal(observer.observe(held, { ...lease, now: '2026-09-01T09:00:20.000Z' }), false);

  const expired = describeWriterHealth(lease, () => Date.parse('2026-09-01T09:02:00.000Z'), false);
  assert.equal(expired.ready, false);
  assert.equal(expired.reason, 'WRITER_LEASE_EXPIRED');
  // A refusal storm: fifty guarded writes, one transition.
  for (let index = 0; index < 50; index += 1) {
    observer.observe(expired, { ...lease, now: '2026-09-01T09:02:00.000Z' });
  }
  const released = describeWriterHealth(lease, () => Date.parse('2026-09-01T09:02:00.000Z'), true);
  observer.observe(released, { ...lease, now: '2026-09-01T09:02:00.000Z' });

  const readiness = withSignal(capture, 'accordo.postgresql.readiness');
  assert.deepEqual(readiness.map((record) => record.attributes), [
    { adapter: 'postgresql', ready: true },
    { adapter: 'postgresql', ready: false, reason: 'WRITER_LEASE_EXPIRED' },
  ], 'two transitions, not fifty-two observations');

  const gauge = withSignal(capture, 'accordo.postgresql.writer_lease_remaining_ms');
  assert.equal(gauge.length, 2);
  assert.equal(gauge[0].unit, 'ms');
  assert.equal(gauge[0].value, 60_000);
  assert.equal(gauge[1].value, -60_000, 'an expired lease reports a negative remainder, not a leaked instant');
  assertStructurallyBounded(capture.records());
  assertNoSentinel(capture.records(), 'readiness telemetry');
});

// ────────────────────────────────────── producer 4: backup and restore

test('backup reports success and refusal without the bundle path, the connection or the manifest', async (t) => {
  const { capture, sink } = captureSink();
  const fixture = await backupFixture(t, sink);

  const created = await fixture.operations.create({ bundlePath: fixture.bundlePath });
  assert.equal(created.bundleCommitted, true);
  await assert.rejects(
    () => fixture.operations.create({ bundlePath: fixture.bundlePath }),
    (error) => error.code === 'BACKUP_DESTINATION_EXISTS',
  );
  await fixture.operations.verify({ bundlePath: fixture.bundlePath, expected: fixture.expected });
  await assert.rejects(
    () => fixture.operations.verify({ bundlePath: fixture.bundlePath, expected: { ...fixture.expected, artifactDigest: '0'.repeat(64) } }),
    (error) => typeof error.code === 'string',
  );

  const runs = withSignal(capture, 'accordo.backup.operation');
  assert.deepEqual(runs.map((record) => [record.attributes.operation, record.attributes.outcome]), [
    ['create', 'succeeded'], ['create', 'refused'], ['verify', 'succeeded'], ['verify', 'refused'],
  ]);
  assert.equal(runs[1].attributes.errorCode, 'BACKUP_DESTINATION_EXISTS');
  assert.equal(runs[0].attributes.errorCode, undefined, 'a success carries no error code');
  assertStructurallyBounded(capture.records());
  assertNoSentinel(capture.records(), 'backup telemetry');
});

test('a restore that leaves the target possibly partial is reported as such, not as a clean refusal', async (t) => {
  const { capture, sink } = captureSink();
  const fixture = await backupFixture(t, sink, { partialRestore: true });
  await fixture.operations.create({ bundlePath: fixture.bundlePath });
  await assert.rejects(
    () => fixture.operations.restore({
      bundlePath: fixture.bundlePath,
      expected: fixture.expected,
      target: fixture.target,
      actor: { type: 'user', id: 'v4c-backup-operator' },
      operationId: 'v4c-restore-1',
    }),
    (error) => error.code === 'BACKUP_RESTORE_PARTIAL',
  );
  const restores = withSignal(capture, 'accordo.backup.operation')
    .filter((record) => record.attributes.operation === 'restore');
  assert.equal(restores.length, 1);
  assert.equal(restores[0].attributes.outcome, 'possibly-partial');
  assert.equal(restores[0].attributes.errorCode, 'BACKUP_RESTORE_PARTIAL');
  assertStructurallyBounded(capture.records());
  assertNoSentinel(capture.records(), 'restore telemetry');
});

// ───────────────────────────────── failure, backpressure and lifecycle

test('backpressure is a bounded in-flight set with an observable drop count', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = defineTelemetryExporter({
    name: 'slow', contract: 1,
    emitLog: () => gate, emitMetric: () => gate, emitRun: () => gate,
  });
  const sink = createTelemetrySink({ exporter: slow, maxInFlight: 3 });
  const one = { signal: 'accordo.durable_job.worker_error', attributes: { errorCode: 'DURABLE_JOB_POLL_FAILED' } };
  assert.deepEqual([sink.emitLog(one), sink.emitLog(one), sink.emitLog(one)], [true, true, true]);
  assert.equal(sink.emitLog(one), false, 'the fourth is dropped, not queued');
  assert.equal(sink.emitLog(one), false);
  assert.equal(sink.status().dropped, 2);
  assert.equal(sink.status().inFlight, 3);
  release();
  const flushed = await sink.flush();
  assert.equal(flushed.flushed, true);
  // The counter emission is itself subject to backpressure — it was dropped
  // too, which is exactly the honest cumulative behaviour, not a miscount.
  assert.ok(flushed.dropped >= 2, 'the drop count is observable in process');
  await sink.close();
});

test('the drop, rejection and exporter-failure counters reach the exporter itself, once per flush', async () => {
  const { capture, sink } = captureSink({ maxInFlight: 1 });
  sink.emitLog({ signal: 'accordo.not.a.signal', attributes: {} });
  await sink.flush();
  const counters = capture.records().filter((record) => record.signal.startsWith('accordo.telemetry.'));
  assert.deepEqual(counters.map((record) => [record.signal, record.value, record.unit]), [
    ['accordo.telemetry.rejected', 1, 'count'],
  ]);
  await sink.close();
});

test('flush and close have deadlines a hanging exporter cannot outlive, and leak no timer', async () => {
  const hang = defineTelemetryExporter({
    name: 'hang', contract: 1,
    emitLog: () => new Promise(() => {}), emitMetric: () => new Promise(() => {}), emitRun: () => new Promise(() => {}),
    flush: () => new Promise(() => {}),
    close: () => new Promise(() => {}),
  });
  const sink = createTelemetrySink({ exporter: hang, flushTimeoutMs: 25, closeTimeoutMs: 25 });
  sink.emitLog({ signal: 'accordo.durable_job.worker_error', attributes: { errorCode: 'DURABLE_JOB_POLL_FAILED' } });
  const flushed = await sink.flush();
  assert.equal(flushed.flushed, false);
  assert.equal(flushed.code, 'TELEMETRY_FLUSH_TIMEOUT');
  const closed = await sink.close();
  assert.equal(closed.closed, true);
  assert.equal(closed.drained, false);
  assert.equal(closed.code, 'TELEMETRY_CLOSE_TIMEOUT');
  // A leaked deadline timer would keep the loop alive past this test; the
  // handle count is the assertion that the `finally` actually cleared them.
  const timers = process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout');
  assert.equal(timers.length, 0, `a deadline timer leaked: ${timers.join(',')}`);
});

test('close is idempotent, calls the exporter once, and turns later emissions into counted drops', async () => {
  let closes = 0;
  let flushes = 0;
  const counting = defineTelemetryExporter({
    name: 'counting', contract: 1,
    emitLog() {}, emitMetric() {}, emitRun() {},
    flush() { flushes += 1; },
    close() { closes += 1; },
  });
  const sink = createTelemetrySink({ exporter: counting });
  const one = { signal: 'accordo.durable_job.worker_error', attributes: { errorCode: 'DURABLE_JOB_POLL_FAILED' } };
  assert.equal(sink.emitLog(one), true);
  const [first, second, third] = await Promise.all([sink.close(), sink.close(), sink.close()]);
  assert.equal(closes, 1, 'the exporter is closed exactly once no matter how many shutdown paths reach it');
  assert.equal(first.closed, true);
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
  assert.equal(sink.emitLog(one), false, 'a post-close emission is a counted drop, never an exception');
  assert.equal(sink.status().dropped, 1);
  assert.equal(sink.status().closed, true);
  assert.equal(flushes, 1);
});

test('an exporter that rejects asynchronously is counted and never rejects into a producer', async () => {
  const rejecting = defineTelemetryExporter({
    name: 'rejecting', contract: 1,
    emitLog: async () => { throw new Error(SENTINELS.errorMessage); },
    emitMetric: async () => { throw new Error(SENTINELS.errorMessage); },
    emitRun: async () => { throw new Error(SENTINELS.errorMessage); },
  });
  const sink = createTelemetrySink({ exporter: rejecting });
  assert.equal(sink.emitLog({ signal: 'accordo.durable_job.worker_error', attributes: { errorCode: 'DURABLE_JOB_POLL_FAILED' } }), true);
  const flushed = await sink.flush();
  assert.equal(flushed.flushed, true);
  assert.equal(sink.status().failed, 1);
  await sink.close();
});

test('constructing a sink starts no timer, no socket and no background process', async () => {
  const before = process.getActiveResourcesInfo().slice().sort();
  const { sink } = captureSink();
  assert.deepEqual(process.getActiveResourcesInfo().slice().sort(), before,
    'a sink is inert until the application uses it');
  await sink.close();
});

// ─────────────────────────────────────────── the self-host stderr exporter

test('the json-stderr exporter writes one bounded JSON line per record, to stderr only', async () => {
  const lines = [];
  const exporter = createJsonStderrTelemetryExporter({ write: (line) => lines.push(line) });
  const sink = createTelemetrySink({ exporter });
  sink.emitRun({
    signal: 'accordo.backup.operation',
    attributes: { operation: 'restore', outcome: 'refused', durationMs: 12, errorCode: 'BACKUP_TARGET_NOT_EMPTY' },
  });
  sink.emitLog({
    signal: 'accordo.durable_job.claimed',
    attributes: { kind: 'named-action', handler: 'run-follow-up', attempt: 3 },
  });
  await sink.close();
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.endsWith('\n'), true, 'one record, one line');
    assert.equal(line.slice(0, -1).includes('\n'), false);
  }
  // The raw serialized bytes, not only the objects, are scanned.
  assertNoSentinel(lines.join(''), 'json-stderr bytes');
  assertStructurallyBounded(lines.map((line) => JSON.parse(line)));
  assert.deepEqual(JSON.parse(lines[0]), {
    contract: 1, kind: 'run', signal: 'accordo.backup.operation',
    attributes: { durationMs: 12, errorCode: 'BACKUP_TARGET_NOT_EMPTY', operation: 'restore', outcome: 'refused' },
  });
});

test('a producer given a sentinel-laden world exports nothing of it, end to end', async (t) => {
  const lines = [];
  const capture = createCaptureTelemetryExporter();
  const stderr = createJsonStderrTelemetryExporter({ write: (line) => lines.push(line) });
  const both = defineTelemetryExporter({
    name: 'tee', contract: 1,
    emitLog(record) { capture.exporter.emitLog(record); stderr.emitLog(record); },
    emitMetric(record) { capture.exporter.emitMetric(record); stderr.emitMetric(record); },
    emitRun(record) { capture.exporter.emitRun(record); stderr.emitRun(record); },
  });
  const sink = createTelemetrySink({ exporter: both });

  const fixture = jobFixture(t, sink);
  fixture.registry.register({
    name: 'run-follow-up', version: 1, kind: 'named-action',
    async execute() {
      // Everything a hostile or careless handler could put in front of the
      // exporter: a driver-shaped message, a locator, a secret reference.
      throw Object.assign(new Error(SENTINELS.errorMessage), {
        code: 'JOB_HANDLER_BUSY',
        detail: SENTINELS.databaseUrl,
        connectionString: `postgresql://u:${SENTINELS.password}@${SENTINELS.host}/db`,
        secretRef: SENTINELS.secretReference,
      });
    },
  });
  await fixture.store.enqueue(jobInput, { actor: { type: 'user', id: 'v4c-operator' } });
  fixture.worker.start();
  await fixture.worker.poll();
  await fixture.worker.close();
  await sink.close();

  assert.ok(capture.records().length >= 2, 'the run really did report');
  assertStructurallyBounded(capture.records());
  assertNoSentinel(capture.records(), 'end-to-end captured records');
  assertNoSentinel(lines.join(''), 'end-to-end stderr bytes');
  assert.equal(lines.join('').includes('JOB_HANDLER_BUSY'), true, 'the bounded code is what survives');
});
