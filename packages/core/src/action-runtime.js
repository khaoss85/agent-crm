// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, NotFoundError, ValidationError, normalizeError } from './errors.js';
import { nowIso } from './time.js';

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

/**
 * Validate action input against a declared input schema. Returns a normalized
 * input object or throws a field-tied ValidationError. Only the small set of
 * types the starter needs is supported.
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
      out[field.name] = new Date(raw).toISOString();
    } else if (field.type === 'enum') {
      if (typeof raw !== 'string' || !(field.values ?? []).includes(raw)) {
        throw new ValidationError(`${field.name} must be one of: ${(field.values ?? []).join(', ')}`, { field: field.name });
      }
      out[field.name] = raw;
    } else {
      // string
      if (typeof raw !== 'string') throw new ValidationError(`${field.name} must be a string`, { field: field.name });
      out[field.name] = raw.trim();
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
 *   module: string, action: string, recordId: string, input: unknown, actor: unknown
 * }} params
 */
export async function runRecordAction(params) {
  const { database, events, services, registry, modules, module, action, recordId, input, actor } = params;
  const definition = registry.get(module, action); // throws NotFoundError if unknown
  const targetModule = modules.get(module); // throws NotFoundError if unknown
  const service = targetModule.service;

  const validatedInput = validateActionInput(definition.input ?? [], input);

  const runId = randomUUID();
  const startedAt = nowIso();
  /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
  const steps = [];
  /** @type {any} */
  let result;
  /** @type {any} */
  let failure = null;

  try {
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
          config: params.config ?? {},
          managed: (id, patch) => service.applyManaged(id, patch, { actor }),
          step: (name, output) => steps.push({ name, status: 'completed', output }),
        });
      });
      await outbox.commit(); // events visible only now, after the DB commit
      return value;
    });
    steps.unshift({ name: `${module}.${action}`, status: 'completed' });
  } catch (error) {
    failure = normalizeError(error);
    steps.unshift({ name: `${module}.${action}`, status: 'failed', error: failure.message });
  }

  // Persist the trace outside the business transaction (always recorded).
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

  if (failure) {
    failure.details = {
      ...(failure.details && typeof failure.details === 'object' ? failure.details : {}),
      workflowRunId: runId,
    };
    throw failure;
  }
  return { ok: true, module, action, recordId, runId, result };
}

/** @param {unknown} actor */
function safeActor(actor) {
  if (actor && typeof actor === 'object') {
    const a = /** @type {any} */ (actor);
    return { type: typeof a.type === 'string' ? a.type : null, id: typeof a.id === 'string' ? a.id : null };
  }
  return null;
}

/** @param {any} database @param {{runId: string, workflowName: string, status: string, input: unknown, output: unknown, error: string | null, startedAt: string, steps: Array<{name: string, status: string, output?: unknown, error?: string}>}} run */
function writeTrace(database, run) {
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
