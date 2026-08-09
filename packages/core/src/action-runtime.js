// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, NotFoundError, ValidationError, normalizeError } from './errors.js';
import { nowIso } from './time.js';
// Cycle-safe: both modules export hoisted function declarations only, and
// neither touches the other at module-evaluation time (ADR-017).
import { runExternalOperation } from './external-operation.js';

/**
 * Stable error for an action attempted from an invalid lifecycle state.
 */
export class InvalidStateError extends AppError {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message, { code: 'INVALID_STATE', status: 409, details });
  }
}

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Bound on action string inputs (e.g. a disqualification reason). The HTTP
// body limit (1 MB) bounds the request; this bounds what a single field may
// store, so a pathological value cannot bloat records, audit and traces.
export const ACTION_STRING_MAX_LENGTH = 10_000;

/**
 * Validate action input against a declared input schema. Returns a normalized
 * input object or throws a field-tied ValidationError. Only the small set of
 * types the starter needs is supported.
 *
 * Timestamp contract (canonical, documented in docs/ACTIONS.md): a UTC ISO-8601
 * instant `YYYY-MM-DDTHH:MM:SS(.mmm)?Z`. Offsets are rejected — one canonical
 * form avoids server-local-time ambiguity — and the calendar date must be real:
 * JavaScript's Date rolls `2026-02-30` over to March 2, so the parsed value is
 * round-tripped and must reproduce the input exactly.
 *
 * @param {Array<{name: string, type: string, required?: boolean, values?: string[]}>} schema
 * @param {unknown} body
 */
export function validateActionInput(schema, body) {
  if (body === null || body === undefined) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Action input must be a JSON object');
  }
  const input = /** @type {Record<string, unknown>} */ (body);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of schema) {
    const raw = input[field.name];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (field.required) throw new ValidationError(`${field.name} is required`, { field: field.name });
      continue;
    }
    if (field.type === 'timestamp') {
      if (typeof raw !== 'string' || !TIMESTAMP_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
        throw new ValidationError(`${field.name} must be an ISO-8601 UTC instant (…Z)`, { field: field.name });
      }
      const canonical = new Date(raw).toISOString();
      if (canonical !== (raw.includes('.') ? raw : `${raw.slice(0, -1)}.000Z`)) {
        throw new ValidationError(`${field.name} is not a real calendar date/time`, { field: field.name });
      }
      out[field.name] = canonical;
    } else if (field.type === 'enum') {
      if (typeof raw !== 'string' || !(field.values ?? []).includes(raw)) {
        throw new ValidationError(`${field.name} must be one of: ${(field.values ?? []).join(', ')}`, { field: field.name });
      }
      out[field.name] = raw;
    } else if (field.type === 'boolean') {
      // Strict: only a JSON boolean. "true", 1 and "yes" are refused rather
      // than coerced, so a caller can never half-mean a flag.
      if (typeof raw !== 'boolean') {
        throw new ValidationError(`${field.name} must be true or false`, { field: field.name });
      }
      out[field.name] = raw;
    } else if (field.type === 'json') {
      // Bounded structured input (e.g. a signer list): plain JSON-safe data
      // only — functions, symbols, cycles and non-plain objects are refused,
      // dangerous keys are dropped, and the serialized size is bounded so a
      // pathological payload cannot bloat records, audit and traces. The
      // action still validates the domain shape itself.
      if (typeof raw !== 'object') {
        throw new ValidationError(`${field.name} must be a JSON object or array`, { field: field.name });
      }
      const value = sanitizeJsonSafe(raw, field.name);
      if (JSON.stringify(value ?? null).length > ACTION_STRING_MAX_LENGTH) {
        throw new ValidationError(`${field.name} is too large`, { field: field.name });
      }
      out[field.name] = value;
    } else if (field.type === 'integer') {
      // JSON numbers only — never numeric strings — and only safe integers:
      // fractions, NaN/Infinity and unsafe magnitudes are all rejected, so an
      // action can trust the value arithmetic-safe (money stays minor units).
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) {
        throw new ValidationError(`${field.name} must be a whole number (JSON integer)`, { field: field.name });
      }
      out[field.name] = raw;
    } else {
      // string: outer whitespace is trimmed (inner whitespace preserved), and a
      // whitespace-only value counts as missing — a required reason of "\n\t "
      // must not satisfy the requirement.
      if (typeof raw !== 'string') throw new ValidationError(`${field.name} must be a string`, { field: field.name });
      if (raw.length > ACTION_STRING_MAX_LENGTH) {
        throw new ValidationError(`${field.name} must be at most ${ACTION_STRING_MAX_LENGTH} characters`, { field: field.name });
      }
      const trimmed = raw.trim();
      if (trimmed === '') {
        if (field.required) throw new ValidationError(`${field.name} is required`, { field: field.name });
        continue;
      }
      out[field.name] = trimmed;
    }
  }
  return out;
}

/**
 * Run a record action atomically with buffered domain events and a workflow
 * trace (ADR-011/012).
 *
 * The business writes run inside one outer transaction; generated-service
 * savepoints nest inside it, so all writes commit or none do. Events emitted
 * during the action are queued and dispatched only after the commit. The trace
 * (run + spans) is written after the transaction resolves — success or failure
 * — so a failed action still records a trace and no partial business state can
 * leak into it.
 *
 * @param {{
 *   database: any, events: any, services: Record<string, any>, config?: Record<string, any>,
 *   registry: {get: (module: string, action: string) => any},
 *   modules: {get: (name: string) => any},
 *   core?: Record<string, Function>,
 *   pipelines?: {forModule: (name: string) => any, get: (name: string) => any, list: () => any[]},
 *   commercial?: any,
 *   module: string, action: string, recordId: string, input: unknown, actor: unknown
 * }} params
 */
export async function runRecordAction(params) {
  const { database, events, services, registry, modules, module, action, recordId, input, actor } = params;
  const definition = registry.get(module, action); // throws NotFoundError if unknown
  const targetModule = modules.get(module); // throws NotFoundError if unknown
  const service = targetModule.service;

  const validatedInput = validateActionInput(definition.input ?? [], input);

  // External-operation actions (ADR-017) need TWO local write transactions
  // around a remote call, which the single-transaction envelope below cannot
  // represent honestly. They are routed to the bounded external-operation
  // runner instead — the action still declares phases, never transactions.
  if (definition.externalOperation) {
    return runExternalRecordAction(params, definition, validatedInput);
  }

  const runId = randomUUID();
  // One clock per run: the injected application clock when there is one, the
  // wall clock otherwise. Everything the action stamps uses the same source.
  const now = params.now ?? nowIso;
  const startedAt = now();
  /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
  const steps = [];
  /** @type {any} */
  let result;
  /** @type {any} */
  let failure = null;
  /** @type {any} */
  let dispatchFailure = null;
  /** @type {any} */
  let prepared;

  try {
    // Optional prepare phase (ADR-015): runs BEFORE the event buffer and the
    // write transaction, so an external-style side effect (an enrichment
    // provider call) never holds the database write lock open. The ctx is
    // genuinely read-oriented: no `managed`, and `modules` is a per-module
    // read-only view (get/list/listWhere/countWhere only — no create, update,
    // createManaged or applyManaged is reachable through any property). The
    // record read here is a preview: execute re-reads the authoritative record
    // inside the transaction. The returned value is normalized to plain
    // JSON-safe data and deep-frozen before it reaches execute (functions,
    // symbols, bigints, non-plain objects and cycles are rejected; dangerous
    // keys are dropped). A prepare failure fails the action with an honest
    // trace and never opens the transaction.
    if (typeof definition.prepare === 'function') {
      const previewRecord = service.get(recordId); // NotFoundError → honest 404, no provider call
      prepared = sanitizeJsonSafe(
        await definition.prepare({
          record: previewRecord,
          input: validatedInput,
          actor,
          modules: readOnlyModulesView(modules),
          config: params.config ?? {},
          now,
          step: (name, output) => steps.push({ name, status: 'completed', output }),
        }),
      );
    }
    result = await events.buffered(async (outbox) => {
      const value = await database.transactionAsync(async () => {
        const record = service.get(recordId); // NotFoundError → rolled back, no writes
        if (Array.isArray(definition.fromStates) && !definition.fromStates.includes(record[definition.stateField ?? 'status'])) {
          throw new InvalidStateError(
            `${module}.${action} is not allowed from state "${record[definition.stateField ?? 'status']}"`,
            { field: definition.stateField ?? 'status', from: record[definition.stateField ?? 'status'], action },
          );
        }
        return definition.execute({
          record,
          input: validatedInput,
          actor,
          services,
          modules,
          database,
          // Declared core-module capabilities (ADR-013); frozen, may be absent
          // in minimal test harnesses.
          core: params.core ?? Object.freeze({}),
          // Pipeline definitions (ADR-014); read-only registry view.
          pipelines: params.pipelines ?? Object.freeze({ forModule: () => null, get: () => null, list: () => [] }),
          // Commercial registries (ADR-016); read-only, frozen fallback.
          commercial: params.commercial ?? Object.freeze({
            getCatalogProvider: () => { throw new NotFoundError('Catalog provider', 'none registered'); },
            getDiscountPolicy: () => { throw new NotFoundError('Discount policy', 'none registered'); },
          }),
          // Optional domain packages (ADR-018 addendum); read-only registry
          // view, frozen fallback when no domain is registered.
          domains: params.domains ?? Object.freeze({
            getPolicy: () => { throw new NotFoundError('Domain policy', 'none registered'); },
            has: () => false,
          }),
          // Value returned by the prepare phase (undefined without one).
          prepared,
          config: params.config ?? {},
          now,
          managed: (id, patch) => service.applyManaged(id, patch, { actor }),
          step: (name, output) => steps.push({ name, status: 'completed', output }),
        });
      });
      // The database transaction is committed at this point. A subscriber
      // failure during the flush must NOT be reported as a business failure:
      // the caller would retry (or compensate) an action that already
      // succeeded. Policy (ADR-012): the action stays a success, and the
      // dispatch failure is recorded as a failed trace span and logged.
      try {
        await outbox.commit(); // events visible only now, after the DB commit
      } catch (error) {
        dispatchFailure = normalizeError(error);
      }
      return value;
    });
    steps.unshift({ name: `${module}.${action}`, status: 'completed' });
    if (dispatchFailure) {
      const detail = Array.isArray(dispatchFailure.details?.failures)
        ? `${dispatchFailure.message}: ${dispatchFailure.details.failures.join('; ')}`
        : dispatchFailure.message;
      steps.push({ name: 'events.dispatch', status: 'failed', error: detail });
      console.error(`[agent-crm] ${module}.${action} run ${runId}: business writes committed but event dispatch failed: ${detail}`);
    }
  } catch (error) {
    failure = normalizeError(error);
    // Steps recorded before the failure describe execution progress; the
    // business writes behind them were rolled back with the transaction. The
    // run-level "failed" status is authoritative (documented in ACTIONS.md).
    steps.unshift({ name: `${module}.${action}`, status: 'failed', error: failure.message });
  }

  // Persist the trace outside the business transaction, best-effort: a trace
  // write failure (e.g. the database is briefly locked by a concurrent writer)
  // must never mask the action's real outcome, so it is logged, not thrown.
  try {
    writeTrace(database, {
      runId,
      workflowName: `${module}.${action}`,
      status: failure ? 'failed' : 'completed',
      input: { recordId, input: validatedInput, actor: safeActor(actor) },
      output: failure ? null : result,
      error: failure ? failure.message : null,
      startedAt,
      steps,
    });
  } catch (traceError) {
    console.error(
      `[agent-crm] ${module}.${action} run ${runId}: failed to persist trace: ${traceError instanceof Error ? traceError.message : String(traceError)}`,
    );
  }

  if (failure) {
    failure.details = {
      ...(failure.details && typeof failure.details === 'object' ? failure.details : {}),
      workflowRunId: runId,
    };
    throw failure;
  }
  return { ok: true, module, action, recordId, runId, result };
}

/**
 * Run an external-operation action (ADR-017): intent inside transaction A, the
 * provider call outside every transaction, finalize inside transaction B, and
 * compensation in its own transaction when either failed.
 *
 * The write phases receive the same context an ordinary action's `execute`
 * does; the external phase receives only frozen JSON-safe data plus the
 * provider registries it needs — no database, no modules, no managed writes.
 *
 * @param {any} params @param {any} definition @param {Record<string, unknown>} validatedInput
 */
async function runExternalRecordAction(params, definition, validatedInput) {
  const { database, events, services, modules, module, action, recordId, actor } = params;
  const now = params.now ?? nowIso;
  const service = modules.get(module).service;
  const stateField = definition.stateField ?? 'status';

  const writeContext = () => ({
    services,
    modules,
    database,
    core: params.core ?? Object.freeze({}),
    pipelines: params.pipelines ?? Object.freeze({ forModule: () => null, get: () => null, list: () => [] }),
    commercial: params.commercial ?? Object.freeze({}),
    signature: params.signature ?? Object.freeze({
      getSignatureProvider: () => { throw new NotFoundError('Signature provider', 'none registered'); },
    }),
    domains: params.domains ?? Object.freeze({
      getPolicy: () => { throw new NotFoundError('Domain policy', 'none registered'); },
      has: () => false,
    }),
    config: params.config ?? {},
    managed: (id, patch) => service.applyManaged(id, patch, { actor }),
  });

  const { result, runId } = await runExternalOperation({
    database,
    events,
    name: `${module}.${action}`,
    now,
    input: { recordId, input: validatedInput },
    actor,
    timeoutMs: definition.timeoutMs ?? params.config?.externalTimeoutMs,
    intent: (ctx) => {
      const record = service.get(recordId); // NotFoundError → rolled back
      if (Array.isArray(definition.fromStates) && !definition.fromStates.includes(record[stateField])) {
        throw new InvalidStateError(
          `${module}.${action} is not allowed from state "${record[stateField]}"`,
          { field: stateField, from: record[stateField], action },
        );
      }
      return definition.intent({ ...ctx, ...writeContext(), record, input: validatedInput });
    },
    external: typeof definition.external === 'function'
      // Deliberately narrow: frozen intent data, the validated input, the actor
      // and the provider registries. Nothing here can write to the database.
      ? (ctx) => definition.external({
        intent: ctx.intent,
        input: validatedInput,
        actor,
        signature: params.signature ?? Object.freeze({}),
        commercial: params.commercial ?? Object.freeze({}),
        config: params.config ?? {},
        step: ctx.step,
        now: ctx.now,
      })
      : null,
    finalize: typeof definition.finalize === 'function'
      ? (ctx) => definition.finalize({ ...ctx, ...writeContext(), record: service.get(recordId), input: validatedInput })
      : null,
    compensate: typeof definition.compensate === 'function'
      ? (ctx) => definition.compensate({ ...ctx, ...writeContext(), record: service.get(recordId), input: validatedInput })
      : null,
  });
  return { ok: true, module, action, recordId, runId, result };
}

const READ_ONLY_SERVICE_METHODS = ['get', 'list', 'listWhere', 'countWhere'];
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A read-only view of the module registry for the prepare phase: each module's
 * service is reduced to its read methods, so no write path (create, update,
 * createManaged, applyManaged) is reachable through any ctx property.
 * @param {{get: (name: string) => any}} modules
 */
function readOnlyModulesView(modules) {
  return Object.freeze({
    get(name) {
      const module = modules.get(name); // NotFoundError for unknown modules
      /** @type {Record<string, Function>} */
      const service = {};
      for (const method of READ_ONLY_SERVICE_METHODS) {
        if (typeof module.service?.[method] === 'function') {
          service[method] = module.service[method].bind(module.service);
        }
      }
      return Object.freeze({ name: module.name, service: Object.freeze(service) });
    },
  });
}

/**
 * Normalize a value to plain JSON-safe data and deep-freeze it. Fail closed on
 * anything that cannot round-trip deterministically: functions, symbols,
 * bigints, non-finite numbers, non-plain objects and cycles are refused, and
 * `__proto__`/`constructor`/`prototype` keys are dropped rather than
 * re-assigned. Shared by the prepare phase, structured action input and the
 * external-operation phase boundaries (ADR-015/017).
 * @param {unknown} value @param {string} [path]
 */
export function sanitizeJsonSafe(value, path = 'value', seen = new Set()) {
  if (value === undefined || value === null) return value ?? undefined;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`non-finite number at ${path}`);
    return value;
  }
  if (type === 'function' || type === 'bigint' || type === 'symbol') {
    throw new ValidationError(`plain JSON-safe data required (found ${type} at ${path})`);
  }
  if (seen.has(value)) {
    throw new ValidationError(`cyclic structure at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((item, index) => sanitizeJsonSafe(item, `${path}[${index}]`, seen) ?? null));
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(`plain JSON-safe data required (non-plain object at ${path})`);
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue; // dropped, never re-assigned
      const item = sanitizeJsonSafe(/** @type {any} */ (value)[key], `${path}.${key}`, seen);
      if (item !== undefined) out[key] = item;
    }
    return Object.freeze(out);
  } finally {
    seen.delete(value);
  }
}

/** @param {unknown} actor */
function safeActor(actor) {
  if (actor && typeof actor === 'object') {
    const a = /** @type {any} */ (actor);
    return { type: typeof a.type === 'string' ? a.type : null, id: typeof a.id === 'string' ? a.id : null };
  }
  return null;
}

/**
 * Best-effort operation trace writer, shared with app-level operations that
 * follow the action envelope (e.g. catalog sync, ADR-016).
 * @param {any} database @param {{runId: string, workflowName: string, status: string, input: unknown, output: unknown, error: string | null, startedAt: string, steps: Array<{name: string, status: string, output?: unknown, error?: string}>}} run
 */
export function writeTrace(database, run) {
  const finishedAt = nowIso();
  database.raw
    .prepare(
      `INSERT INTO workflow_runs(id, workflow_name, status, input_json, output_json, error, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(run.runId, run.workflowName, run.status, safeJson(run.input), safeJson(run.output), run.error, run.startedAt, finishedAt);
  for (const step of run.steps) {
    database.raw
      .prepare(
        `INSERT INTO trace_spans(id, run_id, parent_span_id, name, status, input_json, output_json, error, started_at, finished_at)
         VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), run.runId, step.name, step.status, safeJson(step.output ?? null), step.error ?? null, run.startedAt, finishedAt);
  }
}

/** @param {unknown} value */
function safeJson(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export { ValidationError, NotFoundError };
