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
import {
  createSequencesPackage,
  optionalSequenceLabel,
} from '../packages/sequences/src/index.js';

/**
 * BO-F6-12 fetta 1 — `triggerLabel` / `stopLabel` sulla sequenza
 * (backlog:ca96298ca38a, spec sequenze.arch.md §Cosa manca).
 *
 * La vista elenca `Quando …` e dettaglia `Parte quando:` / `Si ferma quando:`
 * dai record `sequence`, non da costanti: questa fetta aggiunge i due campi
 * al manifest (r2 con storia), agli input di `create-sequence` e agli output
 * di `list-sequences` / `read-sequence-metrics`. Niente nuove invarianti.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);
const history = JSON.parse(
  readFileSync(join(here, '..', 'packages', 'sequences', 'modules', 'sequence.history.json'), 'utf8'),
);
const REV1 = history.previousManifests[0];
const REV2 = manifest('sequences', 'sequence');

assert.equal(REV1.revision ?? 1, 1);
assert.equal(REV2.revision, 2);

const USER = { type: 'user', id: 'test-owner' };
const SPACE = 'presti-test';
const STEPS = [
  {
    dayOffset: 0, channel: 'whatsapp', templateName: 'presti_seq', templateLanguage: 'it',
    templateVars: ['Ciao {{name}}'],
  },
];

function modulesFor(database, manifests) {
  const modules = new Map();
  for (const [pkg, name] of manifests) {
    const built = createRecordModuleFromManifest(manifest(pkg, name), {
      database, audit: new AuditLog(database), events: new EventBus(), references: {},
    });
    modules.set(name, { service: built.service });
  }
  return modules;
}

function migrate(database, manifests) {
  for (const { sql } of recordModuleMigrations(manifests)) database.raw.exec(sql);
}

function opsFor(modules) {
  const definition = createSequencesPackage({});
  const runtime = { modules, config: {} };
  return Object.fromEntries(definition.operations.map((entry) => [entry.appMethod, entry.create(runtime)]));
}

test('optionalSequenceLabel: null quando assente, testo quando presente, rifiuto del resto', () => {
  assert.equal(optionalSequenceLabel(undefined, 'triggerLabel'), null);
  assert.equal(optionalSequenceLabel(null, 'stopLabel'), null);
  assert.equal(optionalSequenceLabel('lead dal sito', 'triggerLabel'), 'lead dal sito');
  for (const garbage of ['', '   ', 'x'.repeat(281), 'con\ttab', 'con\nnewline']) {
    assert.throws(() => optionalSequenceLabel(garbage, 'triggerLabel'), /triggerLabel/);
  }
});

test('create-sequence salva le etichette e list/read le espongono; assenti valgono null', async () => {
  const database = createDatabase({ path: ':memory:' });
  try {
    migrate(database, [
      { name: 'sequence', manifest: REV2 },
      { name: 'sequence-step', manifest: manifest('sequences', 'sequence-step') },
      { name: 'sequence-enrollment', manifest: manifest('sequences', 'sequence-enrollment') },
      { name: 'sequence-send', manifest: manifest('sequences', 'sequence-send') },
    ]);
    const ops = opsFor(modulesFor(database, [
      ['sequences', 'sequence'],
      ['sequences', 'sequence-step'],
      ['sequences', 'sequence-enrollment'],
      ['sequences', 'sequence-send'],
    ]));

    const created = await ops.createSequence({
      spaceId: SPACE, sourceKey: 'seq:etichette', name: 'Benvenuto',
      triggerLabel: 'lead dal sito', stopLabel: 'alla prima risposta',
      steps: STEPS, actor: USER,
    });
    assert.equal(created.replayed, false);
    assert.equal(created.sequence.triggerLabel, 'lead dal sito');
    assert.equal(created.sequence.stopLabel, 'alla prima risposta');

    const elenco = await ops.listSequences({ spaceId: SPACE, actor: USER });
    const row = elenco.find((entry) => entry.sourceKey === 'seq:etichette');
    assert.equal(row.triggerLabel, 'lead dal sito');
    assert.equal(row.stopLabel, 'alla prima risposta');

    const metrics = await ops.readSequenceMetrics({ spaceId: SPACE, sourceKey: 'seq:etichette', actor: USER });
    assert.equal(metrics.sequence.triggerLabel, 'lead dal sito');
    assert.equal(metrics.sequence.stopLabel, 'alla prima risposta');

    const plain = await ops.createSequence({
      spaceId: SPACE, sourceKey: 'seq:senza-etichette', name: 'Senza etichette',
      steps: STEPS, actor: USER,
    });
    assert.equal(plain.sequence.triggerLabel ?? null, null);
    assert.equal(plain.sequence.stopLabel ?? null, null);

    await assert.rejects(
      ops.createSequence({
        spaceId: SPACE, sourceKey: 'seq:spazzatura', name: 'Spazzatura',
        triggerLabel: '', steps: STEPS, actor: USER,
      }),
      /triggerLabel/,
    );
  } finally {
    database.close();
  }
});

test('replay con la stessa chiave riusa le etichette registrate, senza mutarle', async () => {
  const database = createDatabase({ path: ':memory:' });
  try {
    migrate(database, [
      { name: 'sequence', manifest: REV2 },
      { name: 'sequence-step', manifest: manifest('sequences', 'sequence-step') },
      { name: 'sequence-enrollment', manifest: manifest('sequences', 'sequence-enrollment') },
      { name: 'sequence-send', manifest: manifest('sequences', 'sequence-send') },
    ]);
    const ops = opsFor(modulesFor(database, [
      ['sequences', 'sequence'],
      ['sequences', 'sequence-step'],
      ['sequences', 'sequence-enrollment'],
      ['sequences', 'sequence-send'],
    ]));

    await ops.createSequence({
      spaceId: SPACE, sourceKey: 'seq:replay', name: 'Replay',
      triggerLabel: 'prima etichetta', steps: STEPS, actor: USER,
    });
    const replayed = await ops.createSequence({
      spaceId: SPACE, sourceKey: 'seq:replay', name: 'Replay',
      steps: STEPS, actor: USER,
    });
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.sequence.triggerLabel, 'prima etichetta');
  } finally {
    database.close();
  }
});

test('una base r1 adotta la r2 senza perdere la sequenza: etichette a null', async () => {
  const database = createDatabase({ path: ':memory:' });
  try {
    const applied = new Set();
    for (const { name, sql } of recordModuleMigrations([{ name: 'sequence', manifest: REV1 }])) {
      database.raw.exec(sql);
      applied.add(name);
    }
    assert.deepEqual([...applied], ['create_sequences']);
    const audit = new AuditLog(database);
    const events = new EventBus();
    const before = createRecordModuleFromManifest(REV1, { database, audit, events, references: {} }).service;
    await before.createManaged({
      sourceKey: 'seq:vecchia', spaceId: SPACE, name: 'Vecchia',
      status: 'draft', decidedAt: new Date().toISOString(),
      actorType: 'user', actorId: 'test-owner',
      sourcePackage: 'sequences', sourceAction: 'create-sequence',
    }, { actor: USER });

    for (const { name, sql } of recordModuleMigrations([{ name: 'sequence', manifest: REV2 }])) {
      if (applied.has(name)) continue;
      database.raw.exec(sql);
      applied.add(name);
    }
    assert.ok(applied.has('evolve_sequences_r2'));

    const after = createRecordModuleFromManifest(REV2, { database, audit, events, references: {} }).service;
    const rows = await after.listWhere({ spaceId: SPACE });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceKey, 'seq:vecchia');
    assert.equal(rows[0].triggerLabel ?? null, null);
    assert.equal(rows[0].stopLabel ?? null, null);
  } finally {
    database.close();
  }
});
