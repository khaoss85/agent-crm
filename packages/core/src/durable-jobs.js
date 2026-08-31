// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { AppError, ValidationError } from './errors.js';
import { durableJobStorageFor, durableJobStorageOwnerFor } from './durable-job-storage.js';
import { resolveClock } from './time.js';

export const DURABLE_JOB_CONTRACT = 1;
export const DURABLE_JOB_STATES = Object.freeze([
  'pending', 'claimed', 'succeeded', 'failed_retryable', 'failed_terminal', 'cancelled',
]);
export const DURABLE_JOB_RETRYABLE_ERRORS = Object.freeze([
  'JOB_CLAIM_RELEASED', 'JOB_HANDLER_BUSY', 'JOB_HANDLER_TEMPORARY_UNAVAILABLE',
]);

const RETRYABLE = new Set(DURABLE_JOB_RETRYABLE_ERRORS);
const CLOSED_STATES = new Set(DURABLE_JOB_STATES);
const NAME = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_TEXT = 256;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 12;
const MAX_ATTEMPTS = 100;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const SENSITIVE_KEY = /(?:secret|password|passwd|credential|authorization|bearer|api[_-]?key|connection[_-]?(?:string|url)|database[_-]?url|private[_-]?key)/i;

function closedObject(value, allowed, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be a plain object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ValidationError(`${label} contains unsupported field "${unknown}"`);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new ValidationError(`${label} requires "${missing}"`);
}

function boundedName(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !NAME.test(value)) {
    throw new ValidationError(`${label} must be a bounded lowercase name`);
  }
  return value;
}

function boundedText(value, label, required = true) {
  if (value === null && !required) return null;
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT || /[\u0000\r\n]/.test(value)) {
    throw new ValidationError(`${label} must be bounded single-line text`);
  }
  return value;
}

function boundedCode(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !ERROR_CODE.test(value)) {
    throw new ValidationError(`${label} must be a bounded error code`);
  }
  return value;
}

function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ValidationError(`${label} must be a positive safe integer`);
  }
  return value;
}

function canonicalInstant(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ValidationError(`${label} must be a canonical UTC ISO instant`);
  }
  return value;
}

function canonicalPayloadValue(value, depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) throw new ValidationError('Job payload exceeds the maximum nesting depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalPayloadValue(entry, depth + 1));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError('Job payload must contain JSON-safe plain data');
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || SENSITIVE_KEY.test(key)) {
      throw new ValidationError('Job payload contains a forbidden or credential-shaped field');
    }
    if (key.length > 128) throw new ValidationError('Job payload field name is too long');
    output[key] = canonicalPayloadValue(value[key], depth + 1);
  }
  return output;
}

export function canonicalJobPayload(payload) {
  const value = canonicalPayloadValue(payload);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new ValidationError('Job payload exceeds the byte limit');
  return Object.freeze({
    value,
    json,
    fingerprint: createHash('sha256').update(json).digest('hex'),
  });
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function safeInteger(value, label) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new AppError(`Persisted durable-job ${label} is invalid`, {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: label },
    });
  }
  return number;
}

function decodeRow(row) {
  if (!row) return null;
  const state = String(row.state);
  if (!CLOSED_STATES.has(state)) {
    throw new AppError('Persisted durable-job state is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'state' },
    });
  }
  let payload;
  try { payload = JSON.parse(String(row.payload_json)); } catch {
    throw new AppError('Persisted durable-job payload is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'payload' },
    });
  }
  const contractVersion = safeInteger(row.contract_version, 'contractVersion');
  const handlerContract = safeInteger(row.handler_contract, 'handlerContract');
  const persistedPayload = canonicalJobPayload(payload);
  if (contractVersion !== DURABLE_JOB_CONTRACT || handlerContract !== 1
    || persistedPayload.json !== String(row.payload_json)
    || persistedPayload.fingerprint !== String(row.payload_fingerprint)) {
    throw new AppError('Persisted durable-job contract or fingerprint is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'contract' },
    });
  }
  const claimValues = [row.claim_worker_id, row.claim_id, row.claim_expires_at];
  const claimPresent = claimValues.map((value) => value !== null && value !== undefined);
  if ((state === 'claimed' && claimPresent.some((present) => !present))
    || (state !== 'claimed' && claimPresent.some(Boolean))) {
    throw new AppError('Persisted durable-job claim metadata is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'claim' },
    });
  }
  const decoded = {
    id: String(row.id), contractVersion,
    tenantId: String(row.tenant_id), kind: String(row.kind),
    handler: Object.freeze({
      name: String(row.handler_name), contract: handlerContract,
      version: safeInteger(row.handler_version, 'handlerVersion'),
    }),
    payload, payloadFingerprint: String(row.payload_fingerprint),
    scheduleAt: iso(row.schedule_at), state,
    attempt: safeInteger(row.attempt, 'attempt'), maxAttempts: safeInteger(row.max_attempts, 'maxAttempts'),
    claim: row.claim_id === null || row.claim_id === undefined ? null : Object.freeze({
      workerId: String(row.claim_worker_id), claimId: String(row.claim_id),
      generation: safeInteger(row.claim_generation, 'claimGeneration'),
      expiresAt: iso(row.claim_expires_at),
    }),
    claimGeneration: safeInteger(row.claim_generation, 'claimGeneration'),
    idempotencyRoot: String(row.idempotency_root),
    outcomeReference: row.outcome_reference == null ? null : String(row.outcome_reference),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
  };
  return Object.freeze(decoded);
}

function claimFenced() {
  return new AppError('The durable-job claim is no longer owned by this worker', {
    code: 'DURABLE_JOB_CLAIM_FENCED', status: 409,
  });
}

/**
 * One store is permanently bound to one application tenant.
 * @param {{storage: any, tenantId: string, clock?: () => string, idSource?: () => string, claimIdSource?: () => string}} options
 */
export function createDurableJobStore(options) {
  closedObject(options, ['storage', 'tenantId', 'clock', 'idSource', 'claimIdSource'], ['storage', 'tenantId'], 'Durable-job store options');
  const tenantId = boundedText(options.tenantId, 'tenantId');
  const now = resolveClock(options.clock);
  const idSource = options.idSource ?? randomUUID;
  const claimIdSource = options.claimIdSource ?? randomUUID;
  if (typeof idSource !== 'function' || typeof claimIdSource !== 'function') throw new TypeError('Durable-job id sources must be functions');
  const storageOwner = durableJobStorageOwnerFor(options.storage);

  const adapterFor = (storage) => {
    if (durableJobStorageOwnerFor(storage) !== storageOwner) {
      throw new AppError('Durable-job transaction belongs to a different storage handle', {
        code: 'DURABLE_JOB_TRANSACTION_MISMATCH', status: 500,
      });
    }
    return durableJobStorageFor(storage);
  };

  const inTransaction = (fn) => options.storage.transaction(async (tx) => fn(adapterFor(tx)));

  async function get(id) {
    const jobId = boundedText(id, 'job id');
    return inTransaction(async (adapter) => decodeRow(await adapter.get(tenantId, jobId)));
  }

  async function enqueue(input, context = {}) {
    closedObject(context, ['transaction'], [], 'Durable-job enqueue context');
    closedObject(input,
      ['kind', 'handler', 'payload', 'scheduleAt', 'maxAttempts', 'idempotencyRoot', 'outcomeReference'],
      ['kind', 'handler', 'payload', 'idempotencyRoot'], 'Durable-job enqueue input');
    closedObject(input.handler, ['name', 'contract', 'version'], ['name', 'contract', 'version'], 'Durable-job handler identity');
    const createdAt = now();
    const explicitSchedule = input.scheduleAt !== undefined;
    const scheduleAt = canonicalInstant(input.scheduleAt ?? createdAt, 'scheduleAt');
    const payload = canonicalJobPayload(input.payload);
    const row = {
      id: boundedText(idSource(), 'generated job id'), contract_version: DURABLE_JOB_CONTRACT,
      tenant_id: tenantId, kind: boundedName(input.kind, 'job kind'),
      handler_name: boundedName(input.handler.name, 'handler name'),
      handler_contract: input.handler.contract === 1 ? 1 : (() => { throw new ValidationError('handler contract must be 1'); })(),
      handler_version: positiveInteger(input.handler.version, 'handler version'),
      payload_json: payload.json, payload_fingerprint: payload.fingerprint,
      schedule_at: scheduleAt, state: 'pending', attempt: 0,
      max_attempts: positiveInteger(input.maxAttempts ?? 3, 'maxAttempts', MAX_ATTEMPTS),
      claim_worker_id: null, claim_id: null, claim_generation: 0, claim_expires_at: null,
      idempotency_root: boundedText(input.idempotencyRoot, 'idempotencyRoot'),
      outcome_reference: input.outcomeReference == null ? null : boundedText(input.outcomeReference, 'outcomeReference'),
      created_at: createdAt, updated_at: createdAt, last_error_code: null,
    };
    const persist = async (adapter) => {
      if (await adapter.insert(row)) return decodeRow(row);
      const existing = decodeRow(await adapter.getByRoot(tenantId, row.idempotency_root));
      if (existing && existing.kind === row.kind && existing.handler.name === row.handler_name
        && existing.handler.contract === row.handler_contract && existing.handler.version === row.handler_version
        && existing.payloadFingerprint === row.payload_fingerprint
        && (!explicitSchedule || existing.scheduleAt === row.schedule_at)
        && existing.maxAttempts === row.max_attempts
        && existing.outcomeReference === row.outcome_reference) return existing;
      throw new AppError('Durable-job idempotency root was already used for different work', {
        code: 'DURABLE_JOB_IDEMPOTENCY_MISMATCH', status: 409,
      });
    };
    return context.transaction
      ? persist(adapterFor(context.transaction))
      : inTransaction(persist);
  }

  async function claim(workerId, leaseMs = 30_000) {
    const worker = boundedText(workerId, 'workerId');
    positiveInteger(leaseMs, 'leaseMs', MAX_LEASE_MS);
    const instant = now();
    const expiresAt = new Date(Date.parse(instant) + leaseMs).toISOString();
    const claimId = boundedText(claimIdSource(), 'generated claim id');
    return inTransaction(async (adapter) => decodeRow(await adapter.claim({
      tenantId, workerId: worker, claimId, now: instant, expiresAt,
    })));
  }

  function requireClaim(job, workerId) {
    if (!job || job.tenantId !== tenantId || job.state !== 'claimed' || !job.claim
      || job.claim.workerId !== workerId) throw claimFenced();
    return job.claim;
  }

  async function finish(job, workerId, transition) {
    const claim = requireClaim(job, workerId);
    const instant = now();
    const changed = await inTransaction((adapter) => adapter.finish({
      tenantId, id: job.id, workerId, claimId: claim.claimId, generation: claim.generation,
      now: instant, state: transition.state,
      scheduleAt: transition.scheduleAt ?? job.scheduleAt,
      outcomeReference: transition.outcomeReference ?? job.outcomeReference,
      errorCode: transition.errorCode ?? null,
    }));
    if (changed !== 1) throw claimFenced();
    return get(job.id);
  }

  return Object.freeze({
    contract: DURABLE_JOB_CONTRACT,
    tenantId,
    now,
    enqueue,
    get,
    claim,
    async succeed(job, workerId, outcomeReference = null) {
      return finish(job, boundedText(workerId, 'workerId'), {
        state: 'succeeded',
        outcomeReference: outcomeReference == null ? null : boundedText(outcomeReference, 'outcomeReference'),
      });
    },
    async fail(job, workerId, input) {
      closedObject(input, ['errorCode', 'retryAt'], ['errorCode'], 'Durable-job failure');
      const errorCode = boundedCode(input.errorCode, 'errorCode');
      const retryable = RETRYABLE.has(errorCode) && job.attempt < job.maxAttempts;
      const retryAt = retryable ? canonicalInstant(input.retryAt, 'retryAt') : job.scheduleAt;
      return finish(job, boundedText(workerId, 'workerId'), {
        state: retryable ? 'failed_retryable' : 'failed_terminal',
        scheduleAt: retryAt, errorCode,
      });
    },
    async release(job, workerId) {
      return finish(job, boundedText(workerId, 'workerId'), {
        state: 'failed_retryable', scheduleAt: now(), errorCode: 'JOB_CLAIM_RELEASED',
      });
    },
    async cancel(id) {
      const jobId = boundedText(id, 'job id');
      const changed = await inTransaction((adapter) => adapter.cancel({ tenantId, id: jobId, now: now() }));
      if (changed !== 1) throw new AppError('Only pending durable jobs can be cancelled', { code: 'DURABLE_JOB_NOT_PENDING', status: 409 });
      return get(jobId);
    },
    async reschedule(id, scheduleAt) {
      const jobId = boundedText(id, 'job id');
      const next = canonicalInstant(scheduleAt, 'scheduleAt');
      const changed = await inTransaction((adapter) => adapter.reschedule({ tenantId, id: jobId, scheduleAt: next, now: now() }));
      if (changed !== 1) throw new AppError('Only pending durable jobs can be rescheduled', { code: 'DURABLE_JOB_NOT_PENDING', status: 409 });
      return get(jobId);
    },
    async list(limit = 100) {
      positiveInteger(limit, 'limit', 500);
      return inTransaction(async (adapter) => (await adapter.list(tenantId, limit)).map(decodeRow));
    },
  });
}

/** Closed named handler registry; executable functions are never persisted. */
export function createDurableJobHandlerRegistry() {
  const handlers = new Map();
  return Object.freeze({
    register(definition) {
      closedObject(definition, ['name', 'version', 'kind', 'execute', 'sideEffect'], ['name', 'version', 'kind', 'execute'], 'Durable-job handler');
      const name = boundedName(definition.name, 'handler name');
      const kind = boundedName(definition.kind, 'handler kind');
      const version = positiveInteger(definition.version, 'handler version');
      if (typeof definition.execute !== 'function') throw new ValidationError('Durable-job handler execute must be a function');
      const sideEffect = definition.sideEffect ?? 'none';
      if (sideEffect !== 'none' && sideEffect !== 'external-operation-v2') {
        throw new ValidationError('Durable-job handler sideEffect must be none or external-operation-v2');
      }
      const key = `${kind}\u0000${name}\u0000${version}`;
      if (handlers.has(key)) throw new AppError('Durable-job handler identity is already registered', { code: 'DURABLE_JOB_HANDLER_DUPLICATE', status: 409 });
      handlers.set(key, Object.freeze({ name, kind, version, sideEffect, execute: definition.execute }));
    },
    resolve(job) {
      return handlers.get(`${job.kind}\u0000${job.handler.name}\u0000${job.handler.version}`) ?? null;
    },
    list() {
      return [...handlers.values()].map(({ execute: _execute, ...handler }) => Object.freeze({ ...handler }))
        .sort((a, b) => `${a.kind}:${a.name}:${a.version}`.localeCompare(`${b.kind}:${b.name}:${b.version}`));
    },
  });
}

function boundedErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : null;
  return typeof code === 'string' && ERROR_CODE.test(code) && code.length <= 128
    ? code
    : 'JOB_HANDLER_FAILED';
}

function defaultBackoff(attempt) {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

/** Explicit worker. Constructing it starts no timers and claims no work. */
export function createDurableJobWorker(options) {
  closedObject(options,
    ['store', 'registry', 'workerId', 'clock', 'pollIntervalMs', 'leaseMs', 'backoff'],
    ['store', 'registry', 'workerId'], 'Durable-job worker options');
  const workerId = boundedText(options.workerId, 'workerId');
  const clock = resolveClock(options.clock ?? options.store.now);
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, 'pollIntervalMs', 60_000);
  const leaseMs = positiveInteger(options.leaseMs ?? 30_000, 'leaseMs', MAX_LEASE_MS);
  const backoff = options.backoff ?? defaultBackoff;
  if (typeof backoff !== 'function') throw new TypeError('Durable-job backoff must be a function');

  let accepting = false;
  let closed = false;
  let timer = null;
  let pollPromise = null;
  let inFlight = null;

  const clearWake = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const scheduleWake = (delay = pollIntervalMs) => {
    clearWake();
    if (!accepting || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void poll().catch(() => {}).finally(() => scheduleWake());
    }, delay);
  };

  async function execute(job) {
    const handler = options.registry.resolve(job);
    if (!handler) {
      return options.store.fail(job, workerId, { errorCode: 'JOB_HANDLER_NOT_REGISTERED' });
    }
    // A recovered external effect is an unknown outcome, not permission to
    // call the provider again. externalOperationId is stable across attempts;
    // reconciliation owns the next step under external-operation v2.
    if (handler.sideEffect === 'external-operation-v2' && job.attempt > 1) {
      return options.store.fail(job, workerId, { errorCode: 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED' });
    }
    const recordHandlerFailure = (error) => {
      let errorCode = boundedErrorCode(error);
      if (handler.sideEffect === 'external-operation-v2') {
        errorCode = 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED';
      }
      const retryable = RETRYABLE.has(errorCode) && handler.sideEffect === 'none' && job.attempt < job.maxAttempts;
      let retryAt;
      if (retryable) {
        const delay = backoff(job.attempt, errorCode);
        if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_LEASE_MS) {
          errorCode = 'JOB_BACKOFF_INVALID';
        } else {
          retryAt = new Date(Date.parse(clock()) + delay).toISOString();
        }
      }
      return options.store.fail(job, workerId, { errorCode, ...(retryAt ? { retryAt } : {}) });
    };
    let result;
    try {
      result = await handler.execute(Object.freeze({
        job, payload: job.payload, tenantId: job.tenantId, workerId, now: clock,
        externalOperationId: job.idempotencyRoot,
      }));
    } catch (error) {
      return recordHandlerFailure(error);
    }
    let outcomeReference;
    try {
      outcomeReference = result && typeof result === 'object' && result.outcomeReference != null
        ? boundedText(result.outcomeReference, 'outcomeReference')
        : null;
    } catch (error) {
      return recordHandlerFailure(error);
    }
    // Persistence failures are not handler failures. Let the worker surface
    // them without falsely terminalizing a job whose commit outcome is unknown.
    return options.store.succeed(job, workerId, outcomeReference);
  }

  async function poll() {
    if (!accepting || closed) return null;
    if (pollPromise) return pollPromise;
    pollPromise = (async () => {
      const job = await options.store.claim(workerId, leaseMs);
      if (!job) return null;
      if (!accepting || closed) return options.store.release(job, workerId);
      inFlight = execute(job);
      try { return await inFlight; } finally { inFlight = null; }
    })();
    try { return await pollPromise; } finally { pollPromise = null; }
  }

  async function drain(input = {}) {
    closedObject(input, ['timeoutMs'], [], 'Durable-job drain options');
    accepting = false;
    clearWake();
    const current = inFlight ?? pollPromise;
    if (!current) return Object.freeze({ drained: true });
    const timeoutMs = positiveInteger(input.timeoutMs ?? 30_000, 'timeoutMs', MAX_LEASE_MS);
    let timeout;
    const marker = Symbol('timeout');
    try {
      const settled = await Promise.race([
        Promise.resolve(current),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(marker), timeoutMs); }),
      ]);
      return Object.freeze({
        drained: settled !== marker,
        ...(settled === marker ? { code: 'DURABLE_JOB_DRAIN_TIMEOUT' } : {}),
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  return Object.freeze({
    workerId,
    start() {
      if (closed) throw new AppError('Durable-job worker is closed', { code: 'DURABLE_JOB_WORKER_CLOSED', status: 409 });
      if (!accepting) { accepting = true; scheduleWake(); }
    },
    wake() {
      if (closed) throw new AppError('Durable-job worker is closed', { code: 'DURABLE_JOB_WORKER_CLOSED', status: 409 });
      if (accepting) scheduleWake(0);
    },
    poll,
    drain,
    stop: drain,
    async close(input = {}) {
      const result = await drain(input);
      closed = true;
      clearWake();
      return result;
    },
    status() {
      return Object.freeze({ accepting, closed, polling: pollPromise !== null, inFlight: inFlight !== null, wakeScheduled: timer !== null });
    },
  });
}
