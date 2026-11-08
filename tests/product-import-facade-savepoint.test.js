// @ts-check

/**
 * Product-import row claims on the portable facade over SQLite
 * (backlog:dc423e525af2, the follow-up of agent-crm#651).
 *
 * The async app's facade keeps the owned `database` handle private, so the
 * row claim used to fall to `mutationAsync`: on SQLite that runs an async
 * body inside one connection-wide savepoint, never atomic — a concurrent
 * request lands inside it and shares its rollback. Now, on sync storage,
 * the claim goes through the facade's `mutationSync` with the transaction
 * handle it passes: one synchronous unit no other request can enter.
 *
 * The facade below mirrors `portableService` in
 * packages/app/src/portable-app.js (no `database`; `manifest`, `audit`,
 * `events`; `mutationSync` handing the sync handle on sync storage): the
 * product-import helper needs the caller's `database.transactionAsync`,
 * which the async app does not publish, so the module services are built
 * over a real SQLite database like the commercial domain harness.
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
import { createProductImport } from '../packages/commercial/src/product-import.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACTOR = { type: 'user', id: 'product-import-facade' };
const FILES = [
  'product.module.json', 'product-version.module.json', 'price-book.module.json',
  'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
  'product-import.module.json', 'product-import-row.module.json',
];
const ROWS = [{ sku: 'YOGA-10', name: 'Pacchetto 10 lezioni', amountCents: 9900 }];

function harness(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close?.());
  const manifests = FILES.map((file) => JSON.parse(
    readFileSync(join(here, '..', 'packages', 'commercial', 'modules', file), 'utf8'),
  ));
  for (const manifest of manifests) {
    for (const { sql } of recordModuleMigrations([{ name: manifest.name, manifest }])) database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const manifest of manifests) {
    const built = createRecordModuleFromManifest(manifest, { database, audit, events, references: {} });
    modules.set(manifest.name, { service: built.service });
  }
  return { database, events, modules };
}

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

/** Facade modules: every service through `facadeOf`, `wrap` decorates the row service. */
function facadeModules({ database, modules }, wrap = (service) => service) {
  return {
    get(name) {
      const entry = modules.get(name);
      if (!entry) return entry;
      const facade = facadeOf(entry.service, database);
      return { service: name === 'product-import-row' ? wrap(facade) : facade };
    },
  };
}

test('confirm and reject decide rows on the facade over SQLite', async (t) => {
  const built = harness(t);
  const imports = createProductImport({ database: built.database, events: built.events, modules: facadeModules(built) });
  const first = await imports.startImport({ source: 'manual', rows: [...ROWS, { sku: 'PROVA', name: 'Prova', amountCents: 1000 }], currency: 'EUR' }, ACTOR);
  const confirmed = await imports.confirmRow({ importId: first.import.id, rowId: first.drafts[0].id }, ACTOR);
  assert.equal(confirmed.row.status, 'confirmed');
  const rejected = await imports.rejectRow({ importId: first.import.id, rowId: first.drafts[1].id }, ACTOR);
  assert.equal(rejected.row.status, 'rejected');
  assert.equal(rejected.import.status, 'closed');
});

test('a rollback of one row claim never deletes another request\'s write on SQLite', async (t) => {
  const built = harness(t);
  const healthy = createProductImport({ database: built.database, events: built.events, modules: facadeModules(built) });
  const a = await healthy.startImport({ source: 'manual', rows: ROWS, currency: 'EUR' }, ACTOR);
  const b = await healthy.startImport({ source: 'manual', rows: ROWS, currency: 'EUR' }, ACTOR);

  // The failing confirm (import A) breaks on its claim's audit insert,
  // after the conditional UPDATE already ran. On the async entry point it
  // parks there until the healthy reject (import B) had its chance: inside
  // a connection-wide savepoint B would land in A's unit (or be refused by
  // it) and A's rollback would take B's decision with it. On sync storage
  // the claim must be one synchronous unit.
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
  const failing = createProductImport({
    database: built.database,
    events: built.events,
    modules: facadeModules(built, (facade) => Object.freeze({
      ...facade,
      mutationAsync: (fn) => facade.mutationAsync(async (tx) => fn(poison(tx, true))),
      mutationSync: (fn) => facade.mutationSync((tx) => fn(tx ? poison(tx, false) : tx)),
    })),
  });

  const failingConfirm = failing.confirmRow({ importId: a.import.id, rowId: a.drafts[0].id }, ACTOR)
    .then(() => null, (error) => error);
  await reachedAudit;
  await new Promise((resolve) => setImmediate(resolve));
  const decided = await healthy.rejectRow({ importId: b.import.id, rowId: b.drafts[0].id }, ACTOR)
    .then((value) => value, (error) => error);
  open();
  const failure = await failingConfirm;

  assert.ok(failure instanceof Error, 'the poisoned confirm surfaces its audit failure');
  assert.ok(!(decided instanceof Error), `the healthy reject lands (got ${decided?.code ?? decided?.message})`);
  const readA = await healthy.readImport({ importId: a.import.id });
  const readB = await healthy.readImport({ importId: b.import.id });
  assert.deepEqual(readB.counts, { pending: 0, confirmed: 0, rejected: 1 }, 'the healthy decision survived');
  assert.deepEqual(readA.counts, { pending: 1, confirmed: 0, rejected: 0 }, 'the failed claim rolled back whole');
  const products = await built.modules.get('product').service.listWhere({});
  assert.equal(products.length, 0, 'the failed confirm left no product behind');
});
