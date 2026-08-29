// @ts-check

import { createDatabase } from '../../core/src/database.js';
import { validateActionDefinition } from '../../core/src/action-registry.js';
import { AppError, ValidationError } from '../../core/src/errors.js';
import { resolvePackageComposition } from '../../core/src/package-composition.js';

/**
 * Source-private M2E-2A machinery. Not exported from `packages/app/src/index.js`
 * or `packages/core/index.js`. The released synchronous factory stays
 * `createAccordoApp()`; the public async factory composes through 2B over this
 * lifecycle.
 */

function asyncContractError(message, details) {
  return new AppError(message, {
    code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
    status: 400,
    details,
  });
}

function requireArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`Selected graph ${label} must be an array`);
  }
  return value;
}

const CLEANUP_REPORT_LIMIT = 200;

function reportCleanupFailure(startupError, cleanupError) {
  try {
    const startup = startupError instanceof Error
      ? startupError.message.slice(0, CLEANUP_REPORT_LIMIT)
      : 'non-error';
    const cleanup = cleanupError instanceof Error
      ? cleanupError.message.slice(0, CLEANUP_REPORT_LIMIT)
      : String(cleanupError).slice(0, CLEANUP_REPORT_LIMIT);
    console.error(
      `[accordo] sqlite lifecycle cleanup failed after startup error; original cause preserved — startup: ${startup} — cleanup: ${cleanup}`,
    );
  } catch {
    // Reporting must never replace the original rejection.
  }
}

export function attachCleanupError(error, cleanupError) {
  let attached = false;
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      Object.defineProperty(error, 'cleanupError', {
        value: cleanupError,
        enumerable: true,
        configurable: true,
      });
      attached = Object.hasOwn(error, 'cleanupError');
    } catch {
      attached = false;
    }
  }
  if (!attached) reportCleanupFailure(error, cleanupError);
}

function readSelectedContract(selected) {
  if (selected === null || selected === undefined || typeof selected !== 'object' || Array.isArray(selected)) {
    throw asyncContractError(
      'Selected graph must be an object with an explicit packageContract 2',
      {},
    );
  }
  let packageContract;
  try {
    packageContract = selected.packageContract;
  } catch (error) {
    throw asyncContractError(
      'Selected graph packageContract could not be read',
      {},
    );
  }
  if (packageContract !== 2) {
    throw asyncContractError(
      `Selected graph uses packageContract ${String(packageContract)}, but the portable async path requires packageContract 2; sync-v1 and async-v2 contracts cannot share one application graph`,
      { selectedContract: packageContract },
    );
  }
  return 2;
}

/**
 * Prove a selected graph is uniformly async-v2 without opening storage.
 *
 * @param {any} selected
 */
export function preflightSelectedGraph(selected) {
  const packageContract = readSelectedContract(selected);
  const packages = requireArray(selected.packages, 'packages');
  const actions = requireArray(selected.actions, 'actions');
  const modules = requireArray(selected.modules, 'modules');
  const moduleNames = modules.filter((name) => typeof name === 'string');
  const resolved = resolvePackageComposition(packages);
  if (resolved.problems.length > 0) {
    throw resolved.problems[0].error ?? asyncContractError(resolved.problems[0].message, {
      code: resolved.problems[0].code,
    });
  }

  const packageFacts = Object.freeze([...resolved.packageFacts.values()]);
  for (const facts of packageFacts) {
    if (facts.packageContract !== packageContract) {
      const message = `Selected graph uses packageContract ${packageContract}, but package "${facts.name}" declares packageContract ${facts.packageContract}; sync-v1 and async-v2 contracts cannot share one application graph`;
      throw asyncContractError(message, {
        package: facts.name,
        packageContract: facts.packageContract,
        selectedContract: packageContract,
      });
    }
  }

  const moduleExists = (name) => moduleNames.includes(name);
  const acceptedActions = [];
  for (const declared of actions) {
    validateActionDefinition(declared, { moduleExists });
    if (declared.actionContract !== packageContract) {
      const identity = `${declared.module}.${declared.name}`;
      const message = `Selected graph uses packageContract ${packageContract}, but action "${identity}" declares actionContract ${declared.actionContract}; sync-v1 and async-v2 contracts cannot share one application graph`;
      throw asyncContractError(message, {
        action: identity,
        actionContract: declared.actionContract,
        selectedContract: packageContract,
      });
    }
    acceptedActions.push(declared);
  }

  return Object.freeze({
    packageContract,
    packages: Object.freeze([...resolved.packages.values()]),
    packageFacts,
    actions: Object.freeze(acceptedActions),
    modules: Object.freeze([...moduleNames]),
  });
}

/**
 * Own one SQLite adapter after a successful v2 preflight.
 *
 * @param {{
 *   selected: any,
 *   dbPath?: string,
 *   busyTimeoutMs?: number,
 *   assemble?: (ctx: { accepted: ReturnType<typeof preflightSelectedGraph>, storage: any }) => any,
 *   openDatabase?: (options: { path?: string, busyTimeoutMs?: number }) => { storage: any, close: () => void },
 *   providers?: unknown,
 *   listen?: unknown,
 * }} [options]
 */
export async function startSqliteLifecycle(options = {}) {
  const accepted = preflightSelectedGraph(options.selected);
  const openDatabase = options.openDatabase ?? createDatabase;
  const assemble = options.assemble ?? (() => undefined);
  // providers / listen are accepted only so tests can prove they never run.
  void options.providers;
  void options.listen;

  const opened = openDatabase({
    path: options.dbPath,
    busyTimeoutMs: options.busyTimeoutMs,
  });

  let closed = false;
  const closeAdapter = () => {
    if (closed) return;
    closed = true;
    opened.close();
  };

  let assembled;
  try {
    assembled = await assemble({ accepted, storage: opened.storage });
  } catch (error) {
    try {
      closeAdapter();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }

  let closePromise;
  const close = () => {
    if (!closePromise) {
      closePromise = Promise.resolve().then(() => {
        closeAdapter();
      });
    }
    return closePromise;
  };

  return Object.freeze({
    accepted,
    storage: opened.storage,
    assembled,
    close,
  });
}
