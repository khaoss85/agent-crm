// @ts-check

/**
 * Test-only harness for the channels package (backlog:e5532d1c9146).
 *
 * Real sqlite (`:memory:`), real module services built from the shipped
 * manifests, the real durable-job store and the real worker — the only
 * doubles are the channel adapter itself and the secret resolver, which is
 * exactly what the kit is for. Deep `packages/core/src` imports are the
 * same ones the repository's own contract tests use; shipped package code
 * never touches them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AuditLog } from '../../packages/core/src/audit.js';
import { createDatabase } from '../../packages/core/src/database.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../../packages/core/src/durable-jobs.js';
import { EventBus } from '../../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../../packages/core/src/record-module-runtime.js';
import { ChannelRegistries } from '../../packages/channels/src/adapter.js';
import { buildChannelConnectionActions } from '../../packages/channels/src/index.js';
import { createChannelOperations } from '../../packages/channels/src/operations.js';
import { fixtureWebhookHeaders } from '../../packages/channels/src/fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..', '..', 'packages', 'channels');

function loadManifest(name) {
  return JSON.parse(readFileSync(join(pkgRoot, 'modules', `${name}.module.json`), 'utf8'));
}

export const CHANNEL_MANIFEST_NAMES = Object.freeze([
  'channel-connection', 'channel-inbox-event', 'channel-dead-letter', 'channel-import-state',
  'channel-import-outcome',
]);

/**
 * @param {{
 *   adapterDefinition: any, fixtureApi: any,
 *   secretRef?: string, secretValue?: string,
 *   tenantId?: string, config?: Record<string, any>,
 *   resolveSender?: ((request: any) => Promise<any>) | null,
 *   dbPath?: string, nowMs?: () => number, extraAdapters?: any[],
 * }} options `nowMs` is the single clock the harness hands to both the
 *   package operations and (via the caller) the adapter, so ingest receive
 *   time and window checks never mix a frozen clock with the wall clock.
 *   `resolveSender` stands in for the composed `channel-sender@1`
 *   capability where the test proves the engine rather than the
 *   reconciliation itself. `dbPath` opens a file database instead of
 *   `:memory:` so two harnesses can share one store like two processes.
 */
export function createChannelsHarness(options) {
  const secretRef = options.secretRef ?? 'vault://kit/channel-a';
  const secretValue = options.secretValue ?? 'kit-secret-value-1';
  const tenantId = options.tenantId ?? 'channel-kit';
  const userActor = { type: 'user', id: 'channel-kit' };

  const database = createDatabase({ path: options.dbPath ?? ':memory:' });
  for (const { sql } of recordModuleMigrations(CHANNEL_MANIFEST_NAMES.map((name) => ({ name, manifest: loadManifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of CHANNEL_MANIFEST_NAMES) {
    const built = createRecordModuleFromManifest(loadManifest(name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }

  const registries = new ChannelRegistries({
    channelAdapters: [options.adapterDefinition, ...(options.extraAdapters ?? [])],
  });
  const resolveSecret = async (ref) => {
    if (ref !== secretRef) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return secretValue;
  };
  const ops = createChannelOperations({
    database, modules, registries, resolveSecret, tenantId, config: options.config,
    resolveSender: options.resolveSender ?? null,
    ...(typeof options.nowMs === 'function' ? { nowMs: options.nowMs } : {}),
  });

  const jobRegistry = createDurableJobHandlerRegistry();
  ops.registerChannelSendHandlers(jobRegistry);
  const jobStore = createDurableJobStore({ storage: database.storage, tenantId });
  const worker = createDurableJobWorker({
    store: jobStore,
    registry: jobRegistry,
    workerId: 'channel-kit',
    actor: { type: 'system', id: 'channel-kit' },
    backoff: () => 0,
    pollIntervalMs: 60000,
  });
  worker.start();

  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const connectionService = () => modules.get('channel-connection').service;

  async function activate(spaceId, connectionKey) {
    const record = ops.getConnection(spaceId, connectionKey);
    if (!record) throw new Error('connection missing for activation');
    return actions['activate-connection'].execute({
      record,
      input: { reason: 'kit activation' },
      actor: userActor,
      modules,
      managed: (id, patch) => connectionService().applyManaged(id, patch, { actor: userActor }),
      now: () => new Date().toISOString(),
    });
  }

  async function pump(jobId, maxRounds = 12) {
    let settled = null;
    for (let round = 0; round < maxRounds; round += 1) {
      const ran = await worker.run(jobId);
      settled = ran ?? await jobStore.get(jobId);
      if (settled && (settled.state === 'succeeded' || settled.state === 'failed_terminal')) return settled;
    }
    throw new Error(`send job never settled: ${JSON.stringify(settled)}`);
  }

  const api = options.fixtureApi;
  const faults = {
    sentCount: () => api.state.sentByKey.size,
    sendCalls: () => api.state.sendCalls,
    transientNext: (n) => api.setMode('flaky', n),
    refuseNext: () => api.setMode('refuse'),
    timeoutNext: () => api.setMode('timeout'),
    reset: () => api.reset(),
    sign: (rawBody) => fixtureWebhookHeaders(rawBody, secretValue, Math.floor(Date.now() / 1000)),
  };

  return {
    database,
    internals: { database, modules, registries },
    ops,
    userActor,
    secretRef,
    secretValue,
    faults,
    register: (spaceId, input) => ops.registerChannelConnection({ spaceId, ...input, actor: input.actor ?? userActor }),
    activate,
    ingest: (spaceId, { connectionKey, rawBody, headers }) => ops.ingestChannelEvent({ spaceId, connectionKey, rawBody, headers }),
    queue: (spaceId, { connectionKey, message, messageKey }) => ops.queueChannelSend({
      spaceId, connectionKey, message, messageKey, actor: userActor,
    }),
    pump,
    connections: (spaceId) => ops.listConnections(spaceId),
    inbox: (spaceId) => ops.listInbox(spaceId),
    letters: (spaceId, state = null) => ops.listDeadLetters(spaceId, state),
    startImport: (spaceId, args) => ops.startInitialImport({ spaceId, ...args, actor: args?.actor ?? userActor }),
    advanceImport: (spaceId, args) => ops.advanceInitialImport({ spaceId, ...args }),
    readImport: (spaceId, args) => ops.readInitialImport({ spaceId, ...args }),
    jobs: () => jobStore.list(500),
    auditRows: () => audit.list({ limit: 500 }),
    async dumpStorage() {
      // The outbox is part of the evidence: a secret smuggled into a job
      // payload must fail the no-secrets scan like any row or audit entry.
      const jobs = await jobStore.list(500);
      return JSON.stringify({
        connections: [...modules.get('channel-connection').service.listWhere({})],
        inbox: [...modules.get('channel-inbox-event').service.listWhere({})],
        letters: [...modules.get('channel-dead-letter').service.listWhere({})],
        jobs: jobs.map((job) => ({
          id: job.id, kind: job.kind, state: job.state,
          idempotencyRoot: job.idempotencyRoot, payload: job.payload,
        })),
        audit: audit.list({ limit: 500 }).map((row) => row.data),
      });
    },
    async close() {
      await worker.close();
      database.close();
    },
  };
}
