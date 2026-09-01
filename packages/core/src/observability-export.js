// @ts-check

/**
 * Bounded observability export (Spine v4C).
 *
 * This is **not** an observability backend, a log store, an APM, an event bus
 * or a second audit system. It is one closed, versioned way to hand bounded
 * operational evidence to a system the deployment already runs. Nothing here
 * stores, aggregates or queries anything, and a telemetry failure can never
 * rewrite business truth: the security audit stays the database authority.
 *
 * The leak fence is the **shape of what may be said**, not a filter over what
 * a caller happened to pass. A signal name must be in the frozen registry
 * below; an attribute key must be declared for that signal; a value must
 * satisfy the declared kind. Anything else refuses the whole record and counts
 * it. Attributes are flat, so there is no recursive structure for a payload to
 * hide in, and no attribute kind can carry free text — the `code` charset is
 * `write-outcome-runtime.js#boundedFailureCode`'s, which a URL, a path, an
 * email, a uuid or a tenant slug cannot match.
 *
 * No OpenTelemetry or OTLP support is implemented or claimed. The exporter
 * shape is deliberately adapter-compatible so one can be written outside the
 * kernel later without a contract change.
 */

export const TELEMETRY_EXPORT_CONTRACT = 1;

const NAME = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_TEXT = 64;
const MAX_NUMBER = 2 ** 40;
const DEFAULT_MAX_IN_FLIGHT = 256;
const DEFAULT_DEADLINE_MS = 5_000;
const MAX_DEADLINE_MS = 60_000;
const MAX_CAPTURE = 1_024;

/** The closed enumerations an `enum` attribute may draw from. */
const ADAPTERS = Object.freeze(['postgresql', 'sqlite']);
// The settled halves of `durable-jobs.js#DURABLE_JOB_STATES`. Kept as a literal
// rather than imported, because durable-jobs imports this module and a cycle
// would be worse than a duplicated list; a test asserts the two agree, so the
// duplication cannot drift silently.
const RUN_STATES = Object.freeze([
  'succeeded', 'failed_retryable', 'failed_terminal', 'cancelled',
]);
const OUTBOX_EFFECTS = Object.freeze(['internal-event-promotion', 'external-finalize-continuation']);
const DISPATCH_OUTCOMES = Object.freeze(['succeeded', 'failed']);
const BACKUP_OPERATIONS = Object.freeze(['create', 'verify', 'restore']);
const BACKUP_OUTCOMES = Object.freeze(['succeeded', 'refused', 'possibly-partial']);
const UNITS = Object.freeze(['ms', 'count']);

const enumOf = (values) => Object.freeze({ kind: 'enum', values });
const CODE_KIND = Object.freeze({ kind: 'code' });
const NAME_KIND = Object.freeze({ kind: 'name' });
const NUMBER_KIND = Object.freeze({ kind: 'number' });
const BOOLEAN_KIND = Object.freeze({ kind: 'boolean' });

/**
 * Every signal this framework may export, and every attribute each one may
 * carry. Nothing outside this table can be emitted.
 *
 * Deliberately absent from every attribute list, because each is either an
 * identifier into tenant-scoped rows or caller-chosen text a length cap does
 * not make safe: tenant id, tenant/resource/migration/repository fingerprint,
 * binding uuid, job id, run id, worker id, idempotency root, outcome
 * reference, job payload, connection locator, secret value or reference,
 * filesystem path and `error.message`. v1 telemetry is therefore
 * aggregate-shaped, not per-record traceable. That is a limitation, recorded
 * as one, not an oversight.
 */
export const TELEMETRY_RUN_STATES = RUN_STATES;

export const TELEMETRY_SIGNALS = Object.freeze({
  'accordo.durable_job.claimed': Object.freeze({
    kind: 'log',
    attributes: Object.freeze({
      kind: NAME_KIND, handler: NAME_KIND, attempt: NUMBER_KIND,
    }),
    required: Object.freeze(['kind', 'handler', 'attempt']),
  }),
  'accordo.durable_job.worker_error': Object.freeze({
    kind: 'log',
    attributes: Object.freeze({ errorCode: CODE_KIND }),
    required: Object.freeze(['errorCode']),
  }),
  'accordo.durable_job.execution': Object.freeze({
    kind: 'run',
    attributes: Object.freeze({
      kind: NAME_KIND, handler: NAME_KIND, state: enumOf(RUN_STATES),
      attempt: NUMBER_KIND, durationMs: NUMBER_KIND, errorCode: CODE_KIND,
    }),
    required: Object.freeze(['kind', 'handler', 'state', 'attempt', 'durationMs']),
  }),
  // `outcome`, not `state`: a dispatch handler knows only whether its own
  // attempt settled. Whether the job is retryable is the worker's decision and
  // is carried by `accordo.durable_job.execution`. Guessing it here would put
  // a classification into telemetry that no authority made.
  'accordo.transactional_outbox.dispatch': Object.freeze({
    kind: 'run',
    attributes: Object.freeze({
      effect: enumOf(OUTBOX_EFFECTS), outcome: enumOf(DISPATCH_OUTCOMES),
      attempt: NUMBER_KIND, durationMs: NUMBER_KIND, errorCode: CODE_KIND,
    }),
    required: Object.freeze(['effect', 'outcome', 'attempt', 'durationMs']),
  }),
  'accordo.postgresql.readiness': Object.freeze({
    kind: 'log',
    attributes: Object.freeze({
      adapter: enumOf(ADAPTERS), ready: BOOLEAN_KIND, reason: CODE_KIND,
    }),
    required: Object.freeze(['adapter', 'ready']),
  }),
  'accordo.postgresql.writer_lease_remaining_ms': Object.freeze({
    kind: 'metric',
    unit: 'ms',
    attributes: Object.freeze({ adapter: enumOf(ADAPTERS), ready: BOOLEAN_KIND }),
    required: Object.freeze(['adapter', 'ready']),
  }),
  'accordo.backup.operation': Object.freeze({
    kind: 'run',
    attributes: Object.freeze({
      operation: enumOf(BACKUP_OPERATIONS), outcome: enumOf(BACKUP_OUTCOMES),
      durationMs: NUMBER_KIND, errorCode: CODE_KIND,
    }),
    required: Object.freeze(['operation', 'outcome', 'durationMs']),
  }),
  'accordo.telemetry.dropped': Object.freeze({
    kind: 'metric', unit: 'count', attributes: Object.freeze({}), required: Object.freeze([]),
  }),
  'accordo.telemetry.rejected': Object.freeze({
    kind: 'metric', unit: 'count', attributes: Object.freeze({}), required: Object.freeze([]),
  }),
  'accordo.telemetry.exporter_failed': Object.freeze({
    kind: 'metric', unit: 'count', attributes: Object.freeze({}), required: Object.freeze([]),
  }),
});

const SELF_COUNTERS = Object.freeze([
  ['dropped', 'accordo.telemetry.dropped'],
  ['rejected', 'accordo.telemetry.rejected'],
  ['failed', 'accordo.telemetry.exporter_failed'],
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT && NAME.test(value);
}

function boundedNumber(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= -MAX_NUMBER && value <= MAX_NUMBER;
}

/**
 * The one place a value is judged exportable. A value that is not an
 * enumeration member, a `boundedFailureCode`-shaped code, a registration
 * identifier, a bounded integer or a boolean is not representable at all.
 *
 * @param {{kind: string, values?: readonly string[]}} declared
 * @param {unknown} value
 */
function attributeAllowed(declared, value) {
  switch (declared.kind) {
    case 'enum':
      return typeof value === 'string' && (declared.values ?? []).includes(value);
    case 'code':
      return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT && CODE.test(value);
    case 'name':
      return boundedName(value);
    case 'number':
      return boundedNumber(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

/**
 * Validate one emission against the closed registry. Returns a frozen record
 * or `null`; `null` is always counted as a rejection by the caller, never
 * silently repaired. A single undeclared key refuses the whole record: dropping
 * the key would hide the producer bug that put it there.
 *
 * @param {string} expectedKind
 * @param {unknown} input
 */
function validateSignal(expectedKind, input) {
  if (!plainObject(input)) return null;
  const keys = Object.keys(input);
  if (keys.some((key) => key !== 'signal' && key !== 'attributes' && key !== 'value')) return null;
  const signal = /** @type {any} */ (input).signal;
  if (typeof signal !== 'string' || !Object.hasOwn(TELEMETRY_SIGNALS, signal)) return null;
  const declared = TELEMETRY_SIGNALS[signal];
  if (declared.kind !== expectedKind) return null;

  const attributes = /** @type {any} */ (input).attributes ?? {};
  if (!plainObject(attributes)) return null;
  const attributeKeys = Object.keys(attributes);
  if (attributeKeys.some((key) => !Object.hasOwn(declared.attributes, key))) return null;
  if (declared.required.some((key) => !attributeKeys.includes(key))) return null;
  const exported = /** @type {Record<string, unknown>} */ ({});
  for (const key of attributeKeys.sort()) {
    if (!attributeAllowed(declared.attributes[key], attributes[key])) return null;
    exported[key] = attributes[key];
  }

  if (declared.kind === 'metric') {
    const value = /** @type {any} */ (input).value;
    if (!boundedNumber(value)) return null;
    return Object.freeze({
      contract: TELEMETRY_EXPORT_CONTRACT,
      kind: 'metric',
      signal,
      unit: declared.unit,
      value,
      attributes: Object.freeze(exported),
    });
  }
  if (Object.hasOwn(input, 'value')) return null;
  return Object.freeze({
    contract: TELEMETRY_EXPORT_CONTRACT,
    kind: declared.kind,
    signal,
    attributes: Object.freeze(exported),
  });
}

/**
 * A closed exporter definition. Everything optional is optional because a
 * no-op exporter has nothing to flush or close, not because the sink will
 * invent one.
 *
 * @param {any} definition
 */
export function defineTelemetryExporter(definition) {
  if (!plainObject(definition)) throw new TypeError('Telemetry exporter must be a plain object');
  const allowed = ['name', 'contract', 'emitLog', 'emitMetric', 'emitRun', 'flush', 'close'];
  const unknown = Object.keys(definition).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`Telemetry exporter contains unsupported field "${unknown}"`);
  if (!boundedName(definition.name)) throw new TypeError('Telemetry exporter name is invalid');
  if (definition.contract !== TELEMETRY_EXPORT_CONTRACT) {
    throw new TypeError('Telemetry exporter contract must be 1');
  }
  for (const key of ['emitLog', 'emitMetric', 'emitRun']) {
    if (typeof definition[key] !== 'function') {
      throw new TypeError(`Telemetry exporter ${key} must be a function`);
    }
  }
  for (const key of ['flush', 'close']) {
    if (definition[key] !== undefined && typeof definition[key] !== 'function') {
      throw new TypeError(`Telemetry exporter ${key} must be a function`);
    }
  }
  return Object.freeze({
    name: definition.name,
    contract: TELEMETRY_EXPORT_CONTRACT,
    emitLog: definition.emitLog,
    emitMetric: definition.emitMetric,
    emitRun: definition.emitRun,
    ...(definition.flush ? { flush: definition.flush } : {}),
    ...(definition.close ? { close: definition.close } : {}),
  });
}

function positiveBound(value, fallback, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new TypeError(`Telemetry sink ${label} is invalid`);
  }
  return value;
}

/**
 * Race a settlement against a deadline without leaking the timer. Same shape
 * as `durable-jobs.js#drain`, deliberately: a hung exporter must not be able to
 * hang application shutdown, and the `finally` is what proves no timer is left.
 *
 * @param {Promise<unknown>} work
 * @param {number} timeoutMs
 */
async function withDeadline(work, timeoutMs) {
  const marker = Symbol('telemetry-timeout');
  let timer;
  try {
    const settled = await Promise.race([
      work,
      new Promise((resolve) => { timer = setTimeout(() => resolve(marker), timeoutMs); }),
    ]);
    return settled !== marker;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The only object producers touch. Constructing it starts no timer, opens no
 * socket and spawns no process: lifecycle is the application's, always.
 *
 * @param {{exporter: any, maxInFlight?: number, flushTimeoutMs?: number, closeTimeoutMs?: number}} options
 */
export function createTelemetrySink(options) {
  if (!plainObject(options)) throw new TypeError('Telemetry sink options must be a plain object');
  const allowed = ['exporter', 'maxInFlight', 'flushTimeoutMs', 'closeTimeoutMs'];
  const unknown = Object.keys(options).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`Telemetry sink options contain unsupported field "${unknown}"`);
  const exporter = defineTelemetryExporter(options.exporter);
  const maxInFlight = positiveBound(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT, 4_096, 'maxInFlight');
  const flushTimeoutMs = positiveBound(options.flushTimeoutMs, DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, 'flushTimeoutMs');
  const closeTimeoutMs = positiveBound(options.closeTimeoutMs, DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, 'closeTimeoutMs');

  const counters = { emitted: 0, dropped: 0, rejected: 0, failed: 0 };
  const inFlight = new Set();
  let closed = false;
  let closing = null;

  const dispatch = (operation, record) => {
    // Bounded in-flight set rather than a growing queue: there is no batch to
    // lose, no timer to schedule, and backpressure is a counted drop.
    if (inFlight.size >= maxInFlight) {
      counters.dropped += 1;
      return false;
    }
    let settlement;
    try {
      settlement = exporter[operation](record);
    } catch {
      counters.failed += 1;
      return false;
    }
    counters.emitted += 1;
    if (settlement && typeof settlement.then === 'function') {
      const tracked = Promise.resolve(settlement).then(
        () => {},
        () => { counters.failed += 1; },
      ).finally(() => { inFlight.delete(tracked); });
      inFlight.add(tracked);
    }
    return true;
  };

  const emit = (expectedKind, operation, input) => {
    // After close the exporter is gone; a late signal is a counted drop, never
    // an error thrown into a shutdown path.
    if (closed) {
      counters.dropped += 1;
      return false;
    }
    const record = validateSignal(expectedKind, input);
    if (record === null) {
      counters.rejected += 1;
      return false;
    }
    return dispatch(operation, record);
  };

  /**
   * Cumulative self-counters, emitted only from here so telemetry about
   * telemetry cannot recurse and needs no delta state to stay honest.
   */
  const emitSelfCounters = () => {
    for (const [field, signal] of SELF_COUNTERS) {
      const value = counters[field];
      if (value > 0) {
        const record = validateSignal('metric', { signal, value, attributes: {} });
        if (record !== null) dispatch('emitMetric', record);
      }
    }
  };

  const settleInFlight = async (timeoutMs) => {
    const pending = [...inFlight];
    const exported = typeof exporter.flush === 'function'
      ? Promise.resolve().then(() => exporter.flush()).catch(() => { counters.failed += 1; })
      : Promise.resolve();
    return withDeadline(Promise.all([...pending, exported]), timeoutMs);
  };

  async function flush(input = {}) {
    if (!plainObject(input)) throw new TypeError('Telemetry flush options must be a plain object');
    const timeoutMs = positiveBound(input.timeoutMs, flushTimeoutMs, MAX_DEADLINE_MS, 'flush timeoutMs');
    if (closed) return Object.freeze({ flushed: true, ...status() });
    emitSelfCounters();
    const settled = await settleInFlight(timeoutMs);
    return Object.freeze({
      flushed: settled,
      ...(settled ? {} : { code: 'TELEMETRY_FLUSH_TIMEOUT' }),
      ...status(),
    });
  }

  function status() {
    return Object.freeze({
      exporter: exporter.name,
      emitted: counters.emitted,
      dropped: counters.dropped,
      rejected: counters.rejected,
      failed: counters.failed,
      inFlight: inFlight.size,
      closed,
    });
  }

  async function close(input = {}) {
    if (!plainObject(input)) throw new TypeError('Telemetry close options must be a plain object');
    const timeoutMs = positiveBound(input.timeoutMs, closeTimeoutMs, MAX_DEADLINE_MS, 'close timeoutMs');
    // Memoized: the exporter's close is called at most once no matter how many
    // shutdown paths reach here, and a second caller waits for the first result
    // rather than starting a second teardown.
    if (closing) return closing;
    closing = (async () => {
      emitSelfCounters();
      const drained = await settleInFlight(timeoutMs);
      closed = true;
      let released = true;
      if (typeof exporter.close === 'function') {
        released = await withDeadline(
          Promise.resolve().then(() => exporter.close()).catch(() => { counters.failed += 1; }),
          timeoutMs,
        );
      }
      const ok = drained && released;
      return Object.freeze({
        closed: true,
        drained: ok,
        ...(ok ? {} : { code: 'TELEMETRY_CLOSE_TIMEOUT' }),
        ...status(),
      });
    })();
    return closing;
  }

  return Object.freeze({
    contract: TELEMETRY_EXPORT_CONTRACT,
    emitLog: (input) => emit('log', 'emitLog', input),
    emitMetric: (input) => emit('metric', 'emitMetric', input),
    emitRun: (input) => emit('run', 'emitRun', input),
    flush,
    close,
    status,
  });
}

/** Does nothing, allocates nothing, and is what a producer gets when given no sink. */
export function createNoopTelemetryExporter() {
  return defineTelemetryExporter({
    name: 'noop',
    contract: TELEMETRY_EXPORT_CONTRACT,
    emitLog() {}, emitMetric() {}, emitRun() {},
  });
}

/**
 * Self-host default: one JSON line per record on **stderr**. stdout is reserved
 * for JSON-RPC everywhere in this repository, so telemetry never goes there.
 *
 * @param {{write?: (line: string) => void}} [options]
 */
export function createJsonStderrTelemetryExporter(options = {}) {
  if (!plainObject(options)) throw new TypeError('Telemetry exporter options must be a plain object');
  const unknown = Object.keys(options).find((key) => key !== 'write');
  if (unknown) throw new TypeError(`Telemetry exporter options contain unsupported field "${unknown}"`);
  if (options.write !== undefined && typeof options.write !== 'function') {
    throw new TypeError('Telemetry exporter write must be a function');
  }
  const write = options.write ?? ((line) => { process.stderr.write(line); });
  // The sink hands over an already-validated frozen record; nothing else is
  // serialized, so the line cannot carry a field the registry does not declare.
  const line = (record) => { write(`${JSON.stringify(record)}\n`); };
  return defineTelemetryExporter({
    name: 'json-stderr',
    contract: TELEMETRY_EXPORT_CONTRACT,
    emitLog: line, emitMetric: line, emitRun: line,
  });
}

/**
 * Test capture: a bounded ring, so a runaway producer in a test cannot grow
 * memory without bound any more than it can in production.
 *
 * The inspection API is returned **beside** the exporter rather than on it,
 * because `defineTelemetryExporter` refuses an exporter carrying any field
 * outside the five contract operations. That strictness is deliberate: it
 * makes "an exporter is exactly this and nothing else" a checkable property
 * instead of a convention, and it costs an integrator only a thin adapter.
 *
 * @param {{limit?: number}} [options]
 */
export function createCaptureTelemetryExporter(options = {}) {
  if (!plainObject(options)) throw new TypeError('Telemetry exporter options must be a plain object');
  const unknown = Object.keys(options).find((key) => key !== 'limit');
  if (unknown) throw new TypeError(`Telemetry exporter options contain unsupported field "${unknown}"`);
  const limit = positiveBound(options.limit, 256, MAX_CAPTURE, 'limit');
  const captured = [];
  let overflowed = 0;
  const capture = (record) => {
    if (captured.length >= limit) {
      captured.shift();
      overflowed += 1;
    }
    captured.push(record);
  };
  const exporter = defineTelemetryExporter({
    name: 'capture',
    contract: TELEMETRY_EXPORT_CONTRACT,
    emitLog: capture, emitMetric: capture, emitRun: capture,
  });
  return Object.freeze({
    exporter,
    records: () => Object.freeze([...captured]),
    signals: () => Object.freeze(captured.map((record) => record.signal)),
    overflowed: () => overflowed,
  });
}

// ─────────────────────────────────────────── producer report adapters
//
// Producers call these, never the sink directly, so the attribute shape of a
// signal lives beside its declaration rather than scattered across four
// runtime files. Each swallows its own failure: a malformed producer call is a
// rejected signal, never an exception raised into a business path.

/**
 * Is this the sink, and not the exporter it wraps?
 *
 * The distinction is load-bearing, not pedantry. Every containment this
 * contract promises — the allowlist, the bounded in-flight set, rejection
 * capture, the deadlines, the post-close drop — lives in the sink. An exporter
 * handed to a producer directly receives an envelope that was never validated,
 * and its returned promise reaches a caller that does not await it, which is
 * an unhandled rejection and, on Node 22, a dead process. A telemetry backend
 * going down would then take the application with it — the exact opposite of
 * the best-effort guarantee in ADR-043.
 *
 * A sink carries `status` and always carries `flush`/`close`; an exporter
 * carries `name` and may carry neither. That is the discriminator.
 *
 * @param {unknown} value
 */
export function isTelemetrySink(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const candidate = /** @type {any} */ (value);
  return candidate.contract === TELEMETRY_EXPORT_CONTRACT
    && ['emitLog', 'emitMetric', 'emitRun', 'flush', 'close', 'status']
      .every((operation) => typeof candidate[operation] === 'function');
}

/**
 * Refuse anything that is not a sink, in the caller's own refusal register.
 * Construction time, not first emission: a misconfigured telemetry wiring must
 * fail where it was written, not silently bypass the fence under load.
 *
 * @param {unknown} value
 * @param {(message: string) => never} refuse
 */
export function requireTelemetrySink(value, refuse) {
  if (value === undefined || value === null) return null;
  if (isTelemetrySink(value)) return value;
  const looksLikeExporter = Boolean(value) && typeof (/** @type {any} */ (value).emitLog) === 'function';
  return refuse(looksLikeExporter
    ? 'telemetry must be the sink from createTelemetrySink, not the exporter it wraps: '
      + 'an exporter passed here receives unvalidated records and its rejections reach nobody'
    : 'telemetry must be the sink returned by createTelemetrySink');
}

function report(telemetry, operation, input) {
  if (!telemetry || typeof telemetry[operation] !== 'function') return false;
  let settlement;
  try {
    settlement = telemetry[operation](input);
  } catch {
    return false;
  }
  // A sink's emit is synchronous and returns a boolean. Swallowing a thenable
  // anyway is what makes "an emission never throws into a producer" a property
  // of this function rather than a promise about its callers.
  if (settlement && typeof settlement.then === 'function') {
    Promise.resolve(settlement).catch(() => {});
    return false;
  }
  return settlement === true;
}

/** Milliseconds between two ISO instants from the caller's own clock, bounded. */
export function telemetryDurationMs(startedAt, endedAt) {
  const start = Date.parse(String(startedAt));
  const end = Date.parse(String(endedAt));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const elapsed = Math.trunc(end - start);
  if (!Number.isSafeInteger(elapsed)) return 0;
  return Math.min(Math.max(elapsed, -MAX_NUMBER), MAX_NUMBER);
}

/** @param {any} telemetry */
export function reportDurableJobClaimed(telemetry, { kind, handler, attempt }) {
  return report(telemetry, 'emitLog', {
    signal: 'accordo.durable_job.claimed',
    attributes: { kind, handler, attempt },
  });
}

/** @param {any} telemetry */
export function reportDurableJobWorkerError(telemetry, { errorCode }) {
  return report(telemetry, 'emitLog', {
    signal: 'accordo.durable_job.worker_error',
    attributes: { errorCode },
  });
}

/** @param {any} telemetry */
export function reportDurableJobExecution(telemetry, { kind, handler, state, attempt, durationMs, errorCode }) {
  return report(telemetry, 'emitRun', {
    signal: 'accordo.durable_job.execution',
    attributes: {
      kind, handler, state, attempt, durationMs,
      ...(errorCode == null ? {} : { errorCode }),
    },
  });
}

/** @param {any} telemetry */
export function reportOutboxDispatch(telemetry, { effect, outcome, attempt, durationMs, errorCode }) {
  return report(telemetry, 'emitRun', {
    signal: 'accordo.transactional_outbox.dispatch',
    attributes: {
      effect, outcome, attempt, durationMs,
      ...(errorCode == null ? {} : { errorCode }),
    },
  });
}

/**
 * The only thing a caught error may contribute to a signal: its own `code`,
 * validated against the export charset. Never `error.message` — a PostgreSQL
 * constraint violation carries tenant ids and fingerprints in its text
 * (`write-outcome-runtime.js#boundedFailureCode`). `null` when no code
 * survives, so the attribute is omitted rather than the record rejected.
 *
 * @param {unknown} error
 */
export function telemetryErrorCode(error) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return null;
  }
  const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  return typeof code === 'string' && code.length > 0 && code.length <= MAX_TEXT && CODE.test(code)
    ? code
    : null;
}

/** @param {any} telemetry */
export function reportBackupOperation(telemetry, { operation, outcome, durationMs, errorCode }) {
  return report(telemetry, 'emitRun', {
    signal: 'accordo.backup.operation',
    attributes: {
      operation, outcome, durationMs,
      ...(errorCode == null ? {} : { errorCode }),
    },
  });
}

/**
 * PostgreSQL writer readiness, reported on **transition only**.
 *
 * The one boolean this holds is de-duplication, not a second source of truth:
 * a `writerGuard` refusal storm would otherwise emit one signal per refused
 * write. The lease row stays the authority, the snapshot is recomputed from
 * `describeWriterHealth` on every observation, and deleting this object changes
 * signal volume and nothing else. No table, column or file is added for it.
 *
 * @param {any} telemetry
 */
export function createWriterReadinessObserver(telemetry) {
  let lastReported = null;
  return Object.freeze({
    /**
     * @param {{ready?: boolean, reason?: string, storage?: {adapter?: string}}} snapshot
     * @param {{expiresAt?: string, now?: string}} [lease]
     */
    observe(snapshot, lease = {}) {
      const ready = Boolean(snapshot?.ready);
      if (lastReported === ready) return false;
      lastReported = ready;
      const adapter = snapshot?.storage?.adapter ?? 'postgresql';
      const reason = snapshot?.reason;
      report(telemetry, 'emitLog', {
        signal: 'accordo.postgresql.readiness',
        attributes: {
          adapter, ready,
          ...(typeof reason === 'string' ? { reason } : {}),
        },
      });
      if (lease.expiresAt !== undefined && lease.now !== undefined) {
        report(telemetry, 'emitMetric', {
          signal: 'accordo.postgresql.writer_lease_remaining_ms',
          value: telemetryDurationMs(lease.now, lease.expiresAt),
          attributes: { adapter, ready },
        });
      }
      return true;
    },
  });
}

/**
 * The executable shape `scripts/repo-truth.js` probes, so the truth fact rests
 * on the contract rather than on this file's prose.
 */
export function telemetryVocabulary() {
  return Object.freeze({
    contract: TELEMETRY_EXPORT_CONTRACT,
    operations: Object.freeze(['emitLog', 'emitMetric', 'emitRun', 'flush', 'close']),
    signals: Object.freeze(Object.keys(TELEMETRY_SIGNALS).sort()),
    attributeKinds: Object.freeze(['boolean', 'code', 'enum', 'name', 'number']),
    exporters: Object.freeze(['capture', 'json-stderr', 'noop']),
    // Stated so a reader of the generated truth document cannot infer support
    // this slice does not implement.
    openTelemetry: false,
  });
}
