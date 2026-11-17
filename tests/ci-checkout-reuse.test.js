import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// backlog:f16911e3 — every job start rewrote ~1.2 GB (fresh checkout plus
// ~107 MB of npm ci) and pushed server disk wait to 16-20%. The cure reuses
// the runner workspace (clean: false, incremental fetch). The shared runner
// also runs untrusted PR jobs before trusted main jobs in the same workspace,
// so an untracked leftover (a planted `.npmrc`, `.env`, tool config, stale
// node_modules) would poison the next job — and the checkout's own git would
// run on that poisoned state (smudge filters from a planted `.gitattributes`,
// `core.hooksPath`/`core.fsmonitor` hooks from the persisted `.git/config`)
// BEFORE any post-checkout cleanup. This file locks the contract that makes
// reuse safe:
//   1. every checkout in scope declares `clean` explicitly;
//   2. every `clean: false` checkout is preceded by an inline-shell sanitize
//      step BEFORE the checkout (same job, same `if:` condition) that drops
//      untracked leftovers AND unsets the `.git/config` keys git would act
//      on during the checkout itself; no step that executes repo code runs
//      before that sanitize step (when the checkout is skipped, no code
//      runs at all);
//   3. every `clean: false` checkout keeps a `git clean -ffdx` step AFTER
//      the checkout as a second layer, still BEFORE the first step that
//      executes repo code;
//   4. bo-shots renders with no install step, so it keeps `clean: true`
//      (deterministic render of exactly the checked-out ref);
//   5. jobs that run code still reinstall from the lockfile;
//   6. no npm Actions cache restore;
//   7. the post-merge production measure has a numeric target and a revert
//      trigger, pinned here so they cannot drift silently.
const FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/bo-shots.yml',
  '.github/workflows/nightly-tool-selection.yml',
];

function read(name) {
  return readFileSync(join(root, name), 'utf8');
}

// Minimal YAML-shape scan: jobs (2-space keys under `jobs:`), their steps
// (6-space `- ` items), each step's 8-space fields (`uses`/`run`/`if:`) and
// the 10-space options under `with:`. Multiline `run: |` bodies are collected
// so `node`/`npm` usage inside them still counts as code execution.
function stepsOf(text) {
  const lines = text.split('\n');
  const steps = [];
  let inJobs = false;
  let job = null;
  let cur = null;
  let withMode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[^\s#]/.test(line)) {
      inJobs = /^jobs:\s*(#.*)?$/.test(line);
      job = null;
      cur = null;
      withMode = false;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = line.match(/^  ([A-Za-z0-9_.-]+):\s*(#.*)?$/);
    if (jobMatch) {
      job = jobMatch[1];
      cur = null;
      withMode = false;
      continue;
    }
    if (job === null) continue;
    // Blank and comment lines carry no structure: they must neither close a
    // `with:` block nor count as script content (comments sit inside `with:`
    // blocks, e.g. the fetch-depth note in ci.yml).
    if (/^\s*(#|$)/.test(line)) continue;
    const stepMatch = line.match(/^      - (.*)$/);
    if (stepMatch) {
      cur = { job, line: i + 1, uses: null, runFirst: '', runBody: [], iff: null, options: {} };
      // The key may sit on the dash line itself (`- uses:`, `- if:`, `- run:`, `- name:`).
      const head = stepMatch[1];
      const headUses = head.match(/^uses:\s*(\S+)/);
      if (headUses) cur.uses = headUses[1];
      const headIf = head.match(/^if:\s*(.+?)\s*$/);
      if (headIf) cur.iff = headIf[1];
      const headRun = head.match(/^run:\s*(.*)$/);
      if (headRun) cur.runFirst = headRun[1];
      steps.push(cur);
      withMode = false;
      continue;
    }
    if (cur === null) continue;
    const field = line.match(/^        ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) {
      withMode = field[1] === 'with';
      if (field[1] === 'uses') cur.uses = field[2].trim();
      else if (field[1] === 'run') cur.runFirst = field[2];
      else if (field[1] === 'if') cur.iff = field[2].trim();
      continue;
    }
    const opt = line.match(/^          ([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (opt && withMode) {
      cur.options[opt[1]] = opt[2];
      continue;
    }
    // Any line indented past the step fields belongs to a multiline `run: |`
    // body, however deeply the shell nests it: the contract must read the
    // whole sanitize script, not just its first level.
    if (/^          /.test(line)) {
      cur.runBody.push(line);
      withMode = false;
    }
  }
  return steps;
}

function checkouts(text) {
  return stepsOf(text).filter((s) => s.uses !== null && /^actions\/checkout@/.test(s.uses));
}

function runText(step) {
  return `${step.runFirst}\n${step.runBody.join('\n')}`;
}

// A step executes repo code when it runs node/npm (or a repo script through
// any launcher). Plain-shell steps (`git fetch`, `docker run`, `gh api`,
// `echo`) do not read the workspace and need no pairing.
function executesCode(step) {
  if (step.uses !== null) return false;
  const body = runText(step);
  return /(^|[^\w-])(node|npm|npx|bash)([^\w-]|$)/.test(body) || body.includes('scripts/');
}

test('every checkout in scope declares clean explicitly', () => {
  for (const name of FILES) {
    const found = checkouts(read(name));
    assert.ok(found.length > 0, `${name} has no actions/checkout step`);
    for (const step of found) {
      assert.ok(
        step.options.clean === 'false' || step.options.clean === 'true',
        `${name}:${step.line} must set clean explicitly`,
      );
    }
  }
});

test('ci.yml jobs that read history keep the full fetch', () => {
  const found = checkouts(read('.github/workflows/ci.yml'));
  assert.equal(found.length, 3, 'ci.yml must keep exactly its fast, verify and public-claims checkouts');
  for (const step of found) {
    assert.equal(step.options.clean, 'false', `ci.yml:${step.line} must reuse the workspace`);
    assert.equal(
      step.options['fetch-depth'],
      '0',
      `ci.yml:${step.line} needs fetch-depth 0 (touched-file diff and truth agreement read history)`,
    );
  }
});

test('history-free checkouts take a shallow fetch', () => {
  for (const name of ['.github/workflows/bo-shots.yml', '.github/workflows/nightly-tool-selection.yml']) {
    const found = checkouts(read(name));
    assert.equal(found.length, 1, `${name} must keep exactly one checkout`);
    assert.equal(
      found[0].options['fetch-depth'],
      '1',
      `${name}:${found[0].line} needs fetch-depth 1: neither the render nor the matrix reads history`,
    );
  }
});

// A step sanitizes the reused workspace when it is inline shell (no `uses:`,
// so no repo code) that drops untracked leftovers AND unsets the
// `.git/config` keys whose commands git would run during the checkout
// itself (core.hooksPath, core.fsmonitor, smudge/clean filters).
function sanitizesWorkspace(step) {
  if (step.uses !== null) return false;
  const body = runText(step);
  return (
    body.includes('git clean -ffdx') &&
    body.includes('core.hooksPath') &&
    body.includes('core.fsmonitor') &&
    body.includes('config --get-regexp')
  );
}

test('every clean:false checkout is sanitized BEFORE the checkout runs', () => {
  for (const name of FILES) {
    const steps = stepsOf(read(name));
    for (const co of steps.filter((s) => s.uses !== null && /^actions\/checkout@/.test(s.uses))) {
      if (co.options.clean !== 'false') continue;
      const clean = steps.find(
        (s) =>
          s.job === co.job &&
          s.uses === null &&
          s.iff === co.iff &&
          s.line < co.line &&
          sanitizesWorkspace(s),
      );
      assert.ok(
        clean,
        `${name}:${co.line} reuses the workspace but no pre-checkout sanitize step precedes it ` +
          `under the same condition: the checkout's own git would run on the previous job's ` +
          `poisoned state before any cleanup`,
      );
      for (const code of steps.filter((s) => s.job === co.job && s.iff === co.iff && executesCode(s))) {
        assert.ok(
          code.line > clean.line,
          `${name}:${code.line} executes repo code before the pre-checkout sanitize ` +
            `(${name}:${clean.line}): no repo code may run on the reused space before it`,
        );
      }
    }
  }
});

test('every clean:false checkout is paired with an untracked-file drop before first code execution', () => {
  for (const name of FILES) {
    const steps = stepsOf(read(name));
    for (const co of steps.filter((s) => s.uses !== null && /^actions\/checkout@/.test(s.uses))) {
      if (co.options.clean !== 'false') continue;
      const drop = steps.find(
        (s) =>
          s.job === co.job &&
          s.uses === null &&
          s.iff === co.iff &&
          s.line > co.line &&
          runText(s).includes('git clean -ffdx'),
      );
      assert.ok(
        drop,
        `${name}:${co.line} reuses the workspace but no 'git clean -ffdx' step follows it ` +
          `under the same condition: an untracked leftover from a previous job would poison this one`,
      );
      for (const code of steps.filter((s) => s.job === co.job && s.iff === co.iff && executesCode(s))) {
        assert.ok(
          code.line > drop.line,
          `${name}:${code.line} executes repo code before the untracked-file drop ` +
            `(${name}:${drop.line}): the drop must come first`,
        );
      }
    }
  }
});

test('bo-shots renders deterministically: clean:true, no reuse, no install needed', () => {
  const found = checkouts(read('.github/workflows/bo-shots.yml'));
  assert.equal(found.length, 1, 'bo-shots.yml must keep exactly one checkout');
  assert.equal(
    found[0].options.clean,
    'true',
    'bo-shots.yml must keep clean:true: with no install step a reused space would render a stale tree',
  );
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

test('post-merge production measure has a numeric target and a revert trigger', () => {
  // Production-only (reads the server, never re-runs the changed code): mean
  // over the next 3 jobs after the merge. The supervisor round checks it;
  // above either number the clean:false hunks are reverted.
  const ci = read('.github/workflows/ci.yml');
  const budget = ci.match(/disk-budget-gb-per-job-start\s+([0-9.]+)/);
  assert.ok(budget, 'ci.yml must pin disk-budget-gb-per-job-start (was ~1.3 GB: ~1.2 rewrite + ~0.1 npm ci)');
  assert.equal(budget[1], '0.7', 'disk budget per job start must read 0.7 GB');
  const wait = ci.match(/disk-wait-pct\s+below\s+([0-9]+)/);
  assert.ok(wait, 'ci.yml must pin disk-wait-pct below (was 16-20%)');
  assert.equal(wait[1], '5', 'disk wait must stay below 5% at job start');
  assert.match(ci, /revert-when/, 'ci.yml must name the revert trigger for a missed production target');
});
