// @ts-check

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The package source-boundary primitives, in one place.
 *
 * These used to be copy-pasted byte-identical into `package-commands.js` and
 * `tests/helpers/package-conformance.js`. ADR-018 addendum 4 records that a
 * quote-sensitivity defect in the private-import rule had to be fixed in both
 * copies, and nothing asserted they stayed equal. `crm package test` would have
 * been copy three, so the rule moves here first and every caller imports it.
 */

/**
 * A package may not reach into `packages/core/src`. The rule has to see the
 * import however it is written: single or double quotes, a backtick, a static
 * `from` clause (which also covers `export … from`) or a dynamic `import()` —
 * a quote style is not a boundary.
 */
export const PRIVATE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])[^'"`]*core\/src\/[^'"`]*\1/;

/** Every module specifier a source file imports, whatever quote style it used. */
export const IMPORT_SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g;

/**
 * Remove comments before the boundary rules read a file.
 *
 * Both rules are regular expressions over source text, and a regular expression
 * cannot tell code from prose. A doc comment that writes a path in backticks
 * after the word "from" — *"the signer policy from `packages/signature/src/…`"*
 * — is matched as an import, and a conforming package fails conformance for a
 * sentence explaining why it is conforming. That is a false accusation from an
 * authority, which is worse than a missed one: it is unfixable except by
 * deleting the explanation.
 *
 * Stripping has to respect strings, or it invents the opposite bug: cutting at
 * the `//` inside `'https://example.test'` would blind the scanner to every
 * import after it on that line. So this walks the source once, tracking quote,
 * template and regular-expression state, and replaces comment bodies with
 * spaces — same length, same line structure, no content.
 *
 * @param {string} source
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  // The last significant character, which is what decides whether a `/` opens a
  // regular expression or divides. The classic heuristic, and the ambiguity it
  // cannot resolve (`a /b/ c`) is not valid JavaScript in a source file anyway.
  let previous = '';
  const REGEX_ALLOWED_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', 'return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await']);
  const keywordBefore = () => /(?:^|[^\w$])(return|typeof|case|in|of|do|else|yield|await)\s*$/.exec(out)?.[1] ?? '';

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (char === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      out += char;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        out += source[i];
        if (source[i] === quote) { i += 1; break; }
        i += 1;
      }
      previous = quote;
      continue;
    }
    if (char === '/' && (REGEX_ALLOWED_BEFORE.has(previous) || keywordBefore() !== '')) {
      // A regular expression literal: copy it whole, so a `//` inside it is not
      // read as a comment and a quote inside it does not open a string.
      out += char;
      i += 1;
      let inClass = false;
      while (i < source.length) {
        if (source[i] === '\\') { out += source[i] + (source[i + 1] ?? ''); i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        out += source[i];
        if (source[i] === '/' && !inClass) { i += 1; break; }
        if (source[i] === '\n') { i += 1; break; }
        i += 1;
      }
      previous = '/';
      continue;
    }

    out += char;
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return out;
}

/** JavaScript, including `.mjs` — a package's entry point may be either. */
export const SOURCE_RE = /\.m?js$/;

/**
 * Every JavaScript file under a package directory, sorted, skipping
 * `node_modules` and dotted directories. Sorted because a scan whose order
 * follows the filesystem reports a different first failure on a different
 * machine.
 *
 * @param {string} dir
 */
export function packageSources(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_RE.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Every specifier a source file imports. Used to ask whether a package reaches
 * into another package's private source — a question a substring search cannot
 * answer, because `packages/contracts/src/service-capability.js` contains the
 * text `service/` in the sense of a filename rather than a package boundary.
 *
 * Comments are stripped first: a path written in prose is not an import, and a
 * package that explains its boundary must not fail for explaining it.
 *
 * @param {string} source
 */
export function importSpecifiers(source) {
  /** @type {string[]} */
  const out = [];
  for (const match of stripComments(source).matchAll(IMPORT_SPECIFIER_RE)) out.push(match[2]);
  return out;
}

/**
 * Does this source reach into `packages/core/src`? The same question
 * `PRIVATE_IMPORT_RE` asks, asked over code rather than over prose.
 *
 * @param {string} source
 */
export function importsPrivateKernelPath(source) {
  return PRIVATE_IMPORT_RE.test(stripComments(source));
}
