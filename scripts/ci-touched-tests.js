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
 *   (specifiers are resolved against the importing file, extension-free);
 * - a changed file no test file imports (docs, workflows, `package.json`,
 *   site content) selects nothing: the agreement gates of the same CI job
 *   (`gtm:check`, `repo:truth -- --check`) still run.
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
 * Exit codes: 0 the selected tests passed (or there were none), 1 the
 * selection failed or a test failed, 2 unusable input.
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
  const pattern = /(?:import\s+(?:[^'"]*?\s+from\s+)?|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/g;
  let match = pattern.exec(content);
  while (match) {
    const resolved = normalize(join(dirname(testFile), match[1])).replace(/\\/g, '/');
    found.add(stripSourceExtension(resolved));
    match = pattern.exec(content);
  }
  return found;
}

/**
 * Map changed repository-relative paths to the test files that cover them:
 * changed test files themselves, plus every test file relatively importing a
 * changed file. `testContents` maps repository-relative test paths to their
 * source. Returns sorted repository-relative test paths.
 */
export function selectTouchedTests(
  /** @type {string[]} */ changedFiles,
  /** @type {Map<string, string>} */ testContents,
) {
  const selected = new Set();
  const changed = new Set(
    changedFiles.map((file) => stripSourceExtension(normalize(file).replace(/\\/g, '/'))),
  );
  for (const [testPath, content] of testContents) {
    const stripped = stripSourceExtension(testPath);
    if (changed.has(stripped) || changed.has(testPath)) {
      selected.add(testPath);
      continue;
    }
    for (const imported of relativeImportsOf(testPath, content)) {
      if (changed.has(imported)) {
        selected.add(testPath);
        break;
      }
    }
  }
  return [...selected].sort();
}

function parseArgs(argv) {
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

  const selected = selectTouchedTests(changed, contents);

  if (options.list || selected.length === 0) {
    process.stdout.write(
      selected.length === 0
        ? `ci-touched-tests: ${changed.length} changed file(s), no test file imports them — nothing to run.\n`
        : `${selected.join('\n')}\n`,
    );
    process.exit(0);
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
