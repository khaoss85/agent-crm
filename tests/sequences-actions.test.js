import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import { ActionRegistry, validateActionDefinition } from '../packages/core/src/action-registry.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createSequencesPackage } from '../packages/sequences/src/index.js';
import {
  buildActivateSequenceAction,
  buildPauseSequenceAction,
} from '../packages/sequences/src/sequences.js';

/**
 * Sequence activate/pause actions (backlog:925808b3f193, BO-F3-03
 * "10 Sequenze"): the only way a sequence starts or stops firing from the
 * backoffice. Draft or paused activates; active pauses; anything else
 * refuses with 409; an anonymous actor is refused before any write.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SPACE = 'presti';
const T0 = new Date(Date.now() + 60_000).toISOString();

function compose() {
  const manifest = JSON.parse(
    readFileSync(join(here, '..', 'packages', 'sequences', 'modules', 'sequence.module.json'), 'utf8'),
  );
  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations([{ name: 'sequence', manifest }])) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const built = createRecordModuleFromManifest(manifest, { database, audit, events, references: {} });
  const modules = new Map([['sequence', { service: built.service }]]);
  return { modules };
}

async function draftSequence(modules, sourceKey = 'seq-bentornato') {
  const service = modules.get('sequence').service;
  return service.createManaged({
    sourceKey,
    spaceId: SPACE,
    name: 'Bentornato in palestra',
    status: 'draft',
    decidedAt: T0,
    actorType: USER.type,
    actorId: USER.id,
    sourcePackage: 'sequences',
    sourceAction: 'create-sequence',
  }, { actor: USER });
}

test('the package registers activate and pause on the sequence module', () => {
  const graph = createSequencesPackage({});
  const names = (graph.actions ?? []).map((action) => action.name).sort();
  assert.deepEqual(names, ['activate', 'pause']);
  const registry = new ActionRegistry({ moduleExists: (name) => name === 'sequence' });
  for (const action of graph.actions) registry.register(action);
  const activate = registry.get('sequence', 'activate');
  assert.deepEqual(activate.fromStates, ['draft', 'paused']);
  assert.equal(activate.confirm, true);
  const pause = registry.get('sequence', 'pause');
  assert.deepEqual(pause.fromStates, ['active']);
  assert.equal(pause.confirm, true);
  assert.equal(registry.listForModule('sequence').length, 2);
});

test('activate moves draft to active, pause moves active to paused', async () => {
  const { modules } = compose();
  const activate = buildActivateSequenceAction();
  const pause = buildPauseSequenceAction();
  validateActionDefinition(activate, { moduleExists: () => true });
  validateActionDefinition(pause, { moduleExists: () => true });
  const created = await draftSequence(modules);
  const started = await activate.execute({ record: created, actor: USER, modules, now: () => T0 });
  assert.equal(started.sequence.status, 'active');
  assert.equal(started.event, 'activate');
  const stopped = await pause.execute({ record: started.sequence, actor: USER, modules, now: () => T0 });
  assert.equal(stopped.sequence.status, 'paused');
  const restarted = await activate.execute({ record: stopped.sequence, actor: USER, modules, now: () => T0 });
  assert.equal(restarted.sequence.status, 'active');
});

test('activate on active refuses with 409, pause on draft refuses with 409', async () => {
  const { modules } = compose();
  const activate = buildActivateSequenceAction();
  const pause = buildPauseSequenceAction();
  const created = await draftSequence(modules);
  const started = await activate.execute({ record: created, actor: USER, modules, now: () => T0 });
  await assert.rejects(
    activate.execute({ record: started.sequence, actor: USER, modules, now: () => T0 }),
    (error) => error?.code === 'SEQUENCE_TRANSITION_INVALID' && error?.status === 409,
  );
  await assert.rejects(
    pause.execute({ record: created, actor: USER, modules, now: () => T0 }),
    (error) => error?.code === 'SEQUENCE_TRANSITION_INVALID' && error?.status === 409,
  );
});

test('an anonymous actor is refused before any write', async () => {
  const { modules } = compose();
  const activate = buildActivateSequenceAction();
  const created = await draftSequence(modules);
  await assert.rejects(
    activate.execute({ record: created, actor: { type: '', id: '' }, modules, now: () => T0 }),
    (error) => error?.code === 'SEQUENCE_ACTOR_REQUIRED' && error?.status === 403,
  );
  const rows = await modules.get('sequence').service.listWhere({ spaceId: SPACE, sourceKey: 'seq-bentornato' });
  assert.equal(rows[0].status, 'draft');
});
