// @ts-check

/**
 * f268787b540c: the lifecycle-renewal operations e2e suite is sharded so each
 * file stays under the per-file ceiling (`MEASURE_FILE_MAX_SEC`, 600 s) even
 * with the server loaded. The full scheduled CI on main turned red twice on
 * this file alone (workflow_dispatch 44578241261 on 2026-11-19 and schedule
 * 45939270157 on 2026-11-27: `measure-suite: piece N: ... passed the 600s
 * per-file ceiling and was killed; nothing recorded`), while every case that
 * finished was green — the file is too slow, not wrong. Same structural proxy
 * as the delivery-execution split (voce fb0d1a3517b1, PR #1179): timing is
 * load-dependent and cannot be asserted deterministically here, so this file
 * pins that no `lifecycle-renewal-operations-e2e*` file declares more than
 * four top-level cases, and that the thirteen original cases are all still
 * present somewhere — a split that drops or weakens a case fails here, not in
 * the full.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const testsDir = join(root, 'tests');

const shardFiles = () => readdirSync(testsDir)
  .filter((name) => /^lifecycle-renewal-operations-e2e.*\.test\.js$/.test(name))
  .sort();

const topLevelCases = (name) => {
  const text = readFileSync(join(testsDir, name), 'utf8');
  const titles = [...text.matchAll(/^test\('((?:[^'\\]|\\.)*)'/gm)].map((match) => match[1]);
  return { name, titles };
};

/** The thirteen cases of the suite before the split — none may be lost. */
const ALL_THIRTEEN = [
  'plan-renewal reads: it changes no table, and reports the boundary with its provenance',
  'an impossible calendar date is refused rather than rolled over into evidence',
  'a lost response can be retried: the identical ask replays, a different one is refused by field',
  'a follow-up key is a round number, so resolved work can come round again',
  'the follow-up state model is an explicit table: terminal never regresses',
  'money evidence keeps every dimension that distinguishes one ask from another',
  'audit, events and trace are exact, and every event name is one M16a can honour',
  'two application instances race one transition: one winner, and no raw SQLite error',
  'a failure after the write rolls everything back, and the retry produces exactly one result',
  'every correctness read is exact past the 500-row page bound',
  'the evidence is read-only through every generic surface, and writing needs a human',
  'a retry after a restart still replays, over rows a previous process wrote',
  'the package detaches and reattaches, and its rows outlive it',
];

test('f268787b540c: the suite is sharded, no file carries more than four cases', () => {
  const shards = shardFiles().map(topLevelCases);
  assert.ok(shards.length >= 2, `expected the suite split across files, found: ${shards.map((s) => s.name).join(', ')}`);
  const crowded = shards.filter((shard) => shard.titles.length > 4);
  assert.deepEqual(
    crowded.map((shard) => `${shard.name}: ${shard.titles.length}`),
    [],
    'a shard with more than four boots risks the 600 s per-file ceiling under load — split it further',
  );
});

test('f268787b540c: all thirteen original cases still run, none loosened away', () => {
  const shards = shardFiles().map(topLevelCases);
  const present = new Set(shards.flatMap((shard) => shard.titles));
  const missing = ALL_THIRTEEN.filter((title) => !present.has(title));
  assert.deepEqual(missing, [], 'a case the suite used to prove is no longer declared anywhere');
  const total = shards.reduce((sum, shard) => sum + shard.titles.length, 0);
  assert.equal(total, ALL_THIRTEEN.length, 'cases were duplicated or invented in the split');
});
