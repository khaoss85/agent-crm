import test from 'node:test';
import assert from 'node:assert/strict';

import { stripNonCode, readsProperty, importsFrom, SCANNER_LIMITS } from './source-scan.mjs';

/**
 * The architecture-evidence observations decide two ADRs, so the thing that
 * produces them has to be checked as carefully as the thing it measures.
 *
 * The fixtures below name `widget-*` modules rather than the real Intelligence
 * ones deliberately. Only the harness is allowed to know where Intelligence
 * lives, and a scanner test needs a module name, not *that* module name — using
 * the real one would make the extraction edit this file for no reason.
 *
 * The scanner it replaced was a substring `git grep`, and it was wrong in both
 * directions: a file mentioning `app.intelligence` only in a comment counted as
 * a consumer, and `app['intelligence']` did not. Every case below is one of
 * those two failures, written as a test so neither can come back.
 */

test('prose is not a consumer: comments, strings and templates are stripped', () => {
  const decoy = [
    '// a line comment about app.intelligence',
    '/* a block comment about app.intelligence',
    '   spanning lines and still about app.intelligence */',
    "const doc = 'see app.intelligence for details';",
    'const tpl = `template mentioning app.intelligence`;',
    'const re = /app\\.intelligence/;',
    'export const notAConsumer = { doc, tpl, re };',
  ].join('\n');

  assert.equal(readsProperty(decoy, 'app', 'intelligence'), false,
    'a file that only talks about the field must not be recorded as reading it');
  assert.doesNotMatch(stripNonCode(decoy), /intelligence/,
    'nothing referencing the field should survive stripping, because none of it is code');
});

test('every real form of the read is found, not just the dotted one', () => {
  const forms = {
    dotted: 'export const a = (app) => app.intelligence;',
    optional: 'export const b = (app) => app?.intelligence;',
    computedSingle: "export const c = (app) => app['intelligence'];",
    computedDouble: 'export const d = (app) => app["intelligence"];',
    acrossLines: 'export const e = (app) => app\n  .intelligence;',
    spaced: 'export const f = (app) => app . intelligence;',
    destructured: 'export const g = (app) => { const { intelligence } = app; return intelligence; };',
    renamed: 'export const h = (app) => { const { intelligence: i } = app; return i; };',
  };
  for (const [name, source] of Object.entries(forms)) {
    assert.equal(readsProperty(source, 'app', 'intelligence'), true, `${name} is a real read and must be found`);
  }
});

test('a similarly named neighbour is not a consumer', () => {
  // `intelligenceRegistries` and `notApp.intelligence` are different things.
  assert.equal(readsProperty('export const a = (app) => app.intelligenceRegistries;', 'app', 'intelligence'), false);
  assert.equal(readsProperty('export const b = (other) => other.intelligence;', 'app', 'intelligence'), false);
  assert.equal(readsProperty('export const c = (app) => appx.intelligence;', 'app', 'intelligence'), false);
});

test('a commented-out import is not an import', () => {
  const source = [
    "// import { thing } from './widget-registry.js';",
    "/* import { other } from './widget-actions.js'; */",
    "const note = \"imported from './widget-registry.js' once\";",
    "import { real } from './widget-actions.js';",
  ].join('\n');
  const found = importsFrom(source, /widget-(registry|actions)\.js$/);
  assert.deepEqual(found, ['./widget-actions.js'],
    'only the live import statement counts; the commented ones and the string do not');
});

test('export-from and dynamic import are imports too', () => {
  assert.deepEqual(
    importsFrom("export { x } from './widget-registry.js';", /widget-registry\.js$/),
    ['./widget-registry.js'],
  );
  assert.deepEqual(
    importsFrom("const m = await import('./widget-actions.js');", /widget-actions\.js$/),
    ['./widget-actions.js'],
  );
});

test('a template substitution is code and survives stripping', () => {
  // The interpolated expression is real code; the surrounding text is not.
  const source = 'export const a = (app) => `value: ${app.intelligence.models.length} about app.intelligence`;';
  assert.equal(readsProperty(source, 'app', 'intelligence'), true,
    'a read inside ${...} is a read');
  const stripped = stripNonCode(source);
  assert.match(stripped, /app\.intelligence\.models/);
  assert.equal((stripped.match(/intelligence/g) || []).length, 1,
    'the prose half of the template must not survive');
});

test('escapes and nested quotes do not desynchronize the scanner', () => {
  const source = [
    "const a = 'it\\'s a string mentioning app.intelligence';",
    'const b = "a \\"quoted\\" string mentioning app.intelligence";',
    'const c = `back\\`tick mentioning app.intelligence`;',
    'export const d = { a, b, c };',
  ].join('\n');
  assert.equal(readsProperty(source, 'app', 'intelligence'), false,
    'an escaped quote must not end the literal early and expose prose as code');
});

test('division is not mistaken for a regex literal', () => {
  const source = 'export const a = (app, x, y) => (x / y) + (app.intelligence ? 1 : 0);';
  assert.equal(readsProperty(source, 'app', 'intelligence'), true,
    'treating the division as a regex would swallow the rest of the line');
});

test('the scanner publishes what it does not claim', () => {
  assert.ok(SCANNER_LIMITS.length >= 3);
  for (const limit of SCANNER_LIMITS) assert.match(limit, /^[A-Z_]+ — /);
  const text = SCANNER_LIMITS.join(' ');
  // An honest limit list names the alias case, because that one is real: a
  // consumer that copies the field to a local first is genuinely not followed.
  assert.match(text, /ALIASING_NOT_TRACKED/);
});
