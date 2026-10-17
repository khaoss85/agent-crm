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
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { relativeImportsOf, selectTouchedTests } from '../scripts/ci-touched-tests.js';

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

test('selection is end to end on a throwaway repository with real git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'touched-'));
  try {
    const git = (/** @type {string[]} */ args) =>
      spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
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
