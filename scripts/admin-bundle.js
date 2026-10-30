// @ts-check
/**
 * Backoffice bundle build (backlog:3f74a2f296ec).
 *
 * The shell in `apps/admin/public` used to load 30+ ES modules one by one
 * (`app.js` importing `admin-*.js` in a cascade): on a cold connection the
 * first paint of `/bo` waited for every round trip. This script bundles the
 * whole `app.js` graph into ONE versioned file (`bo-<sha12>.js`) plus a
 * versioned copy of the stylesheet (`bo-styles-<sha12>.css`), and points
 * `index.html` (and the `login.html` stylesheet link) at them. First access
 * is then: `index.html` (no-store) + 1 JS + 1 CSS.
 *
 * No bundler dependency on purpose: the graph uses only static named
 * `import { … } from './x.js'` / `export …` forms (asserted below, fail
 * closed), so each module is wrapped in its own scope and wired through a
 * registry — no identifier rewriting, no cross-file collisions.
 *
 *   node scripts/admin-bundle.js          # write bundle + rewrite html
 *   node scripts/admin-bundle.js --check   # read-only: fail if stale
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(root, 'apps/admin/public');
const ENTRY = 'app.js';
const HASH_LEN = 12;

const LOCAL_IMPORT = /import\s+([^;]*?)\s+from\s*['"](\.[^'"]*)['"]\s*;/gs;
const EXPORT_PREFIX = /^export\s+(?=(?:async\s+)?function\b|class\b|(?:const|let|var)\b)/gm;
const EXPORT_LIST = /^\s*export\s*\{([^}]*)\}\s*;?\s*$/gm;
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
 * Build the bundle in memory. Pure (no writes): tests and --check share it.
 */
export function buildAdminBundle() {
  const files = localModules(PUBLIC_DIR);
  if (!files.has(ENTRY)) throw new Error('admin-bundle: app.js entry is missing');
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const name of files) sources.set(name, readFileSync(join(PUBLIC_DIR, name), 'utf8'));
  const order = topoOrder(ENTRY, sources);
  const sections = order.map((file) => {
    const { body, prelude, epilogue } = transformModule(file, /** @type {string} */ (sources.get(file)));
    return `/* ---- ${file} (bundled, do not edit) ---- */\n__bo[${JSON.stringify('./' + file)}] = (() => {\n${prelude}${prelude ? '\n' : ''}${body}${epilogue}\n})();`;
  });
  const jsBody = `/* Accordo backoffice bundle. Generated by scripts/admin-bundle.js — do not edit.\n * Sources: ${order.join(', ')}. */\nconst __bo = Object.create(null);\n${sections.join('\n\n')}\n`;
  const jsHash = createHash('sha256').update(jsBody).digest('hex').slice(0, HASH_LEN);
  const jsName = `bo-${jsHash}.js`;
  const cssSource = readFileSync(join(PUBLIC_DIR, 'styles.css'), 'utf8');
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
 * @param {{ order: string[], jsBody: string, jsName: string, cssSource: string, cssName: string }} built
 */
export function renderHtml(built) {
  const scriptPattern = /<script\s+type="module"\s+src="(?:app|bo-[0-9a-f]+)\.js"><\/script>/;
  const stylePattern = /<link\s+rel="stylesheet"\s+href="(?:styles|bo-styles-[0-9a-f]+)\.css"\s*\/>/;
  const indexSource = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const indexHtml = replaceOnce(
    replaceOnce(indexSource, scriptPattern, `<script type="module" src="${built.jsName}"></script>`, 'shell script tag'),
    stylePattern,
    `<link rel="stylesheet" href="${built.cssName}" />`,
    'shell stylesheet link',
  );
  const loginSource = readFileSync(join(PUBLIC_DIR, 'login.html'), 'utf8');
  const loginHtml = replaceOnce(loginSource, stylePattern, `<link rel="stylesheet" href="${built.cssName}" />`, 'login stylesheet link');
  return { indexHtml, loginHtml };
}

function pruneStale(keep) {
  for (const name of readdirSync(PUBLIC_DIR)) {
    if (/^bo(-styles)?-[0-9a-f]+\.(js|css)$/.test(name) && !keep.has(name)) {
      rmSync(join(PUBLIC_DIR, name));
    }
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const built = buildAdminBundle();
  const { indexHtml, loginHtml } = renderHtml(built);
  const expected = new Map([
    [join(PUBLIC_DIR, built.jsName), built.jsBody],
    [join(PUBLIC_DIR, built.cssName), built.cssSource],
    [join(PUBLIC_DIR, 'index.html'), indexHtml],
    [join(PUBLIC_DIR, 'login.html'), loginHtml],
  ]);
  if (checkOnly) {
    const stale = [];
    for (const [path, content] of expected) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content) stale.push(path);
    }
    for (const name of readdirSync(PUBLIC_DIR)) {
      if (/^bo(-styles)?-[0-9a-f]+\.(js|css)$/.test(name) && ![built.jsName, built.cssName].includes(name)) {
        stale.push(join(PUBLIC_DIR, name));
      }
    }
    if (stale.length) {
      console.error(`admin-bundle --check: stale generated files:\n${stale.join('\n')}\nRun: node scripts/admin-bundle.js`);
      process.exitCode = 1;
    } else {
      console.log(`admin-bundle --check: fresh (${built.jsName}, ${built.cssName}, ${built.order.length} modules).`);
    }
    return;
  }
  mkdirSync(PUBLIC_DIR, { recursive: true });
  writeFileSync(join(PUBLIC_DIR, built.jsName), built.jsBody);
  writeFileSync(join(PUBLIC_DIR, built.cssName), built.cssSource);
  writeFileSync(join(PUBLIC_DIR, 'index.html'), indexHtml);
  writeFileSync(join(PUBLIC_DIR, 'login.html'), loginHtml);
  pruneStale(new Set([built.jsName, built.cssName]));
  console.log(`admin-bundle: ${built.jsName} + ${built.cssName} from ${built.order.length} modules.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
