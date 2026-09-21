// @ts-check

import { createHttpServer } from '../../../apps/server/src/index.js';
import { AppError, ValidationError } from '../../core/src/errors.js';
import {
  isThenable,
  refuseThenableDomainValue,
  settleContractValue,
  thenableDomainValueError,
} from '../../core/src/async-values.js';
import { attachCleanupError } from './async-lifecycle.js';
import { startPortableSqliteApp } from './portable-app.js';

/**
 * Source-private M2E-2C machinery. Not exported from `packages/app/src/index.js`
 * or `packages/core/index.js`. The released serve path stays the synchronous
 * factory; the public async factory does not start HTTP.
 *
 * Portable composition, security/identity/authorization assembly, package
 * startup hooks and capability-contract echoes all settle before the HTTP
 * listener is bound. A startup failure closes owned resources, never listens,
 * and never replaces the original cause with a cleanup failure.
 */

const ACTION_ELIGIBLE_CORE_MODULES = Object.freeze(['opportunity']);

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireFunctionOrNull(value, label) {
  if (value == null) return null;
  if (typeof value !== 'function') {
    throw new ValidationError(`${label} must be a function once assembled`);
  }
  return value;
}

/**
 * @param {any} value
 * @param {string} label
 */
async function assembleMaybeAsync(value, label) {
  const settled = isThenable(value) ? await value : value;
  refuseThenableDomainValue(settled, label);
  return settled;
}

/**
 * @param {any} selected
 * @param {{ modules: any, actor: { type: string, id: string }, now: () => string }} context
 */
async function runPackageStartupHooks(selected, context) {
  for (const pkg of selected?.packages ?? []) {
    if (typeof pkg?.start !== 'function') continue;
    const result = pkg.start(context);
    refuseThenableDomainValue(
      await settleContractValue(result, 2, `package "${pkg.name}" start`),
      `package "${pkg.name}" start`,
    );
  }
}

/**
 * Instantiate every offered capability and verify an optional interface
 * `capabilityContract` echoes the accepted declaration. A thenable standing
 * in for the interface is refused rather than read as a domain value.
 *
 * @param {any} selected
 * @param {{ modules: any, actor: { type: string, id: string }, now: () => string }} context
 */
async function verifyCapabilityContracts(selected, context) {
  for (const pkg of selected?.packages ?? []) {
    for (const cap of pkg?.capabilities ?? []) {
      const declared = cap.capabilityContract;
      const identity = `${cap.name}@${cap.version}`;
      if (typeof cap.create !== 'function') {
        throw new AppError(`Capability ${identity} did not declare create()`, {
          code: 'CAPABILITY_INVALID',
          status: 500,
          details: { capability: cap.name, version: cap.version, package: pkg.name },
        });
      }
      const created = cap.create({ ...context, consumer: pkg.name });
      if (
        isThenable(created)
        && created
        && typeof created === 'object'
        && Object.hasOwn(created, 'capabilityContract')
      ) {
        throw thenableDomainValueError(`capability ${identity} interface`);
      }
      const iface = await settleContractValue(created, declared, `capability ${identity} interface`);
      if (!iface || typeof iface !== 'object' || Array.isArray(iface)) {
        throw new AppError(`Capability ${identity} did not return an interface`, {
          code: 'CAPABILITY_INVALID',
          status: 500,
          details: { capability: cap.name, version: cap.version, package: pkg.name },
        });
      }
      if (Object.hasOwn(iface, 'capabilityContract') && iface.capabilityContract !== declared) {
        throw new AppError(
          `Capability "${identity}" interface capabilityContract ${String(iface.capabilityContract)} does not echo declared capabilityContract ${String(declared)}`,
          {
            code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
            status: 400,
            details: {
              package: pkg.name,
              capability: cap.name,
              version: cap.version,
              declared,
              echo: iface.capabilityContract,
            },
          },
        );
      }
    }
  }
}

/**
 * HTTP-only adapter over the 2B facade. Operation `appMethod` aliases attach
 * here so the in-process allowlist stays lexical.
 *
 * @param {any} app
 * @param {{ spine?: any }} security
 */
function createPortableHttpApp(app, security) {
  /** @type {Record<string, any>} */
  const adapter = {
    storage: app.storage,
    packageContract: app.packageContract,
    services: app.services,
    modules: app.modules,
    actions: app.actions,
    operations: app.operations,
    pipelines: app.pipelines,
    domains: Object.freeze({
      get: (name) => app.domains.get(name),
      has: (name) => app.domains.has(name),
      names: () => app.domains.names(),
      resources: () => app.domains.resources(),
      metadata: () => app.domains.metadata(),
      report: () => app.domains.report(),
      get size() {
        return app.domains.names().length;
      },
    }),
    workflows: app.workflows,
    audit: app.audit,
    events: app.events,
    providers: app.providers,
    notifications: app.notifications,
    runAction: (params) => app.runAction(params),
    reconcileWrite: (params) => app.reconcileWrite(params),
    lookupWrite: (params) => app.lookupWrite(params),
    listUnacknowledgedWrites: (params) => app.listUnacknowledgedWrites(params),
    acknowledgeWrite: (params) => app.acknowledgeWrite(params),
    now: app.now,
    schema: app.schema,
    config: app.config,
    actionEligibleCoreModules: ACTION_ELIGIBLE_CORE_MODULES,
    spine: security.spine ?? null,
    health: () => (typeof app.health === 'function'
      ? app.health()
      : Object.freeze({
        ok: true,
        ready: app.storage?.available === true,
        storage: app.storage,
      })),
    metrics: () => app.metrics(),
    doctor() {
      return {
        ok: true,
        name: 'accordo',
        version: '0.1.0',
        node: process.version,
        storage: app.storage,
        packageContract: app.packageContract,
        modules: app.modules.list(),
        workflows: app.workflows.list(),
        providers: app.providers.list(),
      };
    },
    close: app.close,
  };

  for (const alias of app.operations.list()) {
    if (!alias.appMethod) continue;
    if (alias.appMethod in adapter) {
      throw new ValidationError(
        `package "${alias.package}" operation "${alias.name}": appMethod "${alias.appMethod}" would shadow an existing application key`,
      );
    }
    adapter[alias.appMethod] = (...args) => app.operations.run(alias.name, ...args);
  }

  return adapter;
}

/**
 * @param {import('node:http').Server} server
 * @param {number} port
 * @param {string} host
 */
function listenHttp(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address());
    });
  });
}

/**
 * @param {any} server
 */
async function closeServerIfListening(server) {
  if (!server || server.listening !== true) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Own portable composition, await security/startup/capability verification,
 * then bind HTTP. Default CLI serve remains the synchronous v1 factory.
 *
 * @param {{
 *   selected: any,
 *   dbPath?: string,
 *   busyTimeoutMs?: number,
 *   clock?: () => string,
 *   approvalThresholdCents?: number,
 *   catalogTimeoutMs?: number,
 *   signatureTimeoutMs?: number,
 *   openDatabase?: (options: { path?: string, busyTimeoutMs?: number }) => { storage: any, close: () => void },
 *   providers?: unknown,
 *   port?: number,
 *   host?: string,
 *   listen?: (server: import('node:http').Server, port: number, host: string) => any,
 *   security?: { start?: () => any, close?: () => any },
 *   identityVerifier?: unknown,
 *   authorize?: unknown,
 *   spine?: any,
 * }} [options]
 */
export async function startPortableHttpServer(options = {}) {
  const port = options.port ?? 0;
  const host = options.host ?? '127.0.0.1';
  const listen = options.listen;
  const securityProvider = options.security ?? null;
  /** @type {any} */
  let app;
  /** @type {import('node:http').Server | undefined} */
  let server;
  let listening = false;

  const closeOwned = async () => {
    try {
      await closeServerIfListening(server);
    } finally {
      try {
        if (securityProvider && typeof securityProvider.close === 'function') {
          await securityProvider.close();
        }
      } finally {
        if (app) await app.close();
      }
    }
  };

  try {
    app = await startPortableSqliteApp({
      selected: options.selected,
      dbPath: options.dbPath,
      busyTimeoutMs: options.busyTimeoutMs,
      clock: options.clock,
      approvalThresholdCents: options.approvalThresholdCents,
      catalogTimeoutMs: options.catalogTimeoutMs,
      signatureTimeoutMs: options.signatureTimeoutMs,
      openDatabase: options.openDatabase,
      providers: options.providers,
    });

    if (securityProvider && typeof securityProvider.start === 'function') {
      refuseThenableDomainValue(
        await settleContractValue(securityProvider.start(), 2, 'security start'),
        'security start',
      );
    }

    const identityVerifier = requireFunctionOrNull(
      await assembleMaybeAsync(options.identityVerifier, 'identityVerifier'),
      'identityVerifier',
    );
    const authorize = requireFunctionOrNull(
      await assembleMaybeAsync(options.authorize, 'authorize'),
      'authorize',
    );

    const context = {
      modules: app.modules,
      actor: { type: 'system', id: 'portable-startup' },
      now: app.now,
    };
    await runPackageStartupHooks(options.selected, context);
    await verifyCapabilityContracts(options.selected, context);

    void identityVerifier;
    void authorize;
    const httpApp = createPortableHttpApp(app, {
      spine: options.spine ?? null,
    });
    server = createHttpServer(httpApp);

    if (typeof listen === 'function') {
      await assembleMaybeAsync(listen(server, port, host), 'listen');
      listening = true;
    } else {
      await listenHttp(server, port, host);
      listening = true;
    }
  } catch (error) {
    try {
      await closeOwned();
    } catch (cleanupError) {
      attachCleanupError(error, cleanupError);
    }
    throw error;
  }

  const address = server?.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  let closePromise;
  const close = () => {
    if (!closePromise) {
      closePromise = closeOwned();
    }
    return closePromise;
  };

  return Object.freeze({
    app,
    server,
    host,
    port: actualPort,
    url,
    listening,
    close,
  });
}
