// @ts-check

import { createDatabase } from '../../core/src/database.js';
import { runWithAffineStorage } from '../../core/src/storage-runtime.js';
import { validateActionDefinition } from '../../core/src/action-registry.js';
import { AppError, ValidationError } from '../../core/src/errors.js';
import { resolvePackageComposition } from '../../core/src/package-composition.js';

/**
 * Source-private M2E-2A machinery. Not exported from `packages/app/src/index.js`
 * or `packages/core/index.js`. The released synchronous factory stays
 * `createAccordoApp()`; the public async factory composes through 2B over this
 * lifecycle.
 */

function refuseLegacyExternalOperations(accepted) {
  const actions = [
    ...(accepted.actions ?? []),
    ...(accepted.packages ?? []).flatMap((pkg) => pkg.actions ?? []),
  ];
  for (const action of actions) {
    if (action?.externalOperation === undefined) continue;
    if (action.externalOperation !== 2) {
      const identity = `${action.module ?? 'action'}.${action.name ?? 'unnamed'}`;
      throw new AppError(
        `PostgreSQL composition requires externalOperation 2 with provider idempotency and reconciliation (received ${identity} externalOperation ${String(action.externalOperation)})`,
        {
          code: 'EXTERNAL_OPERATION_V2_REQUIRED',
          status: 400,
          details: { action: identity, externalOperation: action.externalOperation },
        },
      );
    }
    const provider = action.provider;
    if (provider && (typeof provider.call !== 'function' || typeof provider.reconcile !== 'function')) {
      const identity = `${action.module ?? 'action'}.${action.name ?? 'unnamed'}`;
      throw new AppError(
        `PostgreSQL composition requires a provider with call and reconcile on ${identity}`,
        { code: 'EXTERNAL_OPERATION_V2_REQUIRED', status: 400, details: { action: identity } },
      );
    }
  }
}

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
 *   moduleMigrations?: Array<{name: string, sql: string}>,
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
    // `createDatabase` has always accepted these; only this hop dropped them,
    // so on SQLite no supported composition could apply a contract's own
    // migration — the scheduled-ask table among them.
    moduleMigrations: options.moduleMigrations,
  });

  let closed = false;
  const closeAdapter = () => {
    if (closed) return;
    closed = true;
    opened.close();
  };

  let assembled;
  try {
    // The adapter's own handle, whose `transactionAsync` is the one that opens
    // the durable-job ownership scope on SQLite. It travels in the assembly
    // context, never on the frozen receipt, which stays pinned shut.
    assembled = await assemble({ accepted, storage: opened.storage, database: opened });
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

/**
 * Own one PostgreSQL control+data bootstrap after a successful v2 preflight.
 *
 * @param {{
 *   selected: any,
 *   tenantId: string,
 *   identityVerifier: { operations: any },
 *   control: object,
 *   data: object,
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   clock?: () => string,
 *   faultInject?: string,
 *   now?: () => number,
 *   leaseTtlMs?: number,
 *   queryDeadlineMs?: number,
 *   acquisitionDeadlineMs?: number,
 *   rebind?: unknown,
 *   promoteClone?: unknown,
 *   assemble?: (ctx: { accepted: ReturnType<typeof preflightSelectedGraph>, storage: any, bootstrap: any }) => any,
 * }} options
 */
export async function startPostgresqlLifecycle(options) {
  const accepted = preflightSelectedGraph(options.selected);
  refuseLegacyExternalOperations(accepted);
  const assemble = options.assemble ?? (() => undefined);
  const { bootstrapPostgresqlApplication } = await import('../../core/src/postgresql-bootstrap.js');
  const bootstrap = await bootstrapPostgresqlApplication({
    control: options.control,
    data: options.data,
    tenantId: options.tenantId,
    identityVerifier: options.identityVerifier,
    moduleMigrations: options.moduleMigrations,
    clock: options.clock,
    faultInject: options.faultInject,
    now: options.now,
    leaseTtlMs: options.leaseTtlMs,
    queryDeadlineMs: options.queryDeadlineMs,
    acquisitionDeadlineMs: options.acquisitionDeadlineMs,
    rebind: options.rebind,
    promoteClone: options.promoteClone,
    // Spine v4C. Without this hop the bootstrap's writer-readiness observer is
    // unreachable from every supported composition: it was built, exported and
    // tested, and no application could ever hand it a sink.
    telemetry: options.telemetry,
    selectedExtra: accepted.packages.map((pkg) => pkg.name),
  });

  // Connection-affine, which it was not until something used it. Nothing did:
  // this handle reached `assemble` and no caller read it, so a statement run
  // inside its transaction would have gone to the pool instead of the open
  // connection. Composing production operations over it is what showed that.
  const handle = {
    storage: bootstrap.dataStorage,
    transactionAsync(fn) {
      return bootstrap.dataStorage.transaction(
        async (tx) => runWithAffineStorage(handle, tx, () => fn(tx)),
      );
    },
  };

  let assembled;
  try {
    assembled = await assemble({ accepted, storage: bootstrap.dataStorage, bootstrap, handle });
  } catch (error) {
    try {
      await bootstrap.close();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }

  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = bootstrap.close();
    return closePromise;
  };

  return Object.freeze({
    accepted,
    storage: bootstrap.dataStorage,
    bootstrap,
    assembled,
    close,
  });
}

/**
 * Own one PostgreSQL data plane opened for reading only.
 *
 * The difference from `startPostgresqlLifecycle` is what is absent: no control
 * endpoint, no identity verifier, no lease, no migrations. The handle's
 * `transactionAsync` is kept and forwarded unchanged — it reaches storage that
 * refuses to open a transaction, so a write path that assumes it exists gets a
 * typed refusal from the seam rather than a `TypeError` from a missing key.
 *
 * @param {{
 *   selected: any,
 *   tenantId: string,
 *   data: object,
 *   pinnedBindingUuid?: string,
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   queryDeadlineMs?: number,
 *   acquisitionDeadlineMs?: number,
 *   assemble?: (ctx: { accepted: any, storage: any, bootstrap: any, handle: any }) => any,
 * }} options
 */
export async function startPostgresqlReaderLifecycle(options) {
  const accepted = preflightSelectedGraph(options.selected);
  refuseLegacyExternalOperations(accepted);
  const assemble = options.assemble ?? (() => undefined);
  const { bootstrapPostgresqlReader } = await import('../../core/src/postgresql-bootstrap.js');
  const bootstrap = await bootstrapPostgresqlReader({
    data: options.data,
    tenantId: options.tenantId,
    pinnedBindingUuid: options.pinnedBindingUuid,
    moduleMigrations: options.moduleMigrations,
    queryDeadlineMs: options.queryDeadlineMs,
    acquisitionDeadlineMs: options.acquisitionDeadlineMs,
  });

  const handle = {
    storage: bootstrap.dataStorage,
    transactionAsync(fn) {
      return bootstrap.dataStorage.transaction(
        async (tx) => runWithAffineStorage(handle, tx, () => fn(tx)),
      );
    },
  };

  let assembled;
  try {
    assembled = await assemble({ accepted, storage: bootstrap.dataStorage, bootstrap, handle });
  } catch (error) {
    try {
      await bootstrap.close();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }

  let closePromise;
  const close = () => {
    if (!closePromise) closePromise = bootstrap.close();
    return closePromise;
  };

  return Object.freeze({ accepted, storage: bootstrap.dataStorage, bootstrap, assembled, close });
}
