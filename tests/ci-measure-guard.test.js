// @ts-check

/**
 * `ci-measure-guard.js`: the scheduled run measures unless the committed
 * ledger already names this head, the runner-local record does, or the head
 * moved past the recorded measurement only in the measurement-flow files —
 * and doubt always measures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideMeasure,
  headAlreadyMeasured,
  measurementOnlyDiffArgs,
  onlyMeasurementFilesChanged,
  parseStateRecord,
  recordStatePayload,
} from '../scripts/ci-measure-guard.js';
import { REALIGN_FILES } from '../scripts/realign-truth-main.js';

const HEAD = '16a5299fda2bd85eaa76bc4baadbce06ac869bde';

test('the recorded head needs no measure, short or full sha', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: '16a5299' }), true);
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: HEAD }), true);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: '16a5299' }), false);
});

test('a moved head measures', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: 'd906099' }), false);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: 'd906099' }), true);
});

test('a recorded sha that is not a prefix of the head measures', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: `${HEAD}1` }), false);
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: 'zzzzzzz' }), false);
});

test('missing or malformed values measure, never skip', () => {
  assert.equal(decideMeasure({ headSha: undefined, recordedSha: '16a5299' }), true);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: undefined }), true);
  assert.equal(decideMeasure({ headSha: 'not-a-sha', recordedSha: '16a5299' }), true);
  assert.equal(decideMeasure({}), true);
});

test('matching is case-insensitive and trims whitespace', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: '  16A5299\n' }), true);
});

test('the state file naming this head skips the run without a ledger match', () => {
  // The re-anchored merge always moves HEAD past the measured commit, so the
  // ledger alone never matches: the runner-local record is what skips the
  // unchanged-head window.
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: 'd906099', sidecarSha: HEAD }), false);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: 'd906099', sidecarSha: 'd9060991111111111111111111111111111111111' }), true);
});

test('an unusable state record never skips, it measures', () => {
  for (const text of ['', 'not json', '{}', '{"sha":"zzzzzzz"}', '{"sha":"16a5299"}', '{"measuredAt": 42}']) {
    assert.deepEqual(parseStateRecord(text), {});
  }
  assert.deepEqual(parseStateRecord(JSON.stringify({ sha: HEAD, measuredAt: 1 })), { sidecarSha: HEAD });
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: 'd906099', sidecarSha: undefined }), true);
});

test('the record payload needs a full head and a usable clock', () => {
  assert.deepEqual(recordStatePayload(HEAD, 1000), { sha: HEAD, measuredAt: 1000 });
  assert.equal(recordStatePayload('16a5299', 1000), null);
  assert.equal(recordStatePayload(HEAD, Number.NaN), null);
  assert.equal(recordStatePayload(undefined, 1000), null);
});

test('the diff excludes exactly the measurement-flow files, never a copy', () => {
  const args = measurementOnlyDiffArgs(HEAD);
  assert.deepEqual(
    args.filter((arg) => arg.startsWith(':!')),
    [...REALIGN_FILES].map((file) => `:!${file}`),
  );
  assert.ok(args.includes('HEAD') && args.includes('--quiet'));
  assert.deepEqual(measurementOnlyDiffArgs('16a5299'), []);
  assert.deepEqual(measurementOnlyDiffArgs(undefined), []);
});

test('a measurement-only move past the recorded head skips the run', () => {
  assert.equal(
    decideMeasure({ headSha: HEAD, recordedSha: 'd906099', sidecarSha: 'd906099d906099d906099d906099d906099d9060', measurementOnly: true }),
    false,
  );
  assert.equal(
    decideMeasure({ headSha: HEAD, recordedSha: 'd906099', sidecarSha: 'd906099d906099d906099d906099d906099d9060' }),
    true,
  );
});

test('only the measurement flow writing since the record skips, real code measures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-measure-guard-'));
  try {
    const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(git(['init', '-q']).status, 0);
    mkdirSync(join(dir, 'site'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'code.js'), 'v1\n');
    for (const file of REALIGN_FILES) writeFileSync(join(dir, file), 'measured: base\n');
    const commit = (message) => {
      assert.equal(git(['add', '-A']).status, 0);
      assert.equal(git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message]).status, 0);
      return git(['rev-parse', 'HEAD']).stdout.trim();
    };
    const measured = commit('base');
    for (const file of REALIGN_FILES) writeFileSync(join(dir, file), 'measured: re-anchored\n');
    const reanchored = commit('chore(truth): realign main');
    assert.notEqual(reanchored, measured);
    // The re-anchored merge moved HEAD without measuring anything new.
    assert.equal(onlyMeasurementFilesChanged(dir, measured), true);
    assert.equal(decideMeasure({ headSha: reanchored, recordedSha: 'd906099', sidecarSha: measured, measurementOnly: onlyMeasurementFilesChanged(dir, measured) }), false);
    writeFileSync(join(dir, 'code.js'), 'v2\n');
    const merged = commit('feat: real change');
    assert.equal(onlyMeasurementFilesChanged(dir, measured), false);
    assert.equal(decideMeasure({ headSha: merged, recordedSha: 'd906099', sidecarSha: measured, measurementOnly: onlyMeasurementFilesChanged(dir, measured) }), true);
    // An unknown base never skips: doubt measures.
    assert.equal(onlyMeasurementFilesChanged(dir, 'd906099d906099d906099d906099d906099d9060'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
