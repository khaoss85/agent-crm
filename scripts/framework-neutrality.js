// @ts-check

/**
 * Framework-neutrality guard (backlog:4c63c9dc).
 *
 * The framework ships no customer name: `packages/` must not name one.
 * Test fixtures may (`tests/` use the first customer's names as fixture
 * values) — they are the single declared exception, and this scan never
 * looks at them.
 *
 *   node scripts/framework-neutrality.js [--root <dir>]
 *
 * Exit 0 when `packages/` is clean, 1 listing every offending file and
 * line otherwise. `tests/framework-neutrality.test.js` is the same check
 * as a repo-wide guard (see REPO_WIDE_GUARDS in
 * `scripts/ci-touched-tests.js`): it fails the PR that introduces a name,
 * and it unit-proves the matcher both fires on the known spellings and
 * stays quiet on lookalike Italian words.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The customer names that must never appear in `packages/`, each with the
 * reason it is listed. One entry per customer, never per spelling: the
 * patterns below cover the spellings.
 */
export const CLIENT_NAMES = Object.freeze([
  {
    name: 'Presti Group',
    reason: 'first customer (LIVE since 2026-10-16): framework text and defaults stay customer-neutral',
    patterns: Object.freeze([
      /\bpresti\b/i,
      /presti[\s_\-]*group/i,
    ]),
  },
]);

/** Source extensions the scan reads. Anything else is not framework prose. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md']);

/** Directories the scan never descends into. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

/**
 * Every offending line under `scopeDir`, one entry per line.
 *
 * @param {string} scopeDir the directory to scan (usually `<root>/packages`).
 * @returns {Array<{ file: string, line: number, text: string, client: string }>}
 */
export function scanClientNameViolations(scopeDir) {
  /** @type {Array<{ file: string, line: number, text: string, client: string }>} */
  const violations = [];
  const walk = (/** @type {string} */ directory) => {
    for (const name of readdirSync(directory)) {
      if (SKIPPED_DIRECTORIES.has(name)) continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const dot = name.lastIndexOf('.');
      if (dot === -1 || !SCANNED_EXTENSIONS.has(name.slice(dot))) continue;
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        for (const client of CLIENT_NAMES) {
          if (client.patterns.some((pattern) => pattern.test(line))) {
            violations.push({
              file: relative(process.cwd(), path),
              line: index + 1,
              text: line.trim(),
              client: client.name,
            });
            break;
          }
        }
      }
    }
  };
  walk(scopeDir);
  return violations.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = String(flag('--root') ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const violations = scanClientNameViolations(join(root, 'packages'));
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stdout.write(`${violation.file}:${violation.line}: ${violation.client}: ${violation.text}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write('framework-neutrality: no customer names in packages/.\n');
  }
}
