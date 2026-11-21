import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

// backlog:f16911e3 — every job start rewrote ~1.2 GB (fresh checkout plus
// ~107 MB of npm ci) and pushed server disk wait to 16-20% (Leader 13/11).
// The closed PR #950 tried reusing the runner workspace between jobs; every
// round opened a new way for one job's code to survive into the next
// (.git/hooks, .git/info/attributes, .git/config keys acting during the
// checkout itself). The arbitration (supervisor 17/11) closed that road: no
// checkout reuse at all — every job checks out with clean:true, and the disk
// saving lives ONLY on dependencies, through the npm cache outside the work
// dir that npm itself verifies against the lockfile. clean:true wipes the
// worktree only, never the runner's `.git` (hooks, info/attributes, config
// keys can persist there): per-job fresh dirs stay a follow-up, so this file
// promises worktree-only cleaning, not a fresh `.git`. This file locks that
// contract:
//   1. every checkout in scope declares `clean: true` explicitly;
//   2. no `clean: false` anywhere in scope (no workspace reuse, no sanitize
//      dance: there is nothing to sanitize because nothing is reused);
//   3. every job that runs `npm ci` restores the npm cache first (same job,
//      same condition), so the only saving is the verified dependency cache;
//   4. no step executes repo code before its job's checkout, and jobs without
//      a checkout execute no repo code at all;
//   5. bo-shots still installs nothing (deterministic render of the ref);
//   6. the ci.yml jobs that read history keep the full fetch (touched-file
//      diff and truth agreement need it; the pack is under 3 MB).
const FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/bo-shots.yml',
  '.github/workflows/nightly-tool-selection.yml',
];

// backlog:a6def994 — the single cache contract: one key and one path shared
// by the nightly writer and every PR reader, so the restore always hits the
// entry the nightly saved. A restore with a different key prefix silently
// misses (the 20/11 failure: readers asked npm-* while the setup-node
// producer saved node-cache-*), so the key is part of the contract, not just
// the step shape.
const CACHE_PATH = '~/.npm';
const CACHE_KEY = "npm-${{ runner.os }}-${{ hashFiles('package-lock.json') }}";
const CACHE_RESTORE_KEYS = 'npm-${{ runner.os }}-';

// A read-only reader: actions/cache/restore with the contract key, prefix
// and path. The only cache shape allowed in ci.yml (no save post step).
function cacheReader(step) {
  return (
    step.uses !== null &&
    step.uses.startsWith('actions/cache/restore@') &&
    step.options.path === CACHE_PATH &&
    step.options.key === CACHE_KEY &&
    step.options['restore-keys'] === CACHE_RESTORE_KEYS
  );
}

// A save-capable writer: the full actions/cache (restores at step time, its
// post step saves only on an exact-key miss) or an explicit save, with the
// contract key and path. Lives only in the scheduled nightly workflow.
function cacheWriter(step) {
  return (
    step.uses !== null &&
    (step.uses.startsWith('actions/cache/save@') || /^actions\/cache@v\d+/.test(step.uses)) &&
    step.options.path === CACHE_PATH &&
    step.options.key === CACHE_KEY
  );
}

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
    if (/^\s*(#|$)/.test(line)) continue;
    const stepMatch = line.match(/^      - (.*)$/);
    if (stepMatch) {
      cur = { job, line: i + 1, uses: null, runFirst: '', runBody: [], iff: null, options: {} };
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
      cur.options[opt[1]] = opt[2].replace(/^['"]|['"]$/g, '');
      continue;
    }
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

test('every checkout in scope declares clean:true explicitly', () => {
  for (const name of FILES) {
    const found = checkouts(read(name));
    assert.ok(found.length > 0, `${name} has no actions/checkout step`);
    for (const step of found) {
      assert.equal(
        step.options.clean,
        'true',
        `${name}:${step.line} must set clean:true explicitly: no workspace reuse on the shared runner`,
      );
    }
  }
});

test('no workspace reuse anywhere in scope', () => {
  for (const name of FILES) {
    const text = read(name);
    assert.doesNotMatch(
      text,
      /clean:\s*false/,
      `${name} must not reuse the workspace: the arbitration closed that road after three rounds of new poison paths`,
    );
  }
});

test('jobs that install dependencies restore the verified npm cache first', () => {
  for (const name of FILES) {
    const steps = stepsOf(read(name));
    for (const inst of steps.filter((s) => s.uses === null && /(^|[^\w-])npm ci([^\w-]|$)/.test(runText(s)))) {
      // An unconditional cache restore covers a conditional install in the same
      // job; the reverse would leave the install without a cache.
      // Two shapes count (backlog:a6def994): the read-only actions/cache/restore
      // with the contract key and path (the only shape allowed in ci.yml: no
      // post step, no slow save) and, in the scheduled nightly workflow only,
      // the save-capable writer (full actions/cache, which restores at step
      // time) or the legacy setup-node npm cache. Either way npm itself
      // verifies every tarball against the lockfile on read.
      const cache = steps.find(
        (s) =>
          s.job === inst.job &&
          s.uses !== null &&
          (cacheReader(s) ||
            (name === '.github/workflows/nightly-tool-selection.yml' &&
              (cacheWriter(s) || (s.uses.startsWith('actions/setup-node@') && s.options.cache === 'npm')))) &&
          (s.iff === null || s.iff === inst.iff) &&
          s.line < inst.line,
      );
      assert.ok(
        cache,
        `${name}:${inst.line} runs npm ci without a prior npm cache restore in the same job: ` +
          `the only disk saving allowed is the read-only cache outside the work dir`,
      );
    }
  }
});

test('ci.yml never saves the npm cache (backlog:6cc2b44b stays fixed)', () => {
  const steps = stepsOf(read('.github/workflows/ci.yml'));
  for (const s of steps) {
    if (s.uses === null) continue;
    assert.ok(
      !(s.uses.startsWith('actions/setup-node@') && s.options.cache !== undefined),
      `ci.yml:${s.line} re-enables the setup-node cache: its save post step held jobs 13-17 min on 19/11; ` +
        `restore read-only with actions/cache/restore instead`,
    );
    assert.ok(
      !s.uses.startsWith('actions/cache/save@') && !/^actions\/cache@v\d+/.test(s.uses),
      `ci.yml:${s.line} saves the cache: only actions/cache/restore (read-only) is allowed here; ` +
        `the scheduled nightly workflow is the one that keeps the entry fresh`,
    );
  }
});

test('nightly writer and ci readers share one cache key and path (backlog:a6def994)', () => {
  // The restore only hits when the reader asks for exactly what the writer
  // saved: same key, same path. This is the 20/11 regression net — readers
  // on npm-* with a setup-node producer on node-cache-* passed every shape
  // check and missed every restore.
  const writers = stepsOf(read('.github/workflows/nightly-tool-selection.yml')).filter(cacheWriter);
  assert.equal(
    writers.length,
    1,
    `nightly must have exactly one cache writer with key ${CACHE_KEY} and path ${CACHE_PATH}, ` +
      `found ${writers.length}: the scheduled workflow is the one that keeps the entry fresh`,
  );
  const readers = stepsOf(read('.github/workflows/ci.yml')).filter(cacheReader);
  assert.equal(
    readers.length,
    3,
    `ci.yml must keep exactly three cache readers (fast, verify, public-claims), found ${readers.length}`,
  );
  for (const r of readers) {
    assert.equal(
      r.options.key,
      writers[0].options.key,
      `ci.yml:${r.line} restores key ${r.options.key} but the nightly writer saves ${writers[0].options.key}: ` +
        `the restore would miss`,
    );
    assert.equal(
      r.options.path,
      writers[0].options.path,
      `ci.yml:${r.line} restores path ${r.options.path} but the nightly writer saves ${writers[0].options.path}: ` +
        `the restore would miss`,
    );
  }
  // The actions/cache save post step needs `actions: write` (backlog:a6def994
  // review 20/11: with `actions: read` the save is denied warning-only, the
  // job stays green and no entry is ever written, so every PR restore misses).
  const nightly = read('.github/workflows/nightly-tool-selection.yml');
  assert.ok(
    /(^|\n)\s*actions:\s*write/m.test(nightly),
    `nightly-tool-selection.yml grants no actions:write: the single cache writer ` +
      `cannot save, the entry is never warmed and every ci.yml restore misses`,
  );
});

test('no repo code runs before its job checkout', () => {
  for (const name of FILES) {
    const steps = stepsOf(read(name));
    const byJob = new Map();
    for (const s of steps) {
      if (!byJob.has(s.job)) byJob.set(s.job, []);
      byJob.get(s.job).push(s);
    }
    for (const [job, list] of byJob) {
      const co = list.find((s) => s.uses !== null && /^actions\/checkout@/.test(s.uses));
      for (const code of list.filter(executesCode)) {
        if (co === undefined) {
          assert.fail(`${name}: job ${job}:${code.line} executes repo code with no checkout in the job`);
        }
        // An unconditional checkout covers conditional code below it; conditional
        // code under a different condition than the checkout is not covered.
        assert.ok(
          code.line > co.line && (co.iff === null || co.iff === code.iff),
          `${name}:${code.line} executes repo code before the checkout (${name}:${co.line}): ` +
            `nothing from the repo may run on a workspace the checkout has not cleaned`,
        );
      }
    }
  }
});

test('bo-shots still installs nothing', () => {
  const steps = stepsOf(read('.github/workflows/bo-shots.yml'));
  const installs = steps.filter(
    (s) => s.uses === null && /(^|[^\w-])npm (ci|install)([^\w-]|$)/.test(runText(s)),
  );
  assert.equal(installs.length, 0, 'bo-shots.yml must keep no install step: the render is node builtins only');
});

test('ci.yml jobs that read history keep the full fetch', () => {
  const found = checkouts(read('.github/workflows/ci.yml'));
  assert.equal(found.length, 3, 'ci.yml must keep exactly its fast, verify and public-claims checkouts');
  for (const step of found) {
    assert.equal(
      step.options['fetch-depth'],
      '0',
      `ci.yml:${step.line} needs fetch-depth 0 (touched-file diff and truth agreement read history)`,
    );
  }
});
