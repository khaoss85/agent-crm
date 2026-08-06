// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, normalizeError } from './errors.js';
import { nowIso } from './time.js';
import { writeTrace, sanitizeJsonSafe } from './action-runtime.js';

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
  const { database, events, name, actor, input } = operation;
  const runId = operation.runId ?? randomUUID();
  const startedAt = nowIso();
  const timeoutMs = Number.isSafeInteger(operation.timeoutMs) && /** @type {number} */ (operation.timeoutMs) > 0
    ? /** @type {number} */ (operation.timeoutMs)
    : DEFAULT_EXTERNAL_TIMEOUT_MS;
  /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
  const steps = [];
  const step = (stepName, output) => steps.push({ name: stepName, status: 'completed', output });
  const shared = { ...(operation.context ?? {}), input, actor, now: () => nowIso(), step };

  /** Run one transactional phase with its own buffered-event outbox. */
  const transactional = async (phase, fn) => events.buffered(async (outbox) => {
    const value = await database.transactionAsync(async () => fn());
    try {
      await outbox.commit();
    } catch (error) {
      const dispatchFailure = normalizeError(error);
      steps.push({ name: `${name}.${phase}.events`, status: 'failed', error: dispatchFailure.message });
      console.error(`[agent-crm] ${name} run ${runId}: ${phase} committed but event dispatch failed: ${dispatchFailure.message}`);
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
        console.error(`[agent-crm] ${name} run ${runId}: compensation failed: ${normalized.message}`);
      }
    }
  }

  try {
    writeTrace(database, {
      runId,
      workflowName: name,
      status: failure ? 'failed' : 'completed',
      input: { input, actor: safeActor(actor) },
      output: failure ? null : result,
      error: failure ? failure.message : null,
      startedAt,
      steps,
    });
  } catch (traceError) {
    console.error(`[agent-crm] ${name} run ${runId}: failed to persist trace: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
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
