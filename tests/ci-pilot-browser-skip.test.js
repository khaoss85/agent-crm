// @ts-check

/**
 * Skip-path proof for `scripts/ci-pilot-browser.sh` (backlog:ae2d5d3c): a
 * diff that does not touch `apps/admin/public/` exits 0 in about a second
 * without cloning the pilot — the "PRs that do not touch the client pay
 * nothing" acceptance. The run path needs the network and the pilot, so it
 * is exercised by the fast CI job itself, not here: the script points at a
 * throwaway repo through AGENT_CRM_DIR and never clones on this diff.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execGit } from './helpers/isolated-git.js';

const SCRIPT = new URL('../scripts/ci-pilot-browser.sh', import.meta.url).pathname;

/** @param {string} dir */
function git(dir, ...args) {
  execGit(args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
}

function throwawayRepo() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'ci-pilot-browser-skip-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  fs.mkdirSync(join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(join(dir, 'docs', 'x.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '-qb', 'pr');
  return dir;
}

test('a docs-only diff skips the pilot browser proof without cloning', () => {
  const dir = throwawayRepo();
  try {
    fs.writeFileSync(join(dir, 'docs', 'x.md'), 'changed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'docs only');
    const started = Date.now();
    const out = execFileSync('bash', [SCRIPT], {
      cwd: dir,
      env: {
        ...process.env,
        BASE_REF: 'main',
        AGENT_CRM_DIR: dir,
        HEAD_SHA: 'test-head',
        // An unreachable remote proves no clone is attempted: a run path
        // would fail here instead of skipping.
        PILOT_GIT_URL: 'file:///nonexistent-pilot-remote',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(out, /pilot-browser: SKIP in \d+s/);
    assert.match(out, /no change under apps\/admin\/public/);
    assert.ok(Date.now() - started < 60_000, 'the skip stays fast');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a packages-only diff skips the pilot browser proof as well', () => {
  const dir = throwawayRepo();
  try {
    fs.mkdirSync(join(dir, 'packages', 'demo'), { recursive: true });
    fs.writeFileSync(join(dir, 'packages', 'demo', 'index.js'), 'export const x = 1;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'packages only');
    const out = execFileSync('bash', [SCRIPT], {
      cwd: dir,
      env: {
        ...process.env,
        BASE_REF: 'main',
        AGENT_CRM_DIR: dir,
        HEAD_SHA: 'test-head',
        PILOT_GIT_URL: 'file:///nonexistent-pilot-remote',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.match(out, /pilot-browser: SKIP in \d+s/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
