// @ts-check

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { restoreProvenance } from '../scripts/vercel-unshallow.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-vercel-history-'));
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  git(source, 'config', 'user.email', 'test@example.com');
  git(source, 'config', 'user.name', 'Test');
  let measured = '';
  for (let index = 0; index < 4; index += 1) {
    writeFileSync(join(source, 'record.txt'), `${index}\n`);
    git(source, 'add', '.');
    git(source, 'commit', '-m', `commit ${index}`);
    if (index === 0) measured = git(source, 'rev-parse', 'HEAD');
  }
  return { root, source, measured };
}

function writeLedger(cwd, sha) {
  mkdirSync(join(cwd, 'site'), { recursive: true });
  writeFileSync(join(cwd, 'site', 'claims.json'), `${JSON.stringify({ measuredAgainst: { sha } })}\n`);
}

test('already-full checkout needs no fetch and proves the ledger SHA', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  writeLedger(value.source, value.measured.slice(0, 7));
  const calls = [];
  const status = restoreProvenance({
    cwd: value.source,
    runGit(args) {
      calls.push(args);
      return spawnSync('git', args, { cwd: value.source, encoding: 'utf8' });
    },
    out() {}, error() {},
  });
  assert.equal(status, 0);
  assert.equal(calls.some(([command]) => command === 'fetch'), false);
});

test('a shallow checkout passes only after a real fetch makes provenance available', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  const clone = join(value.root, 'clone');
  git(value.root, 'clone', '--depth=1', `file://${value.source}`, clone);
  writeLedger(clone, value.measured.slice(0, 7));
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true');
  assert.equal(restoreProvenance({ cwd: clone, out() {}, error() {} }), 0);
  assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false');
  git(clone, 'merge-base', '--is-ancestor', value.measured, 'HEAD');
});

test('zero-exit fetch without its post-condition falls back and never claims success early', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-vercel-strategy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeLedger(root, 'abcdef1');
  const calls = [];
  let fetches = 0;
  const state = { shallow: true, object: false, ancestor: false };
  const messages = [];
  const status = restoreProvenance({
    cwd: root,
    env: { VERCEL_GIT_REPO_OWNER: 'owner', VERCEL_GIT_REPO_SLUG: 'repo' },
    runGit(args) {
      calls.push(args);
      if (args[0] === 'fetch') {
        fetches += 1;
        if (fetches === 2) Object.assign(state, { object: true, ancestor: true });
        return { status: 0, stdout: '' };
      }
      if (args[0] === 'rev-parse') return { status: 0, stdout: state.shallow ? 'true\n' : 'false\n' };
      if (args[0] === 'cat-file') return { status: state.object ? 0 : 1 };
      if (args[0] === 'merge-base') return { status: state.ancestor ? 0 : 1 };
      return { status: 1 };
    },
    out(message) { messages.push(message); }, error(message) { messages.push(message); },
  });
  assert.equal(status, 0);
  assert.equal(fetches, 2);
  assert.match(messages[0], /exited 0 but provenance is still unproved/);
  assert.match(messages.at(-1), /provenance for abcdef1 verified/);
  assert.equal(
    calls.filter(([command]) => command === 'fetch').some((args) => args.includes('abcdef1')),
    false,
    'success occurred before the SHA-fetch fallback',
  );
});

test('bounded shallow history passes when the measured object and ancestry are proved', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-vercel-bounded-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeLedger(root, '7654321');
  let fetches = 0;
  const status = restoreProvenance({
    cwd: root,
    runGit(args) {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n' };
      if (args[0] === 'cat-file' || args[0] === 'merge-base') return { status: 0 };
      if (args[0] === 'fetch') fetches += 1;
      return { status: 1 };
    },
    out() {}, error() {},
  });
  assert.equal(status, 0);
  assert.equal(fetches, 0);
});

test('a failed first fetch reaches fallback; all failed strategies exit nonzero', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-vercel-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeLedger(root, '1234567');
  let fetches = 0;
  const errors = [];
  const status = restoreProvenance({
    cwd: root,
    env: { VERCEL_GIT_REPO_OWNER: 'owner', VERCEL_GIT_REPO_SLUG: 'repo' },
    runGit(args) {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true\n' };
      if (args[0] === 'fetch') { fetches += 1; return { status: 1, stderr: 'refused' }; }
      return { status: 1 };
    },
    out() {}, error(message) { errors.push(message); },
  });
  assert.equal(status, 1);
  assert.equal(fetches, 5);
  assert.match(errors[1], /https:\/\/github.com\/owner\/repo\.git/);
  assert.match(errors[0], /failed: refused; trying the next strategy/);
  assert.match(errors.at(-1), /unable to prove 1234567/);
});

test('a measured commit that exists but is not an ancestor fails closed', (t) => {
  const value = fixture();
  t.after(() => rmSync(value.root, { recursive: true, force: true }));
  git(value.source, 'checkout', '-b', 'side', value.measured);
  writeFileSync(join(value.source, 'side.txt'), 'side\n');
  git(value.source, 'add', '.');
  git(value.source, 'commit', '-m', 'side');
  const side = git(value.source, 'rev-parse', 'HEAD');
  git(value.source, 'checkout', 'main');
  writeLedger(value.source, side.slice(0, 7));
  const errors = [];
  assert.equal(restoreProvenance({ cwd: value.source, out() {}, error(message) { errors.push(message); } }), 1);
  assert.match(errors.at(-1), /is not an ancestor of HEAD/);
});

test('the current measured SHA is read from the authoritative ledger, never hardcoded', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-vercel-ledger-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeLedger(root, 'fedcba9');
  const calls = [];
  restoreProvenance({
    cwd: root,
    runGit(args) {
      calls.push(args);
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'false\n' };
      return { status: 1 };
    },
    out() {}, error() {},
  });
  assert.deepEqual(calls.find(([command]) => command === 'cat-file'), ['cat-file', '-e', 'fedcba9^{commit}']);
});
