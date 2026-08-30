// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { createExecutionRunStore } from './execution-run-store.js';
import {
  assertOutcomeScope,
  encodeJsonSafe,
  providerIdempotencyKey,
  requestFingerprint,
  resolveIdempotencyKey,
  subjectFingerprint,
  tenantNamespace,
} from './idempotency.js';
import { isSyncStorage, storageApi } from './storage-runtime.js';
import { nowIso } from './time.js';
import { deterministicUuid, snapshotWriteIds, withWriteIds } from './write-ids.js';
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
  const runId = deterministicUuid(`${tenantNs}\0${rawKey}\0${phase}\0run`);
  const providerKey = providerIdempotencyKey(tenantNs, rawKey);
  const store = createWriteOutcomeStore(database);
  const seed = `${tenantNs}\0${rawKey}\0${phase}`;

  try {
    const existing = await store.lookup(tenantNs, rawKey, phase);
    if (existing) {
      assertOutcomeScope(existing, scope);
      await promoteAndFinalize(database, events, store, existing);
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
    try {
      const result = await ENVELOPE.run({
        idempotencyKey: rawKey,
        runId,
        providerIdempotencyKey: providerKey,
      }, async () => events.buffered(async (outbox) => {
        const value = await withWriteIds(seed, async () => {
          const inner = await database.transactionAsync(async () => {
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
              status: 'completed',
              input: encodeJsonSafe({
                target,
                input: spec.input ?? null,
                actor: spec.actor && typeof spec.actor === 'object'
                  ? { type: /** @type {any} */ (spec.actor).type ?? null, id: /** @type {any} */ (spec.actor).id ?? null }
                  : null,
              }),
              output: encoded,
              error: null,
              startedAt,
              steps: steps.slice(),
            };
            await store.insert({
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
            });
            await openPendingRun(database, {
              runId,
              workflowName: operation,
              input: traceIntent.input,
              startedAt,
            });
            return encoded;
          });
          return inner;
        });
        const committed = await store.lookup(tenantNs, rawKey, phase);
        if (committed) {
          const won = await store.tryPromoteEvents(committed);
          if (won) {
            try {
              await outbox.commit();
            } catch (dispatchError) {
              console.error(
                `[accordo] ${operation} run ${runId}: business writes committed but event dispatch failed: `
                + `${dispatchError instanceof Error ? dispatchError.message : String(dispatchError)}`,
              );
            }
          } else {
            outbox.discard();
          }
          await finalizePendingTrace(database, committed.traceIntent);
        } else {
          outbox.discard();
        }
        return value;
      }));
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
            await promoteAndFinalize(database, events, store, winner);
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
      await promoteAndFinalize(database, events, store, existing);
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
async function promoteAndFinalize(database, events, store, outcome) {
  const won = await store.tryPromoteEvents(outcome);
  if (won) {
    for (const entry of outcome.eventIntents ?? []) {
      if (!entry || typeof entry !== 'object') continue;
      try {
        await events.emit(entry.event, entry.payload);
      } catch (error) {
        console.error(
          `[accordo] ${outcome.operation} run ${outcome.runId}: recovery event dispatch failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  await finalizePendingTrace(database, outcome.traceIntent);
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

export { providerIdempotencyKey, isUnknownCommit, unknownCommitError };
