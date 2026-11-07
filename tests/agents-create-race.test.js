import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAgentOperations } from '../packages/agents/src/operations.js';

/**
 * Review #661 (giro 2, P2): two concurrent creates of the same intent —
 * a double submit, or a retry racing the original — both pass the
 * listWhere check before either writes. The loser must replay the winner
 * as `duplicate: true`, never fail on the unique source key.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'op-1' };
const MANIFESTS = ['teammate-agent', 'teammate-assignment', 'teammate-run'];
const manifest = (name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', 'agents', 'modules', `${name}.module.json`), 'utf8'),
);

function compose() {
  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations(MANIFESTS.map((name) => ({ name, manifest: manifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of MANIFESTS) {
    const built = createRecordModuleFromManifest(manifest(name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }
  return createAgentOperations({ modules, now: () => '2026-11-07T10:00:00.000Z' });
}

const AGENT = {
  spaceId: 'presti', sourceKey: 'agent:presti:riaggancio', name: 'Riaggancio', role: 'Ricontatta', instructions: 'Trova i clienti', actor: USER,
};

test('two concurrent create-agent of one source key: one creates, the other replays duplicate', async () => {
  const ops = compose();
  const results = await Promise.all([ops.createAgent({ ...AGENT }), ops.createAgent({ ...AGENT })]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(results[0].agent.sourceKey, results[1].agent.sourceKey);
});

test('two concurrent create-assignment of one source key: one creates, the other replays duplicate', async () => {
  const ops = compose();
  await ops.createAgent({ ...AGENT });
  const assignment = {
    spaceId: 'presti', sourceKey: 'bo-agent-assign:1', agentSourceKey: AGENT.sourceKey, phrase: 'ogni lunedì il report', actor: USER,
  };
  const results = await Promise.all([ops.createAssignment({ ...assignment }), ops.createAssignment({ ...assignment })]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
});

test('a source key taken in another space is a typed refusal, never a cross-space replay', async () => {
  const ops = compose();
  await ops.createAgent({ ...AGENT });
  await assert.rejects(
    () => ops.createAgent({ ...AGENT, spaceId: 'altro' }),
    (error) => error.code === 'AGENT_SOURCE_KEY_TAKEN' && error.status === 409,
  );
});
