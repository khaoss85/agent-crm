// @ts-check

/**
 * Two-connection race worker for the appointments no-double-booking proof.
 *
 * Each worker is its own isolate with its own database connection to the same
 * file: no process-local chain is shared, so only the handle transaction
 * (`BEGIN IMMEDIATE` on SQLite) can serialize the two writers. The main test
 * releases every round at once through the shared barrier; the worker books
 * its round immediately and reports a plain receipt — errors cross the
 * isolate boundary as data, never as live `Error` instances.
 *
 * Run only through `tests/appointments-model.test.js`, never directly: the
 * main test owns the database file, the barrier and the assertions.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

import { AuditLog } from '../../packages/core/src/audit.js';
import { createDatabase } from '../../packages/core/src/database.js';
import { EventBus } from '../../packages/core/src/event-bus.js';
import { NotFoundError } from '../../packages/core/src/errors.js';
import { createRecordModuleFromManifest } from '../../packages/core/src/record-module-runtime.js';
import { bookAppointment } from '../../packages/appointments/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(join(here, '..', '..', 'packages', 'appointments', 'modules', 'appointment.module.json'), 'utf8'),
);

/** @param {unknown} data */
function setup(data) {
  const { dbPath } = /** @type {{ dbPath: string }} */ (data);
  // The table already exists — the main test applies the migration before
  // spawning workers, so opening here never races DDL.
  const database = createDatabase({ path: dbPath });
  const built = createRecordModuleFromManifest(manifest, {
    database,
    audit: new AuditLog(database),
    events: new EventBus(),
    references: {},
  });
  const service = built.service;
  const modules = {
    get: (/** @type {string} */ name) => {
      if (name === 'appointment') return { service };
      throw new NotFoundError(`module ${name} not found`);
    },
  };
  return { database, modules };
}

/** @param {Int32Array} shared @param {number} generation */
function awaitGeneration(shared, generation) {
  while (Atomics.load(shared, 1) !== generation) {
    Atomics.wait(shared, 1, Atomics.load(shared, 1), 50);
  }
}

const { dbPath, shared, rounds } = /** @type {{ dbPath: string, shared: SharedArrayBuffer, rounds: Array<any> }} */ (workerData);
const barrier = new Int32Array(shared);

// Built inside the try so a setup failure still reports through the parent
// rather than dying silent: when both workers are ready, the only remaining
// work is the booking itself, so the race window is maximal.
let database = null;
try {
  const built = setup({ dbPath });
  database = built.database;
  const context = {
    modules: built.modules,
    actor: { type: 'user', id: 'race-probe' },
    now: () => new Date().toISOString(),
    consumer: 'host',
    followUps: null,
  };
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0, 1);
  for (let round = 0; round < rounds.length; round++) {
    awaitGeneration(barrier, round + 1);
    const request = rounds[round];
    try {
      const result = await bookAppointment(context, request);
      parentPort?.postMessage({
        round,
        ok: true,
        replayed: result.replayed === true,
        id: result.appointment?.id ?? null,
      });
    } catch (error) {
      parentPort?.postMessage({
        round,
        ok: false,
        code: /** @type {any} */ (error)?.code ?? null,
        status: /** @type {any} */ (error)?.status ?? null,
        message: String(/** @type {any} */ (error)?.message ?? error),
      });
    }
  }
} finally {
  database?.close();
}
