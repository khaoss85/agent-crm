// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase } from '../packages/core/src/database.js';
import { createExecutionRunStore } from '../packages/core/src/execution-run-store.js';
import { runRecordAction, writeTrace } from '../packages/core/src/action-runtime.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import { WorkflowEngine } from '../packages/workflows/src/engine.js';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * **Production Spine v2 M2C — the execution-run store.**
 *
 * Two runtimes used to prepare their own SQLite statements against
 * `workflow_runs` and `trace_spans`: the workflow engine, which opens a run and
 * closes it step by step, and the action runtime's `writeTrace`, which persists
 * a run that has already finished. They now share one internal core store
 * behind Storage Contract v1. These tests prove the move changed nothing a
 * caller can observe — the same rows, the same result and exception shapes, the
 * same step and span ordering, the same compensation, the same best-effort
 * trace semantics, and the same evidence after a restart.
 */

// ---------------------------------------------------------------------------
// The structural guard
// ---------------------------------------------------------------------------

/**
 * **What this guard is, stated exactly.**
 *
 * It is a *token scan* for the known spellings of direct driver access in two
 * named files. It catches regression by editing — someone reaching for
 * `database.raw` again — and that is worth having, because that is how the
 * driver actually comes back.
 *
 * **It does not prove unreachability, and must not be read as proving it.** No
 * regex can: `const d = database; const r = d['r' + 'aw'];` defeats any pattern
 * written here, and chasing that is a losing game rather than a stricter guard.
 * A test named for a guarantee it cannot deliver is the same reassurance the
 * falsification kit refuses when a mutation stops aiming at anything — so this
 * one is named for what it does.
 *
 * The pattern set is M2B's, unchanged and deliberately so: one milestone
 * hardening a guard and the next writing a weaker copy is how a repository ends
 * up with two answers to the same question. Every spelling was watched failing
 * against these two files by construction.
 */
const RAW_DRIVER_SPELLINGS = Object.freeze([
  // `database.raw`, `database?.raw`, `this.database.raw`
  /database\s*\??\.\s*raw\b/,
  // `.raw.prepare(`, `?.raw?.exec(`
  /\??\.\s*raw\s*\??\.\s*(?:prepare|exec)\s*\(/,
  // `database['raw']`, `database?.["raw"]`
  /database\s*\??\.?\s*\[\s*['"]raw['"]\s*\]/,
  // `const { raw } = database`, `const { raw, storage } = this.database`
  /\{[^{}]*\braw\b[^{}]*\}\s*=\s*[^;\n]*\bdatabase\b/i,
  // the driver constructor itself
  /\bDatabaseSync\b/,
]);

/** @param {string} source */
const rawDriverSpelling = (source) => RAW_DRIVER_SPELLINGS.find((pattern) => pattern.test(source)) ?? null;

/**
 * The two files M2C declared, and nothing else. Work's transaction-context
 * check in `packages/work/src/follow-up.js` and the adapter internals in
 * `packages/core/src/database.js`, `core-adapters.js` and `spine-store.js` still
 * reach the driver, deliberately, and this assertion makes no claim about them.
 */
const M2C_SLICE = Object.freeze([
  'packages/workflows/src/engine.js',
  'packages/core/src/action-runtime.js',
]);

test('the two migrated files carry no known spelling of direct driver access', () => {
  for (const path of M2C_SLICE) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const found = rawDriverSpelling(source);
    assert.equal(found, null,
      `${path} must persist runs and spans through the structured storage seam, but matched ${found}`);
  }
});

/**
 * **A guard nobody has watched fail is not a guard.** Every spelling the scan
 * claims to cover is pinned here, and each was additionally verified by
 * construction — written into a migrated file, the guard watched failing, the
 * file restored.
 */
test('the scan catches the spellings it claims to cover', () => {
  const escapes = [
    'const insert = database.raw.prepare(sql);',
    'const insert = database?.raw.prepare(sql);',
    'const insert = database?.raw?.prepare(sql);',
    'const driver = tasks?.database?.raw;',
    'const driver = deps.database ?. raw;',
    'this.database.raw.prepare(sql).run(runId);',
    "const insert = database['raw'].prepare(sql);",
    'const insert = database["raw"].prepare(sql);',
    "const insert = database?.['raw'].prepare(sql);",
    'const { raw } = database;',
    'const { raw, storage } = this.database;',
    'insert.run(...); database.raw.exec("COMMIT");',
    'const db = new DatabaseSync(":memory:");',
  ];
  for (const escape of escapes) {
    assert.notEqual(rawDriverSpelling(escape), null, `the scan must catch: ${escape}`);
  }
  // …and it does not fire on the seam the two files legitimately use, nor on
  // unrelated identifiers that merely contain the word.
  for (const allowed of [
    'database.storage.sync.execute(statement);',
    'const rawBody = Buffer.from(params.rawBody);',
    'createExecutionRunStore(database).recordRun(run);',
    'this.runs = createExecutionRunStore(database);',
    "const kinds = ['raw', 'cooked'];",
  ]) {
    assert.equal(rawDriverSpelling(allowed), null, `the scan must allow: ${allowed}`);
  }
});

/**
 * **The limitation, asserted rather than described.** These are real escapes the
 * scan does not catch, and pinning them here is the honest half of the claim: a
 * reader who assumes this guard proves unreachability can run this test and see
 * that it does not.
 */
test('the scan is a token scan, and cannot prove unreachability', () => {
  for (const undetected of [
    "const d = database; const r = d['r' + 'aw'];",
    'const key = "raw"; const r = handle[key];',
    'const r = Reflect.get(database, "ra" + "w");',
  ]) {
    assert.equal(rawDriverSpelling(undetected), null,
      `this guard is a token scan and does not claim to catch: ${undetected}`);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memory(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  return database;
}

/** A file-backed database, because a restart is a second connection to a file. */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2c-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'runs.sqlite');
}

// Raw reads, in a test file, on purpose: the point of several assertions below
// is exactly what the physical row holds, which a mapped domain object hides.
//
// Ordered by `rowid`, which is insert order. Deliberately NOT by `started_at`:
// two spans of one fast run share a millisecond, and a tie broken by a random
// UUID would make these assertions flaky about something that is not the claim.
// The production read orders by `started_at` and always has — a tie there is
// resolved by the scan, which is why `tests/workflow.test.js` can assert a
// three-span order at all.
const runRows = (database) => database.raw
  .prepare('SELECT * FROM workflow_runs ORDER BY rowid').all()
  // node:sqlite hands back null-prototype rows; compare plain data.
  .map((row) => ({ ...row }));

const spanRows = (database, runId) => database.raw
  .prepare('SELECT * FROM trace_spans WHERE run_id = ? ORDER BY rowid').all(runId)
  .map((row) => ({ ...row }));

/** A store whose id and clock are pinned, so a row can be asserted whole. */
function pinned(database, over = {}) {
  let issued = 0;
  let tick = 0;
  return createExecutionRunStore(database, {
    newId: () => `id-${++issued}`,
    clock: () => `2026-08-27T09:00:0${tick++}.000Z`,
    ...over,
  });
}

const recordedRun = (over = {}) => ({
  runId: 'run-1',
  workflowName: 'lead.qualify',
  status: 'completed',
  input: { recordId: 'r1' },
  output: { ok: true },
  error: null,
  startedAt: '2026-08-27T08:00:00.000Z',
  steps: [{ name: 'lead.qualify', status: 'completed' }],
  ...over,
});

/** Capture `console.error` for the span of one call. */
async function withCapturedErrors(fn) {
  const original = console.error;
  /** @type {string[]} */
  const logged = [];
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const value = await fn();
    return { value, logged };
  } finally {
    console.error = original;
  }
}

/**
 * The action runtime, driven directly with the minimal harness its own source
 * anticipates ("may be absent in minimal test harnesses"). It is the real
 * `runRecordAction`, the real event bus and a real database — only the module
 * registry and the record are stubs, because the claim under test is about the
 * trace it writes, not about generated modules.
 */
function actionHarness(database, definition) {
  const service = {
    get: (id) => ({ id, status: 'open' }),
    applyManaged: () => {},
  };
  return (over = {}) => runRecordAction({
    database,
    events: new EventBus(),
    services: {},
    registry: { get: () => definition },
    modules: { get: (name) => ({ name, service }) },
    module: 'thing',
    action: 'do',
    recordId: 'r1',
    input: {},
    actor: { type: 'user', id: 'tester' },
    ...over,
  });
}

const okAction = {
  module: 'thing', name: 'do', actionContract: 1, input: [],
  execute: () => ({ ok: true }),
};

// ---------------------------------------------------------------------------
// The store — what it writes
// ---------------------------------------------------------------------------

test('startRun writes a running row with the store\'s own id and clock, and SQL NULL everywhere else', (t) => {
  const database = memory(t);
  const store = pinned(database);

  const runId = store.startRun({ workflowName: 'demo', input: { a: 1 } });

  assert.equal(runId, 'id-1');
  assert.deepEqual(runRows(database), [{
    id: 'id-1',
    workflow_name: 'demo',
    status: 'running',
    input_json: '{"a":1}',
    // Not the string "null": the columns an open run has nothing to say about
    // are SQL NULL, exactly as the statement this replaced left them.
    output_json: null,
    error: null,
    started_at: '2026-08-27T09:00:00.000Z',
    finished_at: null,
  }]);
});

test('a span opens running with its own input and closes completed with its output', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const runId = store.startRun({ workflowName: 'demo', input: { a: 1 } });
  const spanId = store.startSpan({ runId, name: 'load', input: { input: { a: 1 }, state: {} } });

  assert.deepEqual(spanRows(database, runId), [{
    id: 'id-2',
    run_id: runId,
    parent_span_id: null,
    name: 'load',
    status: 'running',
    input_json: '{"input":{"a":1},"state":{}}',
    output_json: null,
    error: null,
    started_at: '2026-08-27T09:00:01.000Z',
    finished_at: null,
  }]);

  store.completeSpan({ spanId, output: { loaded: true } });
  const [span] = spanRows(database, runId);
  assert.equal(span.status, 'completed');
  assert.equal(span.output_json, '{"loaded":true}');
  assert.equal(span.finished_at, '2026-08-27T09:00:02.000Z');
  // Closing a span never touches what it was given.
  assert.equal(span.input_json, '{"input":{"a":1},"state":{}}');
  assert.equal(span.error, null);
});

test('a step that returns nothing still records the JSON string "null", as it always did', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const runId = store.startRun({ workflowName: 'demo', input: null });
  const spanId = store.startSpan({ runId, name: 'silent', input: null });
  store.completeSpan({ spanId, output: undefined });
  assert.equal(spanRows(database, runId)[0].output_json, 'null');
});

test('a failed span records the message and finishes, leaving its output NULL', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const runId = store.startRun({ workflowName: 'demo', input: null });
  const spanId = store.startSpan({ runId, name: 'boom', input: null });

  store.failSpan({ spanId, error: 'it exploded' });

  const [span] = spanRows(database, runId);
  assert.equal(span.status, 'failed');
  assert.equal(span.error, 'it exploded');
  assert.equal(span.output_json, null);
  assert.equal(span.finished_at, '2026-08-27T09:00:02.000Z');
});

test('completeRun and failRun write the statuses, outputs and finish instants the engine wrote', (t) => {
  const database = memory(t);
  const store = pinned(database);

  const completed = store.startRun({ workflowName: 'a', input: null });
  store.completeRun({ runId: completed, output: { done: true } });
  const failed = store.startRun({ workflowName: 'b', input: null });
  store.failRun({ runId: failed, error: 'nope', output: { partial: 1 } });

  const rows = Object.fromEntries(runRows(database).map((row) => [row.workflow_name, row]));
  assert.equal(rows.a.status, 'completed');
  assert.equal(rows.a.output_json, '{"done":true}');
  assert.equal(rows.a.error, null);
  assert.ok(rows.a.finished_at);
  // A failed run keeps the state it had reached: that is what its trace is for.
  assert.equal(rows.b.status, 'failed');
  assert.equal(rows.b.error, 'nope');
  assert.equal(rows.b.output_json, '{"partial":1}');
  assert.ok(rows.b.finished_at);
});

test('recordRun writes one finish instant across the run and every span, each carrying the run\'s own start', (t) => {
  const database = memory(t);
  const store = pinned(database);

  store.recordRun(recordedRun({
    steps: [
      { name: 'thing.do', status: 'completed' },
      { name: 'events.dispatch', status: 'failed', error: 'subscriber exploded' },
    ],
  }));

  const [run] = runRows(database);
  assert.equal(run.id, 'run-1');
  assert.equal(run.started_at, '2026-08-27T08:00:00.000Z');
  const spans = spanRows(database, 'run-1');
  assert.equal(spans.length, 2);
  for (const span of spans) {
    // One clock reading covers the whole write, because one is what the
    // statement this replaced took.
    assert.equal(span.finished_at, run.finished_at);
    // A recorded span has no start of its own: it carries the run's.
    assert.equal(span.started_at, run.started_at);
    // …and no input of its own either. SQL NULL, not the string "null".
    assert.equal(span.input_json, null);
    assert.equal(span.parent_span_id, null);
  }
  assert.deepEqual(spans.map((span) => [span.name, span.status, span.error]), [
    ['thing.do', 'completed', null],
    ['events.dispatch', 'failed', 'subscriber exploded'],
  ]);
  // A step with no output of its own still stores an encoded null.
  assert.deepEqual(spans.map((span) => span.output_json), ['null', 'null']);
});

test('a failed recorded run stores the JSON string "null" as its output, not SQL NULL', (t) => {
  const database = memory(t);
  pinned(database).recordRun(recordedRun({
    status: 'failed', output: null, error: 'it broke',
    steps: [{ name: 'thing.do', status: 'failed', error: 'it broke' }],
  }));
  const [run] = runRows(database);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'it broke');
  // `safeJson(null)` produced this string, and a reader that distinguishes
  // "no output recorded" from "the output was null" would break if it moved.
  assert.equal(run.output_json, 'null');
});

test('an unserializable value becomes a marker rather than an exception', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const cyclic = /** @type {any} */ ({});
  cyclic.self = cyclic;
  const runId = store.startRun({ workflowName: 'demo', input: cyclic });
  assert.equal(runRows(database)[0].input_json, '{"unserializable":true}');
  assert.equal(typeof runId, 'string');
});

// ---------------------------------------------------------------------------
// The store — how it fails
// ---------------------------------------------------------------------------

test('the store refuses a database without Storage Contract v1', () => {
  for (const handle of [undefined, null, {}, { storage: {} }, { storage: { sync: null } }]) {
    assert.throws(() => createExecutionRunStore(handle), (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /requires a database with Storage Contract v1/);
      return true;
    });
  }
});

test('an injected id source is validated on what it returns, not only that it is callable', (t) => {
  const database = memory(t);
  // Construction-time misuse raises TypeError, exactly as `resolveClock` does.
  assert.throws(() => createExecutionRunStore(database, { newId: 'nope' }), TypeError);

  // A bad *value* is on its way to a write, so it carries the framework's code.
  for (const bad of [null, 42, '', '   ', 'a'.repeat(201), 'has\u0000null']) {
    const store = createExecutionRunStore(database, { newId: () => /** @type {any} */ (bad) });
    assert.throws(() => store.startRun({ workflowName: 'demo', input: null }),
      (error) => error.code === 'VALIDATION_ERROR');
  }
  // Nothing reached the table.
  assert.deepEqual(runRows(database), []);
});

test('an injected clock is validated on every call, before anything is written', (t) => {
  const database = memory(t);
  assert.throws(() => createExecutionRunStore(database, { clock: 'nope' }), TypeError);
  const store = createExecutionRunStore(database, { clock: () => 'yesterday' });
  assert.throws(() => store.startRun({ workflowName: 'demo', input: null }),
    /canonical UTC ISO instant/);
  assert.deepEqual(runRows(database), []);
});

test('the identity rule is one rule: every stored identity string gets the same bounds', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const long = 'x'.repeat(201);
  const control = 'a\u0007b';

  const refusals = [
    () => store.startRun({ workflowName: long, input: null }),
    () => store.startRun({ workflowName: control, input: null }),
    () => store.startRun({ workflowName: '', input: null }),
    () => store.startRun({ workflowName: /** @type {any} */ (7), input: null }),
    () => store.startSpan({ runId: 'r', name: long, input: null }),
    () => store.startSpan({ runId: control, name: 'ok', input: null }),
    () => store.recordRun(recordedRun({ runId: control })),
    () => store.recordRun(recordedRun({ workflowName: long })),
    () => store.recordRun(recordedRun({ startedAt: control })),
    () => store.recordRun(recordedRun({ steps: [{ name: long, status: 'completed' }] })),
    // The Unicode separators and the C1 range, which a naive class misses.
    () => store.startRun({ workflowName: 'a\u2028b', input: null }),
    () => store.startRun({ workflowName: 'a\u2029b', input: null }),
    () => store.startRun({ workflowName: 'a\u009Bb', input: null }),
  ];
  for (const [index, refuse] of refusals.entries()) {
    assert.throws(refuse, (error) => error.code === 'VALIDATION_ERROR', `refusal ${index}`);
  }
  assert.deepEqual(runRows(database), []);
});

test('an error message keeps its newlines, because a trace of a failure must survive being written', (t) => {
  const database = memory(t);
  const store = pinned(database);
  // Real normalized messages wrap. The identity rule deliberately does not
  // apply here: refusing this would lose the trace of the failure it describes,
  // and because the trace write is best-effort the loss would be silent.
  const message = 'Validation failed:\n  - name is required\n  - value must be >= 0';
  const runId = store.startRun({ workflowName: 'demo', input: null });
  store.failRun({ runId, error: message, output: null });
  assert.equal(runRows(database)[0].error, message);

  store.recordRun(recordedRun({
    runId: 'run-2', status: 'failed', output: null, error: message,
    steps: [{ name: 'thing.do', status: 'failed', error: message }],
  }));
  assert.equal(spanRows(database, 'run-2')[0].error, message);
});

test('a status outside the schema\'s own CHECK set is refused in the framework\'s words', (t) => {
  const database = memory(t);
  const store = pinned(database);

  assert.throws(() => store.recordRun(recordedRun({ status: 'compensated' })),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /must be one of running, completed, failed/);
      return true;
    });
  assert.throws(() => store.recordRun(recordedRun({ steps: [{ name: 'x', status: 'skipped' }] })),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /must be one of running, completed, failed, compensated/);
      return true;
    });
  // The whole run is validated before the first row lands: a malformed step no
  // longer leaves an orphaned run row with no spans behind it.
  assert.deepEqual(runRows(database), []);
});

test('every argument shape is closed against unknown, symbol, non-enumerable and inherited fields', (t) => {
  const database = memory(t);
  const store = pinned(database);

  // An unnamed key is refused rather than dropped: a caller passing `spans`
  // instead of `steps` would otherwise write a run with no spans and be told it
  // succeeded.
  assert.throws(() => store.recordRun({ ...recordedRun(), spans: [] }),
    /unsupported field "spans"/);
  assert.throws(() => store.startRun(/** @type {any} */ ({ workflowName: 'a', input: null, extra: 1 })),
    /unsupported field "extra"/);

  // A symbol key, and a non-enumerable one: `Object.keys` sees neither.
  const symbolled = { ...recordedRun(), [Symbol('hidden')]: 1 };
  assert.throws(() => store.recordRun(symbolled), /unsupported field "Symbol\(hidden\)"/);
  const hidden = { ...recordedRun() };
  Object.defineProperty(hidden, 'sneaky', { value: 1, enumerable: false });
  assert.throws(() => store.recordRun(hidden), /unsupported field "sneaky"/);

  // Not a plain object: a class instance and a null-prototype bag carrying the
  // same fields are still not the shape this contract names.
  class Run {}
  assert.throws(() => store.recordRun(Object.assign(new Run(), recordedRun())), /must be a plain object/);
  assert.throws(() => store.recordRun(Object.assign(Object.create(null), recordedRun())), /must be a plain object/);
  assert.throws(() => store.startRun(/** @type {any} */ ([])), /must be a plain object/);

  // A required field must be an OWN property: refusing keys nobody named says
  // nothing about whether the named ones came from a polluted prototype.
  try {
    // eslint-disable-next-line no-extend-native
    /** @type {any} */ (Object.prototype).workflowName = 'injected';
    const { workflowName, ...withoutName } = recordedRun();
    assert.throws(() => store.recordRun(/** @type {any} */ (withoutName)),
      /requires own field "workflowName"/);
  } finally {
    delete (/** @type {any} */ (Object.prototype).workflowName);
  }
  assert.deepEqual(runRows(database), []);
});

test('recordRun refuses a non-iterable steps and caps a runaway one', (t) => {
  const database = memory(t);
  const store = pinned(database);

  for (const steps of [null, 7, {}, undefined]) {
    assert.throws(() => store.recordRun(recordedRun({ steps })),
      (error) => error.code === 'VALIDATION_ERROR' && /must be iterable/.test(error.message));
  }
  // An accidental infinite generator is a framework refusal, not an
  // out-of-memory crash.
  function* forever() {
    for (;;) yield { name: 'step', status: 'completed' };
  }
  assert.throws(() => store.recordRun(recordedRun({ steps: forever() })),
    /Too many trace spans in one run/);
  assert.deepEqual(runRows(database), []);
});

test('recordRun refuses a generator that issues the same span id twice in one run', (t) => {
  const database = memory(t);
  const store = createExecutionRunStore(database, { newId: () => 'always-the-same' });
  assert.throws(() => store.recordRun(recordedRun({
    steps: [{ name: 'a', status: 'completed' }, { name: 'b', status: 'completed' }],
  })), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.match(error.message, /issued the same id twice in one run/);
    return true;
  });
  assert.deepEqual(runRows(database), []);
});

test('no refusal leaks a driver message', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const attempts = [
    () => store.startRun({ workflowName: '', input: null }),
    () => store.recordRun(recordedRun({ status: 'nope' })),
    () => store.recordRun(recordedRun({ steps: 7 })),
    () => store.recordRun({ ...recordedRun(), spans: [] }),
    () => createExecutionRunStore(database, { newId: () => /** @type {any} */ (null) })
      .startSpan({ runId: 'r', name: 'n', input: null }),
  ];
  for (const attempt of attempts) {
    assert.throws(attempt, (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR', error.message);
      assert.doesNotMatch(error.message, /SQLITE|UNIQUE|constraint|CHECK|SQL|prepare/i, error.message);
      return true;
    });
  }
});

// ---------------------------------------------------------------------------
// The store — what it reads
// ---------------------------------------------------------------------------

test('getRun returns null for an id that matches nothing, and refuses nothing', (t) => {
  const database = memory(t);
  const store = pinned(database);
  assert.equal(store.getRun('nobody'), null);
  // The lookup key is a bound parameter, never rendered SQL. Refusing these
  // would turn a 404 on `GET /api/traces/:id` into a 400 — an observable change
  // to a public route, bought with no safety at all.
  for (const hostile of ['a\u0000b', 'x'.repeat(500), "'; DROP TABLE workflow_runs; --", '']) {
    assert.equal(store.getRun(hostile), null);
  }
  assert.equal(runRows(database).length, 0);
});

test('getRun returns the run with its spans in start order', (t) => {
  const database = memory(t);
  const store = pinned(database);
  const runId = store.startRun({ workflowName: 'demo', input: { a: 1 } });
  const first = store.startSpan({ runId, name: 'first', input: null });
  store.completeSpan({ spanId: first, output: 1 });
  const second = store.startSpan({ runId, name: 'second', input: null });
  store.completeSpan({ spanId: second, output: 2 });
  store.completeRun({ runId, output: { done: true } });

  const run = store.getRun(runId);
  assert.equal(run.id, runId);
  assert.equal(run.workflowName, 'demo');
  assert.deepEqual(run.input, { a: 1 });
  assert.deepEqual(run.output, { done: true });
  assert.deepEqual(run.spans.map((span) => span.name), ['first', 'second']);
  assert.deepEqual(run.spans.map((span) => span.output), [1, 2]);
  assert.equal(run.spans[0].parentSpanId, null);
});

test('listRuns clamps its page exactly as the engine did, and can never be issued unbounded', (t) => {
  const database = memory(t);
  const store = pinned(database);
  for (let index = 0; index < 5; index += 1) {
    store.startRun({ workflowName: index % 2 === 0 ? 'even' : 'odd', input: index });
  }

  // Newest first.
  assert.deepEqual(store.listRuns({}).map((run) => run.input), [4, 3, 2, 1, 0]);
  assert.equal(store.listRuns({ limit: 2 }).length, 2);
  // The floor and the ceiling of `Math.min(Math.max(limit ?? 100, 1), 500)`.
  assert.equal(store.listRuns({ limit: 0 }).length, 1);
  assert.equal(store.listRuns({ limit: -10 }).length, 1);
  assert.equal(store.listRuns({ limit: 10_000 }).length, 5);
  assert.equal(store.listRuns({}).length, 5);
  // Filters, and a filter value nobody defined is an empty list, not a refusal.
  assert.deepEqual(store.listRuns({ workflowName: 'even' }).map((run) => run.input), [4, 2, 0]);
  assert.deepEqual(store.listRuns({ status: 'running', workflowName: 'odd' }).map((run) => run.input), [3, 1]);
  assert.deepEqual(store.listRuns({ status: 'nonsense' }), []);
});

// ---------------------------------------------------------------------------
// Behaviour preservation — the workflow engine
// ---------------------------------------------------------------------------

/** @param {any} database @param {Array<any>} steps */
function engine(database, steps) {
  const instance = new WorkflowEngine({ database, services: { probe: true }, config: { tuned: 1 } });
  instance.register({ name: 'demo', description: 'demo', steps });
  return instance;
}

test('run() returns the same result shape and persists the same completed run', async (t) => {
  const database = memory(t);
  const workflows = engine(database, [
    { name: 'load', execute: () => ({ loaded: true }) },
    { name: 'decide', execute: ({ state }) => ({ decided: state.loaded }) },
  ]);

  const result = await workflows.run('demo', { id: 'x' }, { actor: { type: 'user', id: 'u' } });

  assert.deepEqual(Object.keys(result), ['runId', 'status', 'output']);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, { loaded: true, decided: true });
  const [run] = runRows(database);
  assert.equal(run.id, result.runId);
  assert.equal(run.workflow_name, 'demo');
  assert.equal(run.status, 'completed');
  assert.equal(run.input_json, '{"id":"x"}');
  assert.equal(run.output_json, '{"loaded":true,"decided":true}');
  assert.equal(run.error, null);
  assert.ok(run.started_at && run.finished_at);
  assert.deepEqual(spanRows(database, run.id).map((span) => [span.name, span.status]),
    [['load', 'completed'], ['decide', 'completed']]);
});

test('the step context still carries the run id, services, database and config', async (t) => {
  const database = memory(t);
  /** @type {any} */
  let seen;
  const workflows = engine(database, [{ name: 'peek', execute: (ctx) => { seen = ctx; return {}; } }]);
  const result = await workflows.run('demo', { id: 'x' }, { actor: { type: 'agent', id: 'bot' } });

  assert.equal(seen.runId, result.runId);
  assert.equal(seen.database, database);
  assert.deepEqual(seen.services, { probe: true });
  assert.deepEqual(seen.config, { tuned: 1 });
  assert.deepEqual(seen.actor, { type: 'agent', id: 'bot' });
  assert.deepEqual(seen.input, { id: 'x' });
});

test('a failing step fails the run, carries workflowRunId in details, and records the state as output', async (t) => {
  const database = memory(t);
  const workflows = engine(database, [
    { name: 'load', execute: () => ({ loaded: true }) },
    { name: 'boom', execute: () => { throw new Error('step exploded'); } },
    { name: 'never', execute: () => ({ never: true }) },
  ]);

  const failure = await workflows.run('demo', { id: 'x' }).then(
    () => assert.fail('the run must reject'), (error) => error);

  assert.equal(failure.message, 'step exploded');
  assert.equal(failure.details.workflowRunId, runRows(database)[0].id);
  const [run] = runRows(database);
  assert.equal(run.status, 'failed');
  assert.equal(run.error, 'step exploded');
  // The state the run had reached, not null: that is what a failed trace is for.
  assert.equal(run.output_json, '{"loaded":true}');
  assert.deepEqual(spanRows(database, run.id).map((span) => [span.name, span.status, span.error]), [
    ['load', 'completed', null],
    ['boom', 'failed', 'step exploded'],
  ]);
});

test('compensation runs in reverse over completed steps, and a compensation failure is logged, not thrown', async (t) => {
  const database = memory(t);
  /** @type {string[]} */
  const compensated = [];
  const workflows = engine(database, [
    { name: 'one', execute: () => ({ one: 1 }), compensate: () => { compensated.push('one'); } },
    { name: 'two', execute: () => ({ two: 2 }), compensate: () => { compensated.push('two'); throw new Error('rollback failed'); } },
    { name: 'boom', execute: () => { throw new Error('step exploded'); } },
  ]);

  const { value: failure, logged } = await withCapturedErrors(
    () => workflows.run('demo', {}).then(() => assert.fail('must reject'), (error) => error),
  );

  assert.equal(failure.message, 'step exploded');
  assert.deepEqual(compensated, ['two', 'one']);
  assert.ok(logged.some((line) => /compensation failed in two: rollback failed/.test(line)));
  assert.equal(runRows(database)[0].status, 'failed');
});

test('getRun refuses an unknown run with NotFoundError, and a hostile id is still a not-found', (t) => {
  const database = memory(t);
  const workflows = engine(database, [{ name: 'noop', execute: () => ({}) }]);
  for (const id of ['nobody', 'a\u0000b', 'x'.repeat(500)]) {
    assert.throws(() => workflows.getRun(id), (error) => {
      // A 404, not a 400. Validating the lookup key here would change a public
      // route's status code for an id nobody could ever have been issued.
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.status, 404);
      return true;
    });
  }
});

test('listRuns filters, orders and clamps exactly as it did', async (t) => {
  const database = memory(t);
  const workflows = new WorkflowEngine({ database, services: {} });
  workflows.register({ name: 'alpha', description: '', steps: [{ name: 's', execute: () => ({}) }] });
  workflows.register({ name: 'beta', description: '', steps: [{ name: 's', execute: () => { throw new Error('no'); } }] });
  await workflows.run('alpha', {});
  await workflows.run('alpha', {});
  await workflows.run('beta', {}).catch(() => {});

  assert.equal(workflows.listRuns().length, 3);
  assert.deepEqual(workflows.listRuns({ workflowName: 'alpha' }).map((run) => run.workflowName), ['alpha', 'alpha']);
  assert.deepEqual(workflows.listRuns({ status: 'failed' }).map((run) => run.workflowName), ['beta']);
  assert.equal(workflows.listRuns({ limit: 1 }).length, 1);
  assert.equal(workflows.listRuns({ limit: 0 }).length, 1);
  // Unknown filter keys are still ignored by the engine's public signature.
  assert.equal(workflows.listRuns(/** @type {any} */ ({ nonsense: true })).length, 3);
  // The mapped read shape, unchanged.
  assert.deepEqual(Object.keys(workflows.listRuns({ limit: 1 })[0]),
    ['id', 'workflowName', 'status', 'input', 'output', 'error', 'startedAt', 'finishedAt']);
  assert.deepEqual(Object.keys(workflows.getRun(workflows.listRuns({ limit: 1 })[0].id)),
    ['id', 'workflowName', 'status', 'input', 'output', 'error', 'startedAt', 'finishedAt', 'spans']);
});

test('a run survives a restart: a second connection to the same file reads it back', async (t) => {
  const path = workspace(t);
  const first = createDatabase({ path });
  const workflows = engine(first, [{ name: 'persisted', execute: () => ({ kept: true }) }]);
  const result = await workflows.run('demo', { id: 'x' });
  first.close();

  const second = createDatabase({ path });
  t.after(() => second.close());
  const reopened = new WorkflowEngine({ database: second, services: {} });
  const run = reopened.getRun(result.runId);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.output, { kept: true });
  assert.deepEqual(run.spans.map((span) => [span.name, span.status]), [['persisted', 'completed']]);
  assert.equal(reopened.listRuns().length, 1);
});

test('a run-row write failure still surfaces from run(), because it always did', async (t) => {
  const database = memory(t);
  const workflows = engine(database, [{ name: 'noop', execute: () => ({}) }]);
  const original = database.raw.prepare.bind(database.raw);
  database.raw.prepare = (sql) => {
    if (/^INSERT INTO "?workflow_runs\b/.test(sql)) throw new Error('disk is on fire');
    return original(sql);
  };
  t.after(() => { database.raw.prepare = original; });

  // The engine has never been best-effort about its own run row, and this
  // milestone did not make it so. Only the action runtime's trace is.
  await assert.rejects(workflows.run('demo', {}), /disk is on fire/);
});

test('a workflow run still leaves the same audit and notification evidence', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:', approvalThresholdCents: 5_000_000 });
  t.after(() => app.close());
  const { enterpriseRenewal } = await app.seedDemo();
  const actor = { type: 'agent', id: 'sales-copilot' };

  const before = app.audit.list({ entityType: 'opportunity', entityId: enterpriseRenewal.id }).length;
  const run = await app.workflows.run('request-opportunity-stage-change',
    { opportunityId: enterpriseRenewal.id, targetStage: 'proposal' }, { actor });

  assert.equal(run.output.outcome, 'approval_required');
  const audit = app.audit.list({ entityType: 'opportunity', entityId: enterpriseRenewal.id });
  assert.ok(audit.length > before, 'the workflow still writes audit rows');
  assert.ok(audit.some((entry) => entry.actorId === 'sales-copilot'),
    'the actor still travels with the write');
  // Trace and audit remain two independent records of the same run.
  assert.deepEqual(app.workflows.getRun(run.runId).spans.map((span) => span.status),
    ['completed', 'completed', 'completed']);
});

// ---------------------------------------------------------------------------
// Behaviour preservation — the action runtime's trace
// ---------------------------------------------------------------------------

test('a successful action writes exactly one completed run and its spans through the store', async (t) => {
  const database = memory(t);
  const result = await actionHarness(database, okAction)();

  assert.equal(result.ok, true);
  assert.equal(result.module, 'thing');
  const [run] = runRows(database);
  assert.equal(run.id, result.runId);
  assert.equal(run.workflow_name, 'thing.do');
  assert.equal(run.status, 'completed');
  assert.equal(run.error, null);
  assert.equal(run.output_json, '{"ok":true}');
  assert.ok(run.started_at && run.finished_at);
  const spans = spanRows(database, run.id);
  assert.deepEqual(spans.map((span) => [span.name, span.status]), [['thing.do', 'completed']]);
  // The recorded-run shape: no span input, the run's own start, one finish.
  assert.equal(spans[0].input_json, null);
  assert.equal(spans[0].started_at, run.started_at);
  assert.equal(spans[0].finished_at, run.finished_at);
  // The trace records the actor inside the run's input, which is what makes it
  // evidence about an actor rather than an unattributed write.
  assert.deepEqual(JSON.parse(run.input_json).actor, { type: 'user', id: 'tester' });
});

test('a failing action writes a failed run with the failure trace and the JSON string "null" output', async (t) => {
  const database = memory(t);
  const run = actionHarness(database, {
    ...okAction, execute: () => { throw new Error('action exploded'); },
  });

  const failure = await run().then(() => assert.fail('must reject'), (error) => error);

  assert.equal(failure.message, 'action exploded');
  const [row] = runRows(database);
  assert.equal(failure.details.workflowRunId, row.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'action exploded');
  assert.equal(row.output_json, 'null');
  assert.deepEqual(spanRows(database, row.id).map((span) => [span.name, span.status, span.error]),
    [['thing.do', 'failed', 'action exploded']]);
});

test('a trace write failure does not fail the action: best-effort survives the move', async (t) => {
  const database = memory(t);
  const original = database.raw.prepare.bind(database.raw);
  // The adapter quotes identifiers, so the interception matches both the quoted
  // spelling it now renders and the unquoted one it used to.
  database.raw.prepare = (sql) => {
    if (/^INSERT INTO "?workflow_runs\b/.test(sql)) throw new Error('trace disk is on fire');
    return original(sql);
  };
  t.after(() => { database.raw.prepare = original; });

  const { value: result, logged } = await withCapturedErrors(() => actionHarness(database, okAction)());

  // The caller must never be told to retry or compensate a committed write
  // because the evidence about it could not be filed.
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { ok: true });
  assert.ok(logged.some((line) => /failed to persist trace: trace disk is on fire/.test(line)),
    `the failure is logged, not thrown: ${JSON.stringify(logged)}`);
  assert.deepEqual(runRows(database), []);
});

test('writeTrace still throws, so its callers\' best-effort catch still has something to catch', (t) => {
  const database = memory(t);
  // If this ever stops throwing, every `try { writeTrace(...) } catch` in the
  // repository quietly becomes decoration and a malformed trace is lost in
  // silence instead of being logged.
  assert.throws(() => writeTrace(database, /** @type {any} */ (recordedRun({ status: 'nonsense' }))),
    (error) => error.code === 'VALIDATION_ERROR');
  assert.throws(() => writeTrace(/** @type {any} */ ({}), /** @type {any} */ (recordedRun())),
    (error) => error.code === 'VALIDATION_ERROR');
  assert.deepEqual(runRows(database), []);
});

test('writeTrace keeps its published signature and writes the same row it always did', (t) => {
  const database = memory(t);
  writeTrace(database, recordedRun({
    steps: [{ name: 'catalog.sync', status: 'completed', output: { counts: 3 } }],
  }));
  const [run] = runRows(database);
  assert.equal(run.id, 'run-1');
  assert.equal(run.status, 'completed');
  assert.equal(run.started_at, '2026-08-27T08:00:00.000Z');
  assert.deepEqual(spanRows(database, 'run-1').map((span) => [span.name, span.status, span.output_json]),
    [['catalog.sync', 'completed', '{"counts":3}']]);
});
