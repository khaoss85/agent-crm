// @ts-check

/**
 * Spine production operations — a composition, not a runtime.
 *
 * Six contracts already exist and are already public: the durable job store,
 * registry and worker (v3A), the transactional outbox (v3B), scheduled asks
 * (v3C), the secret provider (v4A), backup/verify/restore (v4B) and the
 * telemetry sink (v4C). Not one line of scheduling, leasing, retrying or
 * dispatching is written here. This module answers the one question none of
 * the six answers alone: *who holds them together, and who starts them.*
 *
 * The answer, in this framework, is never "the framework". Three documents
 * forbid autostart and v3C's whole design rests on it, so:
 *
 * - constructing this handle starts nothing, claims no work and arms no timer,
 *   exactly as `createDurableJobWorker` already behaves one level down;
 * - the composing application supplies the actor, and it must carry system
 *   authority: a worker executes on the framework's behalf. The application
 *   claims that authority itself, through the public `trustedSystemActor`, for
 *   a reason it states. The framework's own inventory of places it claims root
 *   does not grow because an application decided to run a worker, and this
 *   module deliberately adds no call site to it;
 * - `start()` is the only thing that makes anything run.
 *
 * The property this buys, which the suite pins on both adapters: an application
 * that composes operations and never starts them behaves identically to one
 * that never composed them. That is v3C's "nothing runs on a clock", one level
 * up, and it is the first time an application factory knows workers exist.
 *
 * One registry, one store, one worker, three handler families. That the outbox
 * and the timers both register into a registry a caller owns is not a
 * coincidence to exploit — it is the seam those two slices were built with, and
 * it is why this file composes instead of inventing.
 */

import { AppError } from '../../core/src/errors.js';
import {
  DURABLE_JOB_STATES,
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../../core/src/durable-jobs.js';
import { registerTransactionalOutboxHandlers } from '../../core/src/transactional-outbox.js';
import {
  cancelScheduledAsk,
  readScheduledAsk,
  registerScheduledAskHandlers,
  rescheduleAsk,
  scheduleAsk,
} from '../../core/src/domain-timers.js';
import { createBackupOperations } from '../../core/src/backup-restore.js';
import { requireTelemetrySink } from '../../core/src/observability-export.js';

/** Bumped when the shape below stops being a superset of the previous one. */
export const PRODUCTION_OPERATIONS_CONTRACT = 1;

/** Default ceiling for a backlog read. `store.list` refuses above 500. */
const DEFAULT_BACKLOG_LIMIT = 100;

function refuse(code, message) {
  throw new AppError(message, { code, status: 500 });
}

/**
 * Closed option lists, the same discipline the six contracts use: an
 * unsupported key is a misunderstanding about what was composed, and it fails
 * where the wiring was written rather than at the first poll.
 */
function closedObject(value, allowed, required, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse('PRODUCTION_OPERATIONS_INVALID', `${label} must be a plain object`);
  }
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    refuse('PRODUCTION_OPERATIONS_INVALID', `${label} contain unsupported field "${unknown}"`);
  }
  for (const key of required) {
    if (value[key] === undefined || value[key] === null) {
      refuse('PRODUCTION_OPERATIONS_INVALID', `${label} require "${key}"`);
    }
  }
  return value;
}

function optionalSection(value, allowed, required, label) {
  if (value === undefined || value === false) return null;
  if (value === true) {
    if (required.length > 0) {
      refuse('PRODUCTION_OPERATIONS_INVALID', `${label} require ${required.map((k) => `"${k}"`).join(', ')}`);
    }
    return {};
  }
  return closedObject(value, allowed, required, label);
}

/**
 * Compose the production operations of one application over one tenant.
 *
 * @param {{
 *   database: { storage: any, transactionAsync: (fn: () => Promise<any>) => Promise<any> },
 *   tenantId: string,
 *   actor: any,
 *   adapter: 'sqlite' | 'postgresql',
 *   domains?: any,
 *   modules?: any,
 *   clock?: () => string,
 *   telemetry?: any,
 *   jobs?: true | { workerId?: string, pollIntervalMs?: number, leaseMs?: number, backoff?: any },
 *   outbox?: { events: any, resolveExternalFinalize?: any },
 *   timers?: true,
 *   backup?: object,
 * }} options
 */
export function createProductionOperations(options) {
  closedObject(
    options,
    ['database', 'tenantId', 'actor', 'adapter', 'domains', 'modules', 'clock', 'telemetry', 'jobs', 'outbox', 'timers', 'backup'],
    ['database', 'tenantId', 'actor', 'adapter'],
    'Production-operations options',
  );

  const { database, tenantId, actor, adapter } = options;
  const clock = options.clock;

  // The same seam the four core producers use. A misconfigured sink fails here,
  // not at the first signal nobody receives.
  const telemetry = requireTelemetrySink(
    options.telemetry,
    (message) => refuse('PRODUCTION_OPERATIONS_TELEMETRY_INVALID', message),
  );

  const jobs = optionalSection(options.jobs, ['workerId', 'pollIntervalMs', 'leaseMs', 'backoff'], [], 'Production-operations jobs options');
  const outbox = optionalSection(options.outbox, ['events', 'resolveExternalFinalize'], ['events'], 'Production-operations outbox options');
  const timers = optionalSection(options.timers, [], [], 'Production-operations timers options');
  const backupConfiguration = options.backup ?? null;

  // A worker with an empty registry is a poll loop that can never do anything.
  // Refusing is the honest answer: it says the composition is incomplete rather
  // than running something that looks alive and is not.
  if (!outbox && !timers) {
    refuse(
      'PRODUCTION_OPERATIONS_EMPTY',
      'production operations compose at least one handler family: pass outbox, timers, or both',
    );
  }

  const registry = createDurableJobHandlerRegistry();
  if (outbox) {
    registerTransactionalOutboxHandlers(registry, {
      database,
      events: outbox.events,
      tenantId,
      resolveExternalFinalize: outbox.resolveExternalFinalize,
      telemetry,
    });
  }
  if (timers) {
    // The ask is presented through the application's own package registry, so a
    // timer can only reach a capability the consumer already declared. Both come
    // from the assembled graph: this is where the composition stops being a
    // wiring diagram and starts being the application's own domains.
    if (!options.domains) {
      refuse('PRODUCTION_OPERATIONS_INVALID', 'composed timers need the application package registry');
    }
    registerScheduledAskHandlers(registry, {
      database,
      tenantId,
      domains: options.domains,
      modules: options.modules ?? { get: () => null },
      ...(clock ? { clock } : {}),
    });
  }

  const store = createDurableJobStore({ storage: database.storage, tenantId, ...(clock ? { clock } : {}) });

  const worker = createDurableJobWorker({
    store,
    registry,
    workerId: jobs?.workerId ?? 'production-operations',
    actor,
    ...(clock ? { clock } : {}),
    ...(jobs?.pollIntervalMs !== undefined ? { pollIntervalMs: jobs.pollIntervalMs } : {}),
    ...(jobs?.leaseMs !== undefined ? { leaseMs: jobs.leaseMs } : {}),
    ...(jobs?.backoff !== undefined ? { backoff: jobs.backoff } : {}),
    ...(telemetry ? { telemetry } : {}),
  });

  // Backup is configuration-heavy and entirely optional: an application without
  // a backup provider composed has no backup capability, and says so.
  const backup = backupConfiguration
    ? createBackupOperations({ ...backupConfiguration, ...(telemetry ? { telemetry } : {}) })
    : null;

  /**
   * The timer contract, bound to the database this handle composed over.
   *
   * Without this an application that composes timers cannot schedule one: every
   * entry point wants the transaction seam, and no facade publishes it. Binding
   * the contract's own functions is the composition; the actor stays per call,
   * because v3C refuses an agent the decision to schedule and that refusal must
   * keep reaching the caller who made it.
   */
  const timerContext = (actor_) => ({
    database, tenantId, actor: actor_, ...(clock ? { now: clock } : {}),
  });
  const timerSurface = timers
    ? Object.freeze({
      schedule: (requester, request) => scheduleAsk(timerContext(requester), request),
      cancel: (requester, id) => cancelScheduledAsk(timerContext(requester), id),
      reschedule: (requester, id, scheduledFor) => rescheduleAsk(timerContext(requester), id, scheduledFor),
      read: (id) => readScheduledAsk(database, tenantId, id),
    })
    : null;

  let started = false;
  let stopped = false;

  /**
   * Bounded backlog, by state, with no identifier and no payload leaving the
   * store. It inherits v4C's exclusion wholesale: enums, booleans and counts.
   * `capped` is the honest half — a backlog longer than the limit is reported
   * as capped rather than as its first page pretending to be a total.
   */
  async function backlog(limit) {
    const counts = Object.fromEntries(DURABLE_JOB_STATES.map((state) => [state, 0]));
    const rows = await store.list(limit);
    for (const row of rows) {
      if (Object.hasOwn(counts, row.state)) counts[row.state] += 1;
    }
    return Object.freeze({ ...counts, limit, capped: rows.length >= limit });
  }

  return Object.freeze({
    contract: PRODUCTION_OPERATIONS_CONTRACT,

    /** The composed store, so an application can enqueue and inspect its jobs. */
    jobs: store,
    /** The scheduled-ask contract bound to this database, or null. */
    timers: timerSurface,
    /** Composed backup operations, or null when none was configured. */
    backup,

    start() {
      if (stopped) {
        refuse('PRODUCTION_OPERATIONS_STOPPED', 'production operations were stopped and do not restart');
      }
      worker.start();
      started = true;
    },

    /**
     * Finish what is in flight and stop accepting. Bounded by construction: the
     * worker returns `DURABLE_JOB_DRAIN_TIMEOUT` rather than waiting forever,
     * and this reports it verbatim. A drained handle can be started again.
     */
    async drain(input = {}) {
      closedObject(input, ['timeoutMs'], [], 'Production-operations drain options');
      const drained = await worker.drain(input);
      started = false;
      return drained;
    },

    /** Terminal. Same bound as `drain`, and nothing restarts afterwards. */
    async stop(input = {}) {
      closedObject(input, ['timeoutMs'], [], 'Production-operations stop options');
      const drained = await worker.close(input);
      started = false;
      stopped = true;
      return drained;
    },

    /**
     * The bounded operational posture, which is what a deployment receipt and a
     * future control plane read. No tenant id, no job id, no fingerprint, no
     * caller-controlled text — v4C settled that exclusion and this inherits it.
     */
    async status(input = {}) {
      closedObject(input, ['backlogLimit'], [], 'Production-operations status options');
      const limit = input.backlogLimit ?? DEFAULT_BACKLOG_LIMIT;
      const workerStatus = worker.status();
      return Object.freeze({
        contract: PRODUCTION_OPERATIONS_CONTRACT,
        storage: Object.freeze({ adapter, available: true }),
        started,
        stopped,
        worker: Object.freeze({
          accepting: workerStatus.accepting,
          closed: workerStatus.closed,
          polling: workerStatus.polling,
          inFlight: workerStatus.inFlight,
          lastErrorCode: workerStatus.lastWorkerErrorCode ?? null,
        }),
        composed: Object.freeze({
          outbox: outbox !== null,
          timers: timers !== null,
          backup: backup !== null,
          telemetry: telemetry !== null,
        }),
        backlog: await backlog(limit),
      });
    },
  });
}
