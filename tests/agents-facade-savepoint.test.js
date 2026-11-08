// @ts-check

/**
 * Teammate runs on the portable facade over SQLite (backlog:dc423e525af2,
 * the follow-up of agent-crm#651).
 *
 * The async app's `app.modules` facade keeps the owned `database` handle
 * private. The run seam used to need that handle, so the agents operations
 * refused on the facade; the only other entry point it had was
 * `mutationAsync`, which on SQLite runs an async body inside one
 * connection-wide savepoint — never atomic, and a concurrent request lands
 * inside it and shares its rollback. Now, on sync storage, the conditional
 * run write goes through the facade's `mutationSync` with the transaction
 * handle it passes: one synchronous unit no other request can enter.
 *
 * The facade below mirrors `portableService` as agent-crm#651 ships it in
 * packages/app/src/portable-app.js (no `database`; `manifest`, `audit`,
 * `events`; `mutationSync` handing the sync handle on sync storage;
 * `mutationAsync`), over real SQLite record services, and drives
 * `createAgentOperations` with it — the path a host takes with
 * `app.modules`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuditLog } from '../packages/core/src/audit.js';
import { createDatabase } from '../packages/core/src/database.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAgentOperations } from '../packages/agents/src/operations.js';

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SYSTEM = { type: 'system', id: 'agent-sweep' };
const SPACE = 'presti';
const MON_07 = '2026-11-02T07:00:00.000Z';
const MON_0801 = '2026-11-02T08:01:00.000Z';
const runKey = (assignment) => `run:${assignment}:2026-11-02T08:00:00.000Z`;
const MANIFESTS = ['teammate-agent', 'teammate-assignment', 'teammate-run'];

const manifest = (name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', 'agents', 'modules', `${name}.module.json`), 'utf8'),
);

/** The portable facade shape of one record service on sync storage. */
function facadeOf(service, database) {
  const handle = database.storage.sync;
  const facade = {};
  for (const name of ['get', 'list', 'listWhere', 'countWhere', 'createManaged', 'applyManaged', 'mutationAsync']) {
    if (typeof service[name] === 'function') facade[name] = (...args) => service[name](...args);
  }
  facade.mutationSync = (fn) => service.mutationSync(() => fn(handle));
  facade.manifest = service.manifest;
  facade.audit = { record: (event, tx) => service.audit.record(event, tx), list: (filters) => service.audit.list(filters) };
  facade.events = {
    emit: (...args) => service.events.emit(...args),
    subscribe: (...args) => service.events.subscribe(...args),
    buffered: (...args) => service.events.buffered(...args),
  };
  return Object.freeze(facade);
}

async function composed(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close?.());
  for (const { sql } of recordModuleMigrations(MANIFESTS.map((name) => ({ name, manifest: manifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const raw = new Map();
  for (const name of MANIFESTS) {
    raw.set(name, createRecordModuleFromManifest(manifest(name), { database, audit, events, references: {} }).service);
  }
  const app = {
    audit,
    modules: { get: (name) => (raw.has(name) ? { service: facadeOf(raw.get(name), database) } : undefined) },
  };
  let clock = MON_07;
  const now = () => clock;
  const ops = createAgentOperations({ modules: app.modules, now });
  await ops.createAgent({
    actor: USER, spaceId: SPACE, sourceKey: 'ag-riaggancio', name: 'Riaggancio',
    role: 'Ricontatta i clienti', instructions: 'Prepara un messaggio per ciascuno.',
  });
  for (const sourceKey of ['as-a', 'as-b']) {
    await ops.createAssignment({
      actor: USER, spaceId: SPACE, sourceKey, agentSourceKey: 'ag-riaggancio',
      phrase: 'ogni giorno', plan: { cadence: 'daily', timeOfDay: '08:00' },
    });
  }
  clock = MON_0801;
  const summary = await ops.runDue({
    actor: SYSTEM,
    at: MON_0801,
    execute: async ({ assignment }) => ({
      kind: 'proposals',
      proposals: [{ action: 'reengagement-message', payload: { summary: `Ricontatta per ${assignment.sourceKey}` } }],
    }),
  });
  return { app, ops, now, summary };
}

const outcomeOf = async (app, sourceKey) => (
  await app.modules.get('teammate-run').service.listWhere({ spaceId: SPACE, sourceKey })
)[0]?.outcome;

test('run-due, reject and revise work on the portable facade over SQLite', async (t) => {
  const { app, ops, summary } = await composed(t);
  assert.equal(summary.proposed, 2, 'both runs landed through the facade');
  const revised = await ops.reviseRun({
    actor: USER, spaceId: SPACE, runSourceKey: runKey('as-a'), payload: { text: 'Ciao!' },
  });
  assert.equal(revised.proposal.payload.text, 'Ciao!');
  const rejected = await ops.rejectRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey('as-b') });
  assert.equal(rejected.run.outcome, 'rejected');
  const { run } = await ops.approveRun({
    actor: USER, spaceId: SPACE, runSourceKey: runKey('as-a'), applyAction: async () => ({}),
  });
  assert.equal(run.outcome, 'applied');
});

test('a rollback of one run write never deletes another request\'s write on SQLite', async (t) => {
  const { app, now, ops } = await composed(t);
  // The failing request (run A) breaks on its audit insert, after its
  // conditional UPDATE already ran. On the async entry point it parks
  // there until the healthy request (run B) has finished: if its body ran
  // inside a connection-wide savepoint, B would land inside it and A's
  // rollback would take B's write with it. On sync storage the write must
  // be one synchronous unit, so nothing can land inside it.
  let reached;
  const reachedAudit = new Promise((resolve) => { reached = resolve; });
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const poison = (tx, park) => {
    const realExecute = tx.execute.bind(tx);
    return {
      ...tx,
      execute: (statement) => {
        if (statement?.kind === 'insert' && statement?.table === 'audit_events') {
          reached();
          if (park) return gate.then(() => { throw new Error('injected audit failure'); });
          throw new Error('injected audit failure');
        }
        return realExecute(statement);
      },
    };
  };
  const failingModules = {
    get(name) {
      const entry = app.modules.get(name);
      if (name !== 'teammate-run') return entry;
      const service = entry.service;
      const wrapped = { ...service };
      if (typeof service.mutationAsync === 'function') {
        wrapped.mutationAsync = (fn) => service.mutationAsync(async (tx) => fn(poison(tx, true)));
      }
      if (typeof service.mutationSync === 'function') {
        wrapped.mutationSync = (fn) => service.mutationSync((tx) => fn(tx ? poison(tx, false) : tx));
      }
      return { ...entry, service: Object.freeze(wrapped) };
    },
  };
  const failingOps = createAgentOperations({ modules: failingModules, now });

  const failing = failingOps.rejectRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey('as-a') })
    .then(() => null, (error) => error);
  await reachedAudit;
  await new Promise((resolve) => setImmediate(resolve));
  const healthy = await ops.rejectRun({ actor: USER, spaceId: SPACE, runSourceKey: runKey('as-b') });
  open();
  const failure = await failing;

  assert.ok(failure, 'the poisoned write surfaces its audit failure');
  assert.equal(healthy.run.outcome, 'rejected');
  assert.equal(await outcomeOf(app, runKey('as-b')), 'rejected', 'the healthy write survived');
  assert.equal(await outcomeOf(app, runKey('as-a')), 'proposed', 'the failed write rolled back whole');
  const audit = await app.audit.list({ entityType: 'teammate-run' });
  const rejections = audit.filter((event) => event.action === 'teammate-run.updated'
    && event.data?.outcome === 'rejected');
  assert.equal(rejections.length, 1, 'exactly the healthy rejection left an audit row');
});
