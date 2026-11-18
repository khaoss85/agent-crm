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
      const cache = steps.find(
        (s) =>
          s.job === inst.job &&
          s.uses !== null &&
          s.uses.startsWith('actions/setup-node@') &&
          s.options.cache === 'npm' &&
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
