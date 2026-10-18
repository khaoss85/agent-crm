import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifestSelectedEntries } from '../packages/app/src/manifest-selection.js';
import { preflightSelectedGraph } from '../packages/app/src/async-lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK_MODULES_DIR = join(HERE, '../packages/work/modules');

/**
 * The production path of accordo 97a4fbbea85b: composers build their
 * selected graph from the checked-in manifests through
 * `loadManifestSelectedEntries`, which reads the `<name>.history.json`
 * sidecar beside each manifest. A revised module then composes its original
 * migration byte-identical plus one additive evolution — the upgrade the
 * PostgreSQL suite replays end to end.
 */

test('the loader attaches the checked-in sidecar history to the revised module only', () => {
  const entries = loadManifestSelectedEntries(WORK_MODULES_DIR);
  assert.deepEqual(entries.map((entry) => entry.name), ['work-activity', 'work-task']);

  const activity = entries.find((entry) => entry.name === 'work-activity');
  const historyFile = JSON.parse(readFileSync(join(WORK_MODULES_DIR, 'work-activity.history.json'), 'utf8'));
  assert.deepEqual(activity.previousManifests, historyFile.previousManifests);

  const task = entries.find((entry) => entry.name === 'work-task');
  assert.ok(!('previousManifests' in task), 'a module without a sidecar keeps today\'s entry shape');
});

test('loader entries preflight to the original bootstrap plus one additive evolution', () => {
  const accepted = preflightSelectedGraph({
    packageContract: 2,
    packages: [],
    actions: [],
    modules: loadManifestSelectedEntries(WORK_MODULES_DIR),
  });
  const names = accepted.postgresRecordMigrations.map((migration) => migration.name);
  assert.ok(names.includes('pg_bootstrap_work_activities'), 'the original migration is still composed');
  assert.ok(names.includes('pg_evolve_work_activities_r2'), 'revision 2 arrives as a new migration');
  assert.equal(
    names.filter((name) => name.includes('work_activit')).length,
    2,
    'the applied migration is never re-rendered under the same name',
  );
});

function scratchModules(files) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-selection-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    if (name.includes('/')) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

const revision1Manifest = () => JSON.parse(
  readFileSync(join(WORK_MODULES_DIR, 'work-activity.history.json'), 'utf8'),
).previousManifests[0];

test('a present-but-unreadable sidecar refuses loudly instead of composing without history', (t) => {
  const manifest = revision1Manifest();
  const dir = scratchModules({
    'work-activity.module.json': { ...manifest, revision: 2 },
    'work-activity.history.json': '{not json',
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => loadManifestSelectedEntries(dir),
    /cannot be read as its revision history/,
  );
});

test('a sidecar for another module refuses loudly', (t) => {
  const manifest = revision1Manifest();
  const dir = scratchModules({
    'work-activity.module.json': manifest,
    'work-activity.history.json': { module: 'work-task', previousManifests: [] },
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => loadManifestSelectedEntries(dir),
    /is for "work-task", not "work-activity"/,
  );
});

test('a sidecar without a previousManifests array refuses loudly', (t) => {
  const manifest = revision1Manifest();
  const dir = scratchModules({
    'work-activity.module.json': manifest,
    'work-activity.history.json': { module: 'work-activity', previousManifests: 'nope' },
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => loadManifestSelectedEntries(dir),
    /must carry previousManifests as an array/,
  );
});

test('a manifest with no name refuses loudly', (t) => {
  const manifest = revision1Manifest();
  const { name, ...nameless } = manifest;
  void name;
  const dir = scratchModules({ 'work-activity.module.json': nameless });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(
    () => loadManifestSelectedEntries(dir),
    /carries no name/,
  );
});

test('a missing modules directory refuses loudly', () => {
  assert.throws(
    () => loadManifestSelectedEntries(join(tmpdir(), 'manifest-selection-does-not-exist')),
    /cannot be listed/,
  );
});
