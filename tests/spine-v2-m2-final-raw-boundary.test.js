import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * **Production Spine v2 M2-05 — raw-driver boundary.**
 *
 * What this guard is, stated exactly: a *token scan* for the known spellings
 * of direct SQLite-driver access in production business, package and
 * application source (`packages/` + `apps/`). It catches regression by
 * editing — someone reaching for `database.raw` again — which is how the
 * driver actually comes back.
 *
 * **It does not prove unreachability and must not be read as proving it.**
 * No regex can. A dedicated test below pins three real escapes the scan
 * misses; calling this "full semantic unreachability" is a non-claim.
 *
 * The spelling set is deliberately the M2C/M2D list, extended only with the
 * optional-chaining, destructuring and alias forms already known to fool
 * earlier greps (`tasks?.database?.raw`, `{ raw } = database`). A spelling
 * added here must stay in lock-step with those files.
 *
 * Allowlist (named and justified):
 *   - `packages/core/src/database.js` — SQLITE_ADAPTER_INTERNAL. It owns
 *     `DatabaseSync` and the `raw` closure. After M2-05, no other production
 *     business/package/application file is allowed to match.
 *
 * `packages/core/src/core-adapters.js` is **not** allowlisted. It is
 * lead-conversion application logic. After the storage-contract migration it
 * must carry zero of these spellings.
 *
 * Comments-only mentions are excluded (stripped before the production walk).
 * tests/, docs/, examples/journeys and characterization scripts are outside
 * this scan. v1 `createAccordoApp().database.raw` remains the compatibility
 * handle on the synchronous factory; that is characterized v1, not a new leak.
 */

const RAW_DRIVER_SPELLINGS = Object.freeze([
  // `database.raw`, `database?.raw`, `this.database.raw`
  /database\s*\??\.\s*raw\b/,
  // `.raw.prepare(`, `?.raw?.exec(`
  /\??\.\s*raw\s*\??\.\s*(?:prepare|exec)\s*\(/,
  // `database['raw']`, `database?.["raw"]`
  /database\s*\??\.?\s*\[\s*['"]raw['"]\s*\]/,
  // `const { raw } = database`, `const { raw, storage } = this.database`
  /\{[^{}]*\braw\b[^{}]*\}\s*=\s*[^;\n]*\bdatabase\b/i,
  // the driver constructor itself
  /\bDatabaseSync\b/,
]);

/** @param {string} source */
const rawDriverSpelling = (source) => RAW_DRIVER_SPELLINGS.find((pattern) => pattern.test(source)) ?? null;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * SQLITE_ADAPTER_INTERNAL. Owns `DatabaseSync` and the raw handle closure.
 * Do not add `core-adapters.js` here.
 *
 * @type {Readonly<Record<string, string>>}
 */
const ALLOWLIST = Object.freeze({
  'packages/core/src/database.js':
    'SQLITE_ADAPTER_INTERNAL: owns DatabaseSync and the raw closure',
});

const PRODUCTION_ROOTS = Object.freeze(['packages', 'apps']);
const SKIP_DIRS = new Set(['node_modules', 'tests', 'test', '__tests__']);

/**
 * Strip line and block comments. String contents stay: a token scan that
 * dropped strings would miss `database['raw']` written inside a template, and
 * would also make the plant-and-restore below a no-op. Regex literals and
 * comment-like sequences inside strings are accepted limitations of a token
 * scan, not a claim of semantic unreachability.
 *
 * @param {string} source
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const current = source[i];
    const next = source[i + 1];
    if (current === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (current === '/' && next === '*') {
      i += 2;
      while (i + 1 < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (current === '\'' || current === '"' || current === '`') {
      const quote = current;
      out += current;
      i += 1;
      while (i < n) {
        out += source[i];
        if (source[i] === '\\') {
          i += 1;
          if (i < n) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += current;
    i += 1;
  }
  return out;
}

/** @param {string} dir @param {string[]} files */
function walkJs(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJs(full, files);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    files.push(full);
  }
}

function productionJsFiles() {
  /** @type {string[]} */
  const files = [];
  for (const root of PRODUCTION_ROOTS) walkJs(join(repoRoot, root), files);
  return files;
}

function scanProductionRawDriver() {
  /** @type {{ file: string, pattern: string }[]} */
  const hits = [];
  for (const full of productionJsFiles()) {
    const file = relative(repoRoot, full).split('\\').join('/');
    if (Object.hasOwn(ALLOWLIST, file)) continue;
    const source = stripComments(readFileSync(full, 'utf8'));
    const found = rawDriverSpelling(source);
    if (found) hits.push({ file, pattern: String(found) });
  }
  return hits;
}

const PLANTED_SPELLINGS = Object.freeze([
  'const insert = database.raw.prepare(sql);',
  'const insert = database?.raw.prepare(sql);',
  'const insert = database?.raw?.prepare(sql);',
  'const driver = tasks?.database?.raw;',
  'const driver = deps.database ?. raw;',
  'this.database.raw.prepare(sql).run(runId);',
  "const insert = database['raw'].prepare(sql);",
  'const insert = database["raw"].prepare(sql);',
  "const insert = database?.['raw'].prepare(sql);",
  'const { raw } = database;',
  'const { raw, storage } = this.database;',
  'insert.run(...); database.raw.exec("COMMIT");',
  'const db = new DatabaseSync(":memory:");',
  'const raw = tasks.database.raw;',
  'const raw = tasks?.database?.raw;',
  'const raw = tasks?.database.raw;',
  'const flag = deps.database ?. raw.isTransaction;',
  'const select = database?.raw?.exec(sql);',
  "const raw = database['raw'];",
  'const raw = database["raw"];',
  "const raw = database?.['raw'];",
  'const { raw } = tasks.database;',
  'const { raw: driver } = database;',
]);

const PLANT_TARGET = join(repoRoot, 'packages/core/src/core-adapters.js');

/**
 * Embed a spelling as a JS string literal without escaping the quotes the
 * token scan looks for. `JSON.stringify("database[\"raw\"]")` would hide the
 * bracket form from `/database\\s*\\[\\s*['\"]raw['\"]/`.
 *
 * @param {string} value
 */
function asJsStringLiteral(value) {
  if (value.includes("'") && value.includes('"')) {
    throw new Error(`plant spelling uses both quote styles: ${value}`);
  }
  if (value.includes("'")) return `"${value.replace(/\\/g, '\\\\')}"`;
  return `'${value.replace(/\\/g, '\\\\')}'`;
}

test('createCoreAdapters source carries no known spelling of direct driver access', () => {
  const source = stripComments(readFileSync(PLANT_TARGET, 'utf8'));
  assert.equal(
    rawDriverSpelling(source),
    null,
    'core-adapters.js is a business consumer, not adapter-internal; it must read through database.storage.sync',
  );
});

test('production business, package and application source does not reach the raw driver', () => {
  const hits = scanProductionRawDriver();
  assert.deepEqual(
    hits,
    [],
    `production raw-driver spellings outside the SQLite adapter:\n${hits.map((hit) => `${hit.file} ${hit.pattern}`).join('\n')}`,
  );
});

test('the allowlist is exactly the SQLite adapter that owns DatabaseSync', () => {
  const source = readFileSync(join(repoRoot, 'packages/core/src/database.js'), 'utf8');
  assert.notEqual(rawDriverSpelling(source), null, 'database.js must still own DatabaseSync');
  assert.equal(
    Object.keys(ALLOWLIST).join(','),
    'packages/core/src/database.js',
  );
});

test('the scan catches the spellings it claims to cover', () => {
  for (const escape of PLANTED_SPELLINGS) {
    assert.notEqual(rawDriverSpelling(escape), null, `the scan must catch: ${escape}`);
  }
  for (const allowed of [
    'database.storage.sync.execute(statement);',
    'database.storage.sync.many(statement);',
    'database.storage.sync.maybeOne(statement);',
    'const storage = service?.database?.storage;',
    'const rawBody = Buffer.from(params.rawBody);',
    "const kinds = ['raw', 'cooked'];",
    'createCoreAdapters({ database, services, pipelines });',
  ]) {
    assert.equal(rawDriverSpelling(allowed), null, `the scan must allow: ${allowed}`);
  }
});

/**
 * A guard nobody has watched fail is not a guard. Every spelling is written
 * into a protected production file (`core-adapters.js`, the file this
 * milestone migrated), the production walk is watched failing on that
 * spelling, and the file is restored. The planted text lives in a string
 * literal so every snippet — including ones that are not valid JS — still
 * parses, and so comment-stripping cannot hide it.
 */
test('every supported spelling fails the production guard when planted, then restores', (t) => {
  const original = readFileSync(PLANT_TARGET, 'utf8');
  t.after(() => {
    writeFileSync(PLANT_TARGET, original);
  });

  for (const spelling of PLANTED_SPELLINGS) {
    writeFileSync(
      PLANT_TARGET,
      `${original}\nfunction __m2FinalRawBoundaryPlant() { void ${asJsStringLiteral(spelling)}; }\n`,
    );
    try {
      const hits = scanProductionRawDriver();
      assert.ok(
        hits.some((hit) => hit.file === 'packages/core/src/core-adapters.js'),
        `planted spelling must fail the production guard: ${spelling}`,
      );
    } finally {
      writeFileSync(PLANT_TARGET, original);
    }
  }

  assert.equal(readFileSync(PLANT_TARGET, 'utf8'), original);
  assert.deepEqual(scanProductionRawDriver(), []);
});

test('the scan is a token scan, and cannot prove unreachability', () => {
  for (const undetected of [
    "const d = database; const r = d['r' + 'aw'];",
    'const key = "raw"; const r = handle[key];',
    'const r = Reflect.get(database, "ra" + "w");',
  ]) {
    assert.equal(
      rawDriverSpelling(undetected),
      null,
      `this guard is a token scan and does not claim to catch: ${undetected}`,
    );
  }
});

test('v1 createAccordoApp still exposes the compatibility database.raw handle', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal('database' in app, true);
    assert.equal(typeof app.database.raw.prepare, 'function');
    assert.equal(typeof app.database.raw.exec, 'function');
    assert.equal(app.database.storage.contract, 1);
  } finally {
    app.close();
  }
});
