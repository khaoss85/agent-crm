import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(env) {
  return execFileSync('bash', ['scripts/ci-heavy.sh', 'fast', '--', 'echo', 'step-ran'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

test('the installed core lock wins and reads the server policy without sourcing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-'));
  try {
    const core = join(dir, 'heavy-job.sh');
    writeFileSync(core, '#!/bin/bash\necho "args=$*"\nenv | grep ^HEAVY_JOB_ | sort\n');
    chmodSync(core, 0o755);
    const conf = join(dir, '60-heavy-job.conf');
    writeFileSync(conf, '# policy\nHEAVY_JOB_SLOTS=2\nHEAVY_JOB_SLOT2_NEVER=^(release|suite|build)\nHEAVY_JOB_MAX_SEC=9999\nOTHER=x\n');
    const out = run({
      ACCORDO_CORE_HEAVY_JOB: core,
      ACCORDO_HEAVY_JOB_CONF: conf,
      ACCORDO_HEAVY_JOB: join(dir, 'server-local-lock.sh'),
      HEAVY_JOB_MAX_SEC: '540',
    });
    assert.match(out, /^args=accordo ci-fast -- echo step-ran$/m);
    assert.match(out, /^HEAVY_JOB_SLOTS=2$/m);
    assert.match(out, /^HEAVY_JOB_SLOT2_NEVER=\^\(release\|suite\|build\)$/m);
    // A value the step already set is not overridden by the policy file.
    assert.match(out, /^HEAVY_JOB_MAX_SEC=540$/m);
    assert.doesNotMatch(out, /OTHER=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeLock(dir, file) {
  const path = join(dir, file);
  writeFileSync(path, '#!/bin/bash\necho "lock=$0 args=$*"\nenv | grep ^HEAVY_JOB_ | sort\n');
  chmodSync(path, 0o755);
  return path;
}

test('without the core lock an explicit ACCORDO_HEAVY_JOB is still the lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-'));
  try {
    const custom = fakeLock(dir, 'custom.sh');
    const out = run({ ACCORDO_CORE_HEAVY_JOB: join(dir, 'none'), ACCORDO_HEAVY_JOB: custom });
    assert.match(out, new RegExp(`^lock=${custom} args=accordo ci-fast -- echo step-ran$`, 'm'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing policy file still runs the core lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-'));
  try {
    const core = fakeLock(dir, 'core.sh');
    const out = run({ ACCORDO_CORE_HEAVY_JOB: core, ACCORDO_HEAVY_JOB_CONF: join(dir, 'absent.conf') });
    assert.match(out, /args=accordo ci-fast -- echo step-ran/);
    assert.doesNotMatch(out, /HEAVY_JOB_SLOTS=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the last policy line counts without a newline and a malformed key is skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-'));
  try {
    const core = fakeLock(dir, 'core.sh');
    const conf = join(dir, 'policy.conf');
    writeFileSync(conf, 'HEAVY_JOB_bad-key=1\nHEAVY_JOB_=2\nHEAVY_JOB_NOVALUE\nHEAVY_JOB_SLOTS=2');
    const out = run({ ACCORDO_CORE_HEAVY_JOB: core, ACCORDO_HEAVY_JOB_CONF: conf });
    assert.match(out, /^HEAVY_JOB_SLOTS=2$/m);
    assert.match(out, /args=accordo ci-fast -- echo step-ran/);
    assert.doesNotMatch(out, /bad-key/);
    assert.doesNotMatch(out, /HEAVY_JOB_NOVALUE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unset HOME does not abort the step', () => {
  const out = execFileSync('bash', ['scripts/ci-heavy.sh', 'fast', '--', 'echo', 'step-ran'], {
    cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH },
  });
  assert.equal(out.trim(), 'step-ran');
});

test('the nightly measurement (ACCORDO_HEAVY_QUEUE=ci) uses the CI server queue, not the shared one', () => {
  const home = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-home-'));
  try {
    mkdirSync(join(home, 'ci-server'), { recursive: true });
    const ciQueue = fakeLock(join(home, 'ci-server'), 'heavy.sh');
    const core = fakeLock(home, 'core.sh');
    const out = execFileSync('bash', ['scripts/ci-heavy.sh', 'measure-1-of-6', '--', 'echo', 'step-ran'], {
      cwd: root, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ACCORDO_HEAVY_QUEUE: 'ci' },
    });
    assert.match(out, new RegExp(`^lock=${ciQueue} args=accordo ci-measure-1-of-6 -- echo step-ran$`, 'm'));
    const shared = execFileSync('bash', ['scripts/ci-heavy.sh', 'fast', '--', 'echo', 'step-ran'], {
      cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ACCORDO_CORE_HEAVY_JOB: core },
    });
    assert.match(shared, new RegExp(`^lock=${core} args=accordo ci-fast`, 'm'), 'without the variable the PR gate stays in the shared queue');
    const forced = execFileSync('bash', ['scripts/ci-heavy.sh', 'measure-1-of-6', '--', 'echo', 'step-ran'], {
      cwd: root, encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, ACCORDO_HEAVY_QUEUE: 'ci', ACCORDO_CORE_HEAVY_JOB: core },
    });
    assert.match(forced, new RegExp(`^lock=${core} `, 'm'), 'an explicit ACCORDO_CORE_HEAVY_JOB still wins over the CI queue');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('without the core lock nor a lock script the step runs as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-'));
  try {
    const out = run({ ACCORDO_CORE_HEAVY_JOB: join(dir, 'none'), ACCORDO_HEAVY_JOB: join(dir, 'none') });
    assert.equal(out.trim(), 'step-ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
