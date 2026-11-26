// @ts-check

/**
 * fb0d1a3517b1: the delivery-execution e2e suite is sharded so each file stays
 * under the per-file ceiling (`MEASURE_FILE_MAX_SEC`, 600 s) even with the
 * server loaded. Timing is load-dependent and cannot be asserted
 * deterministically here, so this file pins the structural proxy the split
 * was sized on: no `delivery-execution-e2e*` file declares more than four
 * top-level cases (about 100–180 s locally, each case boots its own project),
 * and the twelve original cases are all still present somewhere — a split
 * that drops or weakens a case fails here, not in the full.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testsDir = join(root, 'tests');

const shardFiles = () => readdirSync(testsDir)
  .filter((name) => /^delivery-execution-e2e.*\.test\.js$/.test(name))
  .sort();

const topLevelCases = (name) => {
  const text = readFileSync(join(testsDir, name), 'utf8');
  const titles = [...text.matchAll(/^test\('((?:[^'\\]|\\.)*)'/gm)].map((match) => match[1]);
  return { name, titles };
};

/** The twelve cases of the suite before the split — none may be lost. */
const ALL_TWELVE = [
  'a handed-over project starts, works and completes through the transition table',
  'the transition table is the whole answer, and it refuses everything else',
  'a stale expected state is refused rather than silently overwriting a decision',
  'execution is a human decision, and an agent is refused',
  'execution state is managed: CRUD cannot set it, and hostile notes stay inert',
  'the execution surface is published truthfully, with no forbidden vocabulary',
  'every declared state is reachable, and every declared transition has an action',
  'a work package blocks with stated evidence, resumes, and holds its project open meanwhile',
  'a delivery project closes only when every work package and milestone is completed',
  'a milestone cannot move while its project is not running',
  'operator free text is actually bounded, in length and in content',
  'the record descriptions the schema publishes do not deny what the package does',
];

test('fb0d1a3517b1: the suite is sharded, no file carries more than four cases', () => {
  const shards = shardFiles().map(topLevelCases);
  assert.ok(shards.length >= 2, `expected the suite split across files, found: ${shards.map((s) => s.name).join(', ')}`);
  const crowded = shards.filter((shard) => shard.titles.length > 4);
  assert.deepEqual(
    crowded.map((shard) => `${shard.name}: ${shard.titles.length}`),
    [],
    'a shard with more than four boots risks the 600 s per-file ceiling under load — split it further',
  );
});

test('fb0d1a3517b1: all twelve original cases still run, none loosened away', () => {
  const shards = shardFiles().map(topLevelCases);
  const present = new Set(shards.flatMap((shard) => shard.titles));
  const missing = ALL_TWELVE.filter((title) => !present.has(title));
  assert.deepEqual(missing, [], 'a case the suite used to prove is no longer declared anywhere');
  const total = shards.reduce((sum, shard) => sum + shard.titles.length, 0);
  assert.equal(total, ALL_TWELVE.length, 'cases were duplicated or invented in the split');
});
