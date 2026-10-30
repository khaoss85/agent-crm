// @ts-check
/**
 * Backoffice bundle build (backlog:3f74a2f296ec).
 *
 * The shell in `apps/admin/public` used to load 30+ ES modules one by one
 * (`app.js` importing `admin-*.js` in a cascade): on a cold connection the
 * first paint of `/bo` waited for every round trip. The server bundles the
 * whole `app.js` graph into ONE versioned file (`bo-<sha12>.js`) plus a
 * versioned copy of the stylesheet (`bo-styles-<sha12>.css`), and serves
 * `index.html` (and `login.html`) pointing at them. First access is then:
 * `index.html` (no-store) + 1 JS + 1 CSS.
 *
 * The bundle is generated at serve time, never committed: with many design
 * PRs in parallel a checked-in bundle goes stale on every merge to main.
 * The server builds it lazily on the first `/bo` request that needs it and
 * keeps it in memory (`getAdminBundle`); the name carries the content hash
 * of the sources, so a new deploy is a new name and the old one 404s.
 * Only the sources (`app.js`, `admin-*.js`, `styles.css`) live in git.
 *
 * No bundler dependency on purpose: the graph uses only static named
 * `import { … } from './x.js'` / `export …` forms (asserted below, fail
 * closed), so each module is wrapped in its own scope and wired through a
 * registry — no identifier rewriting, no cross-file collisions.
 *
 *   node scripts/admin-bundle.js --check   # read-only: bundle builds and no bundle files are committed
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(root, 'apps/admin/public');
const ENTRY = 'app.js';
const HASH_LEN = 12;

const LOCAL_IMPORT = /import\s+([^;]*?)\s+from\s*['"](\.[^'"]*)['"]\s*;/gs;
const EXPORT_PREFIX = /^export\s+(?=(?:async\s+)?function\b|class\b|(?:const|let|var)\b)/gm;
const EXPORT_LIST = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm;
const DECLARATION_FN = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const DECLARATION_CLASS = /^export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
const DECLARATION_VAR = /^export\s+(?:const|let|var)\s+/gm;
const BINDING_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FORBIDDEN = /export\s+default\b|export\s*\*\s*from\b|import\s*\(|import\.meta\b/;

/**
 * @param {string} dir
 */
function localModules(dir) {
  return new Set(
    readdirSync(dir).filter((name) => name.endsWith('.js') && !/^bo(-styles)?-[0-9a-f]+\.(js|css)$/.test(name)),
  );
}

/**
 * Strip `//` and `/* … *\/` comments so prose that mentions module syntax
 * (changelog-style headers like "import { x } from './y.js';") never parses
 * as code. String literals (`'…'`, `"…"`, `` `…` `` with `\` escapes) are
 * opaque to the scanner, so URLs and text survive untouched; the shell
 * sources it was written against hold no comment-like sequence inside a
 * regex literal, and anything unrecognized fails closed in `parseImports`.
 * The stripped text feeds detection AND the emitted bundle, never the
 * checked-in sources.
 *
 * @param {string} source
 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const end = source.length;
  while (i < end) {
    const char = source[i];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      out += char;
      i += 1;
      while (i < end) {
        const inner = source[i];
        out += inner;
        if (inner === '\\') {
          out += source[i + 1] ?? '';
          i += 2;
          continue;
        }
        i += 1;
        if (inner === quote) break;
      }
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < end && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < end && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * @param {string} source
 */
function parseImports(source) {
  const imports = [];
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    const clause = match[1].trim();
    const target = match[2];
    if (!clause.startsWith('{')) {
      throw new Error(`admin-bundle: only named imports are supported (got \`${clause}\` from ${target})`);
    }
    const names = clause
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const aliased = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part);
        if (aliased) return { exported: aliased[1], local: aliased[2] };
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) return { exported: part, local: part };
        throw new Error(`admin-bundle: unparseable import \`${part}\` from ${target}`);
      });
    imports.push({ target, names, statement: match[0] });
  }
  return imports;
}

/**
 * Split top-level commas: commas inside `()[]{}` or string literals never
 * separate declarators. Anything unbalanced fails closed.
 *
 * @param {string} text
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== null) {
      current += char;
      if (char === '\\') {
        current += text[i + 1] ?? '';
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (depth < 0) throw new Error('admin-bundle: unbalanced brackets in an export declaration');
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote !== null) throw new Error('admin-bundle: unterminated string in an export declaration');
  if (depth !== 0) throw new Error('admin-bundle: unbalanced brackets in an export declaration');
  parts.push(current);
  return parts;
}

/**
 * Names bound by `export const|let|var …;` starting right after the keyword.
 * The statement ends at the first `;` outside brackets and strings;
 * destructured declarators are rejected (fail closed: name them plainly or
 * extend the bundler deliberately).
 *
 * @param {string} file
 * @param {string} body
 * @param {number} start index just after `export const|let|var `
 */
function varDeclaratorNames(file, body, start) {
  let depth = 0;
  let quote = null;
  let end = -1;
  for (let i = start; i < body.length; i += 1) {
    const char = body[i];
    if (quote !== null) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (depth < 0) throw new Error(`admin-bundle: unbalanced brackets in an export of ${file}`);
    if (char === ';' && depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`admin-bundle: unterminated export declaration in ${file}`);
  return splitTopLevel(body.slice(start, end)).map((part) => {
    const lhs = part.split('=')[0].trim();
    if (!BINDING_IDENT.test(lhs)) {
      throw new Error(`admin-bundle: unsupported export declarator \`${part.trim()}\` in ${file} (only plain bindings)`);
    }
    return lhs;
  });
}

/**
 * @param {string} file
 * @param {string} source
 */
function transformModule(file, source) {
  if (FORBIDDEN.test(source)) {
    throw new Error(`admin-bundle: ${file} uses a module form the bundler does not support (default export, re-export, dynamic import or import.meta)`);
  }
  /** @type {{ exported: string, local: string }[]} */
  const provided = [];
  /** @type {{ exported: string, local: string }[]} */
  const required = [];
  let body = source;
  for (const { target, names, statement } of parseImports(source)) {
    if (!target.startsWith('./')) {
      throw new Error(`admin-bundle: ${file} imports a bare specifier (${target}); only relative files are supported`);
    }
    const resolved = target.slice(2);
    body = body.replace(statement, () => `/* bundled: ${names.map((n) => n.local).join(', ')} from ${resolved} */`);
    for (const name of names) required.push({ ...name, from: resolved });
  }
  for (const match of body.matchAll(DECLARATION_FN)) {
    provided.push({ local: match[1], exported: match[1] });
  }
  for (const match of body.matchAll(DECLARATION_CLASS)) {
    provided.push({ local: match[1], exported: match[1] });
  }
  for (const match of body.matchAll(DECLARATION_VAR)) {
    for (const name of varDeclaratorNames(file, body, match.index + match[0].length)) {
      provided.push({ local: name, exported: name });
    }
  }
  body = body.replace(EXPORT_PREFIX, '');
  for (const match of body.matchAll(EXPORT_LIST)) {
    for (const part of match[1].split(',').map((p) => p.trim()).filter(Boolean)) {
      const aliased = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(part);
      if (aliased) provided.push({ local: aliased[1], exported: aliased[2] });
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) provided.push({ local: part, exported: part });
      else throw new Error(`admin-bundle: unparseable export \`${part}\` in ${file}`);
    }
  }
  body = body.replace(EXPORT_LIST, '');
  for (const { local } of [...provided, ...required]) {
    if (local === '__bo') throw new Error(`admin-bundle: ${file} declares the reserved name __bo`);
  }
  const prelude = required
    .map(({ exported, local, from }) => `const ${local} = __bo[${JSON.stringify('./' + from)}].${exported};`)
    .join('\n');
  const epilogue = provided.length
    ? `\nreturn { ${provided.map(({ exported, local }) => `${exported}: ${local}`).join(', ')} };`
    : '\nreturn {};';
  return { body, prelude, required, provided, epilogue };
}

/**
 * Depth-first topological order of the local graph reachable from ENTRY.
 * Cycles fail closed: two shell modules calling each other at load time
 * would silently read uninitialized bindings after bundling.
 *
 * @param {string} entry
 * @param {Map<string, string>} sources
 */
function topoOrder(entry, sources) {
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      throw new Error(`admin-bundle: circular import involving ${file}; the shell graph must stay acyclic`);
    }
    const source = sources.get(file);
    if (source === undefined) throw new Error(`admin-bundle: ${file} not found under apps/admin/public`);
    visiting.add(file);
    for (const { target } of parseImports(source)) {
      visit(target.slice(2));
    }
    visiting.delete(file);
    visited.add(file);
    order.push(file);
  };
  visit(entry);
  return order;
}

/**
 * Build the bundle in memory. Pure (no writes): the server, tests and
 * --check share it. `publicDir` is the `apps/admin/public` checkout the
 * server was started with (tests pass fixture-free: the real one).
 *
 * @param {string} [publicDir]
 */
export function buildAdminBundle(publicDir = PUBLIC_DIR) {
  const files = localModules(publicDir);
  if (!files.has(ENTRY)) throw new Error('admin-bundle: app.js entry is missing');
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const name of files) sources.set(name, stripComments(readFileSync(join(publicDir, name), 'utf8')));
  const order = topoOrder(ENTRY, sources);
  const sections = order.map((file) => {
    const { body, prelude, epilogue } = transformModule(file, /** @type {string} */ (sources.get(file)));
    return `/* ---- ${file} (bundled, do not edit) ---- */\n__bo[${JSON.stringify('./' + file)}] = (() => {\n${prelude}${prelude ? '\n' : ''}${body}${epilogue}\n})();`;
  });
  const jsBody = `/* Accordo backoffice bundle. Generated by scripts/admin-bundle.js — do not edit.\n * Sources: ${order.join(', ')}. */\nconst __bo = Object.create(null);\n${sections.join('\n\n')}\n`;
  const jsHash = createHash('sha256').update(jsBody).digest('hex').slice(0, HASH_LEN);
  const jsName = `bo-${jsHash}.js`;
  const cssSource = readFileSync(join(publicDir, 'styles.css'), 'utf8');
  const cssHash = createHash('sha256').update(cssSource).digest('hex').slice(0, HASH_LEN);
  const cssName = `bo-styles-${cssHash}.css`;
  return { order, jsBody, jsName, cssSource, cssName };
}

/**
 * @param {string} html
 * @param {RegExp} pattern
 * @param {string} replacement
 * @param {string} label
 */
function replaceOnce(html, pattern, replacement, label) {
  const matches = html.match(pattern);
  if (!matches) throw new Error(`admin-bundle: ${label} not found in html`);
  return html.replace(pattern, replacement);
}

/**
 * Per-module import/export wiring, for tests: every `required` entry names
 * the exporting module (`from`, without `./`) and the exported binding.
 * A required binding missing from its target's `provided` list would load
 * as `undefined` and break the shell on first paint.
 */
/**
 * @param {string} [publicDir]
 */
export function adminBundleWiring(publicDir = PUBLIC_DIR) {
  const files = localModules(publicDir);
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const name of files) sources.set(name, stripComments(readFileSync(join(publicDir, name), 'utf8')));
  return topoOrder(ENTRY, sources).map((file) => {
    const { required, provided } = transformModule(file, /** @type {string} */ (sources.get(file)));
    return {
      file,
      required: required.map(({ exported, from }) => ({ exported, from })),
      provided: provided.map(({ exported }) => exported),
    };
  });
}

/**
 * Point the checked-in shell HTML (which names the sources, `app.js` and
 * `styles.css`) at the built hashed names. The patterns also accept HTML
 * that already names a bundle, so a re-render is idempotent.
 *
 * @param {{ order: string[], jsBody: string, jsName: string, cssSource: string, cssName: string }} built
 * @param {string} [publicDir]
 */
export function renderHtml(built, publicDir = PUBLIC_DIR) {
  const scriptPattern = /<script\s+type="module"\s+src="(?:app|bo-[0-9a-f]+)\.js"><\/script>/;
  const stylePattern = /<link\s+rel="stylesheet"\s+href="(?:styles|bo-styles-[0-9a-f]+)\.css"\s*\/>/;
  const indexSource = readFileSync(join(publicDir, 'index.html'), 'utf8');
  const indexHtml = replaceOnce(
    replaceOnce(indexSource, scriptPattern, `<script type="module" src="${built.jsName}"></script>`, 'shell script tag'),
    stylePattern,
    `<link rel="stylesheet" href="${built.cssName}" />`,
    'shell stylesheet link',
  );
  const loginSource = readFileSync(join(publicDir, 'login.html'), 'utf8');
  const loginHtml = replaceOnce(loginSource, stylePattern, `<link rel="stylesheet" href="${built.cssName}" />`, 'login stylesheet link');
  return { indexHtml, loginHtml };
}

/**
 * In-memory bundle cache for the server. The first `/bo` request that needs
 * the bundle builds it from the sources on disk; every later request reuses
 * the same bytes and names until the process restarts (a new deploy is a
 * new process, hence a new hash when the sources moved). Keyed by resolved
 * public dir so a custom `publicDir` never reads another checkout's bundle.
 * Tests reset it with `resetAdminBundleCache`.
 *
 * @param {string} [publicDir]
 */
/** @type {Map<string, { order: string[], jsBody: string, jsName: string, cssSource: string, cssName: string, indexHtml: string, loginHtml: string }>} */
const bundleCache = new Map();

export function getAdminBundle(publicDir = PUBLIC_DIR) {
  const key = String(publicDir ?? PUBLIC_DIR);
  let cached = bundleCache.get(key);
  if (!cached) {
    const built = buildAdminBundle(key);
    const { indexHtml, loginHtml } = renderHtml(built, key);
    cached = { ...built, indexHtml, loginHtml };
    bundleCache.set(key, cached);
  }
  return cached;
}

export function resetAdminBundleCache() {
  bundleCache.clear();
}

function main() {
  if (!process.argv.includes('--check')) {
    console.error('admin-bundle: the bundle is generated at serve time, never written. Use --check.');
    process.exitCode = 1;
    return;
  }
  const built = buildAdminBundle();
  const committed = readdirSync(PUBLIC_DIR).filter(
    (name) => /^bo(-styles)?-[0-9a-f]+\.(js|css)$/.test(name),
  );
  if (committed.length) {
    console.error(`admin-bundle --check: generated bundle files must not be committed:\n${committed.join('\n')}\nRemove them with: git rm -- <file>`);
    process.exitCode = 1;
    return;
  }
  console.log(`admin-bundle --check: no committed bundle, sources build (${built.jsName}, ${built.cssName}, ${built.order.length} modules).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
