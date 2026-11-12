// @ts-check

/**
 * Syntax check of every checked-in `.js` / `.mjs` file, in ONE process
 * (backlog:3d560518f3e2).
 *
 * It used to spawn `node --check <file>` once per file: 1051 node processes
 * in a row, 187-206 s of the PR gate on the shared CI server. The answer is
 * the same, computed in-process: each file is parsed — never run — as the
 * module format node would load it as, and a file node --check refuses is
 * refused here with its name and node's own diagnostic.
 *
 * Format, as node decides it: `.mjs` is ESM; a `.js` file follows the nearest
 * package.json `"type"` (`"module"` → ESM); with no type node 22 detects, so
 * such a file passes when it parses as CommonJS or, failing that, as ESM.
 * ESM parsing needs `vm.SourceTextModule` (`--experimental-vm-modules`): the
 * script re-runs itself once with that flag when started without it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ignored = new Set(['.git', 'node_modules', 'data']);

/**
 * Every file the check covers under `root`.
 * @param {string} root
 * @returns {string[]}
 */
export function listSourceFiles(root) {
  // The gitignored site build: the gtm phase deletes and rebuilds it, and the
  // fast gate runs its phases in parallel on the Linux runner (scripts/ci-fast.sh).
  const ignoredPaths = new Set([join(root, 'site', 'dist')]);
  // `.mjs` too. The starter installer and the scenario journeys are checked-in
  // executable source that CI runs, and nothing was syntax-checking them: a typo
  // in one surfaced as a journey that "did not complete", minutes later, with the
  // diagnostic buried in a child's last line.
  return walk(root, ignoredPaths).filter((file) => file.endsWith('.js') || file.endsWith('.mjs'));
}

/**
 * What the nearest package.json says about the module format:
 * `module` / `commonjs` (its "type"), `none` (no package.json, or one without
 * "type"), or `unknown` — an unreadable or invalid package.json, or a "type"
 * that is not one of those strings. node decides `unknown` its own way
 * (it accepts an unknown string, refuses a non-string or broken JSON), so
 * those files go to `node --check` instead of a guess.
 * @typedef {'module' | 'commonjs' | 'none' | 'unknown'} PackageKind
 */

/** @type {Map<string, PackageKind>} directory → kind of its nearest package.json */
const kindCache = new Map();

/**
 * @param {string} file
 * @returns {PackageKind}
 */
function packageKind(file) {
  const seen = [];
  let directory = dirname(file);
  /** @type {PackageKind} */
  let found = 'none';
  for (;;) {
    const cached = kindCache.get(directory);
    if (cached) { found = cached; break; }
    seen.push(directory);
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        const type = parsed && typeof parsed === 'object' ? parsed.type : null;
        found = type === undefined ? 'none'
          : type === 'module' || type === 'commonjs' ? type
            : 'unknown';
      } catch {
        found = 'unknown';
      }
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const directory of seen) kindCache.set(directory, found);
  return found;
}

/**
 * Parse `source` as an ES module; null when it parses, the error otherwise.
 * @param {string} source
 * @param {string} file
 */
function parseModule(source, file) {
  try {
    // @ts-ignore experimental API, present under --experimental-vm-modules
    new vm.SourceTextModule(source, { identifier: pathToFileURL(file).href });
    return null;
  } catch (error) {
    return /** @type {Error} */ (error);
  }
}

/**
 * Parse `source` as a CommonJS module body (the wrapper node uses, so a
 * top-level `return` is legal); null when it parses, the error otherwise.
 * @param {string} source
 * @param {string} file
 */
function parseCommonJs(source, file) {
  try {
    // A leading hashbang is legal at the start of a file, not of a function body.
    const body = source.startsWith('#!') ? `//${source.slice(2)}` : source;
    vm.compileFunction(body, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: file });
    return null;
  } catch (error) {
    return /** @type {Error} */ (error);
  }
}

/**
 * The syntax verdict of one file: null when node would accept it, a
 * one-paragraph diagnostic (location, then the parser's message) otherwise.
 * @param {string} file absolute path
 * @returns {string | null}
 */
export function checkFile(file) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    // Unreadable, or gone since the walk: a named failure, never a crash
    // that hides every other file's verdict.
    const failure = /** @type {NodeJS.ErrnoException} */ (error);
    return `${file}\ncannot be read: ${failure.code ?? failure.message}`;
  }
  const kind = packageKind(file);
  // An unknown package scope is node's call, file by file.
  if (kind === 'unknown') return confirm(file);
  const type = file.endsWith('.mjs') ? 'module' : kind;
  let error;
  if (type === 'module') {
    error = parseModule(source, file);
  } else if (type === 'commonjs') {
    error = parseCommonJs(source, file);
  } else {
    // No "type": node detects — CommonJS first, ES module when that fails.
    error = parseCommonJs(source, file);
    if (error && !parseModule(source, file)) error = null;
  }
  return error ? confirm(file) : null;
}

/**
 * A file the in-process parse refused gets node's own word, from the one
 * `node --check` this run spawns per refused file (none on a green tree):
 * the diagnostic is then exactly node's (file, line, caret, message), and
 * should the two ever disagree, node's verdict is the one that stands.
 * @param {string} file
 * @returns {string | null}
 */
function confirm(file) {
  const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (run.status === 0) return null;
  return String(run.stderr ?? '').trim() || `${file}: node --check exited ${run.status}`;
}

/**
 * @param {string} directory
 * @param {Set<string>} ignoredPaths
 * @returns {string[]}
 */
function walk(directory, ignoredPaths) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const path = join(directory, name);
    if (ignoredPaths.has(path)) continue;
    let isDirectory = false;
    // Gone between readdir and stat: listed anyway, so a source file that
    // vanished mid-run is reported by name by checkFile instead of crashing here.
    try { isDirectory = statSync(path).isDirectory(); } catch { isDirectory = false; }
    if (isDirectory) results.push(...walk(path, ignoredPaths));
    else results.push(path);
  }
  return results;
}

function main() {
  // @ts-ignore experimental API
  if (typeof vm.SourceTextModule !== 'function') {
    // One re-run with the flag, never more (the env guard stops a loop).
    if (process.env.ACCORDO_CHECK_REEXEC === '1') {
      console.error('check: vm.SourceTextModule is unavailable even with --experimental-vm-modules.');
      process.exitCode = 2;
      return;
    }
    const run = spawnSync(process.execPath,
      ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, ACCORDO_CHECK_REEXEC: '1' } });
    process.exitCode = run.status ?? 1;
    return;
  }
  const root = process.cwd();
  const files = listSourceFiles(root);
  const failures = [];
  for (const file of files) {
    const error = checkFile(file);
    if (error) failures.push({ file: relative(root, file), error });
  }
  if (failures.length) {
    for (const failure of failures) console.error(`\n${failure.file}\n${failure.error}`);
    process.exitCode = 1;
  } else {
    console.log(`Syntax check passed for ${files.length} JavaScript files.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
