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
 *   Three times `main` turned red after green-alone PRs for exactly
 *   this: #222 against #221 (`tests/isolated-git.test.js`), #234
 *   (`tests/actor-fails-closed.test.js:251`), and the nightly main run
 *   41956161675 (`tests/admin-authority-tokens.test.js`, cure in #593).
 *   The guards never substitute
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
 *   the slowest files) never starts the run it cannot finish as one
 *   selection: the gate warns and runs the default fast suite instead. The
 *   cap counts the joined total, not the mapped selection alone: the
 *   always-run guards join after the cap, and a mapped set that fits can
 *   still outgrow the step once they join (seen: ~47 mapped + 14 guards
 *   needing ~900 s against a 270 s bound) — past the cap the same warned
 *   fallback runs.
 *
 * The fallback never drops the remainder quietly: every selected test the
 * core suite leaves out drains behind it in the same shared queue, nearest
 * first (`bonusQueue`), while the run bound allows — backlog:3335fd28, an
 * oversized selection whose ~198 dropped tests never ran. A bound that
 * expires with only bonus files unrun (the core green, nothing failed)
 * warns naming them instead of failing red over coverage the step could
 * not fit; an unfinished core file, or any failure, still fails red. The
 * full suite on `main` stays the safety net behind whatever the bound does
 * not reach: the 540 s gate this phase shares (`scripts/ci-fast.sh`) could
 * never run a core-wide fan-in whole.
 *
 * The run itself splits past a dozen files into up to four parallel parts
 * (see `shardCountFor`/`testJobs`/`runTestShards`): agent-crm#621 (an
 * outbox change selecting 235 tests) ran the warned fallback as one
 * sequential `node --test` process and timed out past 270 s with no test
 * failing. A dozen files or fewer run exactly as before (one process,
 * `--test-concurrency=2`); past that the parts pull one file at a time
 * from one shared queue, so a core-wide fan-in still fits the bound. Fixed
 * round-robin slices did not: #621 then timed out again with "2 of 4
 * parts" done — two slices held most of the slow files while the other
 * two parts had finished and sat idle. A timeout with core files unfinished
 * still fails red — never green without the core having run — and names
 * the core and bonus files that remained; each file's, each part's and the
 * run's elapsed time are logged, so the cause reads from the log.
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
 * the run timeout (420 s by default, see `DEFAULT_TIMEOUT_SEC`) refuses to
 * hold the queue longer than that — a hanging run fails red instead of
 * queueing every other PR behind it — inside the gate's shared total
 * (540 s, see `scripts/ci-fast.sh`).
 * The run bound additionally yields to the selection phase so
 * select-plus-run always fits its share of the total.
 *
 * Exit codes: 0 the tests that ran passed (the selection plus the
 * repo-wide guards, or the core suite plus whatever bonus the bound drained
 * after a warned fallback — a bound that expires with only bonus files
 * unrun warns naming them instead of failing; an empty diff runs
 * nothing — and a warned fallback runs the guards, so an uncovered source
 * file never exits 0 with nothing run), 1 the selection failed, a test
 * failed, the run failed or timed out with a core file unfinished or any
 * failure (a timeout names the core and bonus files that remained), a
 * listed guard is missing from `tests/`, or the refusal (an oversized
 * selection the PR carries no test file of its own for — the only
 * fail-closed case left), 2 unusable input.
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { spawn } from 'node:child_process';
import { spawnGit } from './git-env.js';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

const TEST_FILE = /\.test\.[cm]?js$/;
const SOURCE_EXT = /\.[cm]?js$/;

/**
 * The run bound: the most the test run may last once the selection is over
 * (it further yields to the selection's elapsed time, see `runBudgetSec`).
 *
 * 420 s since 2026-11-08 (was 270 s, sized for the shared Mac's single
 * machine lock, where every phase ran one after the other). Since
 * agent-crm#681 the fast job waits in the CI server's own queue and the
 * phases run in parallel lanes (`CI_FAST_PARALLEL=4`), killed together at
 * HEAVY_JOB_MAX_SEC=540 — so the only thing this phase shares its 540 s
 * with is `gtm:check`, which runs after it in the same lane. The old bound
 * failed red with every test that ran green: agent-crm#651 (run
 * 42491220408, 10 files left) and #684 (run 42495287784, 1 file left), both
 * on the warned 50-file fallback in 4 parts. The file left in both is
 * `tests/contracts-activation-e2e.test.js`: alone it needs 252 s (7 tests
 * of 21-55 s each, run 42475723018) and more than 257 s on a loaded runner
 * — one file the parts cannot split, still running at 270 s. In run
 * 42491220408 the 50 files carried about 1,200 s of work (603 s done plus
 * the 10 left, as timed in run 42475723018) for 4 parts: ~305 s each at
 * best. See `STEP_BUDGET_SEC` for how the new number fits the 540 s.
 */
const DEFAULT_TIMEOUT_SEC = 420;

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
 *
 * 450 s since 2026-11-08 (was 300 s). Measured on the 14 green fast runs
 * of 2026-11-08 (42461859027 to 42497107593, Linux runner, 4 lanes): the
 * phase after this one in the same lane, `gtm:check`, took 7-15 s; this
 * phase took at most 13 s more than its test run (selection plus startup,
 * both inside this budget); when this lane was not the longest, the whole
 * gate ended by 196 s (`npm run check` 104-193 s, the recipe replay
 * 82-155 s, the plan pins 61-103 s). So this lane needs at most 450 s plus
 * 15 s of `gtm:check`, ~75 s under the 540 s kill — five times the slowest
 * `gtm:check` seen — and the other lanes keep more than 300 s of room.
 * `tests/ci-touched-tests.test.js` keeps at least a minute free against the
 * HEAVY_JOB_MAX_SEC of the fast step in `.github/workflows/ci.yml`.
 */
export const STEP_BUDGET_SEC = 450;

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
 * agent-tool-selection-docs-ids ~1 s, ci-touched-tests ~1 s,
 * admin-authority-tokens ~0.3 s — about 25 s
 * added to the fast step in total. Deliberately NOT always-run: the three
 * characterization suites (~80 s together) join conditionally instead —
 * when the diff touches a file their baseline digests, or adds a source
 * file under a directory their baseline digests (a brand-new file is never
 * a digest key yet, so key matching alone misses it: #293 added
 * packages/commercial/src/quote-pdf.js green-alone and reddened `main`;
 * see `CHARACTERIZATION_SUITES` and `withCharacterizationTests`), so a
 * docs-only PR never pays for them while a PR that would redden their
 * staleness check on `main` runs them here first. The fixed-directory
 * listers (e.g. the `*-package-absence` kernel reads) stay out — same bug
 * class, separate follow-up voices with their own budget strategy. The one
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
  // Client-name scan of packages/ (backlog:4c63c9dc): the framework
  // ships no customer name, so a name entering packages/ fails here on
  // every PR. Test fixtures may name one (the declared exception); the
  // walk lives in scripts/framework-neutrality.js, behind the test file,
  // so the unlisted-guard audit below does not see its shape — it is
  // listed here by audit, like the raw-driver boundary.
  'tests/framework-neutrality.test.js',
  // Pinned digests of files anywhere in the repo: a JTBD row pins its test
  // file's bytes, an evidence document pins its plan's fingerprint. #555
  // (admin-quotes.test.js translated) and #570 (a composition change) moved
  // them with a green fast and a red full suite the night after.
  'tests/jtbd-portfolio-gate.test.js',
  'tests/implementation-evidence.test.js',
  // Reads apps/admin/public/styles.css with readFileSync, never importing
  // it: a CSS-only change selects nothing through the import mapping, so
  // the fast gate stayed green while the nightly full suite failed on
  // «no literal colour outside :root» (main run 41956161675, cure in #593).
  'tests/admin-authority-tokens.test.js',
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
  // The prompt matrix walks docs/ for milestone identifiers, so it still
  // looks like a repo-wide guard — but the fast twin
  // tests/agent-tool-selection-docs-ids.test.js already runs that check in
  // the gate, and running both on every PR would double it. (The oracle
  // that made this file slow moved to tests/helpers/shell-oracle.js, sliced
  // across tests/shell-oracle-a/b/c/d/e/f.test.js, backlog:664d5f481a96; the
  // doubling stays because the walk itself is what the twin covers.)
  'tests/agent-tool-selection-prompts.test.js':
    'prompt milestone walk: covered by the fast twin tests/agent-tool-selection-docs-ids.test.js',
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
  return [...touchedTestDistances(changedFiles, testContents, fileImports).keys()].sort();
}

/**
 * The same reachability as `selectTouchedTests`, with each reached test's
 * import distance from the nearest changed file (1 = imports a changed file
 * directly). The set of reached tests is the same whatever the walk order,
 * so `selectTouchedTests` reads its keys; the distances order an oversized
 * selection (`nearestFirst`): past the file budget the closest tests still
 * run instead of being dropped with the rest. #555 changed
 * `admin-quotes.js`, `tests/admin-signature.test.js` imports it directly,
 * and the oversized fallback dropped it with 39 others — the full suite on
 * `main` went red a night later.
 */
export function touchedTestDistances(
  /** @type {string[]} */ changedFiles,
  /** @type {Map<string, string>} */ testContents,
  /** @type {Map<string, Set<string>>} */ fileImports = new Map(),
) {
  /** @type {Map<string, number>} */
  const selected = new Map();
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
  // Breadth-first, so the first time a test is reached is its shortest
  // distance.
  const depth = new Map([...changed].map((file) => [file, 0]));
  const visited = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    const next = queue.shift();
    if (/\.test$/.test(next ?? '')) {
      const testPath = next === undefined ? undefined : testByStripped.get(next);
      if (testPath !== undefined && !selected.has(testPath)) selected.set(testPath, depth.get(next ?? '') ?? 0);
      // A changed test file still contributes its importers (a test
      // importing a changed test runs too); any other test is a boundary.
      if (next === undefined || !changed.has(next)) continue;
    }
    for (const importer of importersOf.get(next ?? '') ?? []) {
      if (!visited.has(importer)) {
        visited.add(importer);
        depth.set(importer, (depth.get(next ?? '') ?? 0) + 1);
        queue.push(importer);
      }
    }
  }
  return selected;
}

/**
 * The selected tests ordered closest first (distance, then path), for
 * filling what an oversized fallback leaves of the file budget. Pure.
 */
export function nearestFirst(/** @type {Map<string, number>} */ distances) {
  return [...distances.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([test]) => test);
}

/**
 * Fill an oversized fallback up to the file budget with the nearest selected
 * tests it would otherwise drop. Returns the tests to add. Pure.
 */
export function fillNearest(
  /** @type {string[]} */ planned,
  /** @type {string[]} */ ranked,
  /** @type {number} */ maxSelected,
) {
  const room = maxSelected - planned.length;
  if (room <= 0) return [];
  return ranked.filter((test) => !planned.includes(test)).slice(0, room);
}

/**
 * The dropped remainder of a planned run, queued behind the core suite in
 * nearest-first order instead of being dropped (backlog:3335fd28: an
 * oversized selection fell back to the PR-owned changed tests and the ~198
 * dropped selected tests never ran — skipped, against "mai saltata"). The
 * run queue holds the whole mapped selection — the core first, this bonus
 * behind it — so the run bound, not the plan, decides how far an oversized
 * selection drains, and every file the bound does not reach is named at
 * timeout instead of going quiet. Pure: unit-tested.
 */
export function bonusQueue(
  /** @type {Map<string, number>} */ distances,
  /** @type {string[]} */ planned,
) {
  const queued = new Set(planned);
  return nearestFirst(distances).filter((test) => !queued.has(test));
}

/**
 * What a run timeout means for the step: `fail` when a core file is still
 * unfinished, or when any file failed anywhere (a warn-green over a failure
 * would hide it); `warn` when only bonus files the bound did not reach
 * remain and everything that ran passed — the core suite is green, the
 * remainder is named, and the full suite on `main` stays the safety net
 * behind it. Pure: unit-tested.
 */
export function timeoutVerdict(
  /** @type {string[]} */ coreTests,
  /** @type {string[]} */ remaining,
  /** @type {string[]} */ failedFiles,
) {
  if (failedFiles.length > 0) return 'fail';
  const core = new Set(coreTests);
  return remaining.some((file) => core.has(file)) ? 'fail' : 'warn';
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
 * The package declaration freeze tests: the suites that pin a package's
 * declared surface exactly — its action names, its attach/detach surface,
 * its public export keys — so a PR that changes a declaration without
 * updating the freeze fails here instead of on `main`. Twice `main` turned
 * red after green-alone PRs that the import mapping could not hold onto:
 * #360 added the `injectSessionProfile` export behind a 96-test fan-in and
 * #380 added the `postpone` work action behind a 95-test fan-in, so both
 * fell into the warned oversized fallback (the PR's own tests plus the
 * guards) and the freezes that pin those declarations never ran
 * (backlog:86652c07). `tests/work-package-absence.test.js` is unreachable
 * by mapping at all: it asserts on a scratch composition it shells out to,
 * never on a relative import.
 *
 * They run conditionally, on top of a mapped or fallback selection (and so
 * inside the warned fallback too, where the two PRs above were lost):
 * whenever the diff touches `packages/**`, where every declaration they
 * freeze lives. A docs-only diff never touches those paths, so — unlike
 * `REPO_WIDE_GUARDS` — it never selects them. They are not always-run
 * guards: the six files cost a few seconds together (measured ~3 s
 * locally), and an unconditional join would still tax every docs-only PR
 * for a check that cannot flip it. Pure: unit-tested, including both
 * acceptance directions.
 */
export const PACKAGE_DECLARATION_FREEZE_TESTS = Object.freeze([
  // Pins the work v1 action set (complete, cancel, postpone, add-note) plus
  // the factories, MCP tools, CLI commands and migration checksums.
  'tests/spine-v2-m0-characterization.test.js',
  // Pins the attach/detach/reattach surface, including the work action list
  // on a scratch composition the mapping never reaches.
  'tests/work-package-absence.test.js',
  // Pin the exact `packages/app` export keys (factories plus the Admin
  // shell mount exports) from four angles; a new export must update all four.
  'tests/spine-v2-m2e2-portable-http.test.js',
  'tests/spine-v2-m2e2-portable-facade.test.js',
  'tests/spine-v2-m2e2-async-lifecycle.test.js',
  'tests/spine-v2-m2e3-public-async-factory.test.js',
]);

/** Whether a repository-relative path lives under the declared packages. */
function isPackagePath(/** @type {string} */ file) {
  const normalized = normalize(file).replace(/\\/g, '/');
  return normalized === 'packages' || normalized.startsWith('packages/');
}

/**
 * Add the package declaration freeze tests
 * (`PACKAGE_DECLARATION_FREEZE_TESTS`) on top of a mapped or fallback
 * selection when the diff touches a declared package.
 *
 * - a diff with no `packages/**` path (docs-only included) returns the
 *   selection unchanged — but only after the missing check below, so a PR
 *   deleting a listed freeze test without touching a package still fails
 *   red naming it instead of passing with a stale list;
 * - an empty diff stays empty;
 * - a listed freeze test missing from `testContents` throws instead of
 *   silently shrinking the gate, the way `withKernelBoundaryTests` does;
 * - duplicates collapse: a freeze test the mapping already selected runs
 *   once.
 */
export function withPackageDeclarationFreezeTests(
  /** @type {string[]} */ selectedTests,
  /** @type {Map<string, string>} */ testContents,
  /** @type {string[]} */ changedFiles,
  /** @type {readonly string[]} */ freezeTests = PACKAGE_DECLARATION_FREEZE_TESTS,
) {
  if (changedFiles.length === 0) return [...selectedTests].sort();
  const missing = freezeTests.filter((freeze) => !testContents.has(freeze));
  if (missing.length > 0) {
    throw new Error(
      'package declaration freeze test(s) listed in PACKAGE_DECLARATION_FREEZE_TESTS but absent from tests/: '
      + `${missing.join(', ')}. A PR deleting a freeze test updates the list in the same PR.`,
    );
  }
  if (!changedFiles.some(isPackagePath)) return [...selectedTests].sort();
  return [...new Set([...selectedTests, ...freezeTests])].sort();
}

/**
 * The characterization staleness suites: each `tests/characterization/*-baseline.json`
 * freezes the behaviour of the source files its `source` map digests, and the
 * paired `*-characterization.test.js` fails red when a digested file moves
 * without a deliberate baseline regeneration. The import mapping above never
 * selects them — a characterization suite relatively imports almost none of
 * the files it digests — so twice `main` turned red within a day after
 * green-alone PRs (S99, S116) that changed a digested file.
 *
 * They join conditionally, on top of a mapped or fallback selection: whenever
 * the diff touches a file some baseline's `source` map digests. A docs-only
 * diff touches no digested path, so — unlike `REPO_WIDE_GUARDS` — it never
 * selects them. They are not always-run guards: the three suites cost ~80 s
 * together on the shared Mac, and an unconditional join would tax every
 * docs-only PR for a check that cannot flip it. Pure join, impure index:
 * `loadCharacterizationDigests` reads the checked-in baselines once per run
 * (see `main()`), `withCharacterizationTests` is unit-tested, including both
 * acceptance directions.
 *
 * Key matching alone misses a brand-new file: it is never a digest key yet,
 * so #293 (which added `packages/commercial/src/quote-pdf.js` without
 * touching any digested path) ran green-alone and reddened `main` on the
 * ownership guard. A diff that ADDS a digest-relevant source file
 * (`*.js`/`*.mjs`/`*.cjs` or `*.module.json`) under a digest-owned
 * directory therefore selects the suite too: the file's own directory, then
 * each ancestor up to the repository root, is checked against
 * `digestDirectorySuites`, so a new file in a brand-new subdirectory of a
 * digested package still runs its characterization. A merely modified file
 * outside the digest needs no such rule: editing an existing file never
 * changes the owned/unowned set the ownership guard reads — only an added
 * (or renamed-into-place) path can arrive unowned.
 */
export const CHARACTERIZATION_SUITES = Object.freeze([
  { baseline: 'tests/characterization/commercial-baseline.json', test: 'tests/characterization/commercial-characterization.test.js' },
  { baseline: 'tests/characterization/intelligence-baseline.json', test: 'tests/characterization/intelligence-characterization.test.js' },
  { baseline: 'tests/characterization/signature-baseline.json', test: 'tests/characterization/signature-characterization.test.js' },
]);

/** Every characterization staleness suite, for run reporting (see `main()`). */
export const CHARACTERIZATION_TESTS = Object.freeze(
  CHARACTERIZATION_SUITES.map((suite) => suite.test),
);

/**
 * Read every declared characterization baseline's `source` digest map and
 * invert it: repository-relative source path to the staleness suite(s) whose
 * baseline digests it. A source file digested by several baselines (today
 * `packages/commercial/src/registry.js`, digested by the commercial and the
 * signature baselines) maps to every suite, in suite-declaration order.
 * Throws naming the baseline(s) when one is missing, unreadable, or carries
 * no `source` digest map: a PR deleting or reshaping a baseline updates
 * `CHARACTERIZATION_SUITES` in the same PR, or the step fails red instead of
 * passing with a stale list — the way `withRepoWideGuards` treats a deleted
 * guard.
 * @param {string} repoRoot
 * @param {readonly {baseline: string, test: string}[]} suites
 * @returns {Map<string, string[]>}
 */
export function loadCharacterizationDigests(
  repoRoot,
  suites = CHARACTERIZATION_SUITES,
) {
  const index = new Map();
  const unreadable = [];
  for (const { baseline, test: suite } of suites) {
    let document;
    try {
      document = JSON.parse(readFileSync(join(repoRoot, baseline), 'utf8'));
    } catch {
      unreadable.push(baseline);
      continue;
    }
    const source = document !== null && typeof document === 'object' ? document.source : undefined;
    if (source === undefined || source === null || typeof source !== 'object' || Array.isArray(source)) {
      unreadable.push(baseline);
      continue;
    }
    for (const file of Object.keys(source)) {
      const key = normalize(file).replace(/\\/g, '/');
      const tests = index.get(key);
      if (tests === undefined) index.set(key, [suite]);
      else if (!tests.includes(suite)) tests.push(suite);
    }
  }
  if (unreadable.length > 0) {
    throw new Error(
      'characterization baseline(s) missing or without a source digest map: '
      + `${unreadable.join(', ')}. A PR deleting or reshaping a baseline updates CHARACTERIZATION_SUITES in the same PR.`,
    );
  }
  return index;
}

/**
 * Digest-owned directories: the immediate parent directory of every file a
 * characterization baseline digests, each mapped to the staleness suite(s)
 * whose baseline digests something under it. Derived from the digest index
 * (`loadCharacterizationDigests`), so a regenerated baseline moves the
 * boundary with it — no second list to keep in sync.
 * @param {Map<string, string[]>} digestIndex
 * @returns {Map<string, string[]>}
 */
export function digestDirectorySuites(digestIndex) {
  const directories = new Map();
  for (const [file, suites] of digestIndex) {
    const directory = dirname(normalize(file).replace(/\\/g, '/'));
    const known = directories.get(directory);
    if (known === undefined) directories.set(directory, [...suites]);
    else for (const suite of suites) {
      if (!known.includes(suite)) known.push(suite);
    }
  }
  return directories;
}

/** Added paths that can arrive outside digest ownership: executable source and record manifests. */
const DIGEST_RELEVANT_ADDED = /\.[cm]?js$|\.module\.json$/;

/**
 * Add the characterization staleness suite(s) (`CHARACTERIZATION_SUITES`) on
 * top of a mapped or fallback selection when the diff touches a file their
 * baselines digest — or adds a digest-relevant source file under a directory
 * their baselines digest (a brand-new file is never a digest key yet).
 *
 * - a diff touching no digested path (docs-only included) returns the
 *   selection unchanged — but only after the missing check below, so a PR
 *   deleting a listed suite without digesting anything still fails red
 *   naming it instead of passing with a stale list;
 * - an empty diff stays empty;
 * - a listed suite missing from `testContents` throws instead of silently
 *   shrinking the gate, the way `withKernelBoundaryTests` does;
 * - duplicates collapse: a suite the mapping already selected runs once.
 */
export function withCharacterizationTests(
  /** @type {string[]} */ selectedTests,
  /** @type {Map<string, string>} */ testContents,
  /** @type {string[]} */ changedFiles,
  /** @type {Map<string, string[]>} */ digestIndex = new Map(),
  /** @type {readonly {baseline: string, test: string}[]} */ suites = CHARACTERIZATION_SUITES,
  /** @type {string[]} */ addedFiles = [],
) {
  if (changedFiles.length === 0) return [...selectedTests].sort();
  const missing = suites
    .map((suite) => suite.test)
    .filter((suite) => !testContents.has(suite));
  if (missing.length > 0) {
    throw new Error(
      'characterization test(s) listed in CHARACTERIZATION_SUITES but absent from tests/: '
      + `${missing.join(', ')}. A PR deleting a characterization suite updates the list in the same PR.`,
    );
  }
  const matched = new Set();
  for (const file of changedFiles) {
    const key = normalize(file).replace(/\\/g, '/');
    for (const suite of digestIndex.get(key) ?? []) matched.add(suite);
  }
  if (addedFiles.length > 0) {
    const ownedDirs = digestDirectorySuites(digestIndex);
    for (const file of addedFiles) {
      const key = normalize(file).replace(/\\/g, '/');
      if (!DIGEST_RELEVANT_ADDED.test(key)) continue;
      let directory = dirname(key);
      while (directory !== '.' && directory !== '/') {
        for (const suite of ownedDirs.get(directory) ?? []) matched.add(suite);
        directory = dirname(directory);
      }
    }
  }
  if (matched.size === 0) return [...selectedTests].sort();
  return [...new Set([...selectedTests, ...matched])].sort();
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
 * Past this many files one sequential `node --test` process cannot finish
 * the step inside its bound (agent-crm#621: the warned fallback over its
 * files timed out past 270 s with no test failing), so the run splits into
 * parallel parts. At or below it the run stays exactly as before: one
 * process, `--test-concurrency=2`.
 */
export const SINGLE_SHARD_UP_TO = 12;

/**
 * The most parallel parts a run splits into: four lanes of one file at a
 * time stay inside what the shared 16 GB runner survived, beside the other
 * `ci-fast.sh` lanes on the 12-core Linux runner (whose own lane
 * parallelism already pushed the load to 33 on 12 cores once — #447/#448).
 */
export const MAX_SHARDS = 4;

/**
 * How many parallel parts a run of `fileCount` files splits into: one up
 * to `SINGLE_SHARD_UP_TO`, then about one part per dozen files, capped at
 * `MAX_SHARDS`. Pure: unit-tested.
 */
export function shardCountFor(
  /** @type {number} */ fileCount,
  /** @type {number} */ maxShards = MAX_SHARDS,
  /** @type {number} */ singleShardUpTo = SINGLE_SHARD_UP_TO,
) {
  if (fileCount <= singleShardUpTo) return 1;
  return Math.min(maxShards, Math.ceil(fileCount / singleShardUpTo));
}

/**
 * The jobs a run of `tests` over `partCount` parts pulls from its shared
 * queue, in order. One part keeps the old single step: one job over every
 * file, `--test-concurrency=2`. Several parts get one job per file, run one
 * file at a time, so a part that finishes a fast file takes the next one
 * instead of idling: agent-crm#621 split its 50-file fallback round-robin
 * into four fixed parts, two of them held most of the slow files, and the
 * run timed out at 270 s with "2 of 4 parts" done and every test green
 * while the other two parts sat idle. Pure: unit-tested.
 *
 * @returns {{ files: string[], concurrency: number }[]}
 */
export function testJobs(
  /** @type {string[]} */ tests,
  /** @type {number} */ partCount,
) {
  if (tests.length === 0) return [];
  if (Math.max(1, Math.floor(partCount)) === 1) return [{ files: [...tests], concurrency: 2 }];
  return tests.map((file) => ({ files: [file], concurrency: 1 }));
}

/**
 * Run `tests` in `parts` parallel parts that pull from one shared queue
 * (`testJobs`): each part starts a `node --test` process for its next job
 * as soon as its previous one exits, so at most `parts` files run at once
 * and the run ends about when the total work divided by the parts is done
 * (or when its slowest file is, if that is longer) — never when the
 * unluckiest fixed slice is. Every part's output streams live tagged with
 * its part (`[touched 1/4]`), each file's elapsed time is logged, and so is
 * each part's and the whole run's, so the cause of a slow run reads from
 * the log. Past `timeoutSec` the running processes die by SIGKILL and the
 * run resolves timed out naming every file not finished — the caller fails
 * red unless only the bonus remainder is unrun with everything green (see
 * `timeoutVerdict`), never green without the core having run.
 *
 * Resolves (never rejects) to `{ status, timedOut, remaining,
 * completedShards, elapsedSec, partSec, failedFiles }`: `status` is the
 * first nonzero exit code, or 0 when every file passed; `remaining` lists
 * the files running or still queued at the timeout; `completedShards`
 * counts the parts that drained; `partSec` is each part's busy time;
 * `failedFiles` lists every file whose own process exited nonzero, so a
 * timeout that also saw a failure can still fail red instead of warning
 * green over it. `cwd` is the repository root; the processes inherit this
 * process's environment (including `ACCORDO_TEST_POSTGRES` and
 * `ACCORDO_PG_TEST_URL`), minus `NODE_TEST_CONTEXT` so each is always a
 * fresh top-level runner.
 *
 * @returns {Promise<{ status: number, timedOut: boolean, remaining: string[], completedShards: number, elapsedSec: number, partSec: number[], failedFiles: string[] }>}
 */
export function runTestShards(
  /** @type {string[]} */ tests,
  /** @type {{ parts: number, timeoutSec: number, cwd: string, nodePath?: string, startTimer?: (fire: () => void, ms: number) => () => void, onJobDone?: (files: string[], status: number) => void }} */ options,
) {
  const jobs = testJobs(tests, options.parts);
  const parts = Math.min(Math.max(1, Math.floor(options.parts)), Math.max(1, jobs.length));
  /** @type {Promise<{ status: number, timedOut: boolean, remaining: string[], completedShards: number, elapsedSec: number, partSec: number[], failedFiles: string[] }>} */
  const done = new Promise((resolve) => {
    const started = Date.now();
    const elapsedSec = () => (Date.now() - started) / 1000;
    /** @type {number[]} */
    const partSec = Array.from({ length: parts }, () => 0);
    if (jobs.length === 0) {
      resolve({ status: 0, timedOut: false, remaining: [], completedShards: 0, elapsedSec: elapsedSec(), partSec: [], failedFiles: [] });
      return;
    }
    /** @type {Set<import('node:child_process').ChildProcess>} */
    const children = new Set();
    /** @type {boolean[]} */
    const jobDone = jobs.map(() => false);
    let next = 0;
    let drained = 0;
    let firstFailure = 0;
    /** @type {string[]} */
    const failedFiles = [];
    let settled = false;
    // Assigned below once the bound is armed. Declared first so a timer
    // that fires synchronously (an injected one may) finds a callable
    // cancel instead of a temporal-dead-zone ReferenceError.
    /** @type {() => void} */
    let cancelTimer = () => {};
    const settle = (
      /** @type {{ status: number, timedOut: boolean, remaining: string[], completedShards: number, elapsedSec: number, partSec: number[], failedFiles: string[] }} */ result,
    ) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      resolve(result);
    };
    // The bound's clock is injectable (backlog:3d560518f3e2): a test decides
    // when the bound fires — e.g. once a given file has finished — instead
    // of racing a wall-clock second against the machine's load.
    const startTimer = options.startTimer ?? ((fire, ms) => {
      const handle = setTimeout(fire, ms);
      return () => clearTimeout(handle);
    });
    const cancel = startTimer(() => {
      for (const child of children) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
      settle({
        status: 1,
        timedOut: true,
        remaining: jobs.filter((_, index) => !jobDone[index]).flatMap((job) => job.files),
        completedShards: drained,
        elapsedSec: elapsedSec(),
        partSec: partSec.map((sec) => Math.round(sec * 10) / 10),
        failedFiles: [...failedFiles],
      });
    }, options.timeoutSec * 1000);
    // Fired already (settled): nothing left to cancel later, cancel now.
    if (settled) cancel(); else cancelTimer = cancel;
    const startNext = (/** @type {number} */ part) => {
      const tag = `touched ${part + 1}/${parts}`;
      if (settled) return;
      if (next >= jobs.length) {
        drained += 1;
        process.stdout.write(`ci-touched-tests: part ${tag} finished in ${partSec[part].toFixed(1)}s.\n`);
        if (drained === parts) {
          const run = elapsedSec();
          process.stdout.write(
            `ci-touched-tests: ran ${tests.length} test file(s) in ${parts} part(s) in ${run.toFixed(1)}s `
              + `(part busy times: ${partSec.map((sec) => `${sec.toFixed(1)}s`).join(', ')}).\n`,
          );
          settle({
            status: firstFailure,
            timedOut: false,
            remaining: [],
            completedShards: drained,
            elapsedSec: run,
            partSec: partSec.map((sec) => Math.round(sec * 10) / 10),
            failedFiles: [...failedFiles],
          });
        }
        return;
      }
      const index = next;
      next += 1;
      const { files, concurrency } = jobs[index];
      const jobStarted = Date.now();
      // A part is a fresh top-level runner: without this a `node --test`
      // parent lends its `NODE_TEST_CONTEXT=child-v8` to the part, and the
      // part exits 0 without running anything (a silent green the gate must
      // never trust).
      const partEnv = { ...process.env };
      delete partEnv.NODE_TEST_CONTEXT;
      const child = spawn(
        options.nodePath ?? process.execPath,
        ['--no-warnings', '--test', `--test-concurrency=${concurrency}`, '--test-reporter=spec', ...files],
        { cwd: options.cwd, env: partEnv },
      );
      children.add(child);
      let tail = '';
      const tagged = (/** @type {Buffer|string} */ chunk) => {
        tail += String(chunk);
        const lines = tail.split('\n');
        tail = lines.pop() ?? '';
        for (const line of lines) process.stdout.write(`[${tag}] ${line}\n`);
      };
      if (child.stdout !== null) child.stdout.on('data', tagged);
      if (child.stderr !== null) child.stderr.on('data', tagged);
      child.on('error', () => {
        // A spawn failure carries no exit code: the close handler below
        // counts the job as failed.
      });
      child.on('close', (code) => {
        children.delete(child);
        if (settled) return;
        if (tail !== '') process.stdout.write(`[${tag}] ${tail}\n`);
        tail = '';
        jobDone[index] = true;
        const sec = (Date.now() - jobStarted) / 1000;
        partSec[part] += sec;
        const status = code ?? 1;
        if (status !== 0 && firstFailure === 0) firstFailure = status;
        if (status !== 0) failedFiles.push(...files);
        const what = files.length === 1 ? files[0] : `${files.length} file(s)`;
        process.stdout.write(`ci-touched-tests: part ${tag} ran ${what} in ${sec.toFixed(1)}s (exit ${status}).\n`);
        try {
          options.onJobDone?.(files, status);
        } catch (error) {
          // An observer must never stall its part: log and keep draining.
          process.stdout.write(`ci-touched-tests: onJobDone threw for ${what}: ${error instanceof Error ? error.message : error}\n`);
        }
        startNext(part);
      });
    };
    for (let part = 0; part < parts; part += 1) startNext(part);
  });
  return done;
}

/**
 * The busy rule (backlog:3d560518f3e2, the core's external-ci #1004 for this
 * gate): a run that timed out while the machine was full did not prove the
 * tests slow, the machine was. "Full" = load1 above `factor` × CPUs at the
 * run's start or at its bound. Pure: unit-tested.
 * @param {{ loadStart: number | null, loadEnd: number | null, cpus: number, factor?: number }} input
 * @returns {{ busy: boolean, threshold: number }}
 */
export function busyVerdict({ loadStart, loadEnd, cpus: cpuCount, factor = BUSY_LOAD_FACTOR }) {
  const threshold = Math.round(cpuCount * factor * 10) / 10;
  const readings = [loadStart, loadEnd].filter((value) => typeof value === 'number' && Number.isFinite(value));
  return { busy: readings.some((value) => value > threshold), threshold };
}

/** load1 is "full" above this many times the CPU count. */
export const BUSY_LOAD_FACTOR = 1.5;

/**
 * load1 from a loadavg file (`/proc/loadavg` by default, `CI_LOADAVG_FILE`
 * in tests), or null where there is none (macOS, a bad file).
 * @param {string} [file]
 * @returns {number | null}
 */
export function readLoad1(file = process.env.CI_LOADAVG_FILE || '/proc/loadavg') {
  try {
    const value = Number(readFileSync(file, 'utf8').trim().split(/\s+/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The CPU count the rule scales by (`CI_CPU_COUNT` in tests). */
export function cpuCount() {
  const forced = Number(process.env.CI_CPU_COUNT);
  if (Number.isInteger(forced) && forced > 0) return forced;
  return typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
}

/**
 * Decide a red timeout's fate and say it. A timeout with a failed file, or on
 * a machine under the bound, stays red. A timeout on a full machine is
 * "busy": with `busyFile` set (the parallel gate sets it, once) the decision
 * is written there, atomically, for the gate's single retry. The exit stays
 * nonzero either way: only the retry can turn it green.
 * @param {{ loadStart: number | null, loadEnd: number | null, cpus: number, failedFiles: string[], remaining: string[], busyFile?: string }} input
 * @returns {{ busy: boolean, threshold: number, line: string }}
 */
export function decideTimeout({ loadStart, loadEnd, cpus: cpuTotal, failedFiles, remaining, busyFile }) {
  const { busy: full, threshold } = busyVerdict({ loadStart, loadEnd, cpus: cpuTotal });
  const busy = full && failedFiles.length === 0;
  const loads = `load1 ${loadStart ?? 'n/a'} at start, ${loadEnd ?? 'n/a'} at the bound (busy above ${threshold} = ${BUSY_LOAD_FACTOR} x ${cpuTotal} CPUs)`;
  let decision;
  if (failedFiles.length > 0) decision = 'red: a file failed, the load does not matter';
  else if (!full) decision = 'red: the machine was not full, the tests were slow';
  else if (!busyFile) decision = 'red: busy, but this run is already the retry (or the gate does not retry)';
  else decision = 'busy: not counted as red, the gate retries the touched tests once when the load drops';
  if (busy && busyFile) {
    const pending = `${busyFile}.${process.pid}`;
    writeFileSync(pending, `${JSON.stringify({ loadStart, loadEnd, threshold, cpus: cpuTotal, remaining })}\n`);
    renameSync(pending, busyFile);
  }
  return { busy: busy && Boolean(busyFile), threshold, line: `ci-touched-tests: timed out with ${loads}: ${decision}.` };
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
 * The commit the PR is measured against, pinned once (backlog:3d560518f3e2):
 * the base ref resolved to a sha, then the merge-base of that sha with HEAD.
 * Every diff below reads this one sha, so a ref that moves mid-run — a
 * parallel phase's `git fetch` rewriting FETCH_HEAD or a tracking ref — can
 * never split the three diffs across two bases, and the log can name the
 * base it really used.
 * @param {(args: string[]) => { status: number | null, stdout: string }} runGit
 * @param {string} base
 * @returns {{ baseSha: string, mergeBase: string }}
 */
export function resolveDiffBase(runGit, base) {
  const resolved = runGit(['rev-parse', '--verify', `${base}^{commit}`]);
  const baseSha = String(resolved.stdout ?? '').trim();
  if (resolved.status !== 0 || !/^[0-9a-f]{40,64}$/.test(baseSha)) {
    throw new Error(`ci-touched-tests: base revision ${base} is not present. Fetch the PR base before running (CI does this in the step before).`);
  }
  const merged = runGit(['merge-base', baseSha, 'HEAD']);
  const mergeBase = String(merged.stdout ?? '').trim();
  if (merged.status !== 0 || !/^[0-9a-f]{40,64}$/.test(mergeBase)) {
    throw new Error(`ci-touched-tests: ${base} (${baseSha.slice(0, 12)}) shares no history with HEAD: no merge-base to diff against.`);
  }
  return { baseSha, mergeBase };
}

/**
 * The fallback's core before the guards, said as what it is: the PR's own
 * changed test files and the nearest selected tests that filled the budget.
 * It used to read "26 changed test file(s)" for 1 changed test plus 25
 * nearest — which read like a 26-file diff (backlog:3d560518f3e2).
 * @param {readonly string[]} core
 * @param {readonly string[]} changed
 */
export function describeFallbackCore(core, changed) {
  const own = new Set(changed);
  const changedTests = core.filter((file) => own.has(file)).length;
  return `${changedTests} changed test file(s), ${core.length - changedTests} nearest selected`;
}

/**
 * The PR's changed files against `base`, split in four: `changed` drives
 * what runs (the unfiltered diff minus the deleted-only diff: uppercase
 * `--diff-filter=D` selects only deleted paths — lowercase `-d` would
 * exclude them — so the code subtracts that set; a deleted file needs no
 * test run, and a deleted test file no longer on disk would fail
 * the run), `deleted` seeds the reachability search only (a deleted module
 * an unchanged test still imports selects that importer — the walk stops
 * at test files, and a deleted test is absent from the corpus so it is
 * never itself selected), `added` drives the characterization new-file rule
 * (a brand-new file is never a digest key yet: `--diff-filter=ACR` lists
 * the added paths plus the rename/copy destinations `--name-only` prints
 * as their new path, so a file renamed into a digested package counts as
 * added there), `allChanged` drives the guard check (a PR deleting a
 * listed guard without updating the list still fails red).
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
  const fresh = runGit(['diff', '--name-only', '--diff-filter=ACR', range]);
  if (fresh.status !== 0) {
    throw new Error(`ci-touched-tests: \`git diff --name-only --diff-filter=ACR ${range}\` failed.`);
  }
  const paths = (/** @type {string} */ output) => (output
    ? output.split('\n').map((line) => line.trim()).filter(Boolean)
    : []);
  const deleted = new Set(paths(gone.stdout));
  const allChanged = paths(all.stdout);
  return {
    changed: allChanged.filter((file) => !deleted.has(file)),
    deleted: allChanged.filter((file) => deleted.has(file)),
    added: paths(fresh.stdout).filter((file) => !deleted.has(file)),
    allChanged,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let changed;
  let deleted;
  let added;
  let allChanged;
  try {
    const { baseSha, mergeBase } = resolveDiffBase(git, options.base);
    ({ changed, deleted, added, allChanged } = listChangedFiles(git, mergeBase));
    const changedTests = changed.filter((file) => file.endsWith('.test.js')).length;
    process.stdout.write(
      `ci-touched-tests: base ${options.base} = ${baseSha.slice(0, 12)}, merge-base with HEAD ${mergeBase.slice(0, 12)}: `
        + `${allChanged.length} changed file(s), ${changedTests} of them test file(s).\n`,
    );
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
  const distances = touchedTestDistances([...changed, ...deleted], contents, buildFileImports(root));
  const mapped = [...distances.keys()].sort();
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
  let plan = base;
  let preGuardTests = plan.kind === 'skip' || plan.kind === 'refuse' ? [] : plan.tests;
  const applyAlwaysRunGuards = (tests) => {
    try {
      return withCharacterizationTests(
        withPackageDeclarationFreezeTests(
          withKernelBoundaryTests(
            withRepoWideGuards(tests, contents, allChanged),
            contents,
            allChanged,
          ),
          contents,
          allChanged,
        ),
        contents,
        allChanged,
        loadCharacterizationDigests(root),
        CHARACTERIZATION_SUITES,
        added,
      );
    } catch (error) {
      process.stderr.write(`ci-touched-tests: ${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
  };
  if (plan.kind !== 'refuse') {
    plan.tests = applyAlwaysRunGuards(preGuardTests);
  }
  // Total-budget guard: the always-run guards join AFTER the cap, so a
  // mapped selection that fits can still outgrow the step once they join
  // (seen: ~47 mapped + 14 guards needed ~900 s against a 270 s bound).
  // Past the cap the gate falls back the same warned way an oversized
  // mapped selection does — guards still run, the dropped set is named,
  // and the full suite on `main` stays the net.
  if (plan.kind === 'run' && plan.tests.length > options.maxSelected) {
    process.stdout.write(
      `ci-touched-tests: warning: ${preGuardTests.length} selected test(s) plus ${plan.tests.length - preGuardTests.length} always-run guard(s) outgrow this step's ${options.maxSelected}-file budget — running the fallback suite instead.\n`,
    );
    plan = fallbackPlan(changed, 'oversized-selection', allChanged, mapped);
    preGuardTests = plan.kind === 'refuse' ? [] : plan.tests;
    if (plan.kind !== 'refuse') {
      plan.tests = applyAlwaysRunGuards(preGuardTests);
    }
  }
  // An oversized fallback runs the PR's own tests plus the guards, then
  // fills what is left of the file budget with the nearest selected tests
  // (`nearestFirst`) instead of dropping them all.
  if (plan.kind === 'fallback' && plan.reason === 'oversized-selection') {
    const nearest = fillNearest(plan.tests, nearestFirst(distances), options.maxSelected);
    if (nearest.length > 0) {
      process.stderr.write(
        `ci-touched-tests: filling the budget with the ${nearest.length} nearest selected test(s): ${nearest.join(', ')}.\n`,
      );
      preGuardTests = [...preGuardTests, ...nearest];
      plan.tests = [...plan.tests, ...nearest].sort();
    }
  }
  // The dropped remainder drains behind the core suite in the same shared
  // queue, nearest first (`bonusQueue`): an oversized selection no longer
  // leaves selected tests unrun and unnamed — the bound decides how far the
  // queue drains, and a timeout names whatever it did not reach. The refusal
  // queues nothing: fail-closed, there is no evidence this step can run.
  const bonus = plan.kind === 'refuse' ? [] : bonusQueue(distances, plan.tests);
  const queue = [...plan.tests, ...bonus];
  const bonusNote = bonus.length === 0
    ? null
    : `queuing ${bonus.length} bonus test(s) behind the ${plan.tests.length} core file(s), nearest first: ${bonus.join(', ')} — every file the run bound does not reach is named at timeout, and the full suite on \`main\` stays the safety net`;
  const addedGuards = plan.kind === 'refuse'
    ? []
    : plan.tests.filter((test) => !preGuardTests.includes(test));
  const addedBoundary = plan.kind === 'refuse'
    ? []
    : plan.tests.filter(
      (test) => !preGuardTests.includes(test) && KERNEL_BOUNDARY_TESTS.includes(test),
    );
  const addedCharacterization = plan.kind === 'refuse'
    ? []
    : plan.tests.filter(
      (test) => !preGuardTests.includes(test) && CHARACTERIZATION_TESTS.includes(test),
    );
  const addedDeclaration = plan.kind === 'refuse'
    ? []
    : plan.tests.filter(
      (test) => !preGuardTests.includes(test) && PACKAGE_DECLARATION_FREEZE_TESTS.includes(test),
    );

  // Selected tests outside the core suite, after the guards joined: a
  // non-empty set here is always reported — a `::warning::` annotation
  // plus a summary line naming them — including on the skip path, so a
  // discarded mapped set can never go quiet. Outside the refusal they drain
  // as the bonus queue above instead of being dropped; the note then names
  // what is queued rather than what is skipped.
  const droppedTests = (plan.dropped ?? []).filter((test) => !plan.tests.includes(test));
  const droppedNote = droppedTests.length === 0
    ? null
    : `dropping ${droppedTests.length} selected test(s) this step does not run: ${droppedTests.join(', ')}`;
  const remainderNote = bonusNote ?? droppedNote;

  if (options.list) {
    if (plan.reason && plan.kind === 'fallback') {
      process.stderr.write(`ci-touched-tests: warning: ${selectNote ?? plan.reason} — listing the fallback suite plus the repo-wide guards.\n`);
    }
    if (remainderNote !== null) {
      process.stderr.write(`ci-touched-tests: warning: ${remainderNote}.\n`);
    }
    process.stdout.write(queue.length === 0 ? '' : `${queue.join('\n')}\n`);
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
  if (addedCharacterization.length > 0) {
    process.stdout.write(
      `ci-touched-tests: plus ${addedCharacterization.length} characterization test(s): ${addedCharacterization.join(', ')}.\n`,
    );
  }
  if (addedDeclaration.length > 0) {
    process.stdout.write(
      `ci-touched-tests: plus ${addedDeclaration.length} declaration freeze test(s): ${addedDeclaration.join(', ')}.\n`,
    );
  }

  if (plan.kind === 'fallback') {
    // A changed source file no test reaches warns here — the ::warning::
    // annotation for the job plus this summary line naming the uncovered
    // files — instead of blocking: the guards above still run, and the full
    // suite on `main` stays the safety net. A discarded mapped set is
    // named too, so an oversized or timed-out deletion-only diff can never
    // go quiet about the importers it queues behind the core suite.
    const uncovered = changed.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    const why = plan.reason === 'selection-timeout' && selectNote !== null
      ? selectNote
      : plan.reason === 'empty-selection' && preGuardTests.length === 0
        ? `no test file relatively reaches these changed source file(s): ${uncovered.join(', ') || '(deleted scope only)'} — best-effort guards only, the full suite on \`main\` stays the safety net`
        : `selected ${mapped.length} test file(s), past the ${options.maxSelected} this step can run`;
    process.stdout.write(
      `ci-touched-tests: warning: ${why} — running the fallback suite instead `
      + `(${describeFallbackCore(preGuardTests, changed)} plus ${addedGuards.length} repo-wide guard(s)): ${plan.tests.join(', ')}.`
      + `${remainderNote === null ? '' : ` ${remainderNote}.`}\n`,
    );
    process.stdout.write(
      `::warning::ci-touched-tests: ${why} — running ${queue.length} test file(s) instead of ${mapped.length} selected.${remainderNote === null ? '' : ` ${remainderNote}.`}\n`,
    );
  }
  if (plan.kind === 'skip' && remainderNote !== null) {
    // Pathological but reachable: the scope carries no JavaScript, yet a
    // test relatively imports a changed non-source file (a fixture, a data
    // file). The guards above still run; the remainder is queued as bonus
    // (or named when the plan dropped it) instead of going quiet.
    process.stdout.write(
      `ci-touched-tests: warning: ${remainderNote} — best-effort ${bonusNote === null ? 'guards only' : 'guards plus bonus'}, the full suite on \`main\` stays the safety net.\n`,
    );
    process.stdout.write(`::warning::ci-touched-tests: ${remainderNote}.\n`);
  }

  // The run is sharded past a dozen files (see the header): one sequential
  // `node --test` process cannot finish a core-wide fan-in inside the bound
  // (agent-crm#621: the warned fallback timed out past 270 s with no test
  // failing). A dozen files or fewer run exactly as before — same flags as
  // `npm test`, two files at a time, keeping peak memory inside what the
  // shared 16 GB runner survived (ci.yml) — at the price of wall time this
  // step bounds with its timeout instead. Past that the parts pull one file
  // at a time from a shared queue (at most four files at once, beside the
  // other `ci-fast.sh` lanes), so no part idles while another still holds a
  // fixed slice of slow files (agent-crm#621 again: round-robin slices, two
  // parts done, two still busy at 270 s). The queue holds the core suite
  // first and the bonus remainder behind it, so an oversized selection
  // drains nearest-first while the bound allows. The bound yields to the
  // selection phase so select-plus-run always fits the step wrapper; the
  // floor of a minute still runs at least one slow file.
  const runBudget = runBudgetSec(options.timeoutSec, selectionElapsedSec);
  const parts = shardCountFor(queue.length);
  if (parts > 1) {
    process.stdout.write(
      bonus.length === 0
        ? `ci-touched-tests: running ${plan.tests.length} test file(s) in ${parts} parallel part(s) sharing one queue, bound ${runBudget}s.\n`
        : `ci-touched-tests: running ${queue.length} test file(s) (${plan.tests.length} core plus ${bonus.length} bonus draining nearest-first while the bound allows) in ${parts} parallel part(s) sharing one queue, bound ${runBudget}s.\n`,
    );
  }
  const loadStart = readLoad1();
  const run = await runTestShards(queue, { parts, timeoutSec: runBudget, cwd: root });
  if (run.timedOut) {
    const what = plan.kind === 'fallback' ? 'default fast suite' : 'selected run';
    const coreSet = new Set(plan.tests);
    const coreRemaining = run.remaining.filter((file) => coreSet.has(file));
    const bonusRemaining = run.remaining.filter((file) => !coreSet.has(file));
    if (timeoutVerdict(plan.tests, run.remaining, run.failedFiles) === 'warn') {
      // The core suite finished green and nothing failed: only bonus files
      // the bound did not reach remain. Warn naming them instead of failing
      // red over coverage the step could not fit — every unrun file is
      // named, and the full suite on `main` stays the safety net behind it.
      // A failure anywhere, or an unfinished core file, still fails red.
      process.stdout.write(
        `ci-touched-tests: warning: the ${plan.tests.length} core file(s) finished green but `
          + `${bonusRemaining.length} bonus file(s) did not run in ${runBudget}s: ${bonusRemaining.join(', ') || '(none reported)'}. `
          + `The full suite on \`main\` stays the safety net behind them.\n`,
      );
      process.stdout.write(
        `::warning::ci-touched-tests: core green, ${bonusRemaining.length} bonus file(s) unrun after ${runBudget}s: ${bonusRemaining.join(', ') || '(none reported)'}. `
          + `Completed ${run.completedShards} of ${parts} part(s); part busy times: ${run.partSec.map((sec) => `${sec}s`).join(', ')}.\n`,
      );
      process.exit(0);
    }
    const decision = decideTimeout({
      loadStart,
      loadEnd: readLoad1(),
      cpus: cpuCount(),
      failedFiles: run.failedFiles,
      remaining: run.remaining,
      busyFile: process.env.CI_TOUCHED_BUSY_FILE || undefined,
    });
    process.stdout.write(`${decision.line}\n`);
    process.stderr.write(
      `ci-touched-tests: ${what} did not finish in ${runBudget}s — failing red, not hanging the lock. `
        + `${coreRemaining.length} core file(s) remaining: ${coreRemaining.join(', ') || '(none reported)'}; `
        + `${bonusRemaining.length} bonus file(s) remaining: ${bonusRemaining.join(', ') || '(none reported)'}.\n`,
    );
    process.stdout.write(
      `::error::ci-touched-tests: ${what} timed out after ${runBudget}s with `
        + `${coreRemaining.length} core file(s) remaining: ${coreRemaining.join(', ') || '(none reported)'}; `
        + `${bonusRemaining.length} bonus file(s) remaining: ${bonusRemaining.join(', ') || '(none reported)'}. `
        + `${run.failedFiles.length === 0 ? '' : `Failed file(s): ${run.failedFiles.join(', ')}. `}`
        + `Completed ${run.completedShards} of ${parts} part(s); part busy times: ${run.partSec.map((sec) => `${sec}s`).join(', ')}.\n`,
    );
    process.exit(1);
  }
  process.exit(run.status);
}

// Importing this module (the unit test does) must not run the gate: only
// a direct invocation selects and runs tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
