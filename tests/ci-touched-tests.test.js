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

import { hasCodeChange, relativeImportsOf, selectTouchedTests } from '../scripts/ci-touched-tests.js';

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
