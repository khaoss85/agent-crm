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
 *   JavaScript source changed or was deleted (docs, workflows,
 *   `package.json`, site content): the agreement gates of the same CI job
 *   (`gtm:check`, `repo:truth -- --check`) still run. A changed
 *   `.js`/`.cjs`/`.mjs` file with no reaching test does NOT block: the
 *   gate warns (a `::warning::` annotation plus a summary line naming the
 *   uncovered files) and still runs the repo-wide guards below. The fast
 *   gate chooses best-effort — the full suite on `main` stays the safety
 *   net behind it — so an unlinked source file is a warning, never a
 *   refusal. The refusal stays only for an empty fallback suite (see
 *   `fallbackPlan`). Deleted files never run and never join the run list
 *   (a deleted file needs no test run), but their paths count for the
 *   skip-vs-warn-vs-refuse decision as well as the reachability search: a
 *   PR deleting a module an unchanged test still imports selects that
 *   importer, and a deletion-only diff whose importers overflow the budget
 *   refuses (or warns naming the dropped tests) instead of silently
 *   skipping — or the fast gate would pass while the full suite on `main`
 *   fails on the missing import. The unfiltered diff still drives the
 *   guard check below, so deleting a listed guard without updating the
 *   list still fails the step red.
 *
 * - the repo-wide guards (`REPO_WIDE_GUARDS` below) always run on top of
 *   the selection, on every non-empty diff. They are the test files whose
 *   verdict depends on files they never relatively import — repo-wide
 *   `grep` scans and recursive walks of `packages/`, `apps/`, `tests/`
 *   or `scripts/` — so the import mapping above never selects them.
 *   Twice `main` turned red after green-alone PRs for exactly
 *   this: #222 against #221 (`tests/isolated-git.test.js`) and #234
 *   (`tests/actor-fails-closed.test.js:251`). The guards never substitute
 *   for missing coverage: the warned fallback is decided on the
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
 * ~20 minutes and cannot fit the gate's shared ten-minute total, so it
 * still runs only on `main`, which stays the safety net behind every
 * fallback.
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
 * the run timeout refuses to hold the machine lock longer than that — a
 * hanging run fails red instead of queueing every other factory behind
 * it — inside the gate's shared total (540 s, see `scripts/ci-fast.sh`).
 * The run bound additionally yields to the selection phase so
 * select-plus-run always fits its share of the total.
 *
 * Exit codes: 0 the tests that ran passed (the selection plus the
 * repo-wide guards, or the fallback suite plus the guards after a warned
 * fallback; an empty diff runs nothing — and a warned fallback runs the
 * guards, so an uncovered source file never exits 0 with nothing run),
 * 1 the selection failed, a test failed, the fallback run failed, a listed
 * guard is missing from `tests/`, or the refusal (an oversized selection
 * the PR carries no test file of its own for — the only fail-closed case
 * left), 2 unusable input.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { spawnGit } from './git-env.js';
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
 * This phase's internal share of the gate's shared 540 s total (see
 * `scripts/ci-fast.sh`): select-plus-run must fit inside it, with a few
 * seconds of margin for process startup.
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
 * separate follow-up voices with their own budget strategy. The one
 * guard-shaped file that stays out by name is declared in
 * `REPO_WIDE_GUARD_EXCLUSIONS` below, with its reason.
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
  // Recursive walk of docs/ holding the prompt milestone-identifier
  // scan. Fast twin of the same check inside the slow prompts matrix
  // (doubled until that file is split — see REPO_WIDE_GUARD_EXCLUSIONS).
  'tests/agent-tool-selection-docs-ids.test.js',
  // Recursive walk of packages holding every manifest-selected module's
  // rendered migration SQL at its recorded revision: a manifest edit that
  // changes SQL without raising the revision fails here on every PR
  // (seed on presti-group failed after b8266ea widened an enum unbumped).
  'tests/module-manifest-revision-guard.test.js',
  // This gate's own audit (the unlisted-guard test walks tests/ itself):
  // a PR adding a guard-shaped file anywhere must run the audit that
  // requires it listed.
  'tests/ci-touched-tests.test.js',
]);

/**
 * Guard-shaped test files deliberately NOT in `REPO_WIDE_GUARDS`: the
 * audit in `tests/ci-touched-tests.test.js` requires every guard-shaped
 * file to be either listed above or named here with a reason — a third
 * state (unlisted and unexplained) fails the gate. An entry stays only
 * while it is load-bearing: the audit fails when a named file stops
 * looking guard-shaped (split the file, then drop the entry) or silently
 * joins the list above.
 */
export const REPO_WIDE_GUARD_EXCLUSIONS = Object.freeze({
  // Slow benchmark matrix (~240 s idle on the shared Mac, past the 300 s
  // step budget under load: a driver that shells out per corpus case, and
  // it hangs the pre-push hook the same way). A test this slow is not a
  // guard — it can never fit the always-run gate. Its
  // milestone-identifiers check runs instead through the fast twin
  // tests/agent-tool-selection-docs-ids.test.js (doubled until the matrix
  // file itself is split; that split and the hang are their own voice).
  'tests/agent-tool-selection-prompts.test.js':
    'slow benchmark matrix (~240 s): covered by the fast twin tests/agent-tool-selection-docs-ids.test.js',
});

const git = (/** @type {string[]} */ args) => {
  const run = spawnGit(args, { cwd: root });
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
 * changed non-test source file no test reaches — the warned-fallback case.
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
 * warn-and-run-the-guards (code changed, nothing reaches it — best-effort,
 * never a refusal), run the selection, or fall back to the PR's own
 * changed test files when the selection outgrew the run budget. An
 * oversized selection with no changed test file of its own refuses,
 * fail-closed: there is no evidence to run, and it is the only refusal
 * left. Pure: unit-tested without git or timers.
 *
 * `scopeFiles` is the reachability scope the skip-vs-warn-vs-refuse
 * decision reads (`main()` passes `allChanged`: runnable changes plus
 * deleted paths, which seed the search but never run). Deciding on the
 * runnable set alone lets a deletion-only diff silent-skip: with no
 * runnable change `hasCodeChange` is false even while sixty stale
 * importers prove the breakage, and the fast gate exits 0 while the full
 * suite on `main` fails on the missing import. The run list, the
 * `changedTestFiles` fallback and `uncovered` stay runnable-only —
 * deleted files never run — while `dropped` always names the selected
 * tests the plan does not run, so `main()` warns whenever a non-empty
 * mapped set is discarded, including the skip path.
 */
export function planGate(
  /** @type {string[]} */ changedFiles,
  /** @type {string[]} */ selectedTests,
  /** @type {number} */ maxSelected = DEFAULT_MAX_SELECTED,
  /** @type {string[]} */ scopeFiles = changedFiles,
) {
  if (selectedTests.length === 0) {
    return fallbackPlan(changedFiles, 'empty-selection', scopeFiles, selectedTests);
  }
  if (selectedTests.length <= maxSelected) {
    return { kind: 'run', tests: selectedTests, reason: null, dropped: [] };
  }
  return fallbackPlan(changedFiles, 'oversized-selection', scopeFiles, selectedTests);
}

/**
 * The warned fallback for an unusable selection (empty, oversized, or
 * expired): the default fast suite when the PR carries its own tests, the
 * skip when only non-source files changed, the fail-closed refusal when an
 * oversized selection has no test file of its own — and, for every other
 * case of JavaScript changed without reaching tests, a warned fallback with
 * no tests of its own: `main()` still joins the repo-wide guards and runs
 * them, and warns naming the uncovered files. A changed source file no
 * test reaches never blocks the PR; the full suite on `main` is the net.
 * `scopeFiles` and `selectedTests` feed the decision and the `dropped`
 * list as `planGate` documents; both default to the runnable inputs so a
 * caller without a reachability scope keeps the old behavior.
 */
export function fallbackPlan(
  /** @type {string[]} */ changedFiles,
  /** @type {string} */ reason,
  /** @type {string[]} */ scopeFiles = changedFiles,
  /** @type {string[]} */ selectedTests = [],
) {
  const tests = changedTestFiles(changedFiles);
  const dropped = selectedTests.filter((test) => !tests.includes(test));
  if (tests.length > 0) {
    return { kind: 'fallback', tests, reason, dropped };
  }
  if (!hasCodeChange(scopeFiles)) {
    return { kind: 'skip', tests: [], reason, dropped };
  }
  if (reason === 'oversized-selection') {
    const uncovered = changedFiles.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    return { kind: 'refuse', tests: [], reason, uncovered, dropped };
  }
  return { kind: 'fallback', tests: [], reason, dropped };
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
 * The kernel boundary tests: `tests/package-contract.test.js` («the kernel
 * never depends on a package») and `tests/contracts-activation-e2e.test.js`
 * («the contracts domain is optional»). Both judge `packages/core/src` (and
 * `packages/app/src`) file by file, but the mapping cannot reach them from
 * a core change: the e2e test relatively imports no package at all, and the
 * contract test imports only `packages/core/index.js`, so a core file the
 * index does not re-export selects nothing. #258 put domain names into
 * `packages/core` and the fast gate stayed green (S109).
 * They run conditionally, on top of a mapped or fallback selection: whenever
 * the diff touches `packages/core/**` or `packages/app/**`. A docs-only
 * diff never touches those paths, so — unlike `REPO_WIDE_GUARDS` — it never
 * selects them. Pure: unit-tested, including both acceptance directions.
 */
export const KERNEL_BOUNDARY_TESTS = Object.freeze([
  'tests/package-contract.test.js',
  'tests/contracts-activation-e2e.test.js',
]);

/** Whether a repository-relative path lives under the kernel or its app. */
function isKernelPath(/** @type {string} */ file) {
  const normalized = normalize(file).replace(/\\/g, '/');
  return (
    normalized === 'packages/core'
    || normalized.startsWith('packages/core/')
    || normalized === 'packages/app'
    || normalized.startsWith('packages/app/')
  );
}

/**
 * Add the kernel boundary tests (`KERNEL_BOUNDARY_TESTS`) on top of a mapped
 * or fallback selection when the diff touches the kernel or its app.
 *
 * - a diff with no `packages/core/**` or `packages/app/**` path (docs-only
 *   included) returns the selection unchanged — but only after the missing
 *   check below, so a PR deleting a listed boundary test without touching
 *   the kernel still fails red naming it instead of passing with a stale
 *   list;
 * - an empty diff stays empty;
 * - a listed boundary test missing from `testContents` throws instead of
 *   silently shrinking the gate, the way `withRepoWideGuards` does;
 * - duplicates collapse: a boundary test the mapping already selected runs
 *   once.
 */
export function withKernelBoundaryTests(
  /** @type {string[]} */ selectedTests,
  /** @type {Map<string, string>} */ testContents,
  /** @type {string[]} */ changedFiles,
  /** @type {readonly string[]} */ boundaryTests = KERNEL_BOUNDARY_TESTS,
) {
  if (changedFiles.length === 0) return [...selectedTests].sort();
  const missing = boundaryTests.filter((boundary) => !testContents.has(boundary));
  if (missing.length > 0) {
    throw new Error(
      'kernel boundary test(s) listed in KERNEL_BOUNDARY_TESTS but absent from tests/: '
      + `${missing.join(', ')}. A PR deleting a boundary test updates the list in the same PR.`,
    );
  }
  if (!changedFiles.some(isKernelPath)) return [...selectedTests].sort();
  return [...new Set([...selectedTests, ...boundaryTests])].sort();
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

/**
 * The PR's changed files against `base`, split in three: `changed` drives
 * what runs (the unfiltered diff minus the deleted-only diff: uppercase
 * `--diff-filter=D` selects only deleted paths — lowercase `-d` would
 * exclude them — so the code subtracts that set; a deleted file needs no
 * test run, and a deleted test file no longer on disk would fail
 * the run), `deleted` seeds the reachability search only (a deleted module
 * an unchanged test still imports selects that importer — the walk stops
 * at test files, and a deleted test is absent from the corpus so it is
 * never itself selected), `allChanged` drives the guard check (a PR
 * deleting a listed guard without updating the list still fails red).
 * Throws on git failure; `main()` reports it as unusable input. The git
 * runner is injected so the end-to-end test drives these exact commands
 * against a throwaway repository with real git.
 * @param {(args: string[]) => { status: number | null, stdout: string }} runGit
 */
export function listChangedFiles(runGit, /** @type {string} */ base) {
  const range = `${base}...HEAD`;
  const all = runGit(['diff', '--name-only', range]);
  if (all.status !== 0) {
    throw new Error(`ci-touched-tests: \`git diff --name-only ${range}\` failed.`);
  }
  const gone = runGit(['diff', '--name-only', '--diff-filter=D', range]);
  if (gone.status !== 0) {
    throw new Error(`ci-touched-tests: \`git diff --name-only --diff-filter=D ${range}\` failed.`);
  }
  const paths = (/** @type {string} */ output) => (output
    ? output.split('\n').map((line) => line.trim()).filter(Boolean)
    : []);
  const deleted = new Set(paths(gone.stdout));
  const allChanged = paths(all.stdout);
  return {
    changed: allChanged.filter((file) => !deleted.has(file)),
    deleted: allChanged.filter((file) => deleted.has(file)),
    allChanged,
  };
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

  let changed;
  let deleted;
  let allChanged;
  try {
    ({ changed, deleted, allChanged } = listChangedFiles(git, options.base));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }

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

  // Deleted paths seed the reachability search but never the run: a deleted
  // module an unchanged test still imports selects that importer, while a
  // deleted test file is absent from the corpus and so never selected.
  // Plans, fallbacks and warnings below keep using `changed` (no deleted
  // files): deleted files never run and never count as uncovered.
  const mapped = selectTouchedTests([...changed, ...deleted], contents, buildFileImports(root));
  const selectionElapsedSec = (Date.now() - selectStarted) / 1000;

  // The skip-vs-warn-vs-refuse decision reads the reachability scope
  // (`allChanged`: runnable changes plus deleted paths), never the
  // runnable set alone: a deletion-only diff whose importers overflow the
  // budget must refuse (or warn), never silent-skip. The run list below
  // stays runnable-only: deleted files never run.
  const base = selectionElapsedSec > options.selectTimeoutSec
    ? fallbackPlan(changed, 'selection-timeout', allChanged, mapped)
    : planGate(changed, mapped, options.maxSelected, allChanged);
  // The over-budget note is reported on the fallback only; the run path
  // keeps the full bound minus the selection's elapsed time.
  const selectNote = selectionElapsedSec > options.selectTimeoutSec
    ? `selection took ${selectionElapsedSec.toFixed(1)}s, past the ${options.selectTimeoutSec}s budget`
    : null;

  // The warned fallback is decided on the mapped selection alone, before
  // the guards join, so the always-run guards can never mask a changed
  // source file no test reaches (see the header). The guards see the
  // unfiltered diff: a PR deleting a listed guard without updating the list
  // still fails red.
  const plan = base;
  const preGuardTests = plan.kind === 'skip' || plan.kind === 'refuse' ? [] : plan.tests;
  if (plan.kind !== 'refuse') {
    try {
      plan.tests = withKernelBoundaryTests(
        withRepoWideGuards(preGuardTests, contents, allChanged),
        contents,
        allChanged,
      );
    } catch (error) {
      process.stderr.write(`ci-touched-tests: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
  }
  const addedGuards = plan.kind === 'refuse'
    ? []
    : plan.tests.filter((test) => !preGuardTests.includes(test));
  const addedBoundary = plan.kind === 'refuse'
    ? []
    : plan.tests.filter(
      (test) => !preGuardTests.includes(test) && KERNEL_BOUNDARY_TESTS.includes(test),
    );

  // Selected tests the plan does not run, after the guards joined: a
  // non-empty set here is always reported — a `::warning::` annotation
  // plus a summary line naming them — including on the skip path, so a
  // discarded mapped set can never go quiet.
  const droppedTests = (plan.dropped ?? []).filter((test) => !plan.tests.includes(test));
  const droppedNote = droppedTests.length === 0
    ? null
    : `dropping ${droppedTests.length} selected test(s) this step does not run: ${droppedTests.join(', ')}`;

  if (options.list) {
    if (plan.reason && plan.kind === 'fallback') {
      process.stderr.write(`ci-touched-tests: warning: ${selectNote ?? plan.reason} — listing the fallback suite plus the repo-wide guards.\n`);
    }
    if (droppedNote !== null) {
      process.stderr.write(`ci-touched-tests: warning: ${droppedNote}.\n`);
    }
    process.stdout.write(plan.tests.length === 0 ? '' : `${plan.tests.join('\n')}\n`);
    process.exit(0);
  }

  // The only refusal left: an oversized selection the PR carries no test
  // file of its own for, so there is no evidence this step can run. Every
  // other unusable selection warns and runs the guards instead (below).
  if (plan.kind === 'refuse') {
    const uncovered = plan.uncovered ?? changed.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    const deletedScope = deleted.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    process.stdout.write(
      'ci-touched-tests: refusing — the selection outgrew this step\'s budget '
      + 'and the PR carries no test file of its own, so there is nothing to run: '
      + `${uncovered.join(', ') || '(no runnable source in scope)'}.`
      + `${deletedScope.length === 0 ? '' : ` The PR deletes source still in scope: ${deletedScope.join(', ')} — update the stale importers (or restore the module) so the full suite on \`main\` stays green.`}\n`
      + `${droppedNote === null ? '' : `ci-touched-tests: warning: ${droppedNote}.\n`}`
      + 'Add a test that relatively imports them (directly or through tests/helpers); '
      + 'the default `npm test` suite cannot fit the gate\'s shared ten-minute total, '
      + 'so it runs only on `main`, not here.\n',
    );
    process.stdout.write(
      `::error::ci-touched-tests: refusing — the selection outgrew this step's budget with no test file of its own.${droppedNote === null ? '' : ` ${droppedNote}.`}\n`,
    );
    process.exit(1);
  }
  if (plan.tests.length === 0) {
    // Only an empty diff reaches here with nothing to run: any real
    // change — code or not, deleted or not — runs at least the repo-wide
    // guards (a docs-only change can still flip tests/scenario-document.test.js).
    process.stdout.write(
      `ci-touched-tests: ${allChanged.length} changed file(s), no test file reaches them — nothing to run.\n`,
    );
    if (droppedNote !== null) {
      process.stdout.write(`ci-touched-tests: warning: ${droppedNote}.\n`);
      process.stdout.write(`::warning::ci-touched-tests: ${droppedNote}.\n`);
    }
    process.exit(0);
  }
  if (addedGuards.length > 0) {
    process.stdout.write(
      `ci-touched-tests: plus ${addedGuards.length} repo-wide guard(s): ${addedGuards.join(', ')}.\n`,
    );
  }
  if (addedBoundary.length > 0) {
    process.stdout.write(
      `ci-touched-tests: plus ${addedBoundary.length} kernel boundary test(s): ${addedBoundary.join(', ')}.\n`,
    );
  }

  if (plan.kind === 'fallback') {
    // A changed source file no test reaches warns here — the ::warning::
    // annotation for the job plus this summary line naming the uncovered
    // files — instead of blocking: the guards above still run, and the full
    // suite on `main` stays the safety net. A discarded mapped set is
    // named too, so an oversized or timed-out deletion-only diff can never
    // go quiet about the importers it drops.
    const uncovered = changed.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    const why = plan.reason === 'selection-timeout' && selectNote !== null
      ? selectNote
      : plan.reason === 'empty-selection' && preGuardTests.length === 0
        ? `no test file relatively reaches these changed source file(s): ${uncovered.join(', ') || '(deleted scope only)'} — best-effort guards only, the full suite on \`main\` stays the safety net`
        : `selected ${mapped.length} test file(s), past the ${options.maxSelected} this step can run`;
    process.stdout.write(
      `ci-touched-tests: warning: ${why} — running the fallback suite instead `
      + `(${preGuardTests.length} changed test file(s) plus ${addedGuards.length} repo-wide guard(s)): ${plan.tests.join(', ')}.`
      + `${droppedNote === null ? '' : ` ${droppedNote}.`}\n`,
    );
    process.stdout.write(
      `::warning::ci-touched-tests: ${why} — running ${plan.tests.length} test file(s) instead of ${mapped.length} selected.${droppedNote === null ? '' : ` ${droppedNote}.`}\n`,
    );
  }
  if (plan.kind === 'skip' && droppedNote !== null) {
    // Pathological but reachable: the scope carries no JavaScript, yet a
    // test relatively imports a changed non-source file (a fixture, a data
    // file). The guards above still run; the dropped mapped set is named
    // instead of going quiet.
    process.stdout.write(
      `ci-touched-tests: warning: ${droppedNote} — best-effort guards only, the full suite on \`main\` stays the safety net.\n`,
    );
    process.stdout.write(`::warning::ci-touched-tests: ${droppedNote}.\n`);
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
