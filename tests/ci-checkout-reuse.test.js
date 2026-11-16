import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// backlog:f16911e3 — every job start rewrote ~1.2 GB (fresh checkout) plus
// ~107 MB of npm ci and pushed server disk wait to 16-20%. The cure reuses
// the runner workspace (clean: false, incremental fetch). This test locks
// the contract: reused workspace everywhere in scope, full history only
// where a job reads it, and a fresh `npm ci` wherever tests run so no job
// ever reads stale files from the reused space.
const FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/bo-shots.yml',
  '.github/workflows/nightly-tool-selection.yml',
];

function checkoutsOf(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s*)?uses:\s*actions\/checkout@/);
    if (!m) continue;
    const dash = /^\s*-\s*uses:/.test(lines[i]);
    const indent = dash ? m[1].length : m[1].length - 2;
    const options = {};
    let hasWith = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const cur = line.match(/^(\s*)\S/);
      if (!cur || cur[1].length <= indent) break;
      if (/^\s*with:\s*$/.test(line)) {
        hasWith = true;
        continue;
      }
      const kv = line.match(/^\s*([a-z-]+):\s*(.+?)\s*$/);
      if (kv && hasWith) options[kv[1]] = kv[2];
    }
    found.push({ line: i + 1, options });
  }
  return found;
}

function read(name) {
  return readFileSync(join(root, name), 'utf8');
}

test('every checkout in scope reuses the runner workspace (clean: false)', () => {
  for (const name of FILES) {
    const steps = checkoutsOf(read(name));
    assert.ok(steps.length > 0, `${name} has no actions/checkout step`);
    for (const step of steps) {
      assert.equal(
        step.options.clean,
        'false',
        `${name}:${step.line} must set clean: false so the job start fetches incrementally instead of rewriting the workspace`,
      );
    }
  }
});

test('ci.yml jobs that read history keep the full fetch', () => {
  const steps = checkoutsOf(read('.github/workflows/ci.yml'));
  assert.equal(steps.length, 3, 'ci.yml must keep exactly its fast, verify and public-claims checkouts');
  for (const step of steps) {
    assert.equal(
      step.options['fetch-depth'],
      '0',
      `ci.yml:${step.line} needs fetch-depth 0 (touched-file diff and truth agreement read history)`,
    );
  }
});

test('history-free jobs take a shallow fetch', () => {
  for (const name of ['.github/workflows/bo-shots.yml', '.github/workflows/nightly-tool-selection.yml']) {
    const steps = checkoutsOf(read(name));
    assert.equal(steps.length, 1, `${name} must keep exactly one checkout`);
    assert.equal(
      steps[0].options['fetch-depth'],
      '1',
      `${name}:${steps[0].line} needs fetch-depth 1: neither the render nor the matrix reads history`,
    );
  }
});

test('jobs that run tests still reinstall from the lockfile (no stale reads)', () => {
  for (const name of ['.github/workflows/ci.yml', '.github/workflows/nightly-tool-selection.yml']) {
    const text = read(name);
    assert.match(text, /run:\s*npm ci/, `${name} must keep npm ci so the reused workspace never runs stale dependencies`);
  }
});

test('no npm Actions cache restore (it wrote ~160 MB per job)', () => {
  for (const name of FILES) {
    const text = read(name);
    assert.doesNotMatch(text, /^\s*cache:\s*['"]?npm/m, `${name} must not restore the npm Actions cache`);
  }
});
