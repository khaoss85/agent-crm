// @ts-check

/**
 * Cure lane (backlog:55ca4e0cb76d): a PR with the `cure` label heals a red
 * main, so the fast gate takes the heavy name `fast-main-red-cure` (rank 0
 * in the CI server queue via the `main-red-` glob in heavy-job-priority.json).
 * Any other PR keeps `fast`: today's name and rank.
 *
 * The reserved `accordo-cure` runner is NOT registered yet (only the two
 * `accordo-ci` runners answer: #1093 asked for `accordo-cure` and queued 24 h,
 * then cancelled), so the workflow keeps every PR on today's `accordo-ci`
 * runners and must never route `runs-on` by label to a reserved-only label.
 * When the Leader Server registers the third runner, the `runs-on` below
 * goes back to the `cure` label.
 *
 * The runner choice lives in `.github/workflows/ci.yml` (GitHub evaluates
 * it); what this file proves locally is the observable contract around it:
 * the workflow names the cure heavy name by the `cure` label, and
 * `scripts/ci-fast-step.sh` turns CI_FAST_HEAVY_NAME into the heavy name
 * (or `fast` on anything missing or malformed).
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

/**
 * @param {Record<string, string>} env
 */
function runStep(dir, env) {
  // A fake `scripts/ci-heavy.sh` on a scratch cwd records the heavy name the
  // step asked for, instead of taking any lock.
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(
    join(dir, 'scripts', 'ci-heavy.sh'),
    '#!/bin/bash\necho "$1" > "$HEAVY_NAME_FILE"\nexit 0\n',
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
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: 'fast-main-red-cure' }), 'fast-main-red-cure');
});

test('a normal PR keeps today’s heavy name and rank', () => {
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: 'fast' }), 'fast');
  assert.equal(heavyName({}), 'fast', 'missing value falls back to fast');
});

test('a malformed heavy name never reaches the lock: it falls back to fast', () => {
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: '' }), 'fast');
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: 'fast;touch pwned' }), 'fast');
  assert.equal(heavyName({ CI_FAST_HEAVY_NAME: 'fast main-red' }), 'fast');
});

test('the workflow routes the fast job by the cure label', () => {
  assert.match(workflow, /contains\(github\.event\.pull_request\.labels\.\*\.name, 'cure'\)/);
  assert.match(workflow, /runs-on: \[self-hosted, accordo-ci\]/, 'every PR stays on today’s runners');
  assert.doesNotMatch(workflow, /runs-on:.*accordo-cure/, 'no runs-on asks for the unregistered runner');
  assert.match(workflow, /fast-main-red-cure/, 'the cure heavy name');
  assert.match(workflow, /Cure routing/, 'the routing is visible in the job log');
});
