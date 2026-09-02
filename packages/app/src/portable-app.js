// @ts-check

import { startPostgresqlLifecycle, startPostgresqlReaderLifecycle, startSqliteLifecycle } from './async-lifecycle.js';
import { createProductionOperations } from './production-operations.js';
import { AppError } from '../../core/src/errors.js';
import { scheduledAskStorageReady } from '../../core/src/domain-timers.js';
import { assertIdentityTenant, describePortableTenantBinding } from '../../core/src/tenant-binding.js';
import {
  affineStorageFor,
  isSyncStorage,
  runWithAffineStorage,
  storageMany,
  storageMaybeOne,
} from '../../core/src/storage-runtime.js';
import { AuditLog } from '../../core/src/audit.js';
import { EventBus } from '../../core/src/event-bus.js';
import {
  acknowledgeWriteOutcome,
  listUnacknowledgedWriteOutcomes,
  lookupWriteOutcome,
  reconcileWriteOutcome,
} from '../../core/src/write-outcome-runtime.js';
import { ModuleRegistry } from '../../core/src/module-registry.js';
import { CRM_SCHEMA } from '../../core/src/schema.js';
import { createCompanyModule } from '../../modules/company/src/index.js';
import { createContactModule } from '../../modules/contact/src/index.js';
import { createOpportunityModule } from '../../modules/opportunity/src/index.js';
import { createApprovalModule } from '../../modules/approval/src/index.js';
import { PipelineRegistry, pipelineMetadata } from '../../core/src/pipeline-registry.js';
import { PackageRegistry } from '../../core/src/package-registry.js';
import { createOperationRuntime, composePackageOperations } from '../../core/src/operation-runtime.js';
import { NotFoundError, ValidationError } from '../../core/src/errors.js';
import { ActionRegistry, actionMetadata } from '../../core/src/action-registry.js';
import { runRecordAction } from '../../core/src/action-runtime.js';
import { resolveClock } from '../../core/src/time.js';
import { normalizeCompanyName, normalizeEmail } from '../../core/src/core-adapters.js';
import {
  WorkflowEngine,
  decideOpportunityApprovalWorkflow,
  requestOpportunityStageChangeWorkflow,
} from '../../workflows/src/index.js';
import {
  MemoryNotificationProvider,
  ProviderRegistry,
} from '../../providers/src/index.js';

/**
 * Source-private M2E-2B machinery. Not exported from `packages/app/src/index.js`
 * or `packages/core/index.js`. The public async factory composes through this
 * module; the released synchronous factory stays a separate v1 constructor.
 *
 * The portable graph is assembled over 2A's owned storage handle. It is never
 * derived from a constructed v1 application object.
 */

const ACTION_ELIGIBLE_CORE_MODULES = new Set(['opportunity']);

/**
 * Authenticated Admin counts. Uses Storage Contract `kind: 'count'` only.
 *
 * @param {any} database
 */
function countAdminMetrics(database) {
  const statementFor = (table, where) => (where === undefined
    ? { kind: 'count', table }
    : { kind: 'count', table, where });
  const storage = database?.storage;
  if (storage?.sync) {
    const count = (table, where) => Number(storage.sync.maybeOne(statementFor(table, where))?.n ?? 0);
    return Object.freeze({
      companies: count('companies'),
      contacts: count('contacts'),
      opportunities: count('opportunities'),
      pendingApprovals: count('approvals', [{ column: 'status', op: 'eq', value: 'pending' }]),
      workflowRuns: count('workflow_runs'),
      auditEvents: count('audit_events'),
    });
  }
  const count = (table, where) => storageMaybeOne(database, statementFor(table, where), (row) => Number(row?.n ?? 0));
  return Promise.all([
    count('companies'),
    count('contacts'),
    count('opportunities'),
    count('approvals', [{ column: 'status', op: 'eq', value: 'pending' }]),
    count('workflow_runs'),
    count('audit_events'),
  ]).then(([companies, contacts, opportunities, pendingApprovals, workflowRuns, auditEvents]) => Object.freeze({
    companies, contacts, opportunities, pendingApprovals, workflowRuns, auditEvents,
  }));
}

/**
 * Close over selected methods so the inner object (and any `database` field it
 * holds) is not an own property of the returned facade.
 *
 * @param {any} object
 * @param {string[]} methodNames
 */
function closeOver(object, methodNames) {
  /** @type {Record<string, Function>} */
  const facade = {};
  for (const name of methodNames) {
    const method = object[name];
    if (typeof method !== 'function') {
      throw new ValidationError(`portable facade cannot close over missing method "${name}"`);
    }
    facade[name] = (...args) => method.apply(object, args);
  }
  return Object.freeze(facade);
}

/**
 * Public prototype methods only. Instance fields such as `database` stay off
 * the facade; they remain on the inner object the methods close over.
 *
 * @param {object} object
 */
function prototypeFunctionNames(object) {
  /** @type {string[]} */
  const names = [];
  let cursor = Object.getPrototypeOf(object);
  while (cursor && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name === 'constructor' || names.includes(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor && typeof descriptor.value === 'function') names.push(name);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return names;
}

/** @param {any} service */
function portableService(service) {
  return closeOver(service, prototypeFunctionNames(service));
}

/**
 * Storage-contract adapters. The v1 `createCoreAdapters` reads through
 * `database.storage.sync`; this portable copy uses the owned `storage.sync`
 * handle. Neither path reaches the SQLite driver.
 *
 * @param {{database: any, services: {companies: any, contacts: any, opportunities: any}, pipelines?: {forModule: (name: string) => any}}} deps
 */
function createPortableCoreAdapters({ database, services, pipelines }) {
  for (const name of ['companies', 'contacts', 'opportunities']) {
    if (!services[name] || typeof services[name].create !== 'function') {
      throw new ValidationError(`Core adapters need the ${name} service`);
    }
  }
  return Object.freeze({
    findCompaniesByNormalizedName(name) {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new ValidationError('companyName is required to match a company', { field: 'companyName' });
      }
      const wanted = normalizeCompanyName(name);
      const mapRows = (rows) => rows
        .filter((row) => normalizeCompanyName(String(row.name)) === wanted)
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          domain: row.domain === null || row.domain === undefined ? null : String(row.domain),
        }));
      return storageMany(database, {
        kind: 'select',
        table: 'companies',
        columns: ['id', 'name', 'domain', 'created_at'],
        orderBy: [
          { column: 'created_at', direction: 'asc' },
          { column: 'id', direction: 'asc' },
        ],
      }, mapRows);
    },
    findContactByEmail(email) {
      if (typeof email !== 'string' || email.trim() === '') {
        throw new ValidationError('email is required to match a contact', { field: 'email' });
      }
      return storageMaybeOne(database, {
        kind: 'select',
        table: 'contacts',
        columns: ['id', 'company_id', 'email'],
        where: [{ column: 'email', op: 'eq', value: normalizeEmail(email) }],
      }, (row) => (row
        ? { id: String(row.id), companyId: String(row.company_id), email: String(row.email) }
        : null));
    },
    createCompany(input, context) {
      return services.companies.create(input, context);
    },
    createContact(input, context) {
      return services.contacts.create(input, context);
    },
    createOpportunity(input, context) {
      return services.opportunities.create(input, context);
    },
    async enterOpportunityPipeline(opportunityId, context = {}) {
      const pipeline = pipelines && typeof pipelines.forModule === 'function'
        ? pipelines.forModule('opportunity')
        : null;
      if (!pipeline) return null;
      const enteredAt = typeof context.now === 'function' ? context.now() : new Date().toISOString();
      await services.opportunities.applyManaged(
        opportunityId,
        { pipelineKey: pipeline.name, pipelineStage: pipeline.defaultStage, stageEnteredAt: enteredAt },
        { actor: context.actor },
      );
      return { pipeline: pipeline.name, stage: pipeline.defaultStage };
    },
  });
}

/**
 * @param {{
 *   accepted: { packageContract: number, packages: readonly any[], actions: readonly any[], modules: readonly string[] },
 *   storage: any,
 *   options?: Record<string, any>,
 * }} input
 */
/** Test-only mapping from a loopback app facade to its data-plane storage. */
const POSTGRES_TEST_STORAGE = new WeakMap();

/**
 * @param {object} app
 */
export function postgresqlTestStorage(app) {
  return POSTGRES_TEST_STORAGE.get(app) ?? null;
}

async function assemblePortableGraph({ accepted, storage, options = {} }) {
  const now = resolveClock(options.clock);
  const handle = {
    storage,
    tenantId: options.tenantId ?? null,
    /**
     * Action/workflow runtimes call `database.transactionAsync`. 2A owns the
     * connection-affine wrapper on the storage handle; this forwards that
     * identity rather than reconstructing a pool-level facade.
     * @param {() => any} fn
     */
    transactionAsync(fn) {
      if (isSyncStorage(handle)) {
        return handle.storage.sync.savepoint('tx', () => fn(handle.storage.sync));
      }
      const current = affineStorageFor(handle);
      if (current && typeof current.savepoint === 'function') {
        return current.savepoint('nested_tx', () => fn(current));
      }
      return handle.storage.transaction(async (tx) => {
        // Publish the affine client in request-local storage. Never assign it
        // onto the shared handle: overlapping HTTP requests must keep seeing
        // the pool (PostgreSQL) or the outer SQLite contract handle.
        return runWithAffineStorage(handle, tx, () => fn(tx));
      });
    },
  };

  const events = new EventBus();
  const audit = new AuditLog(handle);
  const modules = new ModuleRegistry();
  const providers = new ProviderRegistry();

  const companyModule = createCompanyModule({ database: handle, audit, events });
  modules.register(companyModule);

  const contactModule = createContactModule({
    database: handle,
    audit,
    events,
    companies: companyModule.service,
  });
  modules.register(contactModule);

  const opportunityModule = createOpportunityModule({
    database: handle,
    audit,
    events,
    companies: companyModule.service,
    contacts: contactModule.service,
  });
  modules.register(opportunityModule);

  const approvalModule = createApprovalModule({
    database: handle,
    audit,
    events,
    opportunities: opportunityModule.service,
  });
  modules.register(approvalModule);

  const selectedModules = new Set(accepted.modules);
  const actionModuleExists = (name) => ACTION_ELIGIBLE_CORE_MODULES.has(name) || selectedModules.has(name);
  const actions = new ActionRegistry({ moduleExists: actionModuleExists });
  for (const definition of accepted.actions) actions.register(definition);

  const pipelines = new PipelineRegistry({
    moduleExists: (name) => ACTION_ELIGIBLE_CORE_MODULES.has(name),
  });

  const domains = new PackageRegistry({ packages: [...accepted.packages] });
  await domains.persistFingerprints(handle);
  for (const pkg of accepted.packages) {
    if (typeof pkg.persistFingerprints === 'function') {
      await pkg.persistFingerprints(handle);
    }
  }
  for (const definition of domains.actions()) actions.register(definition);

  const notificationProvider = new MemoryNotificationProvider();
  providers.register({
    name: 'default-notifications',
    kind: 'notification',
    provider: notificationProvider,
  });

  const services = {
    companies: companyModule.service,
    contacts: contactModule.service,
    opportunities: opportunityModule.service,
    approvals: approvalModule.service,
  };

  const coreAdapters = createPortableCoreAdapters({ database: handle, services, pipelines });
  const approvalThresholdCents =
    options.approvalThresholdCents
    ?? Number(process.env.APPROVAL_THRESHOLD_CENTS ?? 5_000_000);
  const config = Object.freeze({
    approvalThresholdCents,
    externalTimeoutMs: options.signatureTimeoutMs,
  });

  const operationRuntime = createOperationRuntime({
    database: handle,
    modules,
    events,
    config: {
      catalogTimeoutMs: options.catalogTimeoutMs,
      signatureTimeoutMs: options.signatureTimeoutMs,
    },
    core: coreAdapters,
  });
  const { aliases: operationAliases } = composePackageOperations({
    registry: domains,
    runtime: operationRuntime,
  });

  const workflows = new WorkflowEngine({
    database: handle,
    services,
    events,
    config: { approvalThresholdCents },
  });
  workflows.register(requestOpportunityStageChangeWorkflow);
  workflows.register(decideOpportunityApprovalWorkflow);

  events.subscribe('approval.requested', async ({ payload }) => {
    await notificationProvider.send({
      recipient: 'sales-manager',
      subject: `Approval required: ${payload.opportunityId}`,
      body: payload.reason,
    });
  });

  const operationsByName = new Map(operationAliases.map((alias) => [alias.name, alias]));

  return {
    packageContract: accepted.packageContract,
    services: Object.freeze({
      companies: portableService(companyModule.service),
      contacts: portableService(contactModule.service),
      opportunities: portableService(opportunityModule.service),
      approvals: portableService(approvalModule.service),
    }),
    modules: Object.freeze({
      get(name) {
        const module = modules.get(name);
        return Object.freeze({
          name: module.name,
          version: module.version,
          description: module.description,
          entities: module.entities,
          service: portableService(module.service),
        });
      },
      list: () => modules.list(),
      schema: () => modules.schema(),
    }),
    actions: Object.freeze({
      get(module, name) {
        return actionMetadata(actions.get(module, name));
      },
      listForModule: (module) => actions.listForModule(module),
    }),
    operations: Object.freeze({
      list() {
        return operationAliases.map((alias) => Object.freeze({
          name: alias.name,
          package: alias.package,
          ...(alias.appMethod ? { appMethod: alias.appMethod } : {}),
        }));
      },
      async run(name, ...args) {
        const alias = operationsByName.get(name);
        if (!alias) throw new NotFoundError('Operation', String(name));
        return alias.fn(...args);
      },
    }),
    pipelines: Object.freeze({
      get(name) {
        return pipelineMetadata(pipelines.get(name));
      },
      forModule(module) {
        const pipeline = pipelines.forModule(module);
        return pipeline ? pipelineMetadata(pipeline) : null;
      },
      list: () => pipelines.list(),
    }),
    domains: Object.freeze({
      get: (name) => domains.get(name),
      has: (name) => domains.has(name),
      names: () => domains.names(),
      resources: () => domains.resources(),
      metadata: () => domains.metadata(),
      report: () => domains.report(),
      capability: (request) => domains.capability(request),
    }),
    workflows: closeOver(workflows, ['run', 'list', 'listRuns', 'getRun']),
    audit: closeOver(audit, ['record', 'list']),
    events: closeOver(events, ['subscribe', 'emit', 'buffered']),
    providers: Object.freeze({
      get(name) {
        const provider = providers.get(name);
        return closeOver(provider, prototypeFunctionNames(provider));
      },
      list: () => providers.list(),
    }),
    notifications: closeOver(notificationProvider, ['send', 'list']),
    runAction(params) {
      const { module, action, recordId, input, actor } = params;
      if (options.boundTenantId) {
        try {
          assertIdentityTenant(params.identity, options.boundTenantId);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      return runRecordAction({
        database: handle,
        events,
        registry: actions,
        modules,
        services,
        core: coreAdapters,
        pipelines,
        domains,
        now,
        config,
        module,
        action,
        recordId,
        input,
        actor,
        spine: null,
        identity: params.identity,
        organizationId: params.organizationId,
        tenantId: params.tenantId ?? options.tenantId ?? handle.tenantId,
        idempotencyKey: params.idempotencyKey,
        provider: params.provider,
      });
    },
    reconcileWrite(params) {
      return reconcileWriteOutcome(handle, events, {
        tenantId: params.tenantId ?? options.tenantId ?? handle.tenantId,
        idempotencyKey: params.idempotencyKey,
        identity: params.identity,
        actor: params.actor,
        operation: params.operation,
        target: params.target ?? '',
        contractVersion: params.contractVersion ?? 'write.v1',
        input: params.input,
        phase: params.phase ?? 'root',
      });
    },
    lookupWrite(params) {
      return lookupWriteOutcome(handle, {
        tenantId: params.tenantId ?? options.tenantId ?? handle.tenantId,
        idempotencyKey: params.idempotencyKey,
        identity: params.identity,
        actor: params.actor,
        phase: params.phase ?? 'root',
      });
    },
    listUnacknowledgedWrites(params = {}) {
      return listUnacknowledgedWriteOutcomes(handle, {
        tenantId: params.tenantId ?? options.tenantId ?? handle.tenantId,
        identity: params.identity,
        actor: params.actor,
      });
    },
    acknowledgeWrite(params) {
      return acknowledgeWriteOutcome(handle, events, {
        tenantId: params.tenantId ?? options.tenantId ?? handle.tenantId,
        idempotencyKey: params.idempotencyKey,
        identity: params.identity,
        actor: params.actor,
      });
    },
    now,
    schema: CRM_SCHEMA,
    config,
    health() {
      if (typeof options.health === 'function') return options.health();
      const adapter = storage?.sync ? 'sqlite' : 'postgresql';
      const descriptor = Object.freeze({ adapter, available: true });
      return Object.freeze({
        ok: true,
        ready: descriptor.available === true,
        storage: descriptor,
      });
    },
    metrics() {
      return countAdminMetrics(handle);
    },
  };
}

/**
 * Three keys are the factory's to supply and nobody else's: the transaction
 * seam, which no facade publishes, the adapter, which the caller does not
 * choose here, and — on PostgreSQL — the bound tenant. A composition that
 * passes one of them has misunderstood who owns the boundary, so it is refused
 * rather than silently overridden.
 *
 * On SQLite there is no bound tenant to inherit, so the caller names it. That
 * asymmetry is the tenant-binding difference itself, not an inconsistency.
 */
async function composeProductionOperations(database, graph, requested, adapter, boundTenantId, telemetry) {
  if (requested === undefined || requested === null) return null;
  if (typeof requested !== 'object' || Array.isArray(requested)) {
    throw new AppError('productionOperations must be a plain object', {
      code: 'PRODUCTION_OPERATIONS_INVALID', status: 500,
    });
  }
  const owned = boundTenantId === undefined
    ? ['database', 'adapter', 'telemetry', 'domains', 'modules']
    : ['database', 'adapter', 'tenantId', 'telemetry', 'domains', 'modules'];
  for (const key of owned) {
    if (key in requested) {
      throw new AppError(`productionOperations may not supply "${key}": the application factory owns it`, {
        code: 'PRODUCTION_OPERATIONS_INVALID', status: 500,
      });
    }
  }
  const operations = createProductionOperations({
    ...requested,
    database,
    adapter,
    domains: graph.domains,
    modules: graph.modules,
    ...(boundTenantId === undefined ? {} : { tenantId: boundTenantId }),
    ...(telemetry === undefined ? {} : { telemetry }),
  });
  if (requested.timers !== undefined && requested.timers !== false) {
    const tenantId = boundTenantId ?? requested.tenantId;
    const migration = adapter === 'postgresql'
      ? "moduleMigrations: [scheduledAskMigration({ dialect: 'postgresql' })]"
      : 'moduleMigrations: [SCHEDULED_ASK_MIGRATION]';
    const readiness = await scheduledAskStorageReady(database, tenantId);
    if (readiness === 'missing') {
      throw new AppError(
        `scheduled asks need their table: pass ${migration}`,
        { code: 'SCHEDULED_ASK_STORAGE_MISSING', status: 500 },
      );
    }
    if (readiness === 'unreadable') {
      // Named rather than guessed. The PostgreSQL adapter reports a missing
      // relation and an unreachable database with the same words, so this
      // refuses with both possibilities stated instead of sending a reader to
      // apply a migration while their database is down.
      throw new AppError(
        'the scheduled-ask table could not be read, and this adapter does not distinguish a missing '
          + `table from an unreachable database. Check both: the migration is ${migration}`,
        { code: 'SCHEDULED_ASK_STORAGE_UNREADABLE', status: 500 },
      );
    }
  }
  return operations;
}

/**
 * Close operations before the storage they poll. A worker that outlives its
 * database is the one lifecycle bug this composition can actually introduce,
 * and the drain is bounded, so shutdown stays bounded too.
 *
 * Declared, because silence here would be the dishonest half: closing the
 * application drains best effort and discards the drain report, so a
 * `DURABLE_JOB_DRAIN_TIMEOUT` at shutdown is not surfaced. An application that
 * needs to see it calls `drain()` or `stop()` itself and reads the result.
 */
function closingOperations(operations, close) {
  if (!operations) return close;
  let promise;
  return () => {
    if (!promise) {
      promise = operations.stop().catch(() => undefined).then(() => close());
    }
    return promise;
  };
}

/**
 * Own one SQLite lifecycle, assemble the portable graph over its storage
 * handle, and return a frozen lexical-allowlist facade.
 *
 * @param {{
 *   selected: any,
 *   dbPath?: string,
 *   busyTimeoutMs?: number,
 *   clock?: () => string,
 *   approvalThresholdCents?: number,
 *   catalogTimeoutMs?: number,
 *   signatureTimeoutMs?: number,
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   openDatabase?: (options: { path?: string, busyTimeoutMs?: number }) => { storage: any, close: () => void },
 *   providers?: unknown,
 *   listen?: unknown,
 *   telemetry?: unknown,
 *   productionOperations?: object,
 * }} [options]
 */
export async function startPortableSqliteApp(options = {}) {
  /** The adapter's own handle, captured from the assembly context. */
  let database;
  // On SQLite the composed operations are the only telemetry producers there
  // are — the writer-readiness observer belongs to the PostgreSQL bootstrap. A
  // sink passed without them would emit nothing and read as a claim that
  // telemetry is on, so it is refused instead.
  if (options.telemetry !== undefined && options.productionOperations === undefined) {
    throw new AppError(
      'telemetry on SQLite reaches nobody without composed production operations',
      { code: 'PRODUCTION_OPERATIONS_TELEMETRY_UNREACHABLE', status: 500 },
    );
  }
  const lifecycle = await startSqliteLifecycle({
    selected: options.selected,
    dbPath: options.dbPath,
    busyTimeoutMs: options.busyTimeoutMs,
    moduleMigrations: options.moduleMigrations,
    openDatabase: options.openDatabase,
    providers: options.providers,
    listen: options.listen,
    assemble: ({ accepted, storage, database: opened }) => {
      database = opened;
      return assemblePortableGraph({ accepted, storage, options });
    },
  });
  const graph = lifecycle.assembled;
  const operations = await composeProductionOperations(
    database, graph, options.productionOperations, 'sqlite', undefined, options.telemetry,
  );
  return Object.freeze({
    storage: Object.freeze({ adapter: 'sqlite', available: true }),
    packageContract: graph.packageContract,
    health: graph.health,
    metrics: graph.metrics,
    services: graph.services,
    modules: graph.modules,
    actions: graph.actions,
    operations: graph.operations,
    pipelines: graph.pipelines,
    domains: graph.domains,
    workflows: graph.workflows,
    audit: graph.audit,
    events: graph.events,
    providers: graph.providers,
    notifications: graph.notifications,
    runAction: graph.runAction,
    reconcileWrite: graph.reconcileWrite,
    lookupWrite: graph.lookupWrite,
    listUnacknowledgedWrites: graph.listUnacknowledgedWrites,
    acknowledgeWrite: graph.acknowledgeWrite,
    now: graph.now,
    schema: graph.schema,
    config: graph.config,
    // Absent unless composed. An application that asks for no operations gets a
    // facade indistinguishable from the one it got before this slice existed.
    ...(operations ? { productionOperations: operations } : {}),
    close: closingOperations(operations, lifecycle.close),
  });
}

/**
 * Own one PostgreSQL lifecycle and assemble the portable graph over its data
 * plane. Connection locators never appear on the returned facade.
 *
 * @param {{
 *   selected: any,
 *   tenantId: string,
 *   identityVerifier: { operations: any },
 *   control: object,
 *   data: object,
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   clock?: () => string,
 *   approvalThresholdCents?: number,
 *   catalogTimeoutMs?: number,
 *   signatureTimeoutMs?: number,
 *   listenMode?: string,
 *   faultInject?: string,
 *   now?: () => number,
 *   leaseTtlMs?: number,
 *   queryDeadlineMs?: number,
 *   acquisitionDeadlineMs?: number,
 *   rebind?: unknown,
 *   promoteClone?: unknown,
 *   telemetry?: unknown,
 *   productionOperations?: object,
 * }} options
 */
export async function startPortablePostgresqlApp(options) {
  /** The adapter's own handle, captured from the assembly context. */
  let database;
  const lifecycle = await startPostgresqlLifecycle({
    selected: options.selected,
    tenantId: options.tenantId,
    identityVerifier: options.identityVerifier,
    control: options.control,
    data: options.data,
    moduleMigrations: options.moduleMigrations,
    clock: options.clock,
    faultInject: options.faultInject,
    now: options.now,
    leaseTtlMs: options.leaseTtlMs,
    queryDeadlineMs: options.queryDeadlineMs,
    acquisitionDeadlineMs: options.acquisitionDeadlineMs,
    rebind: options.rebind,
    promoteClone: options.promoteClone,
    telemetry: options.telemetry,
    assemble: ({ accepted, storage, bootstrap, handle }) => {
      database = handle;
      return assemblePortableGraph({
        accepted,
        storage,
        options: {
          ...options,
          boundTenantId: options.tenantId,
          health: () => bootstrap.health(),
        },
      });
    },
  });
  const graph = lifecycle.assembled;
  const operations = await composeProductionOperations(
    database,
    graph,
    options.productionOperations,
    'postgresql',
    options.tenantId,
    options.telemetry,
  );
  const facade = Object.freeze({
    storage: Object.freeze({ adapter: 'postgresql', available: true }),
    listenMode: options.listenMode ?? 'local-development',
    tenantBinding: describePortableTenantBinding({
      adapter: 'postgresql',
      tenantBound: true,
      controlPlaneAdapter: 'postgresql',
      dataPlaneIsolation: 'dedicated_database',
    }),
    packageContract: graph.packageContract,
    health: graph.health,
    metrics: graph.metrics,
    services: graph.services,
    modules: graph.modules,
    actions: graph.actions,
    operations: graph.operations,
    pipelines: graph.pipelines,
    domains: graph.domains,
    workflows: graph.workflows,
    audit: graph.audit,
    events: graph.events,
    providers: graph.providers,
    notifications: graph.notifications,
    runAction: graph.runAction,
    reconcileWrite: graph.reconcileWrite,
    lookupWrite: graph.lookupWrite,
    listUnacknowledgedWrites: graph.listUnacknowledgedWrites,
    acknowledgeWrite: graph.acknowledgeWrite,
    now: graph.now,
    schema: graph.schema,
    config: graph.config,
    ...(operations ? { productionOperations: operations } : {}),
    // The writer lease has a TTL and renewing it is the application's job, so
    // the application has to be able to reach the renewer. It is inert until
    // started; a composition that ignores it behaves exactly as it did before
    // this existed — and stops being able to read one TTL later, which is the
    // defect, not this key.
    ...(lifecycle.bootstrap?.leaseRenewer ? { leaseRenewer: lifecycle.bootstrap.leaseRenewer } : {}),
    close: closingOperations(operations, lifecycle.close),
  });
  if (lifecycle.bootstrap?.dataStorage) {
    POSTGRES_TEST_STORAGE.set(facade, lifecycle.bootstrap.dataStorage);
  }
  return facade;
}

/**
 * Own one PostgreSQL data plane opened for reading, and assemble the portable
 * graph over it.
 *
 * The owner's constraints are two different sentences and they get two
 * different treatments, because collapsing them would produce a worse facade.
 *
 * *Expose no write capability* → the keys that are purely write capability are
 * **omitted**: `leaseRenewer` (there is no lease to renew), `productionOperations`
 * (workers are the thing that must not start), `reconcileWrite` and
 * `acknowledgeWrite` (both write). A key that is absent cannot be called by
 * mistake.
 *
 * *Refuse every mutation* → `runAction` is present and **refuses**, typed. It
 * is the entry point every application shape has and the one a caller reaches
 * for first; a missing key there would produce a `TypeError` at the call site,
 * which is an accident rather than a boundary.
 *
 * Module services keep their write methods. That is deliberate: the storage
 * seam refuses before rendering a statement, so `services.companies.create()`
 * fails with `STORAGE_READ_ONLY` and no SQL. Two layers, and the second is
 * where the property actually lives.
 *
 * @param {{
 *   selected: any,
 *   tenantId: string,
 *   data: object,
 *   pinnedBindingUuid?: string,
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   clock?: () => string,
 *   approvalThresholdCents?: number,
 *   catalogTimeoutMs?: number,
 *   signatureTimeoutMs?: number,
 *   listenMode?: string,
 *   queryDeadlineMs?: number,
 *   acquisitionDeadlineMs?: number,
 * }} options
 */
export async function startPortablePostgresqlReaderApp(options) {
  const lifecycle = await startPostgresqlReaderLifecycle({
    selected: options.selected,
    tenantId: options.tenantId,
    data: options.data,
    pinnedBindingUuid: options.pinnedBindingUuid,
    moduleMigrations: options.moduleMigrations,
    queryDeadlineMs: options.queryDeadlineMs,
    acquisitionDeadlineMs: options.acquisitionDeadlineMs,
    assemble: ({ accepted, storage, bootstrap }) => assemblePortableGraph({
      accepted,
      storage,
      options: {
        ...options,
        boundTenantId: options.tenantId,
        health: () => bootstrap.health(),
      },
    }),
  });
  const graph = lifecycle.assembled;
  const refuseMutation = (surface) => {
    throw new AppError(
      `this application is composed read-only, so "${surface}" is refused`,
      { code: 'READ_ONLY_COMPOSITION', status: 403, details: { surface } },
    );
  };
  return Object.freeze({
    storage: Object.freeze({ adapter: 'postgresql', available: true, mode: 'read-only' }),
    listenMode: options.listenMode ?? 'local-development',
    tenantBinding: describePortableTenantBinding({
      adapter: 'postgresql',
      tenantBound: true,
      controlPlaneAdapter: 'postgresql',
      dataPlaneIsolation: 'dedicated_database',
    }),
    packageContract: graph.packageContract,
    health: graph.health,
    metrics: graph.metrics,
    services: graph.services,
    modules: graph.modules,
    actions: graph.actions,
    operations: graph.operations,
    pipelines: graph.pipelines,
    domains: graph.domains,
    workflows: graph.workflows,
    audit: graph.audit,
    events: graph.events,
    providers: graph.providers,
    notifications: graph.notifications,
    // Present and refusing, not absent. See the note above.
    runAction: () => refuseMutation('runAction'),
    // A read of the write-outcome ledger is still a read.
    lookupWrite: graph.lookupWrite,
    listUnacknowledgedWrites: graph.listUnacknowledgedWrites,
    now: graph.now,
    schema: graph.schema,
    config: graph.config,
    close: lifecycle.close,
  });
}
