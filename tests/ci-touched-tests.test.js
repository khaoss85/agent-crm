// @ts-check

/**
 * `ci-touched-tests.js`: the fast PR gate runs the test files a change
 * touched — changed test files themselves, plus every test file relatively
 * importing a changed file.
 *
 * The mapping is unit-tested against values; the `git diff <base>...HEAD`
 * selection is driven end to end on a throwaway repository with real git,
 * because a stubbed git there would prove nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnGit } from './helpers/isolated-git.js';
import {
  REPO_WIDE_GUARDS,
  REPO_WIDE_GUARD_EXCLUSIONS,
  buildFileImports,
  changedTestFiles,
  fallbackPlan,
  hasCodeChange,
  listChangedFiles,
  parseArgs,
  planGate,
  relativeImportsOf,
  runBudgetSec,
  selectTouchedTests,
  withRepoWideGuards,
} from '../scripts/ci-touched-tests.js';

/** @param {Record<string, string>} entries */
const contents = (entries) => new Map(Object.entries(entries));

test('a changed test file runs itself', () => {
  const selected = selectTouchedTests(
    ['tests/api.test.js'],
    contents({ 'tests/api.test.js': "import test from 'node:test';\n" }),
  );
  assert.deepEqual(selected, ['tests/api.test.js']);
});

test('a changed source file runs its relative importers', () => {
  const selected = selectTouchedTests(
    ['packages/app/src/index.js'],
    contents({
      'tests/api.test.js': "import { createAccordoApp } from '../packages/app/src/index.js';\n",
      'tests/admin-core.test.js': "import { createAccordoApp } from '../packages/app/src/index.js';\n",
      'tests/commercial-e2e.test.js': "import { createStore } from '../packages/commercial/src/store.js';\n",
    }),
  );
  assert.deepEqual(selected, ['tests/admin-core.test.js', 'tests/api.test.js']);
});

test('extension-free and extension-less specifiers match the same file', () => {
  const selected = selectTouchedTests(
    ['scripts/apply-ci-measurement.js'],
    contents({
      // .js, extension-free, and require() spellings of the same specifier.
      'tests/a.test.js': "import { x } from '../scripts/apply-ci-measurement.js';\n",
      'tests/b.test.js': "import { x } from '../scripts/apply-ci-measurement';\n",
      'tests/c.test.js': "const { x } = require('../scripts/apply-ci-measurement.js');\n",
      'tests/d.test.js': "await import('../scripts/apply-ci-measurement.js');\n",
    }),
  );
  assert.deepEqual(selected, ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js', 'tests/d.test.js']);
});

test('a bare package import is not code in this repository', () => {
  const selected = selectTouchedTests(
    ['node:test'],
    contents({ 'tests/api.test.js': "import test from 'node:test';\n" }),
  );
  assert.deepEqual(selected, []);
});

test('a changed helper runs the tests importing it, and only those', () => {
  const selected = selectTouchedTests(
    ['tests/helpers/fixture-db.js'],
    contents({
      'tests/api.test.js': "import { seed } from './helpers/fixture-db.js';\n",
      'tests/other.test.js': "import { seed } from './helpers/other.js';\n",
    }),
  );
  assert.deepEqual(selected, ['tests/api.test.js']);
});

test('docs, workflows and manifests select no test file', () => {
  const selected = selectTouchedTests(
    ['docs/QUALITY_GATES.md', '.github/workflows/ci.yml', 'package.json', 'site/index.html'],
    contents({ 'tests/api.test.js': "import test from 'node:test';\n" }),
  );
  assert.deepEqual(selected, []);
});

test('relativeImportsOf resolves against the importing file', () => {
  const found = relativeImportsOf(
    'tests/characterization/inner.test.js',
    "import { x } from '../../packages/app/src/index.js';\nimport { y } from '../helpers/fixture-db.js';\n",
  );
  assert.deepEqual([...found].sort(), ['packages/app/src/index', 'tests/helpers/fixture-db']);
});

test('relativeImportsOf parses export-from re-exports', () => {
  const found = relativeImportsOf(
    'tests/re-export.test.js',
    "export { app } from '../packages/app/src/index.js';\nexport * from '../packages/core/src/errors.js';\nexport const local = 1;\n",
  );
  assert.deepEqual([...found].sort(), ['packages/app/src/index', 'packages/core/src/errors']);
});

test('a changed source reached only via a helper selects the helper importer', () => {
  // tests/writer-lease-renewal-postgresql.test.js boots the app through
  // tests/helpers/postgresql-application.js, which is the only file
  // importing the changed source: direct-only mapping would select nothing.
  const selected = selectTouchedTests(
    ['packages/app/src/index.js'],
    contents({
      'tests/writer.test.js': "import { boot } from './helpers/postgresql-application.js';\n",
      'tests/other.test.js': "import test from 'node:test';\n",
    }),
    new Map([
      ['tests/helpers/postgresql-application', new Set(['packages/app/src/index', 'packages/core/src/errors'])],
    ]),
  );
  assert.deepEqual(selected, ['tests/writer.test.js']);
});

test('selection follows two helper hops to the changed source', () => {
  const selected = selectTouchedTests(
    ['packages/core/src/errors.js'],
    contents({
      'tests/deep.test.js': "import { seed } from './helpers/a.js';\n",
      'tests/other.test.js': "import test from 'node:test';\n",
    }),
    new Map([
      ['tests/helpers/a', new Set(['tests/helpers/b'])],
      ['tests/helpers/b', new Set(['packages/core/src/errors'])],
    ]),
  );
  assert.deepEqual(selected, ['tests/deep.test.js']);
});

test('a helper cycle terminates and still selects the reaching test', () => {
  const selected = selectTouchedTests(
    ['packages/core/src/errors.js'],
    contents({
      'tests/cyclic.test.js': "import { seed } from './helpers/a.js';\n",
    }),
    new Map([
      ['tests/helpers/a', new Set(['tests/helpers/b'])],
      ['tests/helpers/b', new Set(['tests/helpers/a', 'packages/core/src/errors'])],
    ]),
  );
  assert.deepEqual(selected, ['tests/cyclic.test.js']);
});

test('a test importing another test does not follow into it', () => {
  const selected = selectTouchedTests(
    ['packages/app/src/index.js'],
    contents({
      'tests/inner.test.js': "import { app } from '../packages/app/src/index.js';\n",
      'tests/outer.test.js': "import './inner.test.js';\n",
    }),
  );
  assert.deepEqual(selected, ['tests/inner.test.js']);
});

test('a re-exporting test is selected for its re-exported source', () => {
  const selected = selectTouchedTests(
    ['packages/app/src/index.js'],
    contents({
      'tests/re-export.test.js': "export { app } from '../packages/app/src/index.js';\n",
      'tests/other.test.js': "import test from 'node:test';\n",
    }),
  );
  assert.deepEqual(selected, ['tests/re-export.test.js']);
});

test('hasCodeChange is true for source, false for docs-only changes', () => {
  // packages/cli/bin/accordo.js is reached by tests only via spawnSync, so
  // an empty selection with this change is the fail-closed case, never a
  // skip.
  assert.equal(hasCodeChange(['packages/cli/bin/accordo.js']), true);
  assert.equal(hasCodeChange(['tests/api.test.js']), true);
  assert.equal(
    hasCodeChange(['docs/QUALITY_GATES.md', '.github/workflows/ci.yml', 'package.json', 'site/index.html']),
    false,
  );
  assert.equal(hasCodeChange([]), false);
});

test('the real graph builder follows a packages/ barrel to the importing test', () => {
  // Regression test: the graph used to be walked from tests/ alone, so a
  // file behind a packages/ barrel (index.js re-exporting create-app.js)
  // never resolved and no test was selected for the file behind it. This
  // calls main()'s real graph builder over a fixture instead of a
  // hand-made map.
  const directory = mkdtempSync(join(tmpdir(), 'touched-graph-'));
  try {
    const write = (/** @type {string} */ path, /** @type {string} */ body) => {
      const full = join(directory, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    };
    write('packages/app/src/create-app.js', 'export const createApp = () => 1;\n');
    write('packages/app/src/index.js', "export * from './create-app.js';\n");
    write('tests/gui.test.js', "import { createApp } from '../packages/app/src/index.js';\n");
    write('tests/other.test.js', "import test from 'node:test';\n");

    const graph = buildFileImports(directory);
    // The barrel itself was walked: it is in the graph and points behind it.
    assert.deepEqual(
      [...(graph.get('packages/app/src/index') ?? [])],
      ['packages/app/src/create-app'],
    );
    // And the changed file behind the barrel selects the importing test.
    const testContents = new Map([
      ['tests/gui.test.js', "import { createApp } from '../packages/app/src/index.js';\n"],
      ['tests/other.test.js', "import test from 'node:test';\n"],
    ]);
    assert.deepEqual(
      selectTouchedTests(['packages/app/src/create-app.js'], testContents, graph),
      ['tests/gui.test.js'],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('parseArgs defaults to origin/main with the 270 s step bound', () => {
  assert.deepEqual(parseArgs([]), {
    base: 'origin/main',
    list: false,
    timeoutSec: 270,
    selectTimeoutSec: 60,
    maxSelected: 50,
  });
});

test('parseArgs consumes --base and --timeout-sec values instead of re-reading them', () => {
  // The documented `--timeout-sec 60 --list` spelling: the value must be
  // consumed as the flag's value, never re-read as an unknown argument.
  assert.deepEqual(
    parseArgs(['--timeout-sec', '60', '--list']),
    { base: 'origin/main', list: true, timeoutSec: 60, selectTimeoutSec: 60, maxSelected: 50 },
  );
  assert.deepEqual(
    parseArgs(['--base', 'FETCH_HEAD']),
    { base: 'FETCH_HEAD', list: false, timeoutSec: 270, selectTimeoutSec: 60, maxSelected: 50 },
  );
});

test('parseArgs consumes --select-timeout-sec and --max-selected', () => {
  assert.deepEqual(
    parseArgs(['--select-timeout-sec', '30', '--max-selected', '10']),
    { base: 'origin/main', list: false, timeoutSec: 270, selectTimeoutSec: 30, maxSelected: 10 },
  );
});

test('changedTestFiles is the PR-owned test scope, sorted', () => {
  assert.deepEqual(
    changedTestFiles([
      'tests/b.test.js',
      'packages/app/src/index.js',
      'tests/a.test.mjs',
      'docs/QUALITY_GATES.md',
      'scripts/tool.test.js',
    ]),
    ['tests/a.test.mjs', 'tests/b.test.js'],
  );
  assert.deepEqual(changedTestFiles(['packages/app/src/index.js']), []);
});

test('planGate runs a selection that fits the budget', () => {
  assert.deepEqual(
    planGate(['packages/app/src/index.js', 'tests/api.test.js'], ['tests/api.test.js'], 50),
    { kind: 'run', tests: ['tests/api.test.js'], reason: null, dropped: [] },
  );
});

test('planGate skips docs-only changes with an empty selection', () => {
  assert.deepEqual(
    planGate(['docs/QUALITY_GATES.md', 'package.json'], [], 50),
    { kind: 'skip', tests: [], reason: 'empty-selection', dropped: [] },
  );
});

test('planGate warns (fallback) when code changed and nothing reaches it', () => {
  // Best-effort, never a refusal: the guards still join in main() and run,
  // and the full suite on `main` stays the safety net.
  assert.deepEqual(
    planGate(['packages/cli/bin/accordo.js'], [], 50),
    { kind: 'fallback', tests: [], reason: 'empty-selection', dropped: [] },
  );
});

test('planGate falls back to the changed tests on an oversized selection', () => {
  const selected = Array.from({ length: 51 }, (_, i) => `tests/s${i}.test.js`);
  const plan = planGate(['packages/core/src/deep.js', 'tests/mine.test.js'], selected, 50);
  assert.equal(plan.kind, 'fallback');
  assert.deepEqual(plan.tests, ['tests/mine.test.js']);
  assert.equal(plan.reason, 'oversized-selection');
  // The fifty-one selected tests the fallback does not run are reported,
  // so main() can warn naming them.
  assert.equal(plan.dropped.length, 51);
  assert.ok(!plan.dropped.includes('tests/mine.test.js'));
});

test('planGate refuses an oversized selection with no changed test of its own', () => {
  // Fail-closed, not an empty green run: there is no evidence to run.
  const selected = Array.from({ length: 51 }, (_, i) => `tests/s${i}.test.js`);
  const plan = planGate(['packages/core/src/deep.js'], selected, 50);
  assert.equal(plan.kind, 'refuse');
  assert.deepEqual(plan.uncovered, ['packages/core/src/deep.js']);
  assert.deepEqual(plan.dropped, selected);
});

test('a deletion-only oversized selection refuses and names the dropped importers', () => {
  // Regression test: the runnable set alone (`changed`, without deleted
  // paths) made this a silent skip — `hasCodeChange([])` is false — while
  // sixty stale importers proved the breakage and the full suite on `main`
  // failed on the missing import. Decided on the reachability scope, it
  // refuses; deleted files still never run.
  const selected = Array.from({ length: 60 }, (_, i) => `tests/keep${i}.test.js`);
  const plan = planGate([], selected, 50, ['packages/core/src/shared.js']);
  assert.equal(plan.kind, 'refuse');
  assert.deepEqual(plan.tests, []);
  assert.deepEqual(plan.dropped, selected);
});

test('a timed-out deletion-only selection warns and names the dropped importers', () => {
  // Same family through the timeout path: `changed` is empty, the mapped
  // set is not, the scope carries the deleted source — a warned fallback,
  // never a skip, and the dropped importers are named.
  const selected = Array.from({ length: 60 }, (_, i) => `tests/keep${i}.test.js`);
  const plan = fallbackPlan([], 'selection-timeout', ['packages/core/src/shared.js'], selected);
  assert.equal(plan.kind, 'fallback');
  assert.deepEqual(plan.tests, []);
  assert.deepEqual(plan.dropped, selected);
});

test('a docs-only change still skips even with a deleted scope beside it', () => {
  // No JavaScript anywhere in the scope: nothing to refuse or warn about.
  const plan = fallbackPlan(['docs/QUALITY_GATES.md'], 'empty-selection', ['docs/QUALITY_GATES.md']);
  assert.deepEqual(plan, { kind: 'skip', tests: [], reason: 'empty-selection', dropped: [] });
});

test('fallbackPlan resolves skip, warned fallback and refuse without a selection', () => {
  assert.deepEqual(
    fallbackPlan(['docs/QUALITY_GATES.md'], 'selection-timeout'),
    { kind: 'skip', tests: [], reason: 'selection-timeout', dropped: [] },
  );
  assert.deepEqual(
    fallbackPlan(['packages/app/src/index.js', 'tests/mine.test.js'], 'selection-timeout'),
    { kind: 'fallback', tests: ['tests/mine.test.js'], reason: 'selection-timeout', dropped: [] },
  );
  // Code changed with no reaching test warns instead of refusing: main()
  // still joins the repo-wide guards and runs them.
  assert.deepEqual(
    fallbackPlan(['packages/app/src/index.js'], 'selection-timeout'),
    { kind: 'fallback', tests: [], reason: 'selection-timeout', dropped: [] },
  );
  assert.deepEqual(
    fallbackPlan(['packages/app/src/index.js'], 'empty-selection'),
    { kind: 'fallback', tests: [], reason: 'empty-selection', dropped: [] },
  );
  // The only refusal left: an oversized selection the PR carries no test
  // file of its own for — no evidence this step can run.
  assert.deepEqual(
    fallbackPlan(['packages/app/src/index.js'], 'oversized-selection'),
    {
      kind: 'refuse',
      tests: [],
      reason: 'oversized-selection',
      uncovered: ['packages/app/src/index.js'],
      dropped: [],
    },
  );
});

test('runBudgetSec yields to the selection phase inside the step budget', () => {
  assert.equal(runBudgetSec(270, 0.1), 270);
  assert.equal(runBudgetSec(270, 60), 235);
  // Never below a minute, even when the selection ate the step.
  assert.equal(runBudgetSec(270, 290), 60);
  // A custom run timeout is kept when it is the tighter bound.
  assert.equal(runBudgetSec(120, 0.1), 120);
});

test('selection is end to end on a throwaway repository with real git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'touched-'));
  try {
    const git = (/** @type {string[]} */ args) =>
      spawnGit(args, { cwd: directory });
    const write = (/** @type {string} */ path, /** @type {string} */ body) => {
      const full = join(directory, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    };

    git(['init']);
    git(['config', 'user.email', 'touched@example.invalid']);
    git(['config', 'user.name', 'touched']);
    write('packages/app/src/index.js', 'export const app = 1;\n');
    write('tests/api.test.js', "import { app } from '../packages/app/src/index.js';\n");
    write('tests/other.test.js', "import test from 'node:test';\n");
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    git(['branch', 'base']);

    // A PR change: one source edit and one new test file.
    write('packages/app/src/index.js', 'export const app = 2;\n');
    write('tests/new.test.js', "import { app } from '../packages/app/src/index.js';\n");
    git(['add', '.']);
    git(['commit', '-m', 'pr']);

    // The production diff commands, not a copy: listChangedFiles runs them.
    const { changed, allChanged } = listChangedFiles(git, 'base');
    assert.deepEqual(changed, ['packages/app/src/index.js', 'tests/new.test.js']);
    assert.deepEqual(allChanged, changed);
    const testContents = new Map();
    for (const testPath of ['tests/api.test.js', 'tests/other.test.js', 'tests/new.test.js']) {
      testContents.set(testPath, git(['show', `HEAD:${testPath}`]).stdout);
    }
    assert.deepEqual(selectTouchedTests(changed, testContents), ['tests/api.test.js', 'tests/new.test.js']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deleted files leave the run but keep reachability and the guard check', () => {
  const directory = mkdtempSync(join(tmpdir(), 'touched-deleted-'));
  try {
    const git = (/** @type {string[]} */ args) =>
      spawnGit(args, { cwd: directory });
    const write = (/** @type {string} */ path, /** @type {string} */ body) => {
      const full = join(directory, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    };

    git(['init']);
    git(['config', 'user.email', 'touched@example.invalid']);
    git(['config', 'user.name', 'touched']);
    write('packages/app/src/keep.js', 'export const keep = 1;\n');
    write('packages/app/src/gone.js', 'export const gone = 1;\n');
    write('tests/keep.test.js', "import { keep } from '../packages/app/src/keep.js';\n");
    write('tests/gone.test.js', "import { gone } from '../packages/app/src/gone.js';\n");
    // Unchanged, still imports the module the PR deletes: the fast gate
    // must run it, or it passes while the full suite on `main` fails on
    // the missing import.
    write('tests/stale.test.js', "import { gone } from '../packages/app/src/gone.js';\n");
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    git(['branch', 'base']);

    // A PR change: one source edit plus two deletions (a source file and
    // the test that reached it).
    write('packages/app/src/keep.js', 'export const keep = 2;\n');
    git(['rm', '-q', 'packages/app/src/gone.js', 'tests/gone.test.js']);
    git(['add', '.']);
    git(['commit', '-m', 'pr']);

    const { changed, deleted, allChanged } = listChangedFiles(git, 'base');
    // Deleted files need no test run: only the edit drives the run.
    assert.deepEqual(changed, ['packages/app/src/keep.js']);
    assert.deepEqual(deleted, ['packages/app/src/gone.js', 'tests/gone.test.js']);
    // The unfiltered diff still sees the deletions, so the guard check in
    // main() (withRepoWideGuards over allChanged) still runs on them: a
    // deleted listed guard is missing from the corpus and throws instead
    // of shrinking the gate.
    assert.deepEqual(
      [...allChanged].sort(),
      ['packages/app/src/gone.js', 'packages/app/src/keep.js', 'tests/gone.test.js'],
    );
    const testContents = new Map([
      ['tests/keep.test.js', git(['show', 'HEAD:tests/keep.test.js']).stdout],
      ['tests/stale.test.js', git(['show', 'HEAD:tests/stale.test.js']).stdout],
    ]);
    // main() seeds reachability with the deleted paths: the deleted module
    // pulls in its unchanged importer, while the deleted test itself is
    // absent from the corpus and never selected.
    assert.deepEqual(
      selectTouchedTests([...changed, ...deleted], testContents),
      ['tests/keep.test.js', 'tests/stale.test.js'],
    );
    // Guards still join a deletion-only remainder through the unfiltered diff.
    assert.deepEqual(
      withRepoWideGuards([], testContents, allChanged, ['tests/keep.test.js']),
      ['tests/keep.test.js'],
    );
    // But a deleted guard that stays listed fails red instead of shrinking
    // the gate.
    assert.throws(
      () => withRepoWideGuards([], testContents, allChanged, ['tests/gone.test.js']),
      /absent from tests\//,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a deleted module selects its unchanged importer, a deleted test never itself', () => {
  const testContents = contents({
    'tests/stale.test.js': "import { gone } from '../packages/app/src/gone.js';\n",
    'tests/other.test.js': "import test from 'node:test';\n",
  });
  // The deleted source path seeds reachability: the test still importing
  // it runs and fails red on the missing import, on the PR and on main.
  assert.deepEqual(
    selectTouchedTests(['packages/app/src/gone.js'], testContents),
    ['tests/stale.test.js'],
  );
  // A deleted test file seeds its own importers but is absent from the
  // corpus, so it is never itself selected.
  assert.deepEqual(
    selectTouchedTests(
      ['tests/gone.test.js'],
      contents({
        'tests/wrapper.test.js': "import './gone.test.js';\n",
        'tests/other.test.js': "import test from 'node:test';\n",
      }),
    ),
    ['tests/wrapper.test.js'],
  );
});

/**
 * The forward walk the reverse index replaces, kept here as the reference
 * the rewrite must agree with: one reachability search per test file.
 */
const forwardSelect = (changedFiles, testContents, fileImports = new Map()) => {
  const strip = (/** @type {string} */ path) => path.replace(/\.[cm]?js$/, '');
  const changed = new Set(changedFiles.map((file) => strip(file)));
  const importsOf = (/** @type {string} */ file) => {
    const extra = fileImports.get(file);
    if (extra) return extra;
    const content = testContents.get(file);
    if (content === undefined) return new Set();
    return relativeImportsOf(file, content);
  };
  const reachesOf = (/** @type {string} */ testPath) => {
    const reached = new Set();
    const queue = [...importsOf(testPath)];
    while (queue.length > 0) {
      const next = queue.pop();
      if (!next || reached.has(next)) continue;
      reached.add(next);
      if (!/\.test$/.test(next)) {
        for (const deeper of importsOf(next)) {
          if (!reached.has(deeper)) queue.push(deeper);
        }
      }
    }
    return reached;
  };
  const selected = new Set();
  for (const [testPath] of testContents) {
    const stripped = strip(testPath);
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
};

/** A large synthetic import graph: layered fan-in behind one target file. */
const buildSyntheticGraph = (layers = 4, width = 500, testCount = 200) => {
  const fileImports = new Map([['packages/synth/src/target', new Set()]]);
  let previous = ['packages/synth/src/target'];
  for (let layer = 0; layer < layers; layer += 1) {
    const current = [];
    for (let i = 0; i < width; i += 1) {
      const name = `packages/synth/src/l${layer}-n${i}`;
      fileImports.set(
        name,
        new Set([previous[i % previous.length], previous[(i + 7) % previous.length]]),
      );
      current.push(name);
    }
    previous = current;
  }
  // A cycle across the layers: the walk must terminate and still select.
  fileImports.get('packages/synth/src/l0-n0').add(`packages/synth/src/l${layers - 1}-n0`);
  // A barrel re-exporting the first file of the deepest layer.
  fileImports.set('packages/synth/src/index', new Set([previous[0]]));
  const testContents = new Map();
  for (let i = 0; i < testCount; i += 1) {
    testContents.set(
      `tests/synth-t${i}.test.js`,
      `import { x } from '../packages/synth/src/l${layers - 1}-n${i}.js';\n`,
    );
  }
  testContents.set(
    'tests/synth-barrel.test.js',
    "import { x } from '../packages/synth/src/index.js';\n",
  );
  testContents.set('tests/synth-unrelated.test.js', "import test from 'node:test';\n");
  return { fileImports, testContents };
};

test('selection over a large synthetic graph stays fast and exact', () => {
  // ~2000 non-test files behind one target, 202 tests: the shape of a big
  // package change (CI run 39044361164 selected 100 files). The bound is
  // generous headroom, not a benchmark: locally this takes well under a
  // second, and the gate's own selection budget is 60 s.
  const { fileImports, testContents } = buildSyntheticGraph();
  const changed = ['packages/synth/src/target.js', 'tests/synth-t0.test.js'];
  const started = Date.now();
  const selected = selectTouchedTests(changed, testContents, fileImports);
  const elapsedSec = (Date.now() - started) / 1000;
  const expected = [...testContents.keys()]
    .filter((path) => path !== 'tests/synth-unrelated.test.js')
    .sort();
  assert.deepEqual(selected, expected);
  assert.ok(elapsedSec < 30, `synthetic selection took ${elapsedSec.toFixed(1)}s`);
});

test('the reverse index agrees with the forward walk on the large graph', () => {
  const { fileImports, testContents } = buildSyntheticGraph();
  const cases = [
    ['packages/synth/src/target.js'],
    ['packages/synth/src/l1-n42.js'],
    ['packages/synth/src/index.js'],
    ['tests/synth-t7.test.js'],
    ['docs/QUALITY_GATES.md'],
  ];
  for (const changed of cases) {
    assert.deepEqual(
      selectTouchedTests(changed, testContents, fileImports),
      forwardSelect(changed, testContents, fileImports),
      `divergent selection for ${changed.join(', ')}`,
    );
  }
});

test('an oversized synthetic selection falls back to the changed tests', () => {
  const { fileImports, testContents } = buildSyntheticGraph();
  const changed = ['packages/synth/src/target.js', 'tests/synth-t0.test.js'];
  const selected = selectTouchedTests(changed, testContents, fileImports);
  assert.ok(selected.length > 50);
  const plan = planGate(changed, selected, 50);
  assert.equal(plan.kind, 'fallback');
  assert.deepEqual(plan.tests, ['tests/synth-t0.test.js']);
  assert.equal(plan.reason, 'oversized-selection');
  assert.deepEqual(
    plan.dropped,
    selected.filter((test) => test !== 'tests/synth-t0.test.js'),
  );
});

// ------------------------------------------------------------------ repo-wide guards
//
// Twice `main` turned red after green-alone PRs (#222 against #221 through
// tests/isolated-git.test.js, #234 through tests/actor-fails-closed.test.js)
// because the guards below scan the whole repository while importing almost
// none of it, so the import mapping never selects them. They always run on
// top of the selection (see `withRepoWideGuards`); these tests hold that.

test('the declared list holds the acceptance guards', () => {
  assert.ok(
    REPO_WIDE_GUARDS.includes('tests/actor-fails-closed.test.js'),
    'a payments-only PR must run tests/actor-fails-closed.test.js',
  );
  assert.ok(
    REPO_WIDE_GUARDS.includes('tests/isolated-git.test.js'),
    'a payments-only PR must run tests/isolated-git.test.js',
  );
  assert.ok(
    REPO_WIDE_GUARDS.includes('tests/module-manifest-revision-guard.test.js'),
    'a manifest-only PR must run tests/module-manifest-revision-guard.test.js',
  );
});

test('a payments-only change runs the guards on top of its selection', () => {
  const guarded = withRepoWideGuards(
    ['tests/payments-checkout.test.js'],
    contents({
      'tests/payments-checkout.test.js': "import test from 'node:test';\n",
      'tests/actor-fails-closed.test.js': "import test from 'node:test';\n",
      'tests/isolated-git.test.js': "import test from 'node:test';\n",
    }),
    ['packages/payments/src/operations.js'],
    ['tests/actor-fails-closed.test.js', 'tests/isolated-git.test.js'],
  );
  assert.deepEqual(guarded, [
    'tests/actor-fails-closed.test.js',
    'tests/isolated-git.test.js',
    'tests/payments-checkout.test.js',
  ]);
});

test('guards join docs-only diffs but an empty diff stays empty', () => {
  const guards = ['tests/isolated-git.test.js'];
  const have = contents({ 'tests/isolated-git.test.js': "import test from 'node:test';\n" });
  assert.deepEqual(
    withRepoWideGuards([], have, ['docs/QUALITY_GATES.md'], guards),
    ['tests/isolated-git.test.js'],
  );
  assert.deepEqual(withRepoWideGuards([], have, [], guards), []);
});

test('a guard the mapping already selected runs once', () => {
  const guarded = withRepoWideGuards(
    ['tests/isolated-git.test.js'],
    contents({ 'tests/isolated-git.test.js': "import test from 'node:test';\n" }),
    ['tests/isolated-git.test.js'],
    ['tests/isolated-git.test.js'],
  );
  assert.deepEqual(guarded, ['tests/isolated-git.test.js']);
});

test('a listed guard missing from the corpus throws instead of shrinking the gate', () => {
  assert.throws(
    () => withRepoWideGuards([], contents({}), ['packages/payments/src/operations.js'], ['tests/gone.test.js']),
    /tests\/gone\.test\.js/,
  );
});

test('REPO_WIDE_GUARDS names existing test files, once each', () => {
  assert.deepEqual(
    [...new Set(REPO_WIDE_GUARDS)].sort(),
    [...REPO_WIDE_GUARDS].sort(),
    'a guard listed twice runs once but reads as two promises — list it once',
  );
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  for (const guard of REPO_WIDE_GUARDS) {
    assert.match(guard, /^tests\/.+\.test\.[cm]?js$/, `${guard} is not a test file under tests/`);
    assert.ok(existsSync(join(repoRoot, guard)), `${guard} is listed but missing on disk`);
  }
});

/**
 * A test file is a repo-wide guard when its verdict can flip because of a
 * repository file it never relatively imports. In this repository that
 * always takes one of two shapes — the only two the fast gate ever missed:
 *
 * - a `grep`/`rg` child process with a bare `packages`, `apps`, `tests`
 *   or `scripts` operand (the actor boundary's `grep -rn … packages apps`);
 * - a recursive directory reader seeded at the repository: one function
 *   whose own body reads a directory and calls itself, invoked with a
 *   repo-rooted argument, a top-directory literal, or a loop variable over
 *   top directories (the isolated-git walk of `tests/`).
 *
 * The reader check is scoped to the function's own braces, not a fixed
 * window: a fixed window bleeds a neighbour's `readdirSync` into a CLI
 * runner that merely defaults its `cwd` to the repo (project-doctor,
 * package-scaffold), and the definition's own parameter list is not a
 * call. Strings and comments are blanked first so a brace inside a
 * message cannot move a boundary.
 *
 * Documented limits: a scan split across helper functions with no
 * repo-rooted call site in the test file (today: the raw-driver boundary,
 * whose walk lives behind a default parameter) is listed by audit, not
 * caught here. A new guard in a new shape extends this detector alongside
 * the list entry — the failure message below says so.
 *
 * @param {string} _relativePath repository-relative test path, unused: the
 * shapes above are path-independent; it is kept so the call reads.
 * @param {string} source the test file's text.
 */
function looksLikeRepoWideGuard(_relativePath, source) {
  if (
    /(execFileSync|execSync|spawnSync|spawn|execFile)\(\s*['"`](grep|rg)['"`]/.test(source)
    && /,\s*['"`](packages|apps|tests|scripts)['"`]/.test(source)
  ) {
    return true;
  }
  if (!/readdir(Sync)?\(|opendir(Sync)?\(|globSync\(/.test(source)) return false;
  // Blanks strings and comments (length-preserving, so indices survive);
  // template bodies stay, `${…}` code with them.
  const scrubbed = source
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (literal) => ' '.repeat(literal.length))
    .replace(/\/\/[^\n]*/g, (comment) => ' '.repeat(comment.length))
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const balancedEnd = (/** @type {string} */ text, /** @type {number} */ open) => {
    let depth = 0;
    for (let j = open; j < Math.min(text.length, open + 8000); j += 1) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
    return -1;
  };
  const bodies = [];
  const defPattern = /function\s+([A-Za-z_$][\w$]*)\s*\(|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/g;
  for (const def of scrubbed.matchAll(defPattern)) {
    const name = def[1] ?? def[2];
    const isFunction = def[1] !== undefined;
    let bodyStart = -1;
    if (isFunction) {
      let depth = 0;
      let j = (def.index ?? 0) + def[0].length - 1;
      for (; j < scrubbed.length; j += 1) {
        if (scrubbed[j] === '(') depth += 1;
        else if (scrubbed[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      bodyStart = scrubbed.indexOf('{', j);
    } else {
      const arrow = scrubbed.indexOf('=>', (def.index ?? 0) + def[0].length - 2);
      let j = arrow + 2;
      while (scrubbed[j] === ' ') j += 1;
      if (scrubbed[j] === '{') bodyStart = j;
      else continue;
    }
    if (bodyStart < 0) continue;
    const bodyEnd = balancedEnd(scrubbed, bodyStart);
    if (bodyEnd < 0) continue;
    bodies.push({
      name,
      body: scrubbed.slice(bodyStart, bodyEnd),
      defIndex: def.index ?? 0,
      end: bodyEnd,
    });
  }
  const loopedDirs = new Set();
  for (const loop of scrubbed.matchAll(/for\s*\([^)]*\bof\s+\[([^\]]*)\]\)/g)) {
    if (/['"`](packages|apps|tests|scripts)['"`]/.test(source.slice(loop.index, (loop.index ?? 0) + loop[0].length))) {
      const bound = /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of/.exec(loop[0]);
      if (bound) loopedDirs.add(bound[1]);
    }
  }
  for (const { name, body, defIndex, end } of bodies) {
    if (!/readdir(Sync)?\(|opendir(Sync)?\(|globSync\(/.test(body)) continue;
    if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    // Call sites anywhere outside the definition itself (a hoisted
    // `function` may run before the lines that declare it).
    const regions = [
      { text: scrubbed.slice(0, defIndex), base: 0 },
      { text: scrubbed.slice(end), base: end },
    ];
    for (const { text, base } of regions) {
      const callPattern = new RegExp(`\\b${name}\\s*\\(`, 'g');
      for (const call of text.matchAll(callPattern)) {
        // Balanced-paren arguments: seeds like join(REPO_ROOT, root) nest.
        const open = (call.index ?? 0) + call[0].length - 1;
        let depth = 0;
        let j = open;
        for (; j < Math.min(text.length, open + 300); j += 1) {
          if (text[j] === '(') depth += 1;
          else if (text[j] === ')') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) continue;
        const args = text.slice(open + 1, j);
        if (/(testsRoot|REPO_ROOT|repoRoot|\bROOT\b)/.test(args)) return true;
        const globalAt = base + open + 1;
        if (/['"`](packages|apps|tests|scripts)['"`]/.test(source.slice(globalAt, base + j))) {
          return true;
        }
        const bare = /^[A-Za-z_$][\w$]*$/.exec(args.trim());
        if (bare && loopedDirs.has(bare[0])) return true;
      }
    }
  }
  return false;
}

test('a repo-wide guard outside the declared lists fails this test', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const testFiles = [];
  const walk = (/** @type {string} */ directory) => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules') continue;
      const absolute = join(directory, name);
      try {
        readdirSync(absolute);
        walk(absolute);
      } catch {
        if (/\.test\.[cm]?js$/.test(name)) {
          testFiles.push(absolute.slice(repoRoot.length + 1).replace(/\\/g, '/'));
        }
      }
    }
  };
  walk(join(repoRoot, 'tests'));
  const unexplained = [];
  for (const relative of testFiles.sort()) {
    const source = readFileSync(join(repoRoot, relative), 'utf8');
    if (
      looksLikeRepoWideGuard(relative, source)
      && !REPO_WIDE_GUARDS.includes(relative)
      && !Object.prototype.hasOwnProperty.call(REPO_WIDE_GUARD_EXCLUSIONS, relative)
    ) {
      unexplained.push(relative);
    }
  }
  assert.deepEqual(
    unexplained,
    [],
    `repo-wide guard(s) outside REPO_WIDE_GUARDS and REPO_WIDE_GUARD_EXCLUSIONS in scripts/ci-touched-tests.js: ${unexplained.join(', ')}. `
    + 'Add them to the list (a guard in a new mechanism shape extends looksLikeRepoWideGuard here too), '
    + 'or, when the file only walks scratch directories it built itself, say so in the PR.',
  );
});

test('every declared exclusion is load-bearing and reasoned', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const names = Object.keys(REPO_WIDE_GUARD_EXCLUSIONS);
  assert.ok(names.length > 0, 'the exclusion list exists so a slow corpus stays out by name, not by silence');
  for (const relative of names) {
    const reason = REPO_WIDE_GUARD_EXCLUSIONS[relative];
    assert.match(relative, /^tests\/.+\.test\.[cm]?js$/, `${relative} is not a test file under tests/`);
    assert.ok(existsSync(join(repoRoot, relative)), `${relative} is excluded but missing on disk`);
    assert.ok(
      typeof reason === 'string' && reason.length > 0,
      `${relative} is excluded without a reason`,
    );
    assert.ok(
      !REPO_WIDE_GUARDS.includes(relative),
      `${relative} is both guarded and excluded — pick one`,
    );
    // Load-bearing: the file still looks guard-shaped today. When the
    // slow corpus is split and stops scanning the repo, this fails and
    // the entry goes away instead of lingering.
    assert.ok(
      looksLikeRepoWideGuard(relative, readFileSync(join(repoRoot, relative), 'utf8')),
      `${relative} no longer looks like a repo-wide guard: drop its exclusion entry`,
    );
  }
});
