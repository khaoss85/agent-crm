// @ts-check

import { randomUUID } from 'node:crypto';
import { ValidationError } from './errors.js';
import { resolveClock } from './time.js';

/**
 * **The one place run and span lifecycle evidence is persisted.**
 *
 * Every execution this framework can explain afterwards leaves the same two
 * rows behind: a `workflow_runs` row saying what ran and how it ended, and a
 * `trace_spans` row per step saying the same about each part of it. Two very
 * different runtimes produce them — the workflow engine, which opens a run and
 * closes it step by step, and the action runtime's trace writer, which persists
 * a run that has already finished — and each of them used to prepare its own
 * statements against the SQLite driver by hand.
 *
 * Two copies of one persistence family is two places for the trace to drift
 * from itself, and the trace is the evidence a person reads when something went
 * wrong. This store is the single implementation, behind Storage Contract v1:
 * it renders no SQL, names no tables but its own two, and gives a caller no way
 * to reach the driver. It knows nothing about any domain — a workflow name is
 * an opaque string its callers choose.
 *
 * ### What it deliberately is not
 *
 * Not a workflow engine, not an event store, not a generic repository, not a
 * tracing-backend abstraction and not an ORM. It has no table parameter, no
 * predicate builder and no raw escape hatch. Its methods are exactly the
 * lifecycle its two consumers perform and nothing more: open a run, open a
 * span, close a span, close a run, persist a run that already finished, read
 * one run with its spans, list runs under a bounded filter.
 *
 * ### No transaction, deliberately
 *
 * Every statement here is a bare statement, because every statement it replaced
 * was. The engine opens a run row before its first step and closes it after the
 * last, which is not a transaction's shape; `recordRun` writes a run row and
 * then its spans, and a span failure leaving the run row behind is current
 * behaviour rather than a defect this store may quietly fix. Wrapping either in
 * `storage.transaction` would also risk `NESTED_TRANSACTION` at a call site
 * that is already inside one. This store throws, and the best-effort
 * `try`/`catch` that decides a trace failure must never mask an action's real
 * outcome (ADR-012/016) stays where it belongs — at the call site.
 */

/** The two tables this store persists into. Neither is a parameter, deliberately. */
const RUNS = 'workflow_runs';
const SPANS = 'trace_spans';

/** The `CHECK` sets the schema itself declares (`packages/core/src/database.js`). */
const RUN_STATUSES = Object.freeze(['running', 'completed', 'failed']);
const SPAN_STATUSES = Object.freeze(['running', 'completed', 'failed', 'compensated']);

/** The default `listRuns` page, and the ceiling above it. Both preserved from the engine. */
const DEFAULT_RUN_LIMIT = 100;
const MAX_RUN_LIMIT = 500;

/**
 * Bounds on identity text. Every one of these strings lands in a database row
 * *and* in evidence a person reads, so an unbounded one is both an unbounded
 * row and an unbounded page of output. 200 sits far above anything real — a
 * workflow name is `module.action`, and an id is a 36-character UUID.
 */
const MAX_IDENTITY = 200;

/**
 * One run's steps are the steps of one execution. The cap exists so an
 * accidental runaway generator is a framework refusal rather than an
 * out-of-memory crash; it is orders of magnitude above any real run, which
 * produces a handful.
 */
const MAX_SPANS = 10_000;

/**
 * Characters that never appear in a real identity and do appear in
 * log-splitting and terminal-escape payloads: C0, DEL, the C1 range, and the
 * Unicode line and paragraph separators.
 */
const FORBIDDEN_IDENTITY_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * **One rule for every piece of identity text this store handles.**
 *
 * Ids, workflow names, span names and the start instant are all stored in the
 * same rows and all read back into the same evidence, so they all earn the same
 * bounds. Applying the rule to some of them and not others is precisely what
 * produced a run of near-identical review findings in the milestone before this
 * one: one place validated, another not, the difference invisible until someone
 * went looking.
 *
 * **Two fields are deliberately exempt, and the exemption is the interesting
 * part.** `error` carries a normalized exception message, which legitimately
 * contains newlines — refusing them would refuse real failure paths, and
 * because the trace write is best-effort the refusal would *silently lose the
 * trace of the failure it was describing*. `input` and `output` go through
 * `encodeJson`, and `JSON.stringify` already escapes every control character.
 *
 * `subject` is the caller's own phrase, so the refusal still names the exact
 * field: a shared validator saying only "identity invalid" would trade a class
 * of bug for a loss of diagnosability.
 *
 * @param {unknown} value
 * @param {string} subject — how the refusal names this value
 * @param {unknown} [details]
 */
function assertIdentityText(value, subject, details) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${subject} must be a non-empty string`, details);
  }
  if (value.length > MAX_IDENTITY) {
    throw new ValidationError(
      `${subject} is too long (${value.length} characters; the limit is ${MAX_IDENTITY})`, details,
    );
  }
  if (FORBIDDEN_IDENTITY_TEXT.test(value)) {
    throw new ValidationError(`${subject} must not contain a control character`, details);
  }
  return value;
}

/**
 * **The other half of the `error` exemption above.** Exempting a message from
 * bounds and from the character class is not the same as accepting anything:
 * these columns are `TEXT` in a `STRICT` table, so a number or an object lands
 * on a driver datatype refusal, and because the trace write is best-effort that
 * refusal is swallowed and logged in the driver's words. A *type* check costs
 * the newline nothing and is the difference between "this store validates
 * everything except one field" and a rule with a stated exception.
 *
 * Deliberately no length bound: a normalized exception message has never had
 * one, and truncating the sentence a person reads when something failed would
 * be a behaviour change dressed as hardening.
 *
 * @param {unknown} value @param {string} subject @param {unknown} [details]
 */
function assertOptionalMessage(value, subject, details) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${subject} must be a string or null`, details);
  }
  return value;
}

/**
 * The status a row may carry, checked against the set the schema's own `CHECK`
 * constraint declares. The same values SQLite would refuse, refused earlier and
 * in this framework's words rather than the driver's.
 * @param {unknown} value @param {readonly string[]} allowed @param {string} subject @param {unknown} [details]
 */
function assertStatus(value, allowed, subject, details) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`${subject} must be one of ${allowed.join(', ')}`, details);
  }
  return value;
}

/**
 * Read a closed argument shape.
 *
 * Three things, and each of them closes a different hole. `Reflect.ownKeys`
 * rather than `Object.keys`, because a field hidden behind
 * `Object.defineProperty(…, {enumerable: false})` or held under a symbol is
 * still a field the caller is asking this store to accept. A genuine
 * `Object.prototype` prototype, because a class instance and a null-prototype
 * bag can carry the same fields and still not be the shape this contract names.
 * And every value read through `Object.hasOwn`, because otherwise a polluted
 * `Object.prototype` supplies a field the caller never passed, with no
 * unsupported own key to find.
 *
 * @param {unknown} value @param {string} label
 * @param {readonly string[]} allowed @param {readonly string[]} required
 * @returns {Record<string, unknown>}
 */
function closedArgument(value, label, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be a plain object`);
  }
  const unknown = Reflect.ownKeys(value).find((key) => !allowed.includes(/** @type {any} */ (key)));
  if (unknown !== undefined) {
    const named = typeof unknown === 'symbol' ? unknown.toString() : unknown;
    throw new ValidationError(`${label} has an unsupported field "${named}"`, { field: named });
  }
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    throw new ValidationError(`${label} requires own field "${missing}"`, { field: missing });
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {Record<string, unknown>} */
  const own = {};
  for (const key of allowed) if (Object.hasOwn(record, key)) own[key] = record[key];
  return own;
}

/**
 * The one JSON encoder for everything these two tables store. It was written
 * twice before this store existed — `stringify` in the workflow engine and
 * `safeJson` in the action runtime — and two copies of "what does a trace
 * column hold" is two answers waiting to disagree. A value that cannot be
 * serialized becomes a marker rather than an exception, because losing the
 * whole trace over one unserializable output helps nobody.
 * @param {unknown} value
 */
function encodeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

/**
 * The decode half of `encodeJson`. A column that will not parse is returned as
 * the text it holds rather than thrown away: a trace is evidence, and evidence
 * that cannot be parsed is still evidence.
 * @param {string | null | undefined} value
 */
function decodeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** @param {any} row */
function mapRunRow(row) {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    status: row.status,
    input: decodeJson(row.input_json),
    output: decodeJson(row.output_json),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** @param {any} row */
function mapSpanRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    status: row.status,
    input: decodeJson(row.input_json),
    output: decodeJson(row.output_json),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * The id source, given the same treatment `resolveClock` gives the clock: an
 * injected generator is *input*, so what it returns is validated on every call
 * rather than only that it is callable. A generator returning `null`, a number
 * or an empty string would otherwise reach `storage.execute` and let the
 * adapter's `PRIMARY KEY` decide — which leaks the driver's words into evidence
 * a person reads.
 *
 * The two refusals differ deliberately. A non-function is construction-time
 * misuse and raises `TypeError`, exactly as `resolveClock` does. A bad *value*
 * is on its way to a write, so it raises `ValidationError` and carries the
 * framework's stable code like every other refusal in this store.
 *
 * @param {unknown} newId
 */
function resolveIdSource(newId) {
  if (newId === undefined || newId === null) return randomUUID;
  if (typeof newId !== 'function') throw new TypeError('newId must be a function returning an id');
  return () => assertIdentityText(newId(), 'The id newId returned', { field: 'id' });
}

/**
 * @param {any} database — an application database handle carrying `storage.sync`
 * @param {{clock?: () => string, newId?: () => string}} [options]
 *   `clock` and `newId` exist so a test can pin timestamps and ids; the defaults
 *   are the framework clock and `randomUUID`, which is what both consumers used
 *   before this store existed.
 */
export function createExecutionRunStore(database, options = {}) {
  const now = resolveClock(options.clock);
  const newId = resolveIdSource(options.newId);
  const storage = database?.storage?.sync;
  if (!storage) {
    throw new ValidationError('The execution-run store requires a database with Storage Contract v1');
  }

  /** @param {string} table @param {string} id @param {Array<{column: string, value: unknown}>} values */
  const patch = (table, id, values) => storage.execute({
    kind: 'update', table, values, where: [{ column: 'id', op: 'eq', value: id }],
  });

  return Object.freeze({
    /**
     * Open a run. Returns the id every later call and every caller-visible
     * result carries.
     * @param {{workflowName: string, input: unknown}} run
     * @returns {string}
     */
    startRun(run) {
      const own = closedArgument(run, 'Execution run', ['workflowName', 'input'], ['workflowName']);
      const workflowName = assertIdentityText(own.workflowName, 'Execution run workflow name', { field: 'workflowName' });
      const id = assertIdentityText(newId(), 'The generated run id', { field: 'id' });
      storage.execute({
        kind: 'insert',
        table: RUNS,
        values: [
          { column: 'id', value: id },
          { column: 'workflow_name', value: workflowName },
          { column: 'status', value: 'running' },
          { column: 'input_json', value: encodeJson(own.input) },
          // These three are SQL NULL until the run closes, exactly as they were.
          { column: 'output_json', value: null },
          { column: 'error', value: null },
          { column: 'started_at', value: now() },
          { column: 'finished_at', value: null },
        ],
      });
      return id;
    },

    /**
     * Open a span under a run. `parent_span_id` is always NULL: neither consumer
     * has ever written anything else, and a parameter nobody passes would be
     * inventing the tracing hierarchy this store is explicitly not.
     * @param {{runId: string, name: string, input: unknown}} span
     * @returns {string}
     */
    startSpan(span) {
      const own = closedArgument(span, 'Trace span', ['runId', 'name', 'input'], ['runId', 'name']);
      const runId = assertIdentityText(own.runId, 'Trace span run id', { field: 'runId' });
      const name = assertIdentityText(own.name, 'Trace span name', { field: 'name' });
      const id = assertIdentityText(newId(), 'The generated span id', { field: 'id' });
      storage.execute({
        kind: 'insert',
        table: SPANS,
        values: [
          { column: 'id', value: id },
          { column: 'run_id', value: runId },
          { column: 'parent_span_id', value: null },
          { column: 'name', value: name },
          { column: 'status', value: 'running' },
          { column: 'input_json', value: encodeJson(own.input) },
          { column: 'output_json', value: null },
          { column: 'error', value: null },
          { column: 'started_at', value: now() },
          { column: 'finished_at', value: null },
        ],
      });
      return id;
    },

    /**
     * Close a span that succeeded. A span id that matches nothing updates
     * nothing and says so to no one — the same silence the statement it replaced
     * kept, because a trace write must never become the reason a step fails.
     * @param {{spanId: string, output: unknown}} span
     */
    completeSpan(span) {
      const own = closedArgument(span, 'Trace span completion', ['spanId', 'output'], ['spanId']);
      const spanId = assertIdentityText(own.spanId, 'Trace span id', { field: 'spanId' });
      patch(SPANS, spanId, [
        { column: 'status', value: 'completed' },
        { column: 'output_json', value: encodeJson(own.output) },
        { column: 'finished_at', value: now() },
      ]);
    },

    /**
     * Close a span that failed. `error` is passed through unbounded and
     * unfiltered: see `assertIdentityText` for why a normalized exception
     * message is deliberately not identity text.
     * @param {{spanId: string, error: string | null}} span
     */
    failSpan(span) {
      const own = closedArgument(span, 'Trace span failure', ['spanId', 'error'], ['spanId', 'error']);
      const spanId = assertIdentityText(own.spanId, 'Trace span id', { field: 'spanId' });
      const error = assertOptionalMessage(own.error, 'Trace span error', { field: 'error' });
      patch(SPANS, spanId, [
        { column: 'status', value: 'failed' },
        { column: 'error', value: error },
        { column: 'finished_at', value: now() },
      ]);
    },

    /**
     * Close a run that succeeded.
     * @param {{runId: string, output: unknown}} run
     */
    completeRun(run) {
      const own = closedArgument(run, 'Execution run completion', ['runId', 'output'], ['runId']);
      const runId = assertIdentityText(own.runId, 'Execution run id', { field: 'runId' });
      patch(RUNS, runId, [
        { column: 'status', value: 'completed' },
        { column: 'output_json', value: encodeJson(own.output) },
        { column: 'finished_at', value: now() },
      ]);
    },

    /**
     * Close a run that failed. It still records an output, because the state a
     * failed run had reached is part of what its trace is for.
     * @param {{runId: string, error: string | null, output: unknown}} run
     */
    failRun(run) {
      const own = closedArgument(run, 'Execution run failure', ['runId', 'error', 'output'], ['runId', 'error']);
      const runId = assertIdentityText(own.runId, 'Execution run id', { field: 'runId' });
      const error = assertOptionalMessage(own.error, 'Execution run error', { field: 'error' });
      patch(RUNS, runId, [
        { column: 'status', value: 'failed' },
        { column: 'error', value: error },
        { column: 'output_json', value: encodeJson(own.output) },
        { column: 'finished_at', value: now() },
      ]);
    },

    /**
     * Persist a run that has already finished, with all of its spans.
     *
     * This is the other runtime's shape and it is *not* `startRun` followed by
     * `completeRun`: the caller minted the run id and the start instant before
     * the work began, one finish instant covers the run and every span, and each
     * span carries the run's own start rather than one of its own. Those are the
     * bytes the rows held before this store existed, and collapsing the two
     * write paths into one generic writer would have changed them.
     *
     * @param {{runId: string, workflowName: string, status: string, input: unknown,
     *   output: unknown, error: string | null, startedAt: string,
     *   steps: Iterable<{name: string, status: string, output?: unknown, error?: string}>}} run
     */
    recordRun(run) {
      const own = closedArgument(run, 'Recorded execution run',
        ['runId', 'workflowName', 'status', 'input', 'output', 'error', 'startedAt', 'steps'],
        ['runId', 'workflowName', 'status', 'startedAt', 'steps']);
      const runId = assertIdentityText(own.runId, 'Execution run id', { field: 'runId' });
      const workflowName = assertIdentityText(own.workflowName, 'Execution run workflow name', { field: 'workflowName' });
      const status = assertStatus(own.status, RUN_STATUSES, 'Execution run status', { field: 'status' });
      const startedAt = assertIdentityText(own.startedAt, 'Execution run startedAt', { field: 'startedAt' });
      const error = assertOptionalMessage(own.error, 'Execution run error', { field: 'error' });

      // The whole batch is validated before the first row is written. The one
      // behaviour this moves is *when* a malformed step is refused — it used to
      // be refused after the run row had already landed, leaving an orphaned run
      // with no spans behind it. Refusing first is the better half of that trade,
      // and the caller's best-effort catch sees the same swallowed failure either
      // way.
      const steps = boundedSteps(own.steps);
      const minted = steps.map(() => assertIdentityText(newId(), 'The generated span id', { field: 'id' }));
      const seen = new Set();
      for (const id of minted) {
        // Within one call this is free, so it is done. Beyond one call it is not
        // done at all, and the asymmetry with the definition-version store is
        // deliberate: that store reads the table under `BEGIN IMMEDIATE`, where
        // the write lock makes read-then-write atomic. This one opens no
        // transaction, so the same read would guarantee nothing while adding a
        // query per span to a write path that has none. A collision beyond this
        // batch meets the `PRIMARY KEY`, exactly as it did before.
        if (seen.has(id)) {
          throw new ValidationError(
            `newId issued the same id twice in one run ("${id}"); every trace span needs its own id`,
          );
        }
        seen.add(id);
      }

      // One finish instant for the run and every span, because one clock reading
      // is what the statement this replaced took.
      const finishedAt = now();
      storage.execute({
        kind: 'insert',
        table: RUNS,
        values: [
          { column: 'id', value: runId },
          { column: 'workflow_name', value: workflowName },
          { column: 'status', value: status },
          { column: 'input_json', value: encodeJson(own.input) },
          { column: 'output_json', value: encodeJson(own.output) },
          { column: 'error', value: error },
          { column: 'started_at', value: startedAt },
          { column: 'finished_at', value: finishedAt },
        ],
      });
      for (const [index, step] of steps.entries()) {
        storage.execute({
          kind: 'insert',
          table: SPANS,
          values: [
            { column: 'id', value: minted[index] },
            { column: 'run_id', value: runId },
            { column: 'parent_span_id', value: null },
            { column: 'name', value: step.name },
            { column: 'status', value: step.status },
            // A recorded span carries no input of its own: the run's input is
            // the whole of what it was given.
            { column: 'input_json', value: null },
            { column: 'output_json', value: encodeJson(step.output ?? null) },
            { column: 'error', value: step.error ?? null },
            { column: 'started_at', value: startedAt },
            { column: 'finished_at', value: finishedAt },
          ],
        });
      }
    },

    /**
     * One run with its spans in start order, or `null` when nothing matches.
     *
     * **The lookup key is passed through unvalidated, on purpose.** This read is
     * HTTP-reachable, and today an id nobody could have issued matches no row
     * and becomes a 404. Refusing it here would make the same request a 400 —
     * an observable change to a public route, bought with no safety, because the
     * key is a bound parameter and never reaches rendered SQL. The caller keeps
     * its own not-found decision.
     *
     * @param {string} runId
     */
    getRun(runId) {
      const row = storage.maybeOne({
        kind: 'select', table: RUNS, columns: '*',
        where: [{ column: 'id', op: 'eq', value: runId }],
      });
      if (!row) return null;
      const spans = storage.many({
        kind: 'select', table: SPANS, columns: '*',
        where: [{ column: 'run_id', op: 'eq', value: runId }],
        orderBy: [{ column: 'started_at', direction: 'asc' }],
      }).map(mapSpanRow);
      return { ...mapRunRow(row), spans };
    },

    /**
     * Runs newest first, under a bounded filter. Filter values are bound
     * parameters and are passed through for the same reason `getRun`'s key is: a
     * status nobody defined matches nothing, which is an empty list rather than
     * a refusal.
     * @param {{status?: string, workflowName?: string, limit?: number}} filters
     */
    listRuns(filters) {
      const own = closedArgument(filters, 'Execution run filter', ['status', 'workflowName', 'limit'], []);
      const where = [];
      if (own.status) where.push({ column: 'status', op: 'eq', value: own.status });
      if (own.workflowName) where.push({ column: 'workflow_name', op: 'eq', value: own.workflowName });
      // The engine's own clamp, moved here byte-for-byte rather than left behind
      // it. Here it is a property of the statement: this list cannot be issued
      // unbounded, whatever a caller passes or forgets to pass.
      const limit = Math.min(
        Math.max(/** @type {number} */ (own.limit) ?? DEFAULT_RUN_LIMIT, 1), MAX_RUN_LIMIT,
      );
      return storage.many({
        kind: 'select', table: RUNS, columns: '*', where,
        orderBy: [{ column: 'started_at', direction: 'desc' }],
        limit,
      }).map(mapRunRow);
    },
  });
}

/**
 * Turn whatever the caller passed as `steps` into a bounded array of validated
 * steps, refusing in this store's own words rather than letting `for…of` raise
 * a bare `TypeError: … is not iterable` that names no contract.
 * @param {unknown} steps
 */
function boundedSteps(steps) {
  if (steps === null || steps === undefined
    || typeof (/** @type {any} */ (steps)[Symbol.iterator]) !== 'function') {
    throw new ValidationError('Recorded execution run steps must be iterable', { field: 'steps' });
  }
  /** @type {Array<{name: string, status: string, output: unknown, error: string | null}>} */
  const collected = [];
  for (const step of /** @type {Iterable<unknown>} */ (steps)) {
    if (collected.length >= MAX_SPANS) {
      throw new ValidationError(`Too many trace spans in one run (the limit is ${MAX_SPANS})`, { field: 'steps' });
    }
    const index = collected.length;
    const own = closedArgument(step, `Trace span step at index ${index}`,
      ['name', 'status', 'output', 'error'], ['name', 'status']);
    collected.push({
      name: assertIdentityText(own.name, 'Trace span name', { index, field: 'name' }),
      status: assertStatus(own.status, SPAN_STATUSES, 'Trace span status', { index, field: 'status' }),
      output: own.output,
      error: assertOptionalMessage(own.error, 'Trace span error', { index, field: 'error' }),
    });
  }
  return collected;
}
