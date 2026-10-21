// @ts-check

/**
 * The heredoc min-corpus cannot shrink quietly.
 *
 * The shell-oracle machinery lives in tests/helpers/shell-oracle.js (shared
 * by the six oracle slices in tests/shell-oracle-a/b/c/d/e/f.test.js,
 * backlog:664d5f481a96), and a full-oracle slice is far too slow for the
 * fast gate — so this file must never import it: importing a test file
 * registers its tests, which would drag the whole matrix into every run
 * that selects this guard, and importing the helper is one step removed
 * from the same trap. It reads the helper as text instead and pins what
 * "halving the heredoc samples" would move: the sample stays at six
 * spellings covering all six delimiter-quoting paths, every sample stays a
 * member of the full list, the full list does not shrink, the generator
 * still emits every placement, and shellCorpus still crosses the sample
 * (not a hardcoded short list).
 *
 * Thresholds are absolute on purpose: they live here, not in the helper,
 * so cutting entries there fails here instead of shrinking the bound along
 * with the corpus. Growing either list stays green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_FILE = 'tests/helpers/shell-oracle.js';

/** Delimiter spellings the full corpus knows today; removals fail, additions pass. */
const MIN_FULL_SPELLINGS = 23;
/** One spelling per delimiter-quoting path; halving the sample fails. */
const MIN_SAMPLE_SPELLINGS = 6;
/** Every placement the generator must emit for one delimiter spelling. */
const HEREDOC_PLACEMENTS = ['body', 'after', 'nearMiss', 'unterminated', 'spaceIndent'];
/** One quoting path per sample entry; the sample is the cross of these. */
const HEREDOC_QUOTING_PATHS = [
  'bare',
  'single-quoted',
  'double-quoted',
  'backslash-escaped',
  'bare-expansion',
  'quoted-expansion',
];

/**
 * Which delimiter-quoting path a spelling exercises. Mirrors the sample's
 * documented contract ("one spelling per delimiter-quoting path"); kept
 * here instead of imported because importing the matrix file would register
 * its ~240 s tests in this run.
 * @param {string} spelling
 */
function heredocQuotingPath(spelling) {
  const quoted = spelling.includes("'") || spelling.includes('"') || spelling.includes('\\');
  if (spelling.includes('$')) return quoted ? 'quoted-expansion' : 'bare-expansion';
  if (spelling.includes("'")) return 'single-quoted';
  if (spelling.includes('"')) return 'double-quoted';
  if (spelling.includes('\\')) return 'backslash-escaped';
  return 'bare';
}

/**
 * Extract the `const <name> = [...]` string array from the matrix source.
 * Fails loudly (never an empty list) when the anchor or the literal moves,
 * so a refactor that defeats the extractor reddens instead of passing
 * vacuously.
 * @param {string} source
 * @param {string} name
 * @returns {string[]}
 */
function extractStringArray(source, name) {
  const anchor = `const ${name} = [`;
  const start = source.indexOf(anchor);
  assert.ok(start !== -1, `${MATRIX_FILE} no longer declares \`${name}\`: update this guard, do not delete it`);
  let index = start + anchor.length - 1;
  let depth = 0;
  let quote = null;
  let end = -1;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) { end = index; break; }
    }
  }
  assert.ok(end !== -1, `could not find the end of \`${name}\` in ${MATRIX_FILE}: update this guard`);
  const body = source.slice(start + anchor.length, end);
  /** @param {string} literal */
  const unescape = (literal) => literal.replace(/\\(.)/g, (_, char) => (
    char === 'n' ? '\n' : char === 't' ? '\t' : char === 'r' ? '\r' : char
  ));
  const entries = [];
  const token = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let match = token.exec(body);
  while (match !== null) {
    entries.push(unescape(match[1] ?? match[2]));
    match = token.exec(body);
  }
  assert.ok(entries.length > 0, `parsed zero entries out of \`${name}\` in ${MATRIX_FILE}: the extractor is stale, fix it`);
  return entries;
}

/**
 * The `function <name>(...) { ... }` body by brace balance. Same
 * fail-loud contract as the array extractor.
 * @param {string} source
 * @param {string} name
 */
function extractFunctionBody(source, name) {
  const anchor = `function ${name}(`;
  const start = source.indexOf(anchor);
  assert.ok(start !== -1, `${MATRIX_FILE} no longer defines \`${name}\`: update this guard, do not delete it`);
  const open = source.indexOf('{', start);
  assert.ok(open !== -1, `could not find the body of \`${name}\`: update this guard`);
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  throw new Error(`could not find the end of \`${name}\`: update this guard`);
}

test('the heredoc min-corpus cannot shrink quietly', () => {
  const source = readFileSync(join(REPO_ROOT, MATRIX_FILE), 'utf8');
  const full = extractStringArray(source, 'HEREDOC_DELIMITER_SPELLINGS');
  const sample = extractStringArray(source, 'SHELL_ORACLE_HEREDOC_SPELLINGS');

  // The extractor really read the lists, not two empty brackets.
  assert.ok(full.includes('EOF'), 'the full-list extraction missed the EOF spelling: the extractor is stale');
  assert.ok(full.includes('É'), 'the full-list extraction missed an exotic spelling: the extractor is stale');
  assert.ok(sample.includes('EOF'), 'the sample extraction missed the EOF spelling: the extractor is stale');

  // Halving either list fails here; growing either stays green.
  assert.ok(
    full.length >= MIN_FULL_SPELLINGS,
    `the full heredoc list shrank to ${full.length} spellings (was ${MIN_FULL_SPELLINGS}): restore it or move the pin deliberately`,
  );
  assert.ok(
    sample.length >= MIN_SAMPLE_SPELLINGS,
    `the heredoc sample shrank to ${sample.length} spellings (was ${MIN_SAMPLE_SPELLINGS}): restore it or move the pin deliberately`,
  );
  const missing = sample.filter((spelling) => !full.includes(spelling));
  assert.deepEqual(missing, [], `sample spellings outside the full corpus sample nothing: ${JSON.stringify(missing)}`);

  // Halving the sample drops a quoting path even when the count is padded
  // back with same-shaped spellings: every path stays represented.
  const covered = new Set(sample.map(heredocQuotingPath));
  for (const path of HEREDOC_QUOTING_PATHS) {
    assert.ok(
      covered.has(path),
      `the heredoc sample no longer covers the ${path} delimiter path; the min-corpus has been cut`,
    );
  }

  // The sample is the list the corpus crosses, not a name the generator
  // ignores: shellCorpus still hands it to heredocCrossProduct.
  const corpusBody = extractFunctionBody(source, 'shellCorpus');
  assert.ok(
    corpusBody.includes('SHELL_ORACLE_HEREDOC_SPELLINGS'),
    'shellCorpus no longer crosses SHELL_ORACLE_HEREDOC_SPELLINGS: the sample is wired to nothing',
  );

  // Dropping a placement from the generator halves no list but still
  // shrinks what is checked: every placement stays emitted.
  const generatorBody = extractFunctionBody(source, 'heredocCrossProduct');
  for (const placement of HEREDOC_PLACEMENTS) {
    assert.ok(
      new RegExp(`(?:^|[^\\w$])${placement}:`).test(generatorBody),
      `the generator no longer emits the ${placement} heredoc placement; a placement has been dropped`,
    );
  }
});
