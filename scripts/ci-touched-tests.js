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
 * - `export ... from` re-exports count as imports for the mapping above;
 * - a changed file no test file reaches selects nothing only when no
 *   JavaScript source changed (docs, workflows, `package.json`, site
 *   content): the agreement gates of the same CI job (`gtm:check`,
 *   `repo:truth -- --check`) still run. A changed `.js`/`.cjs`/`.mjs` file
 *   with no reaching test fails closed instead: the step refuses with
 *   exit 1, naming the uncovered files, rather than exiting 0 without
 *   running anything. It does not run the default `npm test` suite as a
 *   fallback: the full suite holds the machine lock ~20 minutes and cannot
 *   fit this step's five-minute budget, so a fallback run would time out
 *   red on every PR that triggers it.
 *
 * Usage:
 *
 *   node scripts/ci-touched-tests.js [--base <rev>] [--list] [--timeout-sec <n>]
 *
 * `--base` is the revision the change is measured against (`origin/main` by
 * default; CI fetches the PR base and passes it explicitly). `--list` prints
 * the selected files without running them. The run itself is bounded: the
 * per-step CI budget is five minutes, so the default timeout refuses to hold
 * the machine lock longer than that — a hanging selection fails red instead
 * of queueing every other factory behind it.
 *
 * Exit codes: 0 the selected tests passed (or only non-source files
 * changed and there was nothing to run), 1 the selection failed, a test
 * failed, or the fail-closed refusal (a changed source file no test
 * reaches), 2 unusable input.
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
  const importsOf = (/** @type {string} */ file) => {
    const extra = fileImports.get(file);
    if (extra) return extra;
    const content = testContents.get(file);
    if (content === undefined) return new Set();
    return relativeImportsOf(file, content);
  };
  /** The files a test reaches: its own imports, then theirs, cycle-safe. */
  const reachesOf = (/** @type {string} */ testPath) => {
    const reached = new Set();
    const queue = [...importsOf(testPath)];
    while (queue.length > 0) {
      const next = queue.pop();
      if (!next || reached.has(next)) continue;
      reached.add(next);
      // Only non-test files are followed: a test importing another test
      // does not run it, so the graph stops at test boundaries. Reached
      // paths are extension-free, so the boundary is the trailing `.test`.
      if (!/\.test$/.test(next)) {
        for (const deeper of importsOf(next)) {
          if (!reached.has(deeper)) queue.push(deeper);
        }
      }
    }
    return reached;
  };
  for (const [testPath] of testContents) {
    const stripped = stripSourceExtension(testPath);
    if (changed.has(stripped) || changed.has(testPath)) {
      selected.add(testPath);
      continue;
    }
    for (const reached of reachesOf(testPath)) {
      if (changed.has(reached)) {
        selected.add(testPath);
        break;
      }
    }
  }
  return [...selected].sort();
}

/**
 * Command-line options, exported so the unit test locks the documented
 * usage (`--timeout-sec <n>` followed by other flags) instead of trusting
 * it. Error paths exit the process and are not unit-tested.
 */
export function parseArgs(argv) {
  const options = { base: 'origin/main', list: false, timeoutSec: DEFAULT_TIMEOUT_SEC };
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
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        process.stderr.write('ci-touched-tests: --timeout-sec needs a positive number of seconds\n');
        process.exit(2);
      }
      options.timeoutSec = value;
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

  const selected = selectTouchedTests(changed, contents, buildFileImports(root));

  if (options.list) {
    process.stdout.write(selected.length === 0 ? '' : `${selected.join('\n')}\n`);
    process.exit(0);
  }

  // Fail closed: JavaScript source changed but no test reaches it (a CLI
  // reached only via `spawnSync`, a helper nobody imports yet). Exiting 0
  // here would merge an untested change green and redden `main` after the
  // merge, so the gate refuses with exit 1, naming the uncovered files:
  // add a test that relatively imports them (directly or through
  // `tests/helpers`) and the gate runs it. The step deliberately does not
  // run the default `npm test` suite as a fallback: the full suite holds
  // the machine lock ~20 minutes and cannot fit this step's five-minute
  // budget, so a fallback run would time out red on every PR that triggers
  // it — a refusal that says what to do instead of a timeout that cannot
  // pass. The full suite still runs on `main` after the merge. Docs,
  // workflows, manifests and site-only changes keep the exit-0 skip: their
  // gates run in the same CI job.
  if (selected.length === 0) {
    if (!hasCodeChange(changed)) {
      process.stdout.write(
        `ci-touched-tests: ${changed.length} changed file(s), no test file reaches them — nothing to run.\n`,
      );
      process.exit(0);
    }
    const uncovered = changed.filter((file) => SOURCE_EXT.test(normalize(file).replace(/\\/g, '/')));
    process.stdout.write(
      'ci-touched-tests: refusing — no test file relatively reaches these '
      + `changed source file(s): ${uncovered.join(', ')}.\n`
      + 'Add a test that relatively imports them (directly or through tests/helpers); '
      + 'the default `npm test` suite cannot fit this step\'s five-minute budget, '
      + 'so it runs only on `main`, not here.\n',
    );
    process.exit(1);
  }

  // Same flags as `npm test`: two files at a time keeps peak memory inside
  // what the shared 16 GB runner survived (ci.yml), at the price of wall time
  // this step bounds with its timeout instead.
  const run = spawnSync(
    process.execPath,
    ['--no-warnings', '--test', '--test-concurrency=2', '--test-reporter=spec', ...selected],
    { cwd: root, stdio: 'inherit', timeout: options.timeoutSec * 1000, killSignal: 'SIGKILL' },
  );
  if (run.error) {
    process.stderr.write(`ci-touched-tests: selection did not finish in ${options.timeoutSec}s — failing red, not hanging the lock.\n`);
    process.exit(1);
  }
  process.exit(run.status ?? 1);
}

// Importing this module (the unit test does) must not run the gate: only
// a direct invocation selects and runs tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
