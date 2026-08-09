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
 * @param {string} source
 */
export function importSpecifiers(source) {
  /** @type {string[]} */
  const out = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) out.push(match[2]);
  return out;
}
