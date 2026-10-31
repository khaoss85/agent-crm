import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction, runInNewContext } from 'node:vm';
import {
  adminBundleWiring,
  buildAdminBundle,
  getAdminBundle,
  resetAdminBundleCache,
} from '../apps/server/src/admin-bundle.js';
import { readStaticFile, staticCacheControl } from '../apps/server/src/index.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount } from '../packages/app/src/admin-mount.js';

/**
 * Backoffice first paint (backlog:3f74a2f296ec): the shell used to load 30+
 * ES modules one by one (`app.js` importing `admin-*.js` in a cascade), so
 * the first `/bo` paint waited ~20 s on a cold connection. The server now
 * generates one content-hashed bundle at serve time and keeps it in memory:
 * first access is `index.html` (no-store) + 1 JS + 1 CSS, both immutable.
 * Only the sources live in git — a checked-in bundle would go stale on
 * every merge to main with many design PRs in parallel.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'apps/admin/public');

const publicFile = (name) => readFileSync(join(PUBLIC_DIR, name), 'utf8');

const scriptSrcs = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((match) => match[1]);

test('the bundle is generated at serve time, never committed', () => {
  const generated = readdirSync(PUBLIC_DIR).filter(
    (name) => /^bo(-styles)?-[0-9a-f]+\.(js|css)$/.test(name),
  );
  assert.deepEqual(generated, [], 'no generated bundle files on disk');
  assert.match(publicFile('index.html'), /<script\s+type="module"\s+src="app\.js"><\/script>/, 'index.html names the source entry');
  assert.match(publicFile('index.html'), /<link\s+rel="stylesheet"\s+href="styles\.css"\s*\/>/, 'index.html names the source stylesheet');
  resetAdminBundleCache();
  const bundle = getAdminBundle(PUBLIC_DIR);
  assert.match(bundle.jsName, /^bo-[0-9a-f]{12}\.js$/, 'bundle name carries its content hash');
  assert.match(bundle.cssName, /^bo-styles-[0-9a-f]{12}\.css$/, 'stylesheet name carries its content hash');
  assert.ok(bundle.order.includes('app.js'), 'the entry is in the bundle');
  assert.ok(bundle.order.length > 30, `the cascade is gone from the wire (${bundle.order.length} modules bundled)`);
  assert.equal(getAdminBundle(PUBLIC_DIR), bundle, 'the build is cached in memory, rebuilt never per request');
});

test('the bundle is one self-contained scope with no surviving module syntax', () => {
  const built = buildAdminBundle();
  assert.doesNotThrow(() => compileFunction(built.jsBody, [], {}), 'the bundle parses as code');
  assert.ok(!built.jsBody.includes("from './"), 'no local import survives bundling');
  assert.ok(!/^import /m.test(built.jsBody), 'no import statement survives bundling');
  assert.ok(!/^export /m.test(built.jsBody), 'no export statement survives bundling');
  const sections = built.jsBody.match(/\(bundled, do not edit\)/g) ?? [];
  assert.equal(sections.length, built.order.length, 'every bundled module keeps its section marker');
});

test('every bundled import resolves to a provided export (no undefined at load)', () => {
  const wiring = adminBundleWiring();
  assert.ok(wiring.length > 30, `the cascade is wired (${wiring.length} modules)`);
  const providedBy = new Map(wiring.map((mod) => [mod.file, new Set(mod.provided)]));
  for (const mod of wiring) {
    for (const req of mod.required) {
      assert.ok(providedBy.has(req.from), `${mod.file} imports from unknown module ./${req.from}`);
      assert.ok(
        providedBy.get(req.from).has(req.exported),
        `${mod.file} imports ${req.exported} from ./${req.from}, which does not provide it (stale splash follows)`,
      );
    }
  }
});

/**
 * The bundle executes, not just parses: every library module runs in load
 * order and every provided binding is defined. Regression guard for the
 * review finding where declaration exports (`export const …`) were stripped
 * without registering them, so `CONNECTOR_DETAIL_CHANNELS` threw a
 * `TypeError` on `CONNECTOR_CATALOG.map` and the shell stuck on the splash.
 * The entry (`app.js`) is excluded: it boots the shell (DOM + network) and
 * is covered by the mount test and the CI browser shots.
 */
test('the bundle executes: every provided binding is defined, the catalog maps', () => {
  resetAdminBundleCache();
  const built = buildAdminBundle(PUBLIC_DIR);
  const marker = '/* ---- app.js (bundled, do not edit) ---- */';
  const cutAt = built.jsBody.indexOf(marker);
  assert.ok(cutAt !== -1, 'the entry section is marked');
  const universal = () => {
    const fn = () => universal();
    return new Proxy(fn, {
      get: () => universal(),
      set: () => true,
      apply: () => universal(),
      construct: () => universal(),
    });
  };
  const sandbox = {
    console,
    document: universal(),
    window: universal(),
    navigator: universal(),
    location: { hash: '', href: 'http://localhost/bo/', pathname: '/bo/' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    fetch: () => new Promise(() => {}),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Object,
    Array,
    JSON,
    Math,
    Reflect,
    Proxy,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    RegExp,
    Date,
    Number,
    String,
    Boolean,
    BigInt,
    Symbol,
    Intl,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    CustomEvent: class {},
    EventTarget: class {},
    FormData: class {},
    Blob: class {},
    File: class {},
    crypto: { randomUUID: () => 'stub-uuid', getRandomValues: (a) => a },
  };
  sandbox.globalThis = sandbox;
  const registry = runInNewContext(`${built.jsBody.slice(0, cutAt)}\n__bo;`, sandbox, { timeout: 15000 });
  const wiring = new Map(adminBundleWiring().map((mod) => [mod.file, mod]));
  for (const file of built.order) {
    if (file === 'app.js') continue;
    const ns = registry[`./${file}`];
    assert.ok(ns && typeof ns === 'object', `${file} registers its namespace`);
    for (const name of wiring.get(file)?.provided ?? []) {
      assert.notEqual(ns[name], undefined, `${file} provides a defined ${name} (otherwise the splash sticks)`);
    }
  }
  assert.ok(
    Array.isArray(registry['./admin-connectors.js'].CONNECTOR_CATALOG),
    'the catalog loads as an array',
  );
  assert.ok(
    Array.isArray(registry['./admin-connector-detail.js'].CONNECTOR_DETAIL_CHANNELS),
    'the detail channels map the catalog at load instead of throwing TypeError',
  );
});

test('first access loads at most 3 JS files, all versioned', async () => {
  resetAdminBundleCache();
  const found = await readStaticFile(PUBLIC_DIR, '/index.html');
  assert.ok(found, 'the entry is served');
  const srcs = scriptSrcs(found.data.toString('utf8'));
  assert.ok(srcs.length >= 1 && srcs.length <= 3, `first access loads ${srcs.length} JS file(s), not 30+`);
  for (const src of srcs) {
    assert.match(src, /^bo-[0-9a-f]+\.js$/, `first-access script is versioned: ${src}`);
  }
  assert.ok(!found.data.toString('utf8').includes('app.js'), 'the module cascade entry is not referenced');
  assert.ok(!/admin-[a-z-]+\.js/.test(found.data.toString('utf8')), 'no per-module script survives in the shell HTML');
});

test('the shell never serves a blank page: a branded splash paints before the bundle', async () => {
  resetAdminBundleCache();
  const found = await readStaticFile(PUBLIC_DIR, '/');
  const indexHtml = found.data.toString('utf8');
  assert.match(indexHtml, /id="bo-splash"/, 'the splash element ships in the served HTML');
  assert.match(indexHtml, /Accordo/, 'the splash carries the brand');
  assert.match(indexHtml, /Caricamento/, 'the splash says it is loading, in Italian');
  const splashAt = indexHtml.indexOf('id="bo-splash"');
  const shellAt = indexHtml.indexOf('class="bo-shell"');
  assert.ok(splashAt !== -1 && splashAt < shellAt, 'the splash precedes the (initially empty) shell');
  const appSource = publicFile('app.js');
  assert.match(
    appSource,
    /getElementById\('bo-splash'\)\?\.remove\(\)/,
    'the shell dismisses the splash on first paint',
  );
});

test('staticCacheControl: hashed bundles immutable, HTML no-store, rest unchanged', () => {
  resetAdminBundleCache();
  const built = getAdminBundle(PUBLIC_DIR);
  assert.equal(staticCacheControl('/'), 'no-store');
  assert.equal(staticCacheControl('/index.html'), 'no-store');
  assert.equal(staticCacheControl('/bo/'), 'no-store');
  assert.equal(staticCacheControl('/bo/index.html'), 'no-store');
  assert.equal(staticCacheControl('/bo/login.html'), 'no-store');
  assert.equal(staticCacheControl(`/bo/${built.jsName}`), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl(`/bo/${built.cssName}`), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('/bo/app.js'), 'no-cache');
  assert.equal(staticCacheControl('/bo/styles.css'), 'no-cache');
  assert.equal(staticCacheControl('/bo/login.js'), 'no-cache');
});

test('served /bo answers carry the cache policy, the splash and one script', async () => {
  resetAdminBundleCache();
  const built = getAdminBundle(PUBLIC_DIR);
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const page = await mount.handle({ method: 'GET', path: '/bo/', headers: {} });
    assert.equal(page.status, 200);
    assert.equal(page.headers['cache-control'], 'no-store');
    const html = page.body.toString('utf8');
    assert.ok(html.includes('id="bo-splash"'), 'the mounted shell keeps the splash');
    assert.deepEqual(scriptSrcs(html), [built.jsName], 'the mounted shell loads exactly the bundle');
    const bundle = await mount.handle({ method: 'GET', path: `/bo/${built.jsName}`, headers: {} });
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(bundle.body.toString('utf8'), built.jsBody, 'the bundle bytes are the in-memory build');
    const css = await mount.handle({ method: 'GET', path: `/bo/${built.cssName}`, headers: {} });
    assert.equal(css.status, 200);
    assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable');
    const login = await mount.handle({ method: 'GET', path: '/bo/login.html', headers: {} });
    assert.equal(login.status, 200);
    assert.equal(login.headers['cache-control'], 'no-store');
  } finally {
    app.close();
  }
});

test('a hashed name from a previous deploy is a 404, not a stale bundle', async () => {
  resetAdminBundleCache();
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const stale = await mount.handle({ method: 'GET', path: '/bo/bo-000000000000.js', headers: {} });
    assert.equal(stale.status, 404);
    const staleCss = await mount.handle({ method: 'GET', path: '/bo/bo-styles-000000000000.css', headers: {} });
    assert.equal(staleCss.status, 404);
  } finally {
    app.close();
  }
});
