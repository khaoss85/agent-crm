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
 * The bound on **an id this store mints**, and on nothing else.
 *
 * It was briefly a bound on every identity string, justified as "far above
 * anything real". That was an unverified assumption, and it was wrong. A record
 * action's workflow name is the module and action joined by a dot, and
 * `packages/core/src/action-registry.js` validates each part against an
 * anchored lower-case pattern that bounds its **length not at all**. Two
 * individually valid declarations therefore exceed any ceiling invented here —
 * and because the trace write is best-effort, the refusal was swallowed and the
 * action reported success with no run row and no span row. Losing the evidence
 * that something happened, while it happens, is far worse than storing a long
 * name, and nothing before this store bounded it either.
 *
 * The bound survives exactly where it is earned. The store *owns* the ids it
 * mints and interpolates them **verbatim** into the duplicate-id refusal, so
 * here a ceiling protects a message a person reads — which is what the original
 * justification claimed, and only ever achieved for this one value. A UUID is
 * 36 characters.
 */
const MAX_GENERATED_ID = 200;

/**
 * One run's steps are the steps of one execution.
 *
 * Kept, and it is **not** pure preservation — stated plainly rather than
 * claimed away. The statement this replaced *streamed* its inserts, so an
 * accidental infinite generator meant unbounded row growth forever; this store
 * collects the batch first, which is what makes an out-of-memory crash
 * possible and the cap necessary. So the cap converts two pathologies into one
 * refusal, and it is the one place this store deliberately sacrifices evidence
 * to avoid a crash — **silently**, because the caller swallows the refusal.
 *
 * **The bound is 10,000 spans in one run. It is not 10,000 `ctx.step(…)`
 * calls, and an earlier draft of this comment said it was.** That was off by
 * one and review caught it: a caller's runtime contributes spans of its own, so
 * a record action calling `ctx.step` exactly 10,000 times arrives here with
 * 10,001 and loses its whole trace while reporting success. Measured through
 * `runRecordAction`: 9,999 calls survive, 10,000 do not.
 *
 * The caller's budget is therefore **derived, and different for each caller** —
 * which is exactly why this comment states the bound in spans, the only unit
 * this store controls. No single reservation could make one number true for all
 * of them: `action-runtime.js` prepends one span, and two when the event
 * dispatch also fails; `external-operation.js` adds up to five across intent,
 * external, finalize, compensate and events; `catalog-sync.js` adds up to
 * three. A constant chosen for any one of those is quietly wrong for the rest.
 *
 * No real run comes within orders of magnitude, and unlike the checks this
 * store dropped, the alternative here is a crash rather than a stored row.
 */
const MAX_SPANS = 10_000;

/**
 * Characters that never appear in a real identity and do appear in
 * log-splitting and terminal-escape payloads: C0, DEL, the C1 range, and the
 * Unicode line and paragraph separators.
 */
const FORBIDDEN_IDENTITY_TEXT = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * **What this store is entitled to refuse, and nothing beyond it.**
 *
 * Every statement here runs on an evidence path. The engine's writes fail a
 * run; `recordRun`'s are best-effort, so a refusal there is *swallowed by the
 * caller* and the trace disappears in silence. On such a path an invented
 * refusal is not a safety feature — it is an evidence-destruction primitive.
 * The milestone before this one applied the same character-class and
 * length rules to `definition_versions`, and that was right *there* precisely
 * because it sits on the **startup** path, where a refusal is loud and stops
 * the boot. The asymmetry is the whole point.
 *
 * So the store refuses exactly three things:
 *
 * 1. **What it owns.** An id it minted gets the full treatment — non-empty, no
 *    control characters, and a length ceiling — because the store both produces
 *    that value and interpolates it verbatim into the duplicate-id refusal.
 *    See `assertGeneratedId` and `MAX_GENERATED_ID`.
 * 2. **What the driver would refuse anyway** — established by probing the real
 *    schema, not by assuming. A status outside the schema's own `CHECK` set,
 *    and a value a `TEXT` column of a `STRICT` table cannot take. That column
 *    *coerces* a number and a bigint, so those are accepted and passed through
 *    unchanged; a boolean, object, array, `undefined` or `null` genuinely fails
 *    to bind. Same *what* SQLite refuses, moved earlier and into this
 *    framework's words. See `assertStorableText`, `assertStatus` and
 *    `assertOptionalMessage`.
 * 3. **A shape whose acceptance would silently corrupt.** A **missing** named
 *    field — a caller who meant to pass `steps` has asked for a run with no
 *    spans — or a named field arriving through a polluted prototype. An
 *    **extra** field is refused only on the shapes this store owns, never on
 *    what arrives through `writeTrace`: an unread field corrupts nothing, and
 *    refusing it cost the whole trace of a successful operation. See
 *    `suppliedShape` and `ownedShape`.
 *
 * Anything else a caller supplies is stored as given. That is deliberate and it
 * was learned the hard way: a 200-character ceiling and a control-character
 * class were applied to `workflowName`, span `name` and `startedAt` — none of
 * which any framework validator bounds or filters — and each one silently
 * destroyed a whole trace for a declaration the framework itself accepts.
 * `packages/core/src/action-registry.js` bounds neither half of
 * `module`/`action`; a workflow step name and `ctx.step(name, …)` are not
 * validated at all.
 */

/**
 * A value on its way into a `TEXT` column of a `STRICT` table.
 *
 * **Category 2, and the accepted set is the driver's, not an opinion.** An
 * earlier draft required `typeof value === 'string'` on the stated grounds that
 * "the driver would refuse anything else". Probed against the real schema, that
 * was false for exactly the values it mattered for: a `STRICT` `TEXT` column
 * **losslessly coerces** a number or a bigint and stores its text form, so
 * requiring a string was a *new* refusal on a path that accepted them — the same
 * evidence-destruction shape this store spent two rounds removing, because the
 * best-effort caller swallows the refusal.
 *
 * So the set here is exactly what the driver takes: string, number, bigint.
 * Everything else — boolean, object, array, `undefined`, `null` — fails to bind
 * or violates `NOT NULL`, and refusing those early only changes *whose words*
 * the caller reads, never *what* is accepted.
 *
 * **The value is returned unchanged, deliberately.** Converting a number here
 * would store `"42"`, while binding it and letting SQLite coerce stores
 * `"42.0"` — the driver renders a JS number as a double. Preserving the bytes
 * means passing the value through and letting the same coercion happen that
 * happened before this store existed.
 *
 * @param {unknown} value @param {string} subject @param {unknown} [details]
 */
function assertStorableText(value, subject, details) {
  const type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'bigint') {
    throw new ValidationError(`${subject} must be text the database can store`, details);
  }
  return value;
}

/**
 * An id this store minted. Category 1, and the only value that earns the full
 * rule: the store produces it, so no caller is refused something it was given
 * elsewhere, and the store quotes it **verbatim** into the duplicate-id
 * refusal, so a control character or an unbounded length would land in a
 * message a person reads.
 * @param {unknown} value @param {string} subject @param {unknown} [details]
 */
function assertGeneratedId(value, subject, details) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${subject} must be a non-empty string`, details);
  }
  if (FORBIDDEN_IDENTITY_TEXT.test(value)) {
    throw new ValidationError(`${subject} must not contain a control character`, details);
  }
  if (value.length > MAX_GENERATED_ID) {
    throw new ValidationError(
      `${subject} is too long (${value.length} characters; the limit is ${MAX_GENERATED_ID})`, details,
    );
  }
  return value;
}

/**
 * **The other half of the `error` exemption above**, and it takes the same
 * accepted set as `assertStorableText` for the same probed reason.
 *
 * Exempting a message from bounds and from the character class is not the same
 * as accepting *anything*: a boolean, object, array or `undefined` fails to
 * bind, and because the trace write is best-effort that driver refusal is
 * swallowed and logged in the driver's words.
 *
 * **A number is not in that set, and an earlier draft of this comment said it
 * was.** These columns are `TEXT` in a `STRICT` table, which *coerces* a number
 * and a bigint rather than refusing them — `99` stores as `"99.0"`, and a test
 * pins that. The claim survived one round past the code that refuted it, three
 * lines below. Refusing a number here would be an invented refusal on an
 * evidence path, which is the defect this store exists to have stopped making.
 *
 * Deliberately no length bound: a normalized exception message has never had
 * one, and truncating the sentence a person reads when something failed would
 * be a behaviour change dressed as hardening.
 *
 * @param {unknown} value @param {string} subject @param {unknown} [details]
 */
function assertOptionalMessage(value, subject, details) {
  if (value === undefined || value === null) return null;
  // The same accepted set as `assertStorableText`, for the same probed reason:
  // this column is nullable `TEXT` in a `STRICT` table, so it coerces a number
  // or a bigint rather than refusing it. Returned unchanged so the driver's own
  // coercion produces the same bytes it always did.
  const type = typeof value;
  if (type !== 'string' && type !== 'number' && type !== 'bigint') {
    throw new ValidationError(`${subject} must be text the database can store, or null`, details);
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
 * Read the named fields off an argument object, and nothing else.
 *
 * Two things, and each closes a hole that matters on every shape. A genuine
 * `Object.prototype` prototype, because a class instance and a null-prototype
 * bag can carry the same fields and still not be the shape this contract names
 * — and because a non-object cannot be read at all. And every value read
 * through `Object.hasOwn`, because otherwise a polluted `Object.prototype`
 * supplies a field the caller never passed.
 *
 * A **missing** named field is refused here, and that is the check that carries
 * the weight: a caller who meant to pass `steps` and passed something else has
 * asked this store to record a run with no spans, which it must not do quietly.
 *
 * An **extra** field is not this function's business — see `ownedShape` for the
 * one place it is.
 *
 * @param {unknown} value @param {string} label
 * @param {readonly string[]} allowed @param {readonly string[]} required
 * @returns {Record<string, unknown>}
 */
function suppliedShape(value, label, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be a plain object`);
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
 * `suppliedShape`, plus a refusal for any key nobody named.
 *
 * **Used only on the shapes this store owns** — the arguments to its own
 * lifecycle methods, which nothing outside `packages/core` and the workflow
 * engine constructs. There an unnamed key means a caller is using an API that
 * does not exist, and saying so immediately is a kindness.
 *
 * **It is deliberately NOT used on `recordRun`.** That shape arrives through
 * `writeTrace`, a published surface, and refusing an extra field there was the
 * last invented refusal in this store — measured against its own three
 * categories it failed all of them. The field is not something the store owns;
 * the driver never sees it; and accepting it corrupts nothing, because an
 * unread field changes no row. What it cost was the entire trace of a
 * *successful* operation, silently, because someone added a key to an object.
 *
 * The rule was borrowed from `definition-version-store`, where it is right: an
 * unnamed key on *that* entry shape means a caller believes it is persisting
 * something the store will drop. The difference is not whether a shape is
 * unexpected — it is whether a rejected shape could otherwise have been
 * silently persisted. Here nothing is persisted either way.
 *
 * @param {unknown} value @param {string} label
 * @param {readonly string[]} allowed @param {readonly string[]} required
 * @returns {Record<string, unknown>}
 */
function ownedShape(value, label, allowed, required) {
  // The shape check comes first, and the duplication with `suppliedShape` is
  // deliberate: an array reaching `Reflect.ownKeys` first reports an
  // "unsupported field \"length\"", which is a true statement about the wrong
  // problem.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be a plain object`);
  }
  // `Reflect.ownKeys`, not `Object.keys`: a field hidden behind
  // `Object.defineProperty(…, {enumerable: false})`, or held under a symbol,
  // is still a key the caller put there.
  const unknown = Reflect.ownKeys(value).find((key) => !allowed.includes(/** @type {any} */ (key)));
  if (unknown !== undefined) {
    const named = typeof unknown === 'symbol' ? unknown.toString() : unknown;
    throw new ValidationError(`${label} has an unsupported field "${named}"`, { field: named });
  }
  return suppliedShape(value, label, allowed, required);
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
  return () => assertGeneratedId(newId(), 'The id newId returned', { field: 'id' });
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
  const sync = database?.storage?.sync;
  const storage = sync ?? database?.storage;
  if (!storage) {
    throw new ValidationError('The execution-run store requires a database with Storage Contract v1');
  }
  const after = (result, value) => (sync ? value : Promise.resolve(result).then(() => value));

  /** @param {string} table @param {string} id @param {Array<{column: string, value: unknown}>} values */
  const patch = (table, id, values) => {
    const result = storage.execute({
      kind: 'update', table, values, where: [{ column: 'id', op: 'eq', value: id }],
    });
    return after(result, undefined);
  };

  return Object.freeze({
    /**
     * Open a run. Returns the id every later call and every caller-visible
     * result carries.
     * @param {{workflowName: string, input: unknown}} run
     * @returns {string}
     */
    startRun(run) {
      const own = ownedShape(run, 'Execution run', ['workflowName', 'input'], ['workflowName']);
      const workflowName = assertStorableText(own.workflowName, 'Execution run workflow name', { field: 'workflowName' });
      const id = assertGeneratedId(newId(), 'The generated run id', { field: 'id' });
      return after(storage.execute({
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
      }), id);
    },

    /**
     * Open a span under a run. `parent_span_id` is always NULL: neither consumer
     * has ever written anything else, and a parameter nobody passes would be
     * inventing the tracing hierarchy this store is explicitly not.
     * @param {{runId: string, name: string, input: unknown}} span
     * @returns {string}
     */
    startSpan(span) {
      const own = ownedShape(span, 'Trace span', ['runId', 'name', 'input'], ['runId', 'name']);
      const runId = assertStorableText(own.runId, 'Trace span run id', { field: 'runId' });
      const name = assertStorableText(own.name, 'Trace span name', { field: 'name' });
      const id = assertGeneratedId(newId(), 'The generated span id', { field: 'id' });
      return after(storage.execute({
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
      }), id);
    },

    /**
     * Close a span that succeeded. A span id that matches nothing updates
     * nothing and says so to no one — the same silence the statement it replaced
     * kept, because a trace write must never become the reason a step fails.
     * @param {{spanId: string, output: unknown}} span
     */
    completeSpan(span) {
      const own = ownedShape(span, 'Trace span completion', ['spanId', 'output'], ['spanId']);
      const spanId = assertStorableText(own.spanId, 'Trace span id', { field: 'spanId' });
      patch(SPANS, spanId, [
        { column: 'status', value: 'completed' },
        { column: 'output_json', value: encodeJson(own.output) },
        { column: 'finished_at', value: now() },
      ]);
    },

    /**
     * Close a span that failed. `error` is passed through unbounded and
     * unfiltered: see the doctrine above for why a normalized exception
     * message is deliberately not identity text.
     * @param {{spanId: string, error: string | null}} span
     */
    failSpan(span) {
      const own = ownedShape(span, 'Trace span failure', ['spanId', 'error'], ['spanId', 'error']);
      const spanId = assertStorableText(own.spanId, 'Trace span id', { field: 'spanId' });
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
      const own = ownedShape(run, 'Execution run completion', ['runId', 'output'], ['runId']);
      const runId = assertStorableText(own.runId, 'Execution run id', { field: 'runId' });
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
      const own = ownedShape(run, 'Execution run failure', ['runId', 'error', 'output'], ['runId', 'error']);
      const runId = assertStorableText(own.runId, 'Execution run id', { field: 'runId' });
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
      const own = suppliedShape(run, 'Recorded execution run',
        ['runId', 'workflowName', 'status', 'input', 'output', 'error', 'startedAt', 'steps'],
        ['runId', 'workflowName', 'status', 'startedAt', 'steps']);
      const runId = assertStorableText(own.runId, 'Execution run id', { field: 'runId' });
      const workflowName = assertStorableText(own.workflowName, 'Execution run workflow name', { field: 'workflowName' });
      const status = assertStatus(own.status, RUN_STATUSES, 'Execution run status', { field: 'status' });
      const startedAt = assertStorableText(own.startedAt, 'Execution run startedAt', { field: 'startedAt' });
      const error = assertOptionalMessage(own.error, 'Execution run error', { field: 'error' });

      // The whole batch is validated before the first row is written. The one
      // behaviour this moves is *when* a malformed step is refused — it used to
      // be refused after the run row had already landed, leaving an orphaned run
      // with no spans behind it. Refusing first is the better half of that trade,
      // and the caller's best-effort catch sees the same swallowed failure either
      // way.
      const steps = boundedSteps(own.steps);
      const minted = steps.map(() => assertGeneratedId(newId(), 'The generated span id', { field: 'id' }));
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
      const load = async () => {
        const row = await storage.maybeOne({
          kind: 'select', table: RUNS, columns: '*',
          where: [{ column: 'id', op: 'eq', value: runId }],
        });
        if (!row) return null;
        const spans = (await storage.many({
          kind: 'select', table: SPANS, columns: '*',
          where: [{ column: 'run_id', op: 'eq', value: runId }],
          orderBy: [{ column: 'started_at', direction: 'asc' }],
        })).map(mapSpanRow);
        return { ...mapRunRow(row), spans };
      };
      if (sync) {
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
      }
      return load();
    },

    /**
     * Runs newest first, under a bounded filter. Filter values are bound
     * parameters and are passed through for the same reason `getRun`'s key is: a
     * status nobody defined matches nothing, which is an empty list rather than
     * a refusal.
     * @param {{status?: string, workflowName?: string, limit?: number}} filters
     */
    listRuns(filters) {
      const own = ownedShape(filters, 'Execution run filter', ['status', 'workflowName', 'limit'], []);
      const where = [];
      if (own.status) where.push({ column: 'status', op: 'eq', value: own.status });
      if (own.workflowName) where.push({ column: 'workflow_name', op: 'eq', value: own.workflowName });
      // The engine's own clamp, moved here byte-for-byte rather than left behind
      // it. Here it is a property of the statement: this list cannot be issued
      // unbounded, whatever a caller passes or forgets to pass.
      const limit = Math.min(
        Math.max(/** @type {number} */ (own.limit) ?? DEFAULT_RUN_LIMIT, 1), MAX_RUN_LIMIT,
      );
      const rows = storage.many({
        kind: 'select', table: RUNS, columns: '*', where,
        orderBy: [{ column: 'started_at', direction: 'desc' }],
        limit,
      });
      if (sync) return rows.map(mapRunRow);
      return Promise.resolve(rows).then((resolved) => resolved.map(mapRunRow));
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
    const own = suppliedShape(step, `Trace span step at index ${index}`,
      ['name', 'status', 'output', 'error'], ['name', 'status']);
    collected.push({
      name: assertStorableText(own.name, 'Trace span name', { index, field: 'name' }),
      status: assertStatus(own.status, SPAN_STATUSES, 'Trace span status', { index, field: 'status' }),
      output: own.output,
      error: assertOptionalMessage(own.error, 'Trace span error', { index, field: 'error' }),
    });
  }
  return collected;
}
