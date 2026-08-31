// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, normalizeError } from './errors.js';
import { nowIso } from './time.js';
import { writeTrace, sanitizeJsonSafe } from './action-runtime.js';
import { requestFingerprint, resolveIdempotencyKey, tenantNamespace } from './idempotency.js';
import { deterministicUuid } from './write-ids.js';
import {
  isUnknownCommit,
  runIdempotentWrite,
  usesWriteOutcomes,
} from './write-outcome-runtime.js';
import { createWriteOutcomeStore, unknownCommitError } from './write-outcome-store.js';
import {
  dispatchTransactionalOutboxJob,
  ensureCommittedWriteOutcomeEffects,
  transactionalOutboxEffectIdentity,
} from './transactional-outbox.js';

/**
 * The bounded external-operation contract (ADR-017).
 *
 * A remote call must never happen inside a database transaction, and the local
 * database and a remote provider can never commit atomically. The smallest
 * honest shape is therefore three explicitly separated phases:
 *
 *   intent(ctx)     inside transaction A — record the local intent
 *   external(ctx)   OUTSIDE every transaction, under a bounded timeout
 *   finalize(ctx)   inside transaction B — persist the remote outcome
 *   compensate(ctx) inside transaction C — only when external/finalize failed
 *
 * The `external` phase context deliberately carries **no** database, module
 * registry or managed-write access: only the frozen JSON-safe value `intent`
 * returned, the validated input, the actor and whatever provider handle the
 * caller passes in. Action code therefore never gains arbitrary transaction
 * control — it declares phases, and this runner sequences them.
 *
 * Every phase writes into the same evidence envelope as a record action:
 * events buffered per transaction and dispatched only after that transaction
 * commits (ADR-012), and one trace run whose spans distinguish local intent,
 * the provider call and local finalization.
 */

export const DEFAULT_EXTERNAL_TIMEOUT_MS = 5_000;

/**
 * Await `promise` but give up after `ms`. A late settlement is abandoned: the
 * operation has already failed and must not write anything afterwards.
 * @template T @param {Promise<T>} promise @param {number} ms @param {string} label
 */
export function withExternalTimeout(promise, ms, label) {
  /** @type {any} */
  let timer;
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {}); // observe late rejections; never unhandled
  return Promise.race([
    guarded,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AppError(`${label} timed out after ${ms}ms`, { code: 'PROVIDER_TIMEOUT', status: 504 })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Values crossing a phase boundary are normalized to plain JSON-safe data and
 * deep-frozen (the shared ADR-015 discipline), so nothing that carries
 * behavior, a live service handle or a cycle can leak from one phase to the
 * next — in particular into the external phase.
 * @param {unknown} value @param {string} [path]
 */
export function freezePhaseValue(value, path = 'value') {
  return sanitizeJsonSafe(value, path);
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
 * Run one external operation. Returns whatever `finalize` returned (or the
 * `intent` value when there is no external phase to run).
 *
 * @param {{
 *   database: any,
 *   events: any,
 *   name: string,
 *   input?: unknown,
 *   actor?: unknown,
 *   timeoutMs?: number,
 *   runId?: string,
 *   intent: (ctx: any) => any,
 *   external?: ((ctx: any) => any) | null,
 *   finalize?: ((ctx: any) => any) | null,
 *   compensate?: ((ctx: any) => any) | null,
 *   context?: Record<string, unknown>,
 * }} operation
 */
export async function runExternalOperation(operation) {
  if (usesWriteOutcomes(operation.database) || operation.externalOperation === 2) {
    if (usesWriteOutcomes(operation.database) && operation.externalOperation === 1) {
      throw new AppError(
        'PostgreSQL composition requires externalOperation 2 with provider idempotency and reconciliation',
        { code: 'EXTERNAL_OPERATION_V2_REQUIRED', status: 400 },
      );
    }
    return runExternalOperationV2(operation);
  }
  const { database, events, name, actor, input } = operation;
  const runId = operation.runId ?? randomUUID();
  // One clock per run, injectable like every other runtime capability.
  const now = operation.now ?? nowIso;
  const startedAt = now();
  const timeoutMs = Number.isSafeInteger(operation.timeoutMs) && /** @type {number} */ (operation.timeoutMs) > 0
    ? /** @type {number} */ (operation.timeoutMs)
    : DEFAULT_EXTERNAL_TIMEOUT_MS;
  /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
  const steps = [];
  const step = (stepName, output) => steps.push({ name: stepName, status: 'completed', output });
  const shared = { ...(operation.context ?? {}), input, actor, now, step };

  /** Run one transactional phase with its own buffered-event outbox. */
  const transactional = async (phase, fn) => events.buffered(async (outbox) => {
    const value = await database.transactionAsync(async () => fn());
    try {
      await outbox.commit();
    } catch (error) {
      const dispatchFailure = normalizeError(error);
      steps.push({ name: `${name}.${phase}.events`, status: 'failed', error: dispatchFailure.message });
      console.error(`[accordo] ${name} run ${runId}: ${phase} committed but event dispatch failed: ${dispatchFailure.message}`);
    }
    return value;
  });

  /** @type {any} */ let failure = null;
  /** @type {any} */ let result;
  /** @type {any} */ let intentValue;
  /** @type {any} */ let externalValue;
  /** @type {string | null} */ let failedPhase = null;

  try {
    intentValue = freezePhaseValue(await transactional('intent', () => operation.intent(shared)));
    steps.unshift({ name: `${name}.intent`, status: 'completed' });
    result = intentValue;

    if (typeof operation.external === 'function') {
      try {
        // No database, no modules, no managed writes reach this context.
        externalValue = freezePhaseValue(await withExternalTimeout(
          Promise.resolve(operation.external({ ...shared, intent: intentValue })),
          timeoutMs,
          name,
        ));
        steps.push({ name: `${name}.external`, status: 'completed' });
      } catch (error) {
        failedPhase = 'external';
        throw error;
      }
    }

    if (typeof operation.finalize === 'function') {
      try {
        result = await transactional('finalize', () => operation.finalize({ ...shared, intent: intentValue, external: externalValue }));
        steps.push({ name: `${name}.finalize`, status: 'completed' });
      } catch (error) {
        failedPhase = 'finalize';
        throw error;
      }
    }
  } catch (error) {
    failure = normalizeError(error);
    steps.push({ name: `${name}.${failedPhase ?? 'intent'}`, status: 'failed', error: failure.message });
    // Compensation records the local consequence of a remote call whose
    // outcome is unknown. It runs in its own transaction and must never mask
    // the original failure.
    if (failedPhase && typeof operation.compensate === 'function') {
      try {
        await transactional('compensate', () => operation.compensate({
          ...shared,
          intent: intentValue,
          external: externalValue,
          phase: failedPhase,
          failure: { code: failure.code, message: failure.message },
        }));
        steps.push({ name: `${name}.compensate`, status: 'completed' });
      } catch (compensateError) {
        const normalized = normalizeError(compensateError);
        steps.push({ name: `${name}.compensate`, status: 'failed', error: normalized.message });
        console.error(`[accordo] ${name} run ${runId}: compensation failed: ${normalized.message}`);
      }
    }
  }

  try {
    await Promise.resolve(writeTrace(database, {
      runId,
      workflowName: name,
      status: failure ? 'failed' : 'completed',
      input: { input, actor: safeActor(actor) },
      output: failure ? null : result,
      error: failure ? failure.message : null,
      startedAt,
      steps,
    }));
  } catch (traceError) {
    console.error(`[accordo] ${name} run ${runId}: failed to persist trace: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
  }

  if (failure) {
    failure.details = {
      ...(failure.details && typeof failure.details === 'object' ? failure.details : {}),
      workflowRunId: runId,
    };
    throw failure;
  }
  return { result, runId };
}

/**
 * @param {any} provider
 */
function assertProviderV2(provider) {
  if (!provider || typeof provider.call !== 'function' || typeof provider.reconcile !== 'function') {
    throw new AppError(
      'PostgreSQL external operations require a provider with call and reconcile',
      { code: 'EXTERNAL_OPERATION_V2_REQUIRED', status: 400 },
    );
  }
}

function receiptMismatch() {
  return new AppError('Provider receipt does not match the local intent', {
    code: 'PROVIDER_RECEIPT_MISMATCH',
    status: 409,
  });
}

function divergentFinalizeDeclaration() {
  return new AppError('External operation finalize declaration differs from the committed receipt', {
    code: 'DIVERGENT_REPLAY', status: 409,
  });
}

function unknownFinalizeDeclaration() {
  return new AppError('Committed receipt finalize declaration requires operator reconciliation', {
    code: 'EXTERNAL_FINALIZE_DECLARATION_RECONCILIATION_REQUIRED', status: 409,
  });
}

async function assertFinalizeDeclaration(args, stored) {
  if (stored.externalFinalizeDeclared === null) {
    await ensureCommittedWriteOutcomeEffects({
      database: args.database,
      tenantId: args.specBase.tenantId,
      outcome: stored,
      clock: args.now,
    });
    throw unknownFinalizeDeclaration();
  }
  if (stored.externalFinalizeDeclared !== args.finalizeDeclared) {
    throw divergentFinalizeDeclaration();
  }
}

/**
 * @param {any} remote
 * @param {{
 *   providerKey: string,
 *   operation: string,
 *   requestFingerprint: string,
 *   tenantNsHint?: string,
 * }} expected
 */
function assertProviderReceipt(remote, expected) {
  if (!remote || typeof remote !== 'object') throw receiptMismatch();
  const receipt = /** @type {any} */ (remote);
  if (receipt.idempotencyKey !== expected.providerKey) throw receiptMismatch();
  if (typeof receipt.operation === 'string' && receipt.operation !== expected.operation) throw receiptMismatch();
  if (typeof receipt.requestFingerprint === 'string' && receipt.requestFingerprint !== expected.requestFingerprint) {
    throw receiptMismatch();
  }
}

/**
 * External-operation v2: durable intent and finalize phase keys, one stable
 * provider idempotency key, read-only reconcile, never an implicit provider
 * replay. COMMIT_OUTCOME_UNKNOWN is never an automatic retry.
 *
 * @param {any} operation
 */
async function runExternalOperationV2(operation) {
  const { database, events, name, actor, input } = operation;
  const now = operation.now ?? nowIso;
  const provider = operation.provider;
  if (usesWriteOutcomes(database)) assertProviderV2(provider);

  const rawKey = usesWriteOutcomes(database)
    ? resolveIdempotencyKey(operation.idempotencyKey, now)
    : operation.idempotencyKey;
  const tenantId = operation.tenantId ?? database.tenantId;
  const sharedRunId = usesWriteOutcomes(database)
    ? deterministicUuid(`${tenantNamespace(tenantId)}\0${rawKey}\0run`)
    : undefined;
  const specBase = {
    tenantId,
    idempotencyKey: rawKey,
    identity: operation.identity,
    actor,
    contractVersion: 'external.v2',
    input,
    now,
    runId: sharedRunId,
  };

  const intentOutcome = await runIdempotentWrite(database, events, {
    ...specBase,
    operation: `${name}.intent`,
    target: 'intent',
    phase: 'intent',
    settleTrace: false,
  }, async ({ step, runId, idempotencyKey, providerIdempotencyKey }) => {
    const value = freezePhaseValue(await operation.intent({
      input, actor, now, step, runId, idempotencyKey, providerIdempotencyKey,
    }));
    return {
      intent: value,
      providerIdempotencyKey,
      requestFingerprint: requestFingerprint({
        operation: name,
        target: 'intent',
        contractVersion: 'external.v2',
        input,
      }),
    };
  });

  const intentEnvelope = /** @type {any} */ (intentOutcome.result);
  const intentValue = intentEnvelope.intent;
  const providerKey = intentEnvelope.providerIdempotencyKey;
  const requestFp = intentEnvelope.requestFingerprint;
  /** @type {any} */
  let receipt = null;

  if (typeof operation.external === 'function' || provider) {
    receipt = await obtainProviderReceipt({
      database,
      events,
      specBase,
      name,
      provider,
      providerKey,
      requestFp,
      intentValue,
      input,
      actor,
      now,
      external: operation.external,
      finalizeDeclared: typeof operation.finalize === 'function',
    });
  }

  if (typeof operation.finalize !== 'function') {
    return {
      result: intentValue,
      runId: intentOutcome.runId,
      idempotencyKey: intentOutcome.idempotencyKey,
      replayed: intentOutcome.replayed,
    };
  }

  const finalized = await runIdempotentWrite(database, events, {
    ...specBase,
    operation: `${name}.finalize`,
    target: 'finalize',
    phase: 'finalize',
    settleTrace: true,
  }, async ({ step, runId, idempotencyKey, providerIdempotencyKey }) => freezePhaseValue(
    await operation.finalize({
      input, actor, now, step, runId, idempotencyKey, providerIdempotencyKey,
      intent: intentValue,
      external: receipt,
    }),
  ));

  if (usesWriteOutcomes(database)) {
    const receiptOutcome = await createWriteOutcomeStore(database).lookup(
      tenantNamespace(tenantId), rawKey, 'receipt',
    );
    if (receiptOutcome) {
      await ensureCommittedWriteOutcomeEffects({
        database,
        tenantId,
        outcome: receiptOutcome,
        clock: now,
      });
      const effect = transactionalOutboxEffectIdentity(
        tenantId,
        receiptOutcome,
        'external-finalize-continuation',
      );
      try {
        await dispatchTransactionalOutboxJob({
          database, events, tenantId, clock: now,
          workerId: `external-finalize-${receiptOutcome.runId}`,
        }, effect.jobId);
      } catch (error) {
        console.error(
          `[accordo] ${name} run ${receiptOutcome.runId}: finalize continuation evidence remains pending: `
          + 'TRANSACTIONAL_OUTBOX_DISPATCH_FAILED',
        );
      }
    }
  }

  return {
    result: finalized.result,
    runId: finalized.runId,
    idempotencyKey: intentOutcome.idempotencyKey,
    replayed: Boolean(intentOutcome.replayed && finalized.replayed),
  };
}

/**
 * @param {{
 *   database: any,
 *   events: any,
 *   specBase: any,
 *   name: string,
 *   provider: any,
 *   providerKey: string,
 *   requestFp: string,
 *   intentValue: any,
 *   input: unknown,
 *   actor: unknown,
 *   now: () => string,
 *   external?: Function | null,
 *   finalizeDeclared: boolean,
 * }} args
 */
async function obtainProviderReceipt(args) {
  const {
    database, events, specBase, name, provider, providerKey, requestFp,
    intentValue, input, actor, now, external,
  } = args;
  const store = usesWriteOutcomes(database) ? createWriteOutcomeStore(database) : null;
  const rawKey = specBase.idempotencyKey;
  if (store) {
    const stored = await store.lookup(tenantNamespace(specBase.tenantId), rawKey, 'receipt');
    if (stored) {
      await assertFinalizeDeclaration(args, stored);
      return stored.response;
    }
    const attempted = await store.lookup(tenantNamespace(specBase.tenantId), rawKey, 'call');
    if (attempted) {
      if (provider && typeof provider.reconcile === 'function') {
        const remote = await provider.reconcile({
          idempotencyKey: providerKey,
          intent: intentValue,
        });
        if (remote && remote.status !== 'absent' && remote !== null) {
          assertProviderReceipt(remote, { providerKey, operation: name, requestFingerprint: requestFp });
          return persistReceipt(args, freezePhaseValue(remote));
        }
      }
      throw unknownCommitError(rawKey);
    }
  }

  if (provider && typeof provider.reconcile === 'function') {
    const remote = await provider.reconcile({
      idempotencyKey: providerKey,
      intent: intentValue,
    });
    if (remote && remote.status !== 'absent' && remote !== null) {
      assertProviderReceipt(remote, { providerKey, operation: name, requestFingerprint: requestFp });
      return persistReceipt(args, freezePhaseValue(remote));
    }
  }

  if (typeof external !== 'function' && !(provider && typeof provider.call === 'function')) {
    return null;
  }

  if (usesWriteOutcomes(database)) {
    const callOutcome = await runIdempotentWrite(database, events, {
      ...specBase,
      operation: `${name}.call`,
      target: 'call',
      phase: 'call',
      settleTrace: false,
    }, async () => ({ attempted: true, providerIdempotencyKey: providerKey }));
    if (callOutcome.replayed) {
      if (provider && typeof provider.reconcile === 'function') {
        const remote = await provider.reconcile({
          idempotencyKey: providerKey,
          intent: intentValue,
        });
        if (remote && remote.status !== 'absent' && remote !== null) {
          assertProviderReceipt(remote, { providerKey, operation: name, requestFingerprint: requestFp });
          return persistReceipt(args, freezePhaseValue(remote));
        }
      }
      throw unknownCommitError(rawKey);
    }
  }

  const timeoutMs = Number.isSafeInteger(args.specBase.timeoutMs) && args.specBase.timeoutMs > 0
    ? args.specBase.timeoutMs
    : DEFAULT_EXTERNAL_TIMEOUT_MS;
  const called = freezePhaseValue(await withExternalTimeout(
    Promise.resolve(
      provider && typeof provider.call === 'function'
        ? provider.call({
          idempotencyKey: providerKey,
          intent: intentValue,
          input,
          actor,
          now,
          requestFingerprint: requestFp,
          operation: name,
        })
        : external({
          intent: intentValue,
          input,
          actor,
          now,
          step: () => {},
          providerIdempotencyKey: providerKey,
        }),
    ),
    timeoutMs,
    name,
  ));
  if (provider) {
    assertProviderReceipt(called, { providerKey, operation: name, requestFingerprint: requestFp });
  }
  return persistReceipt(args, called);
}

/**
 * @param {any} args
 * @param {any} receipt
 */
async function persistReceipt(args, receipt) {
  const { database, events, specBase, name } = args;
  try {
    const outcome = await runIdempotentWrite(database, events, {
      ...specBase,
      operation: `${name}.receipt`,
      target: 'receipt',
      phase: 'receipt',
      settleTrace: false,
      externalFinalizeDeclared: args.finalizeDeclared === true,
    }, async () => receipt);
    return outcome.result;
  } catch (error) {
    if (!isUnknownCommit(error)) throw error;
    const store = createWriteOutcomeStore(database);
    const existing = await store.lookup(
      tenantNamespace(specBase.tenantId),
      resolveIdempotencyKey(specBase.idempotencyKey, specBase.now),
      'receipt',
    );
    if (existing) {
      await assertFinalizeDeclaration(args, existing);
      return existing.response;
    }
    if (args.provider && typeof args.provider.reconcile === 'function') {
      const remote = await args.provider.reconcile({
        idempotencyKey: args.providerKey,
        intent: args.intentValue,
      });
      if (remote && remote.status !== 'absent') {
        assertProviderReceipt(remote, {
          providerKey: args.providerKey,
          operation: name,
          requestFingerprint: args.requestFp,
        });
        return remote;
      }
    }
    throw unknownCommitError(specBase.idempotencyKey);
  }
}
