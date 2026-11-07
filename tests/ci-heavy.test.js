import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
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

test('without the core lock nor a lock script the step runs as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-ci-heavy-'));
  try {
    const out = run({ ACCORDO_CORE_HEAVY_JOB: join(dir, 'none'), ACCORDO_HEAVY_JOB: join(dir, 'none') });
    assert.equal(out.trim(), 'step-ran');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
