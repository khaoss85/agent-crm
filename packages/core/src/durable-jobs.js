// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { requireActor } from './actor.js';
import { AuditLog } from './audit.js';
import { AppError, ValidationError } from './errors.js';
import {
  assertActiveDurableJobTransaction,
  durableJobStorageFor,
  durableJobStorageOwnerFor,
} from './durable-job-storage.js';
import {
  reportDurableJobClaimed,
  reportDurableJobExecution,
  reportDurableJobWorkerError,
  requireTelemetrySink,
  telemetryDurationMs,
} from './observability-export.js';
import { resolveClock } from './time.js';

export const DURABLE_JOB_CONTRACT = 1;
export const DURABLE_JOB_STATES = Object.freeze([
  'pending', 'claimed', 'succeeded', 'failed_retryable', 'failed_terminal', 'cancelled',
]);
export const DURABLE_JOB_RETRYABLE_ERRORS = Object.freeze([
  'JOB_CLAIM_RELEASED', 'JOB_HANDLER_BUSY', 'JOB_HANDLER_TEMPORARY_UNAVAILABLE',
]);

const RETRYABLE = new Set(DURABLE_JOB_RETRYABLE_ERRORS);
const HANDLER_RETRYABLE = new Set(['JOB_HANDLER_BUSY', 'JOB_HANDLER_TEMPORARY_UNAVAILABLE']);
const HANDLER_TERMINAL = new Set(['JOB_OUTBOX_FINALIZE_DECLARATION_RECONCILIATION_REQUIRED']);
const PRE_EXECUTION_FAILURES = new Set([
  'JOB_HANDLER_NOT_REGISTERED', 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED',
]);
const CLOSED_FAILURE_CODES = new Set([
  ...HANDLER_RETRYABLE,
  ...HANDLER_TERMINAL,
  ...PRE_EXECUTION_FAILURES,
  'JOB_HANDLER_FAILED',
  'JOB_BACKOFF_INVALID',
  'JOB_EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED',
]);
const WORKER_STATUS_ERRORS = new Set(['DURABLE_JOB_STORAGE_UNAVAILABLE']);
const CLOSED_STATES = new Set(DURABLE_JOB_STATES);
const SCHEDULE_INTENTS = new Set(['immediate', 'scheduled']);
const RECOVERY_POLICIES = new Set(['terminal_unknown', 'reconcilable_at_least_once']);
const NAME = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_TEXT = 256;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PAYLOAD_DEPTH = 12;
const MAX_PAYLOAD_ARRAY_ITEMS = Math.floor((MAX_PAYLOAD_BYTES - 1) / 2);
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

function closedJobInput(value, allowed, required) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('shape');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(descriptors).length > 0) throw new Error('symbols');
    const names = Object.keys(descriptors);
    if (names.some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(descriptors, key))) throw new Error('keys');
    const snapshot = {};
    for (const key of names) {
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('accessor');
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw new AppError('Durable-job input could not be inspected safely', {
      code: 'DURABLE_JOB_INPUT_INVALID', status: 400,
    });
  }
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

function mutationAuthority(context, allowed) {
  const snapshot = closedJobInput(context, [...allowed, 'actor'], ['actor']);
  const actorInput = closedJobInput(snapshot.actor, ['type', 'id'], ['type', 'id']);
  const actor = requireActor(actorInput, 'actor');
  return Object.freeze({
    actor: Object.freeze({ type: actor.type, id: boundedText(actor.id, 'actor.id') }),
    context: snapshot,
  });
}

function mutationActor(context, allowed) {
  return mutationAuthority(context, allowed).actor;
}

function systemMutationActor(context, label) {
  const actor = mutationActor(context, []);
  if (actor.type !== 'system') {
    throw new ValidationError(`${label} actor must have system authority`, { field: 'actor.type' });
  }
  return actor;
}

async function recordMutation(audit, handle, actor, action, jobId, data = {}) {
  await Promise.resolve(audit.record({
    actor,
    action: `durable_job.${action}`,
    entityType: 'durable_job',
    entityId: jobId,
    data,
  }, handle));
}

function canonicalPayloadValue(value, depth = 0, ancestors = new WeakSet()) {
  if (depth > MAX_PAYLOAD_DEPTH) throw new Error('depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (!value || typeof value !== 'object') throw new Error('type');
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if ((array && prototype !== Array.prototype) || (!array && prototype !== Object.prototype)) {
    throw new Error('prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(descriptors).length > 0 || ancestors.has(value)) throw new Error('shape');
  ancestors.add(value);
  if (array) {
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > MAX_PAYLOAD_ARRAY_ITEMS) {
      throw new Error('array-length');
    }
    const output = Array.from({ length: length.value }, () => null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length') continue;
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value
        || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('array-property');
      output[Number(key)] = canonicalPayloadValue(descriptor.value, depth + 1, ancestors);
    }
    ancestors.delete(value);
    return output;
  }
  const output = {};
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || SENSITIVE_KEY.test(key)) {
      throw new Error('key');
    }
    if (key.length > 128 || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('property');
    output[key] = canonicalPayloadValue(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
  return output;
}

export function canonicalJobPayload(payload) {
  try {
    const value = canonicalPayloadValue(payload);
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new Error('bytes');
    return Object.freeze({
      value,
      json,
      fingerprint: createHash('sha256').update(json).digest('hex'),
    });
  } catch {
    throw new AppError('Durable-job payload could not be inspected safely', {
      code: 'DURABLE_JOB_PAYLOAD_INVALID', status: 400,
    });
  }
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
  const scheduleIntent = String(row.schedule_intent);
  if (!CLOSED_STATES.has(state)) {
    throw new AppError('Persisted durable-job state is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'state' },
    });
  }
  if (!SCHEDULE_INTENTS.has(scheduleIntent)) {
    throw new AppError('Persisted durable-job schedule intent is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'scheduleIntent' },
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
  let persistedPayload;
  try { persistedPayload = canonicalJobPayload(payload); } catch {
    throw new AppError('Persisted durable-job payload is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'payload' },
    });
  }
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
  let executionStartedAt = null;
  if (row.execution_started_at !== null && row.execution_started_at !== undefined) {
    try { executionStartedAt = canonicalInstant(iso(row.execution_started_at), 'executionStartedAt'); } catch {
      throw new AppError('Persisted durable-job execution-start evidence is invalid', {
        code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'executionStartedAt' },
      });
    }
  }
  if ((state === 'pending' || state === 'cancelled') && executionStartedAt !== null) {
    throw new AppError('Persisted durable-job execution-start evidence is invalid', {
      code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'executionStartedAt' },
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
    scheduleIntent, scheduleAt: iso(row.schedule_at), state,
    recoveryPolicy: RECOVERY_POLICIES.has(row.recovery_policy) ? row.recovery_policy : (() => {
      throw new AppError('Stored durable-job recovery policy is invalid', {
        code: 'DURABLE_JOB_ROW_INVALID', status: 500, details: { field: 'recoveryPolicy' },
      });
    })(),
    attempt: safeInteger(row.attempt, 'attempt'), maxAttempts: safeInteger(row.max_attempts, 'maxAttempts'),
    claim: row.claim_id === null || row.claim_id === undefined ? null : Object.freeze({
      workerId: String(row.claim_worker_id), claimId: String(row.claim_id),
      generation: safeInteger(row.claim_generation, 'claimGeneration'),
      expiresAt: iso(row.claim_expires_at),
    }),
    claimGeneration: safeInteger(row.claim_generation, 'claimGeneration'),
    executionStartedAt,
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
  const audit = new AuditLog({ storage: options.storage });

  const adapterFor = (storage, requireTransaction = false) => {
    if (durableJobStorageOwnerFor(storage) !== storageOwner) {
      throw new AppError('Durable-job transaction belongs to a different storage handle', {
        code: 'DURABLE_JOB_TRANSACTION_MISMATCH', status: 500,
      });
    }
    if (requireTransaction) assertActiveDurableJobTransaction(storage);
    return durableJobStorageFor(storage);
  };

  const inTransaction = (fn) => options.storage.transaction(async (tx) => fn(adapterFor(tx), tx));

  async function get(id) {
    const jobId = boundedText(id, 'job id');
    return inTransaction(async (adapter) => decodeRow(await adapter.get(tenantId, jobId)));
  }

  async function enqueue(input, context = {}) {
    const authority = mutationAuthority(context, ['transaction']);
    const actor = authority.actor;
    const jobInput = closedJobInput(input,
      ['kind', 'handler', 'payload', 'scheduleAt', 'maxAttempts', 'idempotencyRoot', 'outcomeReference', 'recoveryPolicy'],
      ['kind', 'handler', 'payload', 'idempotencyRoot']);
    const handler = closedJobInput(jobInput.handler,
      ['name', 'contract', 'version'], ['name', 'contract', 'version']);
    const createdAt = now();
    const explicitSchedule = jobInput.scheduleAt !== undefined;
    const scheduleIntent = explicitSchedule ? 'scheduled' : 'immediate';
    const scheduleAt = canonicalInstant(jobInput.scheduleAt ?? createdAt, 'scheduleAt');
    const payload = canonicalJobPayload(jobInput.payload);
    const recoveryPolicy = jobInput.recoveryPolicy ?? 'terminal_unknown';
    if (!RECOVERY_POLICIES.has(recoveryPolicy)) {
      throw new ValidationError('Durable-job recovery policy is invalid');
    }
    const row = {
      id: boundedText(idSource(), 'generated job id'), contract_version: DURABLE_JOB_CONTRACT,
      tenant_id: tenantId, kind: boundedName(jobInput.kind, 'job kind'),
      handler_name: boundedName(handler.name, 'handler name'),
      handler_contract: handler.contract === 1 ? 1 : (() => { throw new ValidationError('handler contract must be 1'); })(),
      handler_version: positiveInteger(handler.version, 'handler version'),
      payload_json: payload.json, payload_fingerprint: payload.fingerprint,
      schedule_intent: scheduleIntent,
      recovery_policy: recoveryPolicy,
      schedule_at: scheduleAt, state: 'pending', attempt: 0,
      max_attempts: positiveInteger(jobInput.maxAttempts ?? 3, 'maxAttempts', MAX_ATTEMPTS),
      claim_worker_id: null, claim_id: null, claim_generation: 0, claim_expires_at: null,
      execution_started_at: null,
      idempotency_root: boundedText(jobInput.idempotencyRoot, 'idempotencyRoot'),
      outcome_reference: jobInput.outcomeReference == null ? null : boundedText(jobInput.outcomeReference, 'outcomeReference'),
      created_at: createdAt, updated_at: createdAt, last_error_code: null,
    };
    const persist = async (adapter, handle) => {
      if (await adapter.insert(row)) {
        await recordMutation(audit, handle, actor, 'enqueued', row.id, {
          state: 'pending', scheduleIntent, recoveryPolicy,
        });
        return decodeRow(row);
      }
      const existing = decodeRow(await adapter.getByRoot(tenantId, row.idempotency_root));
      if (existing && existing.kind === row.kind && existing.handler.name === row.handler_name
        && existing.handler.contract === row.handler_contract && existing.handler.version === row.handler_version
        && existing.payloadFingerprint === row.payload_fingerprint
        && existing.scheduleIntent === scheduleIntent
        && (scheduleIntent === 'immediate' || existing.scheduleAt === row.schedule_at)
        && existing.maxAttempts === row.max_attempts
        && existing.recoveryPolicy === row.recovery_policy
        && existing.outcomeReference === row.outcome_reference) return existing;
      throw new AppError('Durable-job idempotency root was already used for different work', {
        code: 'DURABLE_JOB_IDEMPOTENCY_MISMATCH', status: 409,
      });
    };
    return Object.hasOwn(authority.context, 'transaction')
      ? persist(adapterFor(authority.context.transaction, true), authority.context.transaction)
      : inTransaction(persist);
  }

  async function claimDue(workerId, leaseMs = 30_000, context = {}, id = null) {
    const actor = systemMutationActor(context, 'Durable-job claim context');
    const worker = boundedText(workerId, 'workerId');
    const jobId = id == null ? null : boundedText(id, 'job id');
    positiveInteger(leaseMs, 'leaseMs', MAX_LEASE_MS);
    const instant = now();
    const expiresAt = new Date(Date.parse(instant) + leaseMs).toISOString();
    const claimId = boundedText(claimIdSource(), 'generated claim id');
    return inTransaction(async (adapter, handle) => {
      const result = await adapter.claim({ tenantId, workerId: worker, claimId, now: instant, expiresAt, id: jobId });
      for (const expired of result.terminalized) {
        await recordMutation(audit, handle, actor, 'failed', String(expired.id), {
          state: 'failed_terminal', claimGeneration: safeInteger(expired.claim_generation, 'claimGeneration'),
          errorCode: String(expired.last_error_code),
        });
      }
      const job = decodeRow(result.row);
      if (job) {
        await recordMutation(audit, handle, actor, 'claimed', job.id, {
          state: 'claimed', claimGeneration: job.claimGeneration,
          ...(result.recovered ? { recoveredUnknownOutcome: true } : {}),
        });
      }
      return job;
    });
  }

  const claim = (workerId, leaseMs = 30_000, context = {}) => claimDue(workerId, leaseMs, context);
  const claimById = (id, workerId, leaseMs = 30_000, context = {}) => claimDue(workerId, leaseMs, context, id);

  function requireClaim(job, workerId) {
    if (!job || job.tenantId !== tenantId || job.state !== 'claimed' || !job.claim
      || job.claim.workerId !== workerId) throw claimFenced();
    return job.claim;
  }

  async function finish(job, workerId, transition, actor, complete = null) {
    const claim = requireClaim(job, workerId);
    const instant = now();
    return inTransaction(async (adapter, handle) => {
      const changed = await adapter.finish({
        tenantId, id: job.id, workerId, claimId: claim.claimId, generation: claim.generation,
        now: instant, state: transition.state,
        scheduleAt: transition.scheduleAt ?? job.scheduleAt,
        outcomeReference: transition.outcomeReference ?? job.outcomeReference,
        errorCode: transition.errorCode ?? null,
        executionRequired: transition.executionRequired,
      });
      if (changed !== 1) throw claimFenced();
      if (complete !== null) await complete(handle);
      await recordMutation(audit, handle, actor,
        transition.state === 'succeeded' ? 'succeeded' : 'failed', job.id, {
          state: transition.state, claimGeneration: claim.generation,
          ...(transition.errorCode ? { errorCode: transition.errorCode } : {}),
        });
      return decodeRow(await adapter.get(tenantId, job.id));
    });
  }

  return Object.freeze({
    contract: DURABLE_JOB_CONTRACT,
    tenantId,
    now,
    enqueue,
    get,
    claim,
    claimById,
    async beginExecution(job, workerId, context = {}) {
      const actor = systemMutationActor(context, 'Durable-job execution-start context');
      const owner = boundedText(workerId, 'workerId');
      const claim = requireClaim(job, owner);
      const instant = now();
      return inTransaction(async (adapter, handle) => {
        const changed = await adapter.beginExecution({
          tenantId, id: job.id, workerId: owner, claimId: claim.claimId,
          generation: claim.generation, now: instant,
        });
        if (changed !== 1) throw claimFenced();
        await recordMutation(audit, handle, actor, 'execution_started', job.id, {
          state: 'claimed', claimGeneration: claim.generation,
        });
        return decodeRow(await adapter.get(tenantId, job.id));
      });
    },
    async succeed(job, workerId, outcomeReference = null, context = {}, complete = null) {
      const actor = systemMutationActor(context, 'Durable-job success context');
      if (complete !== null && typeof complete !== 'function') {
        throw new ValidationError('Durable-job success completion must be a function');
      }
      return finish(job, boundedText(workerId, 'workerId'), {
        state: 'succeeded',
        outcomeReference: outcomeReference == null ? null : boundedText(outcomeReference, 'outcomeReference'),
        executionRequired: true,
      }, actor, complete);
    },
    async fail(job, workerId, input, context = {}) {
      const actor = systemMutationActor(context, 'Durable-job failure context');
      const failure = closedJobInput(input, ['errorCode', 'retryAt'], ['errorCode']);
      const errorCode = boundedCode(failure.errorCode, 'errorCode');
      if (!CLOSED_FAILURE_CODES.has(errorCode)) {
        throw new ValidationError('errorCode is not a ratified durable-job failure code');
      }
      const retryable = RETRYABLE.has(errorCode) && job.attempt < job.maxAttempts;
      const retryAt = retryable ? canonicalInstant(failure.retryAt, 'retryAt') : job.scheduleAt;
      return finish(job, boundedText(workerId, 'workerId'), {
        state: retryable ? 'failed_retryable' : 'failed_terminal',
        scheduleAt: retryAt, errorCode,
        executionRequired: !PRE_EXECUTION_FAILURES.has(errorCode),
      }, actor);
    },
    async release(job, workerId, context = {}) {
      const actor = systemMutationActor(context, 'Durable-job release context');
      const owner = boundedText(workerId, 'workerId');
      const claim = requireClaim(job, owner);
      const instant = now();
      return inTransaction(async (adapter, handle) => {
        const changed = await adapter.release({
          tenantId, id: job.id, workerId: owner, claimId: claim.claimId,
          generation: claim.generation, now: instant,
        });
        if (changed !== 1) throw claimFenced();
        await recordMutation(audit, handle, actor, 'released', job.id, {
          state: 'failed_retryable', claimGeneration: claim.generation,
          errorCode: 'JOB_CLAIM_RELEASED',
        });
        return decodeRow(await adapter.get(tenantId, job.id));
      });
    },
    async cancel(id, context = {}) {
      const actor = mutationActor(context, []);
      const jobId = boundedText(id, 'job id');
      return inTransaction(async (adapter, handle) => {
        const changed = await adapter.cancel({ tenantId, id: jobId, now: now() });
        if (changed !== 1) throw new AppError('Only pending durable jobs can be cancelled', { code: 'DURABLE_JOB_NOT_PENDING', status: 409 });
        await recordMutation(audit, handle, actor, 'cancelled', jobId, { state: 'cancelled' });
        return decodeRow(await adapter.get(tenantId, jobId));
      });
    },
    async reschedule(id, scheduleAt, context = {}) {
      const actor = mutationActor(context, []);
      const jobId = boundedText(id, 'job id');
      const next = canonicalInstant(scheduleAt, 'scheduleAt');
      return inTransaction(async (adapter, handle) => {
        const changed = await adapter.reschedule({ tenantId, id: jobId, scheduleAt: next, now: now() });
        if (changed !== 1) throw new AppError('Only pending durable jobs can be rescheduled', { code: 'DURABLE_JOB_NOT_PENDING', status: 409 });
        await recordMutation(audit, handle, actor, 'rescheduled', jobId, {
          state: 'pending', scheduleIntent: 'scheduled',
        });
        return decodeRow(await adapter.get(tenantId, jobId));
      });
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
      closedObject(definition, ['name', 'version', 'kind', 'execute', 'complete', 'sideEffect'], ['name', 'version', 'kind', 'execute'], 'Durable-job handler');
      const name = boundedName(definition.name, 'handler name');
      const kind = boundedName(definition.kind, 'handler kind');
      const version = positiveInteger(definition.version, 'handler version');
      if (typeof definition.execute !== 'function') throw new ValidationError('Durable-job handler execute must be a function');
      if (definition.complete !== undefined && typeof definition.complete !== 'function') {
        throw new ValidationError('Durable-job handler complete must be a function');
      }
      const sideEffect = definition.sideEffect ?? 'none';
      if (sideEffect !== 'none' && sideEffect !== 'external-operation-v2') {
        throw new ValidationError('Durable-job handler sideEffect must be none or external-operation-v2');
      }
      const key = `${kind}\u0000${name}\u0000${version}`;
      if (handlers.has(key)) throw new AppError('Durable-job handler identity is already registered', { code: 'DURABLE_JOB_HANDLER_DUPLICATE', status: 409 });
      handlers.set(key, Object.freeze({
        name, kind, version, sideEffect, execute: definition.execute,
        ...(definition.complete ? { complete: definition.complete } : {}),
      }));
    },
    resolve(job) {
      return handlers.get(`${job.kind}\u0000${job.handler.name}\u0000${job.handler.version}`) ?? null;
    },
    list() {
      return [...handlers.values()].map(({ execute: _execute, complete: _complete, ...handler }) => Object.freeze({ ...handler }))
        .sort((a, b) => `${a.kind}:${a.name}:${a.version}`.localeCompare(`${b.kind}:${b.name}:${b.version}`));
    },
  });
}

function boundedOwnErrorCode(error, fallback) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return fallback;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  } catch {
    return fallback;
  }
  const code = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : null;
  return typeof code === 'string' && ERROR_CODE.test(code) && code.length <= 128
    ? code
    : fallback;
}

function boundedErrorCode(error) {
  const code = boundedOwnErrorCode(error, 'JOB_HANDLER_FAILED');
  return HANDLER_RETRYABLE.has(code) || HANDLER_TERMINAL.has(code) ? code : 'JOB_HANDLER_FAILED';
}

function defaultBackoff(attempt) {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

/** Explicit worker. Constructing it starts no timers and claims no work. */
export function createDurableJobWorker(options) {
  closedObject(options,
    ['store', 'registry', 'workerId', 'actor', 'clock', 'pollIntervalMs', 'leaseMs', 'backoff', 'telemetry'],
    ['store', 'registry', 'workerId', 'actor'], 'Durable-job worker options');
  // Spine v4C. Optional and best effort: nothing here is awaited by the job
  // path, no signal is emitted inside a store transaction or beside an audit
  // write, and the security audit remains the only authority on what happened.
  const telemetry = requireTelemetrySink(options.telemetry, (message) => {
    throw new ValidationError(`Durable-job worker ${message}`, { field: 'telemetry' });
  });
  const workerId = boundedText(options.workerId, 'workerId');
  const actor = mutationActor({ actor: options.actor }, []);
  if (actor.type !== 'system') {
    throw new ValidationError('Durable-job worker operation actor must have system authority', { field: 'actor.type' });
  }
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
  let lastWorkerErrorCode = null;

  const recordPollFailure = (error) => {
    const code = boundedOwnErrorCode(error, 'DURABLE_JOB_POLL_FAILED');
    lastWorkerErrorCode = WORKER_STATUS_ERRORS.has(code) ? code : 'DURABLE_JOB_POLL_FAILED';
    reportDurableJobWorkerError(telemetry, { errorCode: lastWorkerErrorCode });
  };

  /** Reported from a settled store row, so classification never outruns truth. */
  const reportExecution = (settled, startedAt) => {
    if (!settled || typeof settled !== 'object') return;
    reportDurableJobExecution(telemetry, {
      kind: settled.kind,
      handler: settled.handler?.name,
      state: settled.state,
      attempt: settled.attempt,
      durationMs: telemetryDurationMs(startedAt, clock()),
      errorCode: settled.lastErrorCode,
    });
  };

  const clearWake = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const scheduleWake = (delay = pollIntervalMs) => {
    clearWake();
    if (!accepting || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void poll().catch(recordPollFailure).finally(() => scheduleWake());
    }, delay);
  };

  async function execute(job) {
    const handler = options.registry.resolve(job);
    if (!handler) {
      return options.store.fail(job, workerId, { errorCode: 'JOB_HANDLER_NOT_REGISTERED' }, { actor });
    }
    // A recovered external effect is an unknown outcome, not permission to
    // call the provider again. externalOperationId is stable across attempts;
    // reconciliation owns the next step under external-operation v2.
    if (handler.sideEffect === 'external-operation-v2' && job.attempt > 1) {
      return options.store.fail(job, workerId, { errorCode: 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED' }, { actor });
    }
    const executingJob = await options.store.beginExecution(job, workerId, { actor });
    const recordHandlerFailure = (error) => {
      let errorCode = boundedErrorCode(error);
      if (handler.sideEffect === 'external-operation-v2') {
        errorCode = 'JOB_EXTERNAL_EXECUTION_RECONCILIATION_REQUIRED';
      }
      const retryable = RETRYABLE.has(errorCode) && handler.sideEffect === 'none' && executingJob.attempt < executingJob.maxAttempts;
      let retryAt;
      if (retryable) {
        try {
          const delay = backoff(executingJob.attempt, errorCode);
          if (!Number.isSafeInteger(delay) || delay < 0 || delay > MAX_LEASE_MS) throw new Error('invalid backoff');
          retryAt = new Date(Date.parse(clock()) + delay).toISOString();
        } catch {
          errorCode = 'JOB_BACKOFF_INVALID';
        }
      }
      return options.store.fail(executingJob, workerId, { errorCode, ...(retryAt ? { retryAt } : {}) }, { actor });
    };
    let result;
    try {
      result = await handler.execute(Object.freeze({
        job: executingJob, payload: executingJob.payload, tenantId: executingJob.tenantId, workerId, now: clock,
        externalOperationId: executingJob.idempotencyRoot,
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
    const complete = typeof handler.complete === 'function'
      ? (transaction) => handler.complete(Object.freeze({
        job: executingJob, outcomeReference, transaction,
      }))
      : null;
    return options.store.succeed(executingJob, workerId, outcomeReference, { actor }, complete);
  }

  async function claimAndExecute(jobId = null) {
    if (!accepting || closed) return null;
    if (pollPromise) return pollPromise;
    pollPromise = (async () => {
      const job = jobId == null
        ? await options.store.claim(workerId, leaseMs, { actor })
        : await options.store.claimById(jobId, workerId, leaseMs, { actor });
      if (!job) return null;
      reportDurableJobClaimed(telemetry, {
        kind: job.kind, handler: job.handler?.name, attempt: job.attempt,
      });
      const startedAt = clock();
      if (!accepting || closed) {
        // A job released at shutdown ran no handler, so no execution is
        // reported for it: emitting one would publish a real elapsed duration
        // and a `failed_retryable` state for work that never started. The
        // claim signal already records that this worker held it.
        return options.store.release(job, workerId, { actor });
      }
      inFlight = execute(job);
      try {
        const settled = await inFlight;
        reportExecution(settled, startedAt);
        return settled;
      } finally { inFlight = null; }
    })();
    try {
      const result = await pollPromise;
      lastWorkerErrorCode = null;
      return result;
    } catch (error) {
      recordPollFailure(error);
      throw error;
    } finally {
      pollPromise = null;
    }
  }

  const poll = () => claimAndExecute();

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
    run: (jobId) => claimAndExecute(boundedText(jobId, 'job id')),
    drain,
    stop: drain,
    async close(input = {}) {
      try {
        return await drain(input);
      } finally {
        accepting = false;
        closed = true;
        clearWake();
      }
    },
    status() {
      return Object.freeze({
        accepting, closed, polling: pollPromise !== null, inFlight: inFlight !== null,
        wakeScheduled: timer !== null, lastWorkerErrorCode,
      });
    },
  });
}
