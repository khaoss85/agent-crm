// @ts-check

import { createHash } from 'node:crypto';
import { trustedSystemActor } from './actor.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from './durable-jobs.js';
import { AppError, ValidationError } from './errors.js';
import { tenantNamespace } from './idempotency.js';
import { deterministicUuid } from './write-ids.js';
import { createWriteOutcomeStore } from './write-outcome-store.js';

export const TRANSACTIONAL_OUTBOX_CONTRACT = 1;
export const TRANSACTIONAL_OUTBOX_EFFECTS = Object.freeze([
  'internal-event-promotion',
  'external-finalize-continuation',
]);

const OUTBOX_ACTOR = trustedSystemActor('dispatching committed transactional outbox effects');
const OUTBOX_KIND = 'write-outcome-effect';
const EVENT_HANDLER = 'promote-write-outcome-events';
const EXTERNAL_HANDLER = 'continue-external-finalize';
const EVENT_NAME = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function effectFingerprint(tenantNs, outcome, effect) {
  return digest(JSON.stringify([
    TRANSACTIONAL_OUTBOX_CONTRACT,
    effect,
    tenantNs,
    outcome.runId,
    outcome.phase,
    outcome.requestFingerprint,
  ]));
}

function effectHandler(effect) {
  if (effect === 'internal-event-promotion') return EVENT_HANDLER;
  if (effect === 'external-finalize-continuation') return EXTERNAL_HANDLER;
  throw new ValidationError('Unsupported transactional-outbox effect');
}

export function transactionalOutboxJobId(effect, sourceFingerprint) {
  if (!TRANSACTIONAL_OUTBOX_EFFECTS.includes(effect)
    || typeof sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(sourceFingerprint)) {
    throw new ValidationError('Transactional-outbox job identity is invalid');
  }
  return deterministicUuid(`transactional-outbox.v1\0${effect}\0${sourceFingerprint}`);
}

export function transactionalOutboxEffectIdentity(tenantId, outcome, effect) {
  const sourceFingerprint = effectFingerprint(tenantNamespace(tenantId), outcome, effect);
  return Object.freeze({
    effect,
    sourceFingerprint,
    jobId: transactionalOutboxJobId(effect, sourceFingerprint),
  });
}

function createStore(database, tenantId, clock, idSource) {
  return createDurableJobStore({
    storage: database.storage,
    tenantId: String(tenantId),
    ...(clock ? { clock } : {}),
    ...(idSource ? { idSource } : {}),
  });
}

/**
 * Enqueue applicable effect identities on the caller's live transaction.
 * Event/provider/domain content remains solely in write_outcomes.
 */
export async function enqueueWriteOutcomeEffects({
  database, tenantId, outcome, transaction, clock,
}) {
  const tenantNs = tenantNamespace(tenantId);
  const effects = [];
  if (Array.isArray(outcome.eventIntents) && outcome.eventIntents.length > 0) {
    effects.push('internal-event-promotion');
  }
  if (outcome.phase === 'receipt' && outcome.externalFinalizeDeclared === true) {
    effects.push('external-finalize-continuation');
  }
  const jobs = [];
  for (const effect of effects) {
    const { sourceFingerprint, jobId } = transactionalOutboxEffectIdentity(tenantId, outcome, effect);
    const store = createStore(database, tenantId, clock, () => jobId);
    const context = transaction === undefined
      ? { actor: OUTBOX_ACTOR }
      : { transaction, actor: OUTBOX_ACTOR };
    jobs.push(await store.enqueue({
      kind: OUTBOX_KIND,
      handler: { name: effectHandler(effect), contract: 1, version: 1 },
      payload: {
        contractVersion: TRANSACTIONAL_OUTBOX_CONTRACT,
        runId: outcome.runId,
        phase: outcome.phase,
        sourceFingerprint,
      },
      idempotencyRoot: `outbox:${effect}:${sourceFingerprint}`,
      maxAttempts: 5,
    }, context));
  }
  return Object.freeze(jobs);
}

/**
 * Deterministically backfill effect ownership for a source that was committed
 * before V3B existed. The source is already authoritative; each insert owns its
 * own transaction and the stable idempotency root makes an interrupted backfill
 * safe to repeat.
 */
export function ensureCommittedWriteOutcomeEffects({
  database, tenantId, outcome, clock,
}) {
  return enqueueWriteOutcomeEffects({ database, tenantId, outcome, clock });
}

function boundedSource(job, effect) {
  const source = job?.payload;
  if (!source || source.contractVersion !== TRANSACTIONAL_OUTBOX_CONTRACT
    || typeof source.runId !== 'string' || source.runId.length < 1 || source.runId.length > 128
    || !['root', 'intent', 'call', 'receipt', 'finalize'].includes(source.phase)
    || typeof source.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(source.sourceFingerprint)) {
    throw new AppError('Transactional-outbox source identity is invalid', {
      code: 'TRANSACTIONAL_OUTBOX_SOURCE_INVALID', status: 500,
    });
  }
  return Object.freeze({ ...source, effect });
}

async function loadSource(store, tenantNs, source) {
  const outcome = await store.lookupByRun(tenantNs, source.runId, source.phase);
  if (!outcome || effectFingerprint(tenantNs, outcome, source.effect) !== source.sourceFingerprint) {
    throw new AppError('Transactional-outbox source outcome is unavailable', {
      code: 'TRANSACTIONAL_OUTBOX_SOURCE_INVALID', status: 500,
    });
  }
  return outcome;
}

function temporaryDispatchFailure() {
  return new AppError('Committed event intent dispatch is temporarily unavailable', {
    code: 'JOB_HANDLER_TEMPORARY_UNAVAILABLE', status: 503,
  });
}

/** Register the two closed effect consumers on a V3A named-handler registry. */
export function registerTransactionalOutboxHandlers(registry, {
  database, events, tenantId, resolveExternalFinalize,
}) {
  const tenantNs = tenantNamespace(tenantId);
  const outcomes = createWriteOutcomeStore(database);
  registry.register({
    kind: OUTBOX_KIND,
    name: EVENT_HANDLER,
    version: 1,
    async execute({ job }) {
      const source = boundedSource(job, 'internal-event-promotion');
      const outcome = await loadSource(outcomes, tenantNs, source);
      if (outcome.eventsPromoted) return { outcomeReference: `outbox:${source.sourceFingerprint}` };
      let invalidIntent = false;
      let dispatchFailed = false;
      for (const entry of outcome.eventIntents ?? []) {
        if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string'
          || entry.event.length > 128 || !EVENT_NAME.test(entry.event)
          || !Object.hasOwn(entry, 'payload')) {
          invalidIntent = true;
          continue;
        }
        try {
          await events.emit(entry.event, entry.payload);
        } catch {
          dispatchFailed = true;
        }
      }
      if (invalidIntent) {
        throw new AppError('Committed event intent is invalid', {
          code: 'TRANSACTIONAL_OUTBOX_INTENT_INVALID', status: 500,
        });
      }
      if (dispatchFailed) throw temporaryDispatchFailure();
      return { outcomeReference: `outbox:${source.sourceFingerprint}` };
    },
    async complete({ job, transaction }) {
      const source = boundedSource(job, 'internal-event-promotion');
      const transactionalOutcomes = createWriteOutcomeStore({ storage: transaction });
      const outcome = await loadSource(transactionalOutcomes, tenantNs, source);
      if (outcome.eventsPromoted) return;
      if (!await transactionalOutcomes.tryPromoteEvents(outcome)) {
        throw new AppError('Committed event promotion evidence could not be fenced', {
          code: 'TRANSACTIONAL_OUTBOX_PROMOTION_FENCED', status: 409,
        });
      }
    },
  });
  registry.register({
    kind: OUTBOX_KIND,
    name: EXTERNAL_HANDLER,
    version: 1,
    async execute({ job }) {
      const source = boundedSource(job, 'external-finalize-continuation');
      if (source.phase !== 'receipt') {
        throw new AppError('External continuation requires a receipt source', {
          code: 'TRANSACTIONAL_OUTBOX_SOURCE_INVALID', status: 500,
        });
      }
      const receipt = await loadSource(outcomes, tenantNs, source);
      const finalized = await outcomes.lookupByRun(tenantNs, source.runId, 'finalize');
      if (finalized) return { outcomeReference: `outbox:${source.sourceFingerprint}` };
      const intent = await outcomes.lookupByRun(tenantNs, source.runId, 'intent');
      const operation = receipt.operation.endsWith('.receipt')
        ? receipt.operation.slice(0, -'.receipt'.length)
        : '';
      const continuation = typeof resolveExternalFinalize === 'function'
        ? await resolveExternalFinalize(operation)
        : null;
      if (typeof continuation !== 'function' || !intent) {
        throw new AppError('External finalize continuation is not registered', {
          code: 'TRANSACTIONAL_OUTBOX_CONTINUATION_UNAVAILABLE', status: 500,
        });
      }
      await continuation(Object.freeze({
        operation,
        runId: source.runId,
        intent: intent.response,
        receipt: receipt.response,
      }));
      const committed = await outcomes.lookupByRun(tenantNs, source.runId, 'finalize');
      if (!committed) {
        throw new AppError('External finalize continuation did not commit its outcome', {
          code: 'TRANSACTIONAL_OUTBOX_FINALIZE_UNPROVEN', status: 500,
        });
      }
      return { outcomeReference: `outbox:${source.sourceFingerprint}` };
    },
  });
  return registry;
}

export function createTransactionalOutboxWorker({
  database, events, tenantId, resolveExternalFinalize, workerId = 'transactional-outbox', clock,
  pollIntervalMs = 1_000, leaseMs = 30_000, backoff,
}) {
  const registry = createDurableJobHandlerRegistry();
  registerTransactionalOutboxHandlers(registry, {
    database, events, tenantId, resolveExternalFinalize,
  });
  return createDurableJobWorker({
    store: createStore(database, tenantId, clock),
    registry,
    workerId,
    actor: OUTBOX_ACTOR,
    ...(clock ? { clock } : {}),
    pollIntervalMs,
    leaseMs,
    ...(backoff ? { backoff } : {}),
  });
}

/** Explicit one-shot exact-job dispatch; creates no persistent background worker. */
export async function dispatchTransactionalOutboxJob(options, jobId) {
  const worker = createTransactionalOutboxWorker({
    ...options,
    pollIntervalMs: options.pollIntervalMs ?? 60_000,
  });
  worker.start();
  try {
    return await worker.run(jobId);
  } finally {
    await worker.close();
  }
}
