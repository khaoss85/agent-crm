// @ts-check

/**
 * Cure lane (backlog:55ca4e0cb76d): a PR with the `cure` label heals a red
 * main, so the fast gate runs on the reserved `accordo-cure` runner and
 * takes the heavy name `fast-main-red-cure` (rank 0 in the CI server queue
 * via the `main-red-` glob in heavy-job-priority.json). Any other PR keeps
 * `fast`: today's lane and rank.
 *
 * The runner choice lives in `.github/workflows/ci.yml` (GitHub evaluates
 * it); what this file proves locally is the observable contract around it:
 * the workflow routes by the `cure` label, and `scripts/ci-fast-step.sh`
 * turns CI_FAST_HEAVY_NAME into the heavy name (or `fast` on anything
 * missing or malformed).
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
  return spawnSync('bash', [stepScript], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
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
  assert.match(workflow, /accordo-cure/, 'the reserved runner label');
  assert.match(workflow, /accordo-ci/, 'a normal PR stays on today’s runners');
  assert.match(workflow, /fast-main-red-cure/, 'the cure heavy name');
  assert.match(workflow, /Cure routing/, 'the routing is visible in the job log');
});
