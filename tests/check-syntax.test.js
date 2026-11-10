// @ts-check

/**
 * `npm run check` answers in one process what `node --check` answered file by
 * file (backlog:3d560518f3e2): same verdict per file, the broken file named.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkScript = fileURLToPath(new URL('../scripts/check.js', import.meta.url));

/** Fixture files: [relative path, source, does node --check accept it]. */
const CASES = /** @type {Array<[string, string, boolean]>} */ ([
  ['package.json', '{ "type": "module" }\n', true],
  ['good.js', 'export const a = 1;\n', true],
  ['top-level-await.js', 'const x = await Promise.resolve(1);\nexport default x;\n', true],
  ['hashbang.mjs', '#!/usr/bin/env node\nimport { a } from "./good.js";\nconsole.log(a);\n', true],
  ['broken.js', 'export const a = ;\n', false],
  ['broken.mjs', 'import { from "x";\n', false],
  ['cjs/package.json', '{ "type": "commonjs" }\n', true],
  ['cjs/return.js', '#!/usr/bin/env node\nif (1) return;\nmodule.exports = 1;\n', true],
  ['cjs/esm-syntax.js', 'export default 1;\n', false],
  ['untyped/package.json', '{ "name": "untyped" }\n', true],
  ['untyped/require.js', 'const fs = require("node:fs");\nmodule.exports = fs;\n', true],
  ['untyped/import.js', 'import fs from "node:fs";\nexport default fs;\n', true],
  ['untyped/broken.js', 'function (\n', false],
]);

/** @param {Array<[string, string, boolean]>} cases */
function fixture(cases) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-check-'));
  for (const [path, source] of cases) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

/** @param {string} cwd */
function runCheck(cwd) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [checkScript], { cwd, encoding: 'utf8', env });
}

test('every fixture verdict is the one node --check gives', () => {
  const root = fixture(CASES);
  try {
    for (const [path, , accepted] of CASES) {
      if (!/\.m?js$/.test(path)) continue;
      const node = spawnSync(process.execPath, ['--check', join(root, path)], { encoding: 'utf8' });
      assert.equal(node.status === 0, accepted, `fixture premise: node --check on ${path}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a syntactically broken file fails the check, by name, and only the broken ones are named', () => {
  const root = fixture(CASES);
  try {
    const run = runCheck(root);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    for (const [path, , accepted] of CASES) {
      if (!/\.m?js$/.test(path)) continue;
      const named = run.stderr.split('\n').includes(path);
      assert.equal(named, !accepted, `${path} ${accepted ? 'must not be' : 'must be'} named\n${run.stderr}`);
    }
    assert.match(run.stderr, /SyntaxError/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clean tree passes and counts every .js and .mjs file', () => {
  const clean = CASES.filter(([, , accepted]) => accepted);
  const root = fixture(clean);
  try {
    const run = runCheck(root);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const files = clean.filter(([path]) => /\.m?js$/.test(path)).length;
    assert.match(run.stdout, new RegExp(`Syntax check passed for ${files} JavaScript files\\.`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
