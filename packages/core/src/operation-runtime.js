// @ts-check

import { ValidationError } from './errors.js';
import { runExternalOperation } from './external-operation.js';

/**
 * The generic application-operation runtime (ADR-032, applicationOperations v1).
 *
 * A package may declare bounded, application-scoped operations —
 * provider-addressed, transaction-disciplined, traced — and the composition
 * attaches them generically. This module owns the mechanics only: it builds
 * the **bounded operation context** a declared operation's `create(runtime)`
 * receives, and composes declared operations into an attachable surface. No
 * domain name appears here; the names live in the package declarations.
 *
 * The bounded context — exactly the keys the two real consumers use, and
 * nothing else (the ADR-032 implementation addendum in DECISIONS.md records
 * the audit):
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
 *
 * The context is deliberately NOT the raw kernel: no action registry, no
 * workflow engine, no provider registry, no package registry and no
 * capability resolver reach an operation through it. Tracing is not a context
 * key either: both shipped consumers persist their runs through the existing
 * runtime/external-operation machinery, and an extension point with zero
 * consumers is not shipped — the ADR's bounded trace writer is deferred to
 * the addendum until a first real consumer migrates onto it.
 *
 * The key set is CLOSED: an operation receives exactly the documented
 * capabilities, and any additional field would be non-contractual. A test
 * (`tests/package-operations-seam.test.js`) freezes the exact key list.
 */

/**
 * Build the bounded operation context. Called once per application instance;
 * every declared operation's `create(runtime)` receives the same frozen
 * context.
 *
 * @param {{database: any, modules: any, events: any, config?: Record<string, unknown>}} handles
 */
export function createOperationRuntime({ database, modules, events, config, core }) {
  if (!database || !modules || !events) {
    throw new ValidationError('operation runtime needs database, modules and events');
  }
  return Object.freeze({
    database,
    modules,
    events,
    config: Object.freeze({ ...(config ?? {}) }),
    runExternal: runExternalOperation,
    // The ADR-013 core adapters — the same frozen handle a record action already
    // receives as `ctx.core`, added to this context by ADR-037 because a real
    // consumer needed it and the alternatives were both worse. Customer Data
    // matches an imported row against `contacts.email`, which core stores
    // lowercased and globally UNIQUE; the adapter does that as an exact indexed
    // read. Reaching the same rows through `modules` would have meant a
    // 500-capped scan (a correctness bug the moment a project has more
    // contacts than that), and reaching them through `database` would have
    // meant a package writing raw SQL against core's tables and re-implementing
    // core's own normalization. Neither is acceptable, so the sanctioned
    // adapter is injected instead of being worked around.
    core: core ?? Object.freeze({}),
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
