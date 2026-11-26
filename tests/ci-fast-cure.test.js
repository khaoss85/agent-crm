// @ts-check

/**
 * Cure lane (backlog:55ca4e0cb76d): a PR with the `cure` label heals a red
 * main, so the fast gate must not queue 3 h behind ordinary PRs. The routing
 * has two halves, both pinned here to their definition — never to comments:
 *
 * - runner: the workflow routes a `cure` PR to the reserved `accordo-cure`
 *   runner (registered by the Leader Server); any other PR stays on today's
 *   `accordo-ci` runners. A static `runs-on` (the 21/11 revert, which sent
 *   every cure PR back to the shared runners) fails the routing test below.
 * - rank: the workflow names a `cure` PR's gate `fast-main-red-cure` (rank 0
 *   in the CI server queue via the `main-red-` glob), and
 *   `scripts/ci-fast-step.sh` turns CI_FAST_HEAVY_NAME into the heavy name
 *   (or `fast` on anything missing or malformed), handing the sanitized lane
 *   to the busy retry so a cure keeps its rank on the retry too.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stepScript = join(repoRoot, 'scripts', 'ci-fast-step.sh');
const workflow = readFileSync(join(repoRoot, '.github/workflows', 'ci.yml'), 'utf8');

// The fast job block: everything the routing test pins lives in it. Slicing
// by job keeps the `verify` and `public-claims` jobs' own `runs-on` lines
// (today's static `accordo-ci`, untouched by the cure lane) out of scope.
const fastStart = workflow.indexOf('\n  fast:\n');
assert.notEqual(fastStart, -1, 'the fast job exists');
const verifyStart = workflow.indexOf('\n  verify:', fastStart);
assert.notEqual(verifyStart, -1, 'the verify job follows the fast job');
const fastJob = workflow.slice(fastStart, verifyStart);

/**
 * The single routing definition: the workflow names the gate's heavy name by
 * the `cure` label. Matched exactly and only once, so a typo in the value
 * (e.g. `fast-main-red-curex`, still sanitizer-valid but rankless) or a
 * comment-only mention fails here instead of certifying a silent cure.
 * @returns {{ cure: string, normal: string }}
 */
function routingDefinition() {
  const pattern = /CI_FAST_HEAVY_NAME: \$\{\{ contains\(github\.event\.pull_request\.labels\.\*\.name, 'cure'\) && '([A-Za-z0-9_-]+)' \|\| '(fast)' \}\}/g;
  const matches = [...workflow.matchAll(pattern)];
  assert.equal(matches.length, 1, 'exactly one cure/normal heavy-name definition');
  const [, cure, normal] = matches[0];
  assert.ok(cure.includes('main-red'), 'the cure heavy name carries the rank-0 token');
  return { cure, normal };
}

/**
 * @param {Record<string, string>} env
 */
function runStep(dir, env) {
  // A fake `scripts/ci-heavy.sh` on a scratch cwd records the heavy name the
  // step asked for, instead of taking any lock.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'ci-heavy.sh'),
    '#!/bin/bash\necho \"$1\" > \"$HEAVY_NAME_FILE\"\nexit 0\n',
  );
  chmodSync(join(dir, 'scripts', 'ci-heavy.sh'), 0o755);
  // The step reads CI_FAST_* from its environment: never inherit the real
  // job's values (a `cure` CI job exports CI_FAST_HEAVY_NAME=fast-main-red-cure,
  // which would leak into the "missing value" case). Each case sets exactly
  // what it means through `env`.
  const base = { ...process.env };
  delete base.CI_FAST_HEAVY_NAME;
  delete base.CI_FAST_GATE_CMD;
  delete base.CI_FAST_RETRY_CMD;
  return spawnSync('bash', [stepScript], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...base,
      CI_TOUCHED_BUSY_FILE: join(dir, 'busy.json'),
      HEAVY_NAME_FILE: join(dir, 'heavy-name.txt'),
      ...env,
    },
  });
}

/**
 * @param {Record<string, string>} env
 */
function heavyName(env) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-fast-cure-'));
  try {
    const run = runStep(dir, env);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^ci-fast-step: heavy-name=/m, 'the heavy name is visible in the log');
    return readFileSync(join(dir, 'heavy-name.txt'), 'utf8').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a cure PR takes the main-red heavy name (rank 0 in the server queue)', () => {
  const { cure } = routingDefinition();
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: cure }), cure);
});

test('a normal PR keeps today’s heavy name and rank', () => {
  const { normal } = routingDefinition();
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: normal }), normal);
  assert.equal(heavyName({}), normal, 'missing value falls back to today’s name');
});

test('a malformed heavy name never reaches the lock: it falls back to today’s name', () => {
  const { normal } = routingDefinition();
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: '' }), normal);
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: 'fast;touch pwned' }), normal);
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: 'fast main-red' }), normal);
});

test('a cure PR takes the reserved accordo-cure runner, any other PR stays on accordo-ci', () => {
  // Anchored to the `runs-on:` line itself (single-line match): workflow
  // comments also name both runners, so a bare /accordo-cure/ match would
  // pass on a static `runs-on` and certify a cure that queues nowhere.
  assert.match(fastJob, /runs-on:.*contains\(github\.event\.pull_request\.labels\.\*\.name, 'cure'\)/, 'runs-on branches on the cure label');
  assert.match(fastJob, /runs-on:.*accordo-cure/, 'a cure PR leaves the shared runners');
  assert.match(fastJob, /runs-on:.*accordo-ci/, 'any other PR stays on today’s runners');
  assert.doesNotMatch(fastJob, /runs-on: \[self-hosted, accordo-ci\]/, 'no static runs-on for every PR (the 21/11 revert)');
  // The routing echo lives in the step's `run:` block, reading the values —
  // not in a comment describing them.
  const stepAt = fastJob.indexOf('- name: Cure routing (runner and queue rank)');
  assert.notEqual(stepAt, -1, 'the cure routing step exists');
  const nextStepAt = fastJob.indexOf('- name: PR gate under one machine lock', stepAt);
  assert.notEqual(nextStepAt, -1, 'the gate step follows the routing step');
  const code = fastJob.slice(stepAt, nextStepAt).split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.ok(code.some((line) => line.includes('*,cure,*)') && code.some((other) => other.includes('runner=accordo-cure'))), 'the run block derives the cure runner from the labels');
  assert.ok(code.some((line) => line.includes('heavy-name=$CI_FAST_HEAVY_NAME')), 'the run block echoes the heavy name it runs under');
});

test('the step hands its sanitized lane to the busy retry', () => {
  const { cure, normal } = routingDefinition();
  for (const [input, lane] of [
    [cure, cure],
    [normal, normal],
    ['fast;touch pwned', normal],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'ci-fast-cure-'));
    try {
      const base = { ...process.env };
      delete base.CI_FAST_HEAVY_NAME;
      delete base.CI_FAST_GATE_CMD;
      delete base.CI_FAST_RETRY_CMD;
      // The gate fails and leaves a busy-shaped record, so the step takes
      // the retry path; the retry command prints the lane it inherited.
      const run = spawnSync('bash', [stepScript], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...base,
          CI_TOUCHED_BUSY_FILE: join(dir, 'busy.json'),
          CI_FAST_GATE_CMD: `echo '{"threshold": 24}' > ${join(dir, 'busy.json')}; exit 1`,
          CI_FAST_RETRY_CMD: 'echo "retry-lane=$CI_FAST_HEAVY_NAME"',
          CI_FAST_HEAVY_NAME: input,
        },
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      // End-anchored: a step that passed the raw value through would print
      // `retry-lane=fast;touch pwned`, which still contains `retry-lane=fast`.
      assert.match(run.stdout, new RegExp(`retry-lane=${lane.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}$`, 'm'), `the retry inherits the sanitized lane of ${input}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the cure routing step never interpolates labels into run: (script injection)', () => {
  assert.match(workflow, /CURE_LABELS:.*join\(github\.event\.pull_request\.labels/, 'labels pass through env');
  // Every line reading labels from the github context must be an env: or
  // if:/contains() expression — never a shell line under run:, where GitHub
  // substitutes the value into the script before the shell parses it.
  const bad = workflow.split('\n').filter((line) => line.includes('github.event.pull_request.labels')
    && !line.includes('CURE_LABELS') && !line.includes('contains('));
  assert.deepEqual(bad, [], 'label reads live only in env/if, never in run:');
});
