// @ts-check

import { ValidationError } from './errors.js';
import { runExternalOperation } from './external-operation.js';
import { writeTrace, sanitizeJsonSafe } from './action-runtime.js';

/**
 * The generic application-operation runtime (ADR-032).
 *
 * A package may declare bounded, application-scoped operations —
 * provider-addressed, transaction-disciplined, traced — and the composition
 * attaches them generically. This module owns the mechanics only: it builds
 * the **bounded operation context** a declared operation's `create(runtime)`
 * receives, and composes declared operations into an attachable surface. No
 * domain name appears here; the names live in the package declarations.
 *
 * The bounded context, exactly the ADR-032 contract:
 *
 *   database     the application database handle the operation code held
 *                before the seam existed
 *   modules      the module registry — record access by module name is the
 *                ordinary mechanism (DX4), and managed writes keep audit
 *   events       the buffered bus, so domain events stay invisible until the
 *                transaction that raised them commits (ADR-012)
 *   config       the bounded, JSON-safe slice the application passes
 *   runExternal  the External Operation sequencer (ADR-017), injected so a
 *                package operation gets intent/external/finalize/compensate
 *                discipline WITHOUT `runExternalOperation` becoming public
 *                API — the contract travels with the seam, the module stays
 *                private, and no third path to it exists
 *   trace        a bounded, best-effort trace writer (below)
 *
 * The context is deliberately NOT the raw kernel: no action registry, no
 * workflow engine, no provider registry, no package registry and no
 * capability resolver reach an operation through it.
 */

/** Bounds on what the injected trace writer will persist. */
const MAX_TRACE_STEPS = 200;
const MAX_TRACE_TEXT = 2_000;

/**
 * Build the bounded trace writer: the same `workflow_runs`/`trace_spans` rows
 * every run surface reads, with the bounds the raw export never had — JSON-safe
 * input/output, size-bounded step lists and messages, and best-effort
 * semantics stated in the contract rather than re-invented per caller.
 * Operation run names are package-declared, never kernel-derived.
 *
 * @param {any} database
 */
function createBoundedTraceWriter(database) {
  return function trace(run) {
    try {
      if (!run || typeof run !== 'object' || typeof run.workflowName !== 'string' || run.workflowName === '') {
        return false;
      }
      const bounded = (value) => {
        try {
          return sanitizeJsonSafe(value ?? null, 'trace');
        } catch {
          return { unserializable: true };
        }
      };
      const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_TRACE_TEXT) : value ?? null);
      writeTrace(database, {
        runId: run.runId,
        workflowName: run.workflowName.slice(0, MAX_TRACE_TEXT),
        status: run.status === 'failed' ? 'failed' : 'completed',
        input: bounded(run.input),
        output: bounded(run.output),
        error: text(run.error),
        startedAt: run.startedAt,
        steps: (Array.isArray(run.steps) ? run.steps : []).slice(0, MAX_TRACE_STEPS).map((step) => ({
          name: typeof step?.name === 'string' ? step.name.slice(0, MAX_TRACE_TEXT) : 'step',
          status: step?.status === 'failed' ? 'failed' : 'completed',
          output: bounded(step?.output ?? null),
          error: text(step?.error),
        })),
      });
      return true;
    } catch {
      // Best-effort by contract: a trace that cannot be persisted never turns
      // a committed business result into a failure.
      return false;
    }
  };
}

/**
 * Build the bounded operation context. Called once per application instance;
 * every declared operation's `create(runtime)` receives the same frozen
 * context.
 *
 * @param {{database: any, modules: any, events: any, config?: Record<string, unknown>}} handles
 */
export function createOperationRuntime({ database, modules, events, config }) {
  if (!database || !modules || !events) {
    throw new ValidationError('operation runtime needs database, modules and events');
  }
  return Object.freeze({
    database,
    modules,
    events,
    config: Object.freeze({ ...(config ?? {}) }),
    runExternal: runExternalOperation,
    trace: createBoundedTraceWriter(database),
  });
}

/**
 * Compose every declared operation into an attachable surface. `create` is
 * called exactly once per operation, at composition. A declaration whose
 * factory does not return a function is a startup defect, surfaced before
 * anything is served.
 *
 * @param {{registry: {operations: () => Array<{package: string, entry: any}>}, runtime: any}} input
 * @returns {{aliases: Array<{appMethod: string, package: string, name: string, fn: Function}>}}
 */
export function composePackageOperations({ registry, runtime }) {
  const aliases = [];
  for (const { package: owner, entry } of registry.operations()) {
    const fn = entry.create(runtime);
    if (typeof fn !== 'function') {
      throw new ValidationError(
        `package "${owner}" operation "${entry.name}": create() must return the operation function`,
      );
    }
    if (entry.appMethod !== undefined) {
      aliases.push({ appMethod: entry.appMethod, package: owner, name: entry.name, fn });
    }
  }
  return { aliases };
}
