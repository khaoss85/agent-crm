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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnGit } from './helpers/isolated-git.js';
import {
  buildFileImports,
  changedTestFiles,
  fallbackPlan,
  hasCodeChange,
  parseArgs,
  planGate,
  relativeImportsOf,
  runBudgetSec,
  selectTouchedTests,
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
    { kind: 'run', tests: ['tests/api.test.js'], reason: null },
  );
});

test('planGate skips docs-only changes with an empty selection', () => {
  assert.deepEqual(
    planGate(['docs/QUALITY_GATES.md', 'package.json'], [], 50),
    { kind: 'skip', tests: [], reason: 'empty-selection' },
  );
});

test('planGate refuses fail-closed when code changed and nothing reaches it', () => {
  assert.deepEqual(
    planGate(['packages/cli/bin/accordo.js'], [], 50),
    {
      kind: 'refuse',
      tests: [],
      reason: 'empty-selection',
      uncovered: ['packages/cli/bin/accordo.js'],
    },
  );
});

test('planGate falls back to the changed tests on an oversized selection', () => {
  const selected = Array.from({ length: 51 }, (_, i) => `tests/s${i}.test.js`);
  assert.deepEqual(
    planGate(['packages/core/src/deep.js', 'tests/mine.test.js'], selected, 50),
    { kind: 'fallback', tests: ['tests/mine.test.js'], reason: 'oversized-selection' },
  );
});

test('planGate refuses an oversized selection with no changed test of its own', () => {
  // Fail-closed, not an empty green run: there is no evidence to run.
  const selected = Array.from({ length: 51 }, (_, i) => `tests/s${i}.test.js`);
  const plan = planGate(['packages/core/src/deep.js'], selected, 50);
  assert.equal(plan.kind, 'refuse');
  assert.deepEqual(plan.uncovered, ['packages/core/src/deep.js']);
});

test('fallbackPlan resolves skip, refuse and fallback without a selection', () => {
  assert.deepEqual(
    fallbackPlan(['docs/QUALITY_GATES.md'], 'selection-timeout'),
    { kind: 'skip', tests: [], reason: 'selection-timeout' },
  );
  assert.deepEqual(
    fallbackPlan(['packages/app/src/index.js', 'tests/mine.test.js'], 'selection-timeout'),
    { kind: 'fallback', tests: ['tests/mine.test.js'], reason: 'selection-timeout' },
  );
  assert.deepEqual(
    fallbackPlan(['packages/app/src/index.js'], 'selection-timeout'),
    {
      kind: 'refuse',
      tests: [],
      reason: 'selection-timeout',
      uncovered: ['packages/app/src/index.js'],
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

    const diff = git(['diff', '--name-only', 'base...HEAD']);
    assert.equal(diff.status, 0);
    const changed = diff.stdout.trim().split('\n');
    const testContents = new Map();
    for (const testPath of ['tests/api.test.js', 'tests/other.test.js', 'tests/new.test.js']) {
      testContents.set(testPath, git(['show', `HEAD:${testPath}`]).stdout);
    }
    assert.deepEqual(selectTouchedTests(changed, testContents), ['tests/api.test.js', 'tests/new.test.js']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.deepEqual(planGate(changed, selected, 50), {
    kind: 'fallback',
    tests: ['tests/synth-t0.test.js'],
    reason: 'oversized-selection',
  });
});
