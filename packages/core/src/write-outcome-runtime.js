// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { createExecutionRunStore } from './execution-run-store.js';
import { AppError, NotFoundError } from './errors.js';
import {
  assertOutcomeScope,
  deriveChildKey,
  encodeJsonSafe,
  providerIdempotencyKey,
  requestFingerprint,
  requireIdempotencyKey,
  resolveIdempotencyKey,
  subjectFingerprint,
  tenantNamespace,
} from './idempotency.js';
import { isSyncStorage, storageApi } from './storage-runtime.js';
import { nowIso } from './time.js';
import { deterministicUuid, snapshotWriteIds, withWriteIds } from './write-ids.js';
import {
  dispatchTransactionalOutboxJob,
  enqueueWriteOutcomeEffects,
  ensureCommittedWriteOutcomeEffects,
  transactionalOutboxEffectIdentity,
} from './transactional-outbox.js';
import {
  createWriteOutcomeStore,
  isUnknownCommit,
  unknownCommitError,
  unknownCommitUnprovable,
} from './write-outcome-store.js';

/**
 * PostgreSQL idempotent write envelope (Spine v2 M4A).
 *
 * SQLite callers fall through to `execute` unchanged. PostgreSQL writes look up
 * tenant+raw key first, compare stored scope, and either return the committed
 * outcome or run the work once inside a SERIALIZABLE transaction that also
 * stores the outcome, event intents and a pending run identity.
 */

/**
 * @param {any} database
 */
export function usesWriteOutcomes(database) {
  return Boolean(database) && !isSyncStorage(database);
}

const ENVELOPE = new AsyncLocalStorage();

/**
 * @param {any} database
 * @param {any} events
 * @param {{
 *   tenantId: unknown,
 *   idempotencyKey?: unknown,
 *   identity?: any,
 *   actor?: unknown,
 *   operation: string,
 *   target?: string,
 *   contractVersion?: string,
 *   input?: unknown,
 *   phase?: string,
 *   now?: () => string,
 *   clock?: () => string,
 * }} spec
 * @param {(ctx: {
 *   emit: (event: string, payload: unknown) => any,
 *   step: (name: string, output?: unknown) => void,
 *   runId: string,
 *   idempotencyKey: string,
 *   providerIdempotencyKey: string,
 * }) => any} execute
 */
export async function runIdempotentWrite(database, events, spec, execute) {
  if (!usesWriteOutcomes(database)) {
    const steps = /** @type {Array<{name: string, status: string, output?: unknown}>} */ ([]);
    return {
      replayed: false,
      idempotencyKey: null,
      runId: null,
      result: await execute({
        emit: (event, payload) => events.emit(event, payload),
        step: (name, output) => steps.push({ name, status: 'completed', output }),
        runId: '',
        idempotencyKey: '',
        providerIdempotencyKey: '',
      }),
      steps,
    };
  }

  const parent = ENVELOPE.getStore();
  if (parent) {
    const steps = /** @type {Array<{name: string, status: string, output?: unknown}>} */ ([]);
    return {
      replayed: false,
      idempotencyKey: parent.idempotencyKey,
      runId: parent.runId,
      result: await execute({
        emit: (event, payload) => events.emit(event, payload),
        step: (name, output) => steps.push({ name, status: 'completed', output }),
        runId: parent.runId,
        idempotencyKey: parent.idempotencyKey,
        providerIdempotencyKey: parent.providerIdempotencyKey,
      }),
      steps,
    };
  }

  const now = spec.now ?? spec.clock ?? nowIso;
  const rawKey = resolveIdempotencyKey(spec.idempotencyKey, now);
  const tenantNs = tenantNamespace(spec.tenantId);
  const phase = spec.phase ?? 'root';
  const operation = spec.operation;
  const target = spec.target ?? '';
  const contractVersion = spec.contractVersion ?? 'write.v1';
  const scope = {
    subjectFingerprint: subjectFingerprint(spec.identity, spec.actor),
    operation,
    target,
    contractVersion,
    requestFingerprint: requestFingerprint({
      operation, target, contractVersion, input: spec.input ?? null,
    }),
  };
  const runId = typeof spec.runId === 'string' && spec.runId
    ? spec.runId
    : deterministicUuid(`${tenantNs}\0${rawKey}\0${phase}\0run`);
  const settleTrace = spec.settleTrace !== false;
  const providerKey = providerIdempotencyKey(tenantNs, rawKey);
  const store = createWriteOutcomeStore(database);
  const seed = `${tenantNs}\0${rawKey}\0${phase}`;

  try {
    const existing = await store.lookup(tenantNs, rawKey, phase);
    if (existing) {
      assertOutcomeScope(existing, scope);
      await promoteAndFinalize(database, events, store, existing, { settleTrace, tenantId: spec.tenantId });
      return {
        replayed: true,
        idempotencyKey: rawKey,
        runId: existing.runId,
        result: existing.response,
        steps: existing.traceIntent?.steps ?? [],
      };
    }
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'DIVERGENT_REPLAY') throw error;
    if (unknownCommitUnprovable(error)) throw unknownCommitError(rawKey, runId);
    throw error;
  }

  const startedAt = now();
  const maxAttempts = 4;
  /** @type {any} */
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
    const steps = [];
    /** @type {any[]} */
    let effectJobs = [];
    try {
      const result = await ENVELOPE.run({
        idempotencyKey: rawKey,
        runId,
        providerIdempotencyKey: providerKey,
      }, async () => events.buffered(async (outbox) => {
        const value = await withWriteIds(seed, async () => {
          const inner = await database.transactionAsync(async () => {
            const traceInput = encodeJsonSafe({
              target,
              input: spec.input ?? null,
              actor: spec.actor && typeof spec.actor === 'object'
                ? { type: /** @type {any} */ (spec.actor).type ?? null, id: /** @type {any} */ (spec.actor).id ?? null }
                : null,
            });
            await openPendingRun(database, {
              runId,
              workflowName: operation,
              input: traceInput,
              startedAt,
            });
            const produced = await execute({
              emit: (event, payload) => events.emit(event, payload),
              step: (name, output) => steps.push({ name, status: 'completed', output }),
              runId,
              idempotencyKey: rawKey,
              providerIdempotencyKey: providerKey,
            });
            const encoded = encodeJsonSafe(produced);
            const traceIntent = {
              runId,
              workflowName: operation,
              status: settleTrace ? 'completed' : 'running',
              input: traceInput,
              output: encoded,
              error: null,
              startedAt,
              steps: steps.slice(),
            };
            const persistedOutcome = {
              tenantNamespace: tenantNs,
              rawKey,
              phase,
              ...scope,
              recordIds: snapshotWriteIds(),
              response: encoded,
              eventIntents: outbox.peek(),
              traceIntent,
              runId,
              createdAt: now(),
            };
            await store.insert(persistedOutcome);
            effectJobs = await enqueueWriteOutcomeEffects({
              database,
              tenantId: spec.tenantId,
              outcome: persistedOutcome,
              transaction: storageApi(database),
              clock: now,
            });
            return encoded;
          });
          return inner;
        });
        outbox.discard();
        return value;
      }));
      const committed = await store.lookup(tenantNs, rawKey, phase);
      if (committed) {
        for (const job of effectJobs.filter((entry) => entry.handler.name === 'promote-write-outcome-events')) {
          try {
            const dispatched = await dispatchTransactionalOutboxJob({
              database, events, tenantId: spec.tenantId, clock: now,
              workerId: `write-outcome-${runId}`,
            }, job.id);
            if (dispatched && dispatched.state !== 'succeeded') {
              console.error(`[accordo] ${operation} run ${runId}: committed outbox dispatch is pending recovery: ${dispatched.lastErrorCode ?? 'TRANSACTIONAL_OUTBOX_DISPATCH_PENDING'}`);
            }
          } catch (dispatchError) {
            console.error(
              `[accordo] ${operation} run ${runId}: committed outbox dispatch is pending recovery: `
              + 'TRANSACTIONAL_OUTBOX_DISPATCH_FAILED',
            );
          }
        }
        if (settleTrace) await finalizePendingTrace(database, committed.traceIntent);
      }
      return {
        replayed: false,
        idempotencyKey: rawKey,
        runId,
        result,
        steps,
      };
    } catch (error) {
      lastError = error;
      if (isUnknownCommit(error)) {
        throw unknownCommitError(rawKey, runId);
      }
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'CONFLICT') {
        try {
          const winner = await store.lookup(tenantNs, rawKey, phase);
          if (winner) {
            assertOutcomeScope(winner, scope);
            await promoteAndFinalize(database, events, store, winner, { settleTrace, tenantId: spec.tenantId });
            return {
              replayed: true,
              idempotencyKey: rawKey,
              runId: winner.runId,
              result: winner.response,
              steps: winner.traceIntent?.steps ?? [],
            };
          }
        } catch (lookupError) {
          if (lookupError && typeof lookupError === 'object' && /** @type {any} */ (lookupError).code === 'DIVERGENT_REPLAY') {
            throw lookupError;
          }
          if (unknownCommitUnprovable(lookupError)) throw unknownCommitError(rawKey, runId);
        }
        const transient = Boolean(/** @type {any} */ (error).details?.transient);
        if (transient && attempt < maxAttempts) continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Reconcile a write whose COMMIT acknowledgement was lost. Never retries
 * automatically. A committed outcome returns the canonical response and
 * promotes events once. Absence authorizes one retry with the same ids/key.
 * Inability to prove either remains unknown and refuses further mutation.
 *
 * @param {any} database
 * @param {any} events
 * @param {{
 *   tenantId: unknown,
 *   idempotencyKey: unknown,
 *   identity?: any,
 *   actor?: unknown,
 *   operation: string,
 *   target?: string,
 *   contractVersion?: string,
 *   input?: unknown,
 *   phase?: string,
 * }} spec
 */
export async function reconcileWriteOutcome(database, events, spec) {
  const rawKey = resolveIdempotencyKey(spec.idempotencyKey);
  const tenantNs = tenantNamespace(spec.tenantId);
  const phase = spec.phase ?? 'root';
  const operation = spec.operation;
  const target = spec.target ?? '';
  const contractVersion = spec.contractVersion ?? 'write.v1';
  const scope = {
    subjectFingerprint: subjectFingerprint(spec.identity, spec.actor),
    operation,
    target,
    contractVersion,
    requestFingerprint: requestFingerprint({
      operation, target, contractVersion, input: spec.input ?? null,
    }),
  };
  const runId = deterministicUuid(`${tenantNs}\0${rawKey}\0${phase}\0run`);
  const store = createWriteOutcomeStore(database);
  try {
    const existing = await store.lookup(tenantNs, rawKey, phase);
    if (existing) {
      assertOutcomeScope(existing, scope);
      await promoteAndFinalize(database, events, store, existing, { tenantId: spec.tenantId });
      return Object.freeze({
        status: 'committed',
        retryAuthorized: false,
        idempotencyKey: rawKey,
        runId: existing.runId,
        result: existing.response,
      });
    }
    return Object.freeze({
      status: 'absent',
      retryAuthorized: true,
      idempotencyKey: rawKey,
      runId,
      result: null,
    });
  } catch (error) {
    if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'DIVERGENT_REPLAY') throw error;
    if (unknownCommitUnprovable(error)) {
      throw unknownCommitError(rawKey, runId);
    }
    throw error;
  }
}

/**
 * @param {any} database
 * @param {any} events
 * @param {ReturnType<typeof createWriteOutcomeStore>} store
 * @param {any} outcome
 */
async function promoteAndFinalize(database, events, store, outcome, options = {}) {
  if (Array.isArray(outcome.eventIntents) && outcome.eventIntents.length > 0) {
    await ensureCommittedWriteOutcomeEffects({
      database,
      tenantId: options.tenantId,
      outcome,
    });
    const effect = transactionalOutboxEffectIdentity(
      options.tenantId,
      outcome,
      'internal-event-promotion',
    );
    try {
      await dispatchTransactionalOutboxJob({
        database, events, tenantId: options.tenantId,
        workerId: `write-outcome-${outcome.runId}`,
      }, effect.jobId);
    } catch (error) {
      console.error(
        `[accordo] ${outcome.operation} run ${outcome.runId}: committed outbox recovery remains pending: `
        + 'TRANSACTIONAL_OUTBOX_DISPATCH_FAILED',
      );
    }
  }
  if (options.settleTrace !== false) await finalizePendingTrace(database, outcome.traceIntent);
}

/**
 * @param {any} database
 * @param {{ runId: string, workflowName: string, input: unknown, startedAt: string }} run
 */
export async function openPendingRun(database, run) {
  const handle = storageApi(database);
  const existing = await handle.maybeOne({
    kind: 'select',
    table: 'workflow_runs',
    columns: '*',
    where: [{ column: 'id', op: 'eq', value: run.runId }],
  });
  if (existing) return run.runId;
  await handle.execute({
    kind: 'insert',
    table: 'workflow_runs',
    values: [
      { column: 'id', value: run.runId },
      { column: 'workflow_name', value: run.workflowName },
      { column: 'status', value: 'running' },
      { column: 'input_json', value: JSON.stringify(run.input ?? null) },
      { column: 'output_json', value: null },
      { column: 'error', value: null },
      { column: 'started_at', value: run.startedAt },
      { column: 'finished_at', value: null },
    ],
  });
  return run.runId;
}

/**
 * @param {any} database
 * @param {any} traceIntent
 */
export async function finalizePendingTrace(database, traceIntent) {
  if (!traceIntent || typeof traceIntent !== 'object' || typeof traceIntent.runId !== 'string') return;
  const store = createExecutionRunStore(database);
  await store.finalizePendingRun({
    runId: traceIntent.runId,
    workflowName: traceIntent.workflowName,
    status: traceIntent.status ?? 'completed',
    input: traceIntent.input,
    output: traceIntent.output ?? null,
    error: traceIntent.error ?? null,
    startedAt: traceIntent.startedAt,
    steps: traceIntent.steps ?? [],
  });
}

/**
 * @param {unknown} error
 * @param {string} idempotencyKey
 */
export function attachIdempotency(error, idempotencyKey) {
  if (!error || typeof error !== 'object') return error;
  const current = /** @type {any} */ (error);
  current.details = {
    ...(current.details && typeof current.details === 'object' ? current.details : {}),
    idempotencyKey,
  };
  return error;
}

export function refuseUnprovableMutation(idempotencyKey, runId) {
  throw unknownCommitError(idempotencyKey, runId);
}

/**
 * Bounded public projection of a write outcome. Never includes domain payload,
 * credentials or locators.
 *
 * @param {any} outcome
 */
export function projectWriteOutcome(outcome) {
  if (!outcome) return null;
  return Object.freeze({
    idempotencyKey: outcome.rawKey,
    operation: outcome.operation,
    target: outcome.target,
    requestFingerprint: outcome.requestFingerprint,
    runId: outcome.runId,
    createdAt: outcome.createdAt,
    acknowledged: outcome.acknowledgedAt != null,
    status: outcome.response == null ? 'pending' : 'committed',
  });
}

/**
 * Tenant-and-subject bound lookup. Another subject's key is indistinguishable
 * from absence.
 *
 * @param {any} database
 * @param {{
 *   tenantId: unknown,
 *   idempotencyKey: unknown,
 *   identity?: any,
 *   actor?: unknown,
 *   phase?: string,
 * }} spec
 */
export async function lookupWriteOutcome(database, spec) {
  if (!usesWriteOutcomes(database)) {
    throw new AppError('Write-outcome lookup requires PostgreSQL', {
      code: 'WRITE_OUTCOME_POSTGRESQL_REQUIRED',
      status: 400,
    });
  }
  const rawKey = requireIdempotencyKey(spec.idempotencyKey);
  const tenantNs = tenantNamespace(spec.tenantId);
  const subject = subjectFingerprint(spec.identity, spec.actor);
  const store = createWriteOutcomeStore(database);
  const existing = await store.lookup(tenantNs, rawKey, spec.phase ?? 'root');
  if (!existing || existing.subjectFingerprint !== subject) {
    throw new NotFoundError('WriteOutcome', rawKey);
  }
  return projectWriteOutcome(existing);
}

/**
 * @param {any} database
 * @param {{ tenantId: unknown, identity?: any, actor?: unknown }} spec
 */
export async function listUnacknowledgedWriteOutcomes(database, spec) {
  if (!usesWriteOutcomes(database)) {
    throw new AppError('Write-outcome lookup requires PostgreSQL', {
      code: 'WRITE_OUTCOME_POSTGRESQL_REQUIRED',
      status: 400,
    });
  }
  const tenantNs = tenantNamespace(spec.tenantId);
  const subject = subjectFingerprint(spec.identity, spec.actor);
  const store = createWriteOutcomeStore(database);
  const rows = await store.listUnacknowledged(tenantNs, subject);
  return rows.map(projectWriteOutcome);
}

/**
 * Idempotent Admin acknowledgement. Derives a child key from the submission
 * root + `admin-ack` + run id. Repeats add no write or audit.
 *
 * @param {any} database
 * @param {any} events
 * @param {{
 *   tenantId: unknown,
 *   idempotencyKey: unknown,
 *   identity?: any,
 *   actor?: unknown,
 * }} spec
 */
export async function acknowledgeWriteOutcome(database, events, spec) {
  const parent = await lookupWriteOutcome(database, spec);
  const childKey = deriveChildKey(parent.idempotencyKey, 'admin-ack', parent.runId);
  const outcome = await runIdempotentWrite(database, events, {
    tenantId: spec.tenantId,
    idempotencyKey: childKey,
    identity: spec.identity,
    actor: spec.actor,
    operation: 'admin.ack',
    target: parent.idempotencyKey,
    contractVersion: 'write.v1',
    input: { runId: parent.runId },
  }, async () => {
    const store = createWriteOutcomeStore(database);
    const tenantNs = tenantNamespace(spec.tenantId);
    const existing = await store.lookup(tenantNs, parent.idempotencyKey, 'root');
    if (!existing) throw new NotFoundError('WriteOutcome', parent.idempotencyKey);
    await store.tryAcknowledge({
      tenantNamespace: tenantNs,
      rawKey: parent.idempotencyKey,
      phase: 'root',
      acknowledgedAt: nowIso(),
    });
    return { ok: true, idempotencyKey: parent.idempotencyKey, runId: parent.runId };
  });
  return Object.freeze({
    ok: true,
    idempotencyKey: parent.idempotencyKey,
    ackKey: childKey,
    runId: parent.runId,
    replayed: outcome.replayed === true,
  });
}

export { providerIdempotencyKey, isUnknownCommit, unknownCommitError, deriveChildKey };
