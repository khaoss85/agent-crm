// @ts-check

/**
 * Runs the tests of the files a change touched — the fast PR gate.
 *
 * The full `npm test` over 207 files holds the shared Mac's single heavy lock
 * for ~20 minutes (CI run 38983644969: the 22.9-minute measure step), so it
 * runs only on `main`, not on every PR push. A PR instead runs this: the test
 * files it changed plus every test file that relatively imports a file it
 * changed. The rest of the corpus is still covered — by the `main` run the PR
 * merges into — so this is a smaller scope, not a smaller standard.
 *
 * Mapping rules (see `selectTouchedTests`, unit-tested in
 * tests/ci-touched-tests.test.js):
 *
 * - a changed `*.test.js`/`*.test.mjs` under `tests/` runs itself;
 * - a changed file imported relatively by a test file runs its importers
 *   (specifiers are resolved against the importing file, extension-free),
 *   following imports transitively through every relative JS import in the
 *   repository — `tests/helpers` and fixtures, `packages/` barrels,
 *   `scripts/`, `apps/`, `examples/`: a test that reaches the changed file
 *   only via a helper or a barrel re-export is still selected;
 * - `export ... from` re-exports count as imports for the mapping above.
 *   The mapping walks the graph backwards: forward edges are indexed once
 *   per run, then a single reverse search from the changed files finds the
 *   reaching tests, instead of one forward search per test file;
 * - a changed file no test file reaches selects nothing only when no
 *   JavaScript source changed (docs, workflows, `package.json`, site
 *   content): the agreement gates of the same CI job (`gtm:check`,
 *   `repo:truth -- --check`) still run. A changed `.js`/`.cjs`/`.mjs` file
 *   with no reaching test fails closed instead: the step refuses with
 *   exit 1, naming the uncovered files, rather than exiting 0 without
 *   running anything.
 *
 * - the repo-wide guards (`REPO_WIDE_GUARDS` below) always run on top of
 *   the selection, on every non-empty diff. They are the test files whose
 *   verdict depends on files they never relatively import — repo-wide
 *   `grep` scans and recursive walks of `packages/`, `apps/`, `tests/`
 *   or `scripts/` — so the import mapping above never selects them, and
 *   the fail-closed refusal never fires for them either (it fires only
 *   when NO test is selected at all, while a normal PR always selects
 *   some). Twice `main` turned red after green-alone PRs for exactly
 *   this: #222 against #221 (`tests/isolated-git.test.js`) and #234
 *   (`tests/actor-fails-closed.test.js:251`). The guards never substitute
 *   for missing coverage: the fail-closed refusal is decided on the
 *   mapped selection alone, before the guards join it.
 *
 * Two budgets bound the step so a big PR cannot wedge it (CI run
 * 39044361164: 100 selected files, the run outlived its bound and the step
 * failed red on a change that needed the gate most):
 *
 * - the selection phase (graph build plus mapping) has 60 seconds
 *   (`--select-timeout-sec`). Past it the gate warns and runs the default
 *   fast suite instead of failing for the timeout;
 * - a selection bigger than `--max-selected` (default 50: that run executed
 *   ~65 of 100 selected files in the full 270 s, so 50 leaves margin for
 *   the slowest files) never starts the run it cannot finish: the gate
 *   warns and runs the default fast suite instead.
 *
 * The default fast suite is the PR's own changed test files — always
 * relevant, self-maintaining, and small by construction. It is not the
 * default `npm test` suite: the full suite holds the machine lock
 * ~20 minutes and cannot fit this step's five-minute budget, so it still
 * runs only on `main`, which stays the safety net behind every fallback.
 *
 * Usage:
 *
 *   node scripts/ci-touched-tests.js [--base <rev>] [--list] [--timeout-sec <n>]
 *     [--select-timeout-sec <n>] [--max-selected <n>]
 *
 * `--base` is the revision the change is measured against (`origin/main` by
 * default; CI fetches the PR base and passes it explicitly). `--list` prints
 * the files that would run (the selection, or the default fast suite when
 * the gate would fall back) without running them. The run itself is bounded:
 * the per-step CI budget is five minutes, so the run timeout refuses to hold
 * the machine lock longer than that — a hanging run fails red instead of
 * queueing every other factory behind it. The run bound additionally yields
 * to the selection phase so select-plus-run always fits the step wrapper.
 *
 * Exit codes: 0 the tests that ran passed (the selection plus the
 * repo-wide guards, or the fallback suite plus the guards after a warned
 * fallback; an empty diff runs nothing), 1 the selection failed, a test
 * failed, the fallback run failed, a listed guard is missing from `tests/`,
 * or the fail-closed refusal (a changed source file no test reaches,
 * decided before the guards join), 2 unusable input.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

const TEST_FILE = /\.test\.[cm]?js$/;
const SOURCE_EXT = /\.[cm]?js$/;

/** This step's share of the PR machine-lock budget (<5 minutes per step). */
const DEFAULT_TIMEOUT_SEC = 270;

/** The selection phase's own budget: graph build plus mapping, in seconds. */
const DEFAULT_SELECT_TIMEOUT_SEC = 60;

/**
 * Past this many selected test files the gate runs the default fast suite
 * instead of starting a run the budget cannot hold (see the header).
 */
const DEFAULT_MAX_SELECTED = 50;

/**
 * The step wrapper's budget in `.github/workflows/ci.yml`: select-plus-run
 * must fit inside it, with a few seconds of margin for process startup.
 */
const STEP_BUDGET_SEC = 300;

/**
 * The repo-wide guards: test files whose verdict depends on repository
 * files they never relatively import, so neither the import mapping nor
 * the fail-closed refusal below ever selects them. Every entry runs on
 * every non-empty diff, on top of the mapped selection (see
 * `withRepoWideGuards`). THE single declaration: `tests/ci-touched-tests.test.js`
 * fails when a repo-wide guard exists outside this list (one direction:
 * a listed file that stops scanning stays listed until someone removes
 * it — removal, not silence, is the update path).
 *
 * Membership rule: the file scans `packages/`, `apps/`, `tests/` or
 * `scripts/` wholesale — a repo-wide `grep`/`rg`, or a recursive directory
 * walk seeded at the repository — so adding any file there can flip its
 * verdict. A test that reads one fixed repo file, or walks a scratch
 * directory it built itself, is not a guard: its fixed path is either
 * mapped through a relative import or covered by the fail-closed refusal.
 *
 * Measured cost on the shared Mac (2026-10-18, `node --test` per file):
 * isolated-git ~1.1 s, spine-tenancy-truth ~2.1 s,
 * commercial-quotes-deprecation ~0.5 s, actor-fails-closed ~1.3 s,
 * scenario-document ~1.4 s, signed-terms-consumption-guard ~0.3 s,
 * spine-v2-m2-final-raw-boundary ~9.8 s,
 * agent-tool-selection-contract ~0.7 s, spine-v2-m2f-entry-wiring ~6.5 s,
 * agent-tool-selection-docs-ids ~1 s, ci-touched-tests ~1 s — about 25 s
 * added to the fast step in total. Deliberately NOT here: the three
 * characterization suites (~80 s together) and the fixed-directory
 * listers (e.g. the `*-package-absence` kernel reads) — same bug class,
 * separate follow-up voices with their own budget strategy. The
 * milestone-identifiers guard was split out of the hanging
 * agent-tool-selection-prompts matrix into its own fast file for this
 * list; the rest of that file stays a follow-up with the hang itself.
 */
export const REPO_WIDE_GUARDS = Object.freeze([
  // Repo-wide `grep trustedSystemActor/SYSTEM_ACTOR` over packages+apps:
  // a new system-authority call site anywhere flips it (reddened main
  // after #234, which touched only packages/payments).
  'tests/actor-fails-closed.test.js',
  // Recursive walk of tests/ refusing direct git spawns outside the
  // isolated helper (reddened main after #222 against #221).
  'tests/isolated-git.test.js',
  // Recursive walk of packages+apps holding the tenancy call boundary.
  'tests/spine-tenancy-truth.test.js',
  // Enumerates every packages/*/src and apps/* holding the
  // commercial-quotes deprecation boundary.
  'tests/commercial-quotes-deprecation.test.js',
  // Recursive walk of the checked-in docs and data (docs, examples,
  // packages) refusing reviewer-invisible bytes.
  'tests/scenario-document.test.js',
  // Scans every package src for signed-term evidence consumption.
  'tests/signed-terms-consumption-guard.test.js',
  // Scans packages+apps for raw-driver spellings outside the allowlist.
  'tests/spine-v2-m2-final-raw-boundary.test.js',
  // Recursive walk of the benchmark's own checked-in files refusing
  // credential-shaped literals.
  'tests/agent-tool-selection-contract.test.js',
  // Recursive walk of packages+apps+api refusing raw SQLite consumers
  // outside the adapter.
  'tests/spine-v2-m2f-entry-wiring.test.js',
  // Recursive walk of docs/ holding the prompt milestone-identifier scan.
  // Split out of the hanging prompts matrix so the gate can run it.
  'tests/agent-tool-selection-docs-ids.test.js',
  // This gate's own audit (the unlisted-guard test walks tests/ itself):
  // a PR adding a guard-shaped file anywhere must run the audit that
  // requires it listed.
  'tests/ci-touched-tests.test.js',
]);

const git = (/** @type {string[]} */ args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
};

/**
 * The `node --test` discovery this mirrors is filesystem-based, and so is
 * this walk: `readdirSync` on a path answers by succeeding on directories
 * and throwing on files.
 */
function isDirectory(/** @type {string} */ path) {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

function listTestFiles() {
  const found = [];
  const walk = (/** @type {string} */ directory) => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules') continue;
      const path = join(directory, name);
      if (isDirectory(path)) walk(path);
      else if (TEST_FILE.test(name)) found.push(path);
    }
  };
  walk(join(root, 'tests'));
  return found.sort();
}

/** Strip a source extension so `foo.js` and `foo` compare equal. */
function stripSourceExtension(/** @type {string} */ path) {
  return path.replace(SOURCE_EXT, '');
}

/**
 * The relative import specifiers a test file uses, resolved to
 * repository-relative, extension-free paths. Bare imports (`node:test`,
 * package names) are not code in this repository and are ignored.
 */
export function relativeImportsOf(
  /** @type {string} */ testFile,
  /** @type {string} */ content,
) {
  const found = new Set();
  const pattern = /(?:import\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*|export\s+[^'"]*?\s+from\s+)['"](\.[^'"]+)['"]/g;
  let match = pattern.exec(content);
  while (match) {
    const resolved = normalize(join(dirname(testFile), match[1])).replace(/\\/g, '/');
    found.add(stripSourceExtension(resolved));
    match = pattern.exec(content);
  }
  return found;
}

/**
 * Whether any changed repository-relative path is JavaScript source. Test
 * files themselves count as source here: a changed test file is always
 * selected below, so an empty selection together with a `true` here means a
 * changed non-test source file no test reaches — the fail-closed case.
 */
export function hasCodeChange(
  /** @type {string[]} */ changedFiles,
) {
  return changedFiles.some((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
}

/**
 * Map changed repository-relative paths to the test files that cover them:
 * changed test files themselves, plus every test file that reaches a changed
 * file through relative imports — directly, or transitively through
 * non-test files such as `tests/helpers/*` or `packages/` barrels (a test
 * booting the app through a helper, or importing a barrel that re-exports
 * the changed file, is the test that catches the regression).
 * `testContents` maps repository-relative test paths to their source;
 * `fileImports` optionally maps any other repository-relative file
 * (helpers, fixtures, barrels, scripts) to the relative imports it uses,
 * resolved the way `relativeImportsOf` resolves them — in production built
 * by `buildFileImports` over the whole repository. Files absent from both
 * maps are leaves. Returns sorted repository-relative test paths.
 */
export function selectTouchedTests(
  /** @type {string[]} */ changedFiles,
  /** @type {Map<string, string>} */ testContents,
  /** @type {Map<string, Set<string>>} */ fileImports = new Map(),
) {
  const selected = new Set();
  const changed = new Set(
    changedFiles.map((file) => stripSourceExtension(normalize(file).replace(/\\/g, '/'))),
  );
  // Forward edges for every known file, indexed once and reused: test files
  // parse their own content, every other file comes from the repository
  // index. The index wins on the rare stripped-path collision, the way the
  // per-test lookup it replaces preferred it. Files absent from both maps
  // are leaves.
  const forward = new Map();
  for (const [testPath, content] of testContents) {
    forward.set(stripSourceExtension(testPath), relativeImportsOf(testPath, content));
  }
  for (const [file, imports] of fileImports) {
    forward.set(file, imports);
  }
  // The reverse index: which files relatively import each file. One search
  // backwards from the changed files then finds every reaching test, in
  // time proportional to the graph instead of tests-times-the-graph.
  const importersOf = new Map();
  for (const [file, imports] of forward) {
    for (const target of imports) {
      let importers = importersOf.get(target);
      if (!importers) {
        importers = new Set();
        importersOf.set(target, importers);
      }
      importers.add(file);
    }
  }
  const testByStripped = new Map();
  for (const [testPath] of testContents) {
    testByStripped.set(stripSourceExtension(testPath), testPath);
  }
  // Backward reachability from the changed files. A test reached this way
  // runs — and the walk stops there, unless the test itself changed: a test
  // importing another test does not pull that test's importers in, so the
  // boundary is the trailing `.test`, the way the forward walk cut it.
  // Reached paths are extension-free throughout.
  const visited = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const next = queue.pop();
    if (/\.test$/.test(next ?? '')) {
      const testPath = next === undefined ? undefined : testByStripped.get(next);
      if (testPath !== undefined) selected.add(testPath);
      // A changed test file still contributes its importers (a test
      // importing a changed test runs too); any other test is a boundary.
      if (next === undefined || !changed.has(next)) continue;
    }
    for (const importer of importersOf.get(next ?? '') ?? []) {
      if (!visited.has(importer)) {
        visited.add(importer);
        queue.push(importer);
      }
    }
  }
  return [...selected].sort();
}

/**
 * The PR's own changed test files: the default fast suite the gate runs
 * when the selection cannot be used (it expired, or it outgrew the run
 * budget). Same scope as the selection rule: `*.test.js`/`*.test.mjs`
 * under `tests/`. Returns sorted repository-relative paths.
 */
export function changedTestFiles(
  /** @type {string[]} */ changedFiles,
) {
  return changedFiles
    .map((file) => normalize(file).replace(/\\/g, '/'))
    .filter((file) => file.startsWith('tests/') && TEST_FILE.test(file))
    .sort();
}

/**
 * What the gate does with a finished selection: skip (no code changed),
 * refuse (code changed, nothing reaches it — the fail-closed case), run
 * the selection, or fall back to the PR's own changed test files when the
 * selection outgrew the run budget. An oversized selection with no changed
 * test file of its own refuses, fail-closed: there is no evidence to run.
 * Pure: unit-tested without git or timers.
 */
export function planGate(
  /** @type {string[]} */ changedFiles,
  /** @type {string[]} */ selectedTests,
  /** @type {number} */ maxSelected = DEFAULT_MAX_SELECTED,
) {
  if (selectedTests.length === 0) {
    return fallbackPlan(changedFiles, 'empty-selection');
  }
  if (selectedTests.length <= maxSelected) {
    return { kind: 'run', tests: selectedTests, reason: null };
  }
  return fallbackPlan(changedFiles, 'oversized-selection');
}

/**
 * The warned fallback for an unusable selection (empty, oversized, or
 * expired): the default fast suite when the PR carries its own tests, the
 * fail-closed refusal when JavaScript changed without any, the skip when
 * only non-source files changed.
 */
export function fallbackPlan(
  /** @type {string[]} */ changedFiles,
  /** @type {string} */ reason,
) {
  const tests = changedTestFiles(changedFiles);
  if (tests.length > 0) {
    return { kind: 'fallback', tests, reason };
  }
  if (!hasCodeChange(changedFiles)) {
    return { kind: 'skip', tests: [], reason };
  }
  const uncovered = changedFiles.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
  return { kind: 'refuse', tests: [], reason, uncovered };
}

/**
 * Add the repo-wide guards (`REPO_WIDE_GUARDS`) on top of a mapped or
 * fallback selection. Pure: unit-tested, including the payments-only case
 * from the acceptance contract.
 *
 * - an empty diff stays empty: with nothing changed there is nothing the
 *   guards could catch;
 * - a listed guard missing from `testContents` throws instead of silently
 *   shrinking the gate: a PR deleting a guard updates the list in the same
 *   PR, or the step fails red naming it;
 * - duplicates collapse: a guard the mapping already selected runs once.
 */
export function withRepoWideGuards(
  /** @type {string[]} */ selectedTests,
  /** @type {Map<string, string>} */ testContents,
  /** @type {string[]} */ changedFiles,
  /** @type {readonly string[]} */ guards = REPO_WIDE_GUARDS,
) {
  if (changedFiles.length === 0) return [...selectedTests].sort();
  const missing = guards.filter((guard) => !testContents.has(guard));
  if (missing.length > 0) {
    throw new Error(
      'repo-wide guard(s) listed in REPO_WIDE_GUARDS but absent from tests/: '
      + `${missing.join(', ')}. A PR deleting a guard updates the list in the same PR.`,
    );
  }
  return [...new Set([...selectedTests, ...guards])].sort();
}

/**
 * The bound for the test run once the selection phase is over: the
 * configured run timeout, reduced by the selection's elapsed time so
 * select-plus-run always fits the step wrapper's budget, and never below
 * a minute (a bound under that cannot run even one slow file). Pure:
 * unit-tested.
 */
export function runBudgetSec(
  /** @type {number} */ timeoutSec,
  /** @type {number} */ selectionElapsedSec,
  /** @type {number} */ stepBudgetSec = STEP_BUDGET_SEC,
) {
  return Math.max(60, Math.min(timeoutSec, stepBudgetSec - 5 - Math.ceil(selectionElapsedSec)));
}

/**
 * Command-line options, exported so the unit test locks the documented
 * usage (`--timeout-sec <n>` followed by other flags) instead of trusting
 * it. Error paths exit the process and are not unit-tested.
 */
/**
 * A positive number of seconds for a `--*-sec` flag, or a `--max-selected`
 * count. Error paths exit the process and are not unit-tested.
 */
function positiveNumber(/** @type {string} */ flag, /** @type {string | undefined} */ raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    process.stderr.write(`ci-touched-tests: ${flag} needs a positive number\n`);
    process.exit(2);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    base: 'origin/main',
    list: false,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    selectTimeoutSec: DEFAULT_SELECT_TIMEOUT_SEC,
    maxSelected: DEFAULT_MAX_SELECTED,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') {
      const value = argv[i + 1];
      if (!value) {
        process.stderr.write('ci-touched-tests: --base needs a revision\n');
        process.exit(2);
      }
      options.base = value;
      i += 1;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--timeout-sec') {
      options.timeoutSec = positiveNumber('--timeout-sec', argv[i + 1]);
      i += 1;
    } else if (arg === '--select-timeout-sec') {
      options.selectTimeoutSec = positiveNumber('--select-timeout-sec', argv[i + 1]);
      i += 1;
    } else if (arg === '--max-selected') {
      options.maxSelected = positiveNumber('--max-selected', argv[i + 1]);
      i += 1;
    } else {
      process.stderr.write(`ci-touched-tests: unknown argument ${arg}\n`);
      process.exit(2);
    }
  }
  return options;
}

/**
 * Every relative JS import in the repository, keyed by extension-free
 * repository-relative path the way `relativeImportsOf` resolves them:
 * `tests/` (helpers, fixtures), `packages/` (including barrel
 * `export ... from` re-exports), `scripts/`, `apps/` and `examples/`. A
 * test reaching the changed file only through a barrel or a helper is the
 * test that catches the regression, so the selection must follow those
 * edges — a graph walked from `tests/` alone never sees the barrel side
 * (a barrel no test file imports directly has no recorded imports) and
 * silently selects nothing for the file behind it.
 */
export function buildFileImports(
  /** @type {string} */ repoRoot,
) {
  const graph = new Map();
  const walk = (/** @type {string} */ directory) => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules') continue;
      const absolute = join(directory, name);
      if (isDirectory(absolute)) {
        walk(absolute);
        continue;
      }
      if (!SOURCE_EXT.test(name) || TEST_FILE.test(name)) continue;
      const relative = absolute.slice(repoRoot.length + 1).replace(/\\/g, '/');
      try {
        graph.set(
          stripSourceExtension(relative),
          relativeImportsOf(relative, readFileSync(absolute, 'utf8')),
        );
      } catch {
        // Unreadable files are leaves; the run below fails loudly if one a
        // selected test needs is really missing.
      }
    }
  };
  for (const top of ['tests', 'packages', 'scripts', 'apps', 'examples']) {
    const directory = join(repoRoot, top);
    if (isDirectory(directory)) walk(directory);
  }
  return graph;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const verify = git(['rev-parse', '--verify', options.base]);
  if (verify.status !== 0 || !verify.stdout) {
    process.stderr.write(
      `ci-touched-tests: base revision ${options.base} is not present. `
        + 'Fetch the PR base before running (CI does this in the step before).\n',
    );
    process.exit(2);
  }

  const diff = git(['diff', '--name-only', `${options.base}...HEAD`]);
  if (diff.status !== 0) {
    process.stderr.write('ci-touched-tests: `git diff --name-only <base>...HEAD` failed.\n');
    process.exit(2);
  }
  const changed = diff.stdout ? diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];

  // The selection phase is synchronous file reads, so its budget is
  // enforced after the fact: past it the gate runs the default fast suite
  // instead of failing for the timeout (or starting a run it cannot finish
  // on top of an already over-budget selection).
  const selectStarted = Date.now();
  const testFiles = listTestFiles().map((absolute) => absolute.slice(root.length + 1).replace(/\\/g, '/'));
  const contents = new Map();
  for (const testPath of testFiles) {
    try {
      contents.set(testPath, readFileSync(join(root, testPath), 'utf8'));
    } catch {
      // A test file listed but unreadable fails loudly at run time below;
      // selection skips what it cannot read rather than refusing the step.
    }
  }

  const mapped = selectTouchedTests(changed, contents, buildFileImports(root));
  const selectionElapsedSec = (Date.now() - selectStarted) / 1000;

  const base = selectionElapsedSec > options.selectTimeoutSec
    ? fallbackPlan(changed, 'selection-timeout')
    : planGate(changed, mapped, options.maxSelected);
  // The over-budget note is reported on the fallback only; the run path
  // keeps the full bound minus the selection's elapsed time.
  const selectNote = selectionElapsedSec > options.selectTimeoutSec
    ? `selection took ${selectionElapsedSec.toFixed(1)}s, past the ${options.selectTimeoutSec}s budget`
    : null;

  // Fail closed BEFORE the guards join: the refusal is decided on the
  // mapped selection alone, so the always-run guards can never mask a
  // changed source file no test reaches (see the header).
  const plan = base;
  const preGuardTests = plan.kind === 'skip' || plan.kind === 'refuse' ? [] : plan.tests;
  if (plan.kind !== 'refuse') {
    try {
      plan.tests = withRepoWideGuards(preGuardTests, contents, changed);
    } catch (error) {
      process.stderr.write(`ci-touched-tests: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
  }
  const addedGuards = plan.kind === 'refuse'
    ? []
    : plan.tests.filter((test) => !preGuardTests.includes(test));

  if (options.list) {
    if (plan.reason && plan.kind === 'fallback') {
      process.stderr.write(`ci-touched-tests: warning: ${selectNote ?? 'oversized selection'} — listing the fallback suite plus the repo-wide guards.\n`);
    }
    process.stdout.write(plan.tests.length === 0 ? '' : `${plan.tests.join('\n')}\n`);
    process.exit(0);
  }

  // Fail closed: JavaScript source changed but no test reaches it (a CLI
  // reached only via `spawnSync`, a helper nobody imports yet). Exiting 0
  // here would merge an untested change green and redden `main` after the
  // merge, so the gate refuses with exit 1, naming the uncovered files:
  // add a test that relatively imports them (directly or through
  // `tests/helpers`) and the gate runs it. The full `npm test` suite holds
  // the machine lock ~20 minutes and cannot fit this step's five-minute
  // budget, so it still runs only on `main` after the merge, never here —
  // including as a fallback. Docs, workflows, manifests and site-only
  // changes keep the exit-0 skip: their gates run in the same CI job.
  if (plan.kind === 'refuse') {
    const uncovered = plan.uncovered ?? changed.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    process.stdout.write(
      'ci-touched-tests: refusing — no test file relatively reaches these '
      + `changed source file(s): ${uncovered.join(', ')}.\n`
      + 'Add a test that relatively imports them (directly or through tests/helpers); '
      + 'the default `npm test` suite cannot fit this step\'s five-minute budget, '
      + 'so it runs only on `main`, not here.\n',
    );
    process.exit(1);
  }
  if (plan.tests.length === 0) {
    // Only an empty diff reaches here with nothing to run: any real
    // change — code or not — runs at least the repo-wide guards (a
    // docs-only change can still flip tests/scenario-document.test.js).
    process.stdout.write(
      `ci-touched-tests: ${changed.length} changed file(s), no test file reaches them — nothing to run.\n`,
    );
    process.exit(0);
  }
  if (addedGuards.length > 0) {
    process.stdout.write(
      `ci-touched-tests: plus ${addedGuards.length} repo-wide guard(s): ${addedGuards.join(', ')}.\n`,
    );
  }

  if (plan.kind === 'fallback') {
    const why = plan.reason === 'selection-timeout' && selectNote !== null
      ? selectNote
      : `selected ${mapped.length} test file(s), past the ${options.maxSelected} this step can run`;
    process.stdout.write(
      `ci-touched-tests: warning: ${why} — running the fallback suite instead `
      + `(${preGuardTests.length} changed test file(s) plus ${addedGuards.length} repo-wide guard(s)): ${plan.tests.join(', ')}.\n`,
    );
    process.stdout.write(
      `::warning::ci-touched-tests: ${why} — running ${plan.tests.length} test file(s) instead of ${mapped.length} selected.\n`,
    );
  }

  // Same flags as `npm test`: two files at a time keeps peak memory inside
  // what the shared 16 GB runner survived (ci.yml), at the price of wall time
  // this step bounds with its timeout instead. The bound yields to the
  // selection phase so select-plus-run always fits the step wrapper; the
  // floor of a minute still runs at least one slow file.
  const runBudget = runBudgetSec(options.timeoutSec, selectionElapsedSec);
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', '--test', '--test-concurrency=2', '--test-reporter=spec', ...plan.tests],
    { cwd: root, stdio: 'inherit', timeout: runBudget * 1000, killSignal: 'SIGKILL' },
  );
  if (run.error) {
    const what = plan.kind === 'fallback' ? 'default fast suite' : 'selected run';
    process.stderr.write(`ci-touched-tests: ${what} did not finish in ${runBudget}s — failing red, not hanging the lock.\n`);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}

// Importing this module (the unit test does) must not run the gate: only
// a direct invocation selects and runs tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
