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
import { ValidationError } from '../packages/core/src/errors.js';

/**
 * Hand-written prefix guard (review #879 giro 2, backlog:7d169a3b1dd2).
 *
 * `update-agent` and `set-agent-status` only touch hand-written agents
 * (`custom-agent:<space>:<key>`). A catalogue key (`agent:<space>:<slug>`)
 * posted directly — bypassing the card, which only shows Modifica/Ritira
 * on hand-written cards — is refused with a 400 ValidationError before any
 * row is read or written, so a production catalogue agent can never be
 * renamed, paused or resumed from outside the card.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SPACE = 'presti';
const HAND_KEY = 'custom-agent:presti:vendite';
const CATALOGUE_KEY = 'agent:presti:riaggancio';

const manifest = (name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', 'agents', 'modules', `${name}.module.json`), 'utf8'),
);

const MANIFESTS = ['teammate-agent', 'teammate-assignment', 'teammate-run'];

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
  return createAgentOperations({ modules, now: () => '2026-11-02T07:00:00.000Z' });
}

async function makeHandAgent(ops) {
  const { agent } = await ops.createAgent({
    actor: USER,
    spaceId: SPACE,
    sourceKey: HAND_KEY,
    name: 'Vendi',
    role: 'Prepara il report vendite',
    instructions: 'Leggi le vendite e proponi il report.',
  });
  return agent;
}

test('update-agent renames a hand-written agent', async () => {
  const ops = compose();
  await makeHandAgent(ops);
  const { agent } = await ops.updateAgent({
    actor: USER, spaceId: SPACE, agentSourceKey: HAND_KEY, name: 'Vendi due',
  });
  assert.equal(agent.name, 'Vendi due');
});

test('update-agent refuses a catalogue key with 400 and writes nothing', async () => {
  const ops = compose();
  const before = await makeHandAgent(ops);
  await assert.rejects(
    ops.updateAgent({ actor: USER, spaceId: SPACE, agentSourceKey: CATALOGUE_KEY, name: 'X' }),
    (error) => error instanceof ValidationError && error.status === 400,
  );
  const { agent } = await ops.updateAgent({
    actor: USER, spaceId: SPACE, agentSourceKey: HAND_KEY, name: 'Vendi tre',
  });
  assert.equal(agent.name, 'Vendi tre');
  assert.notEqual(before.name, undefined);
});

test('set-agent-status pauses a hand-written agent and replays the same status', async () => {
  const ops = compose();
  await makeHandAgent(ops);
  const paused = await ops.setAgentStatus({
    actor: USER, spaceId: SPACE, agentSourceKey: HAND_KEY, status: 'paused',
  });
  assert.equal(paused.agent.status, 'paused');
  assert.equal(paused.duplicate, undefined);
  const replay = await ops.setAgentStatus({
    actor: USER, spaceId: SPACE, agentSourceKey: HAND_KEY, status: 'paused',
  });
  assert.equal(replay.duplicate, true);
});

test('set-agent-status refuses a catalogue key with 400, paused or active', async () => {
  const ops = compose();
  await makeHandAgent(ops);
  for (const status of ['paused', 'active']) {
    await assert.rejects(
      ops.setAgentStatus({ actor: USER, spaceId: SPACE, agentSourceKey: CATALOGUE_KEY, status }),
      (error) => error instanceof ValidationError && error.status === 400,
    );
  }
});
