import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFunction } from 'node:vm';
import { buildAdminBundle, renderHtml } from '../scripts/admin-bundle.js';
import { staticCacheControl } from '../apps/server/src/index.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount } from '../packages/app/src/admin-mount.js';

/**
 * Backoffice first paint (backlog:3f74a2f296ec): the shell used to load 30+
 * ES modules one by one (`app.js` importing `admin-*.js` in a cascade), so
 * the first `/bo` paint waited ~20 s on a cold connection. The shell now
 * ships one content-hashed bundle plus a branded loading splash: first
 * access is `index.html` (no-store) + 1 JS + 1 CSS, both immutable.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'apps/admin/public');

const publicFile = (name) => readFileSync(join(PUBLIC_DIR, name), 'utf8');

const scriptSrcs = (html) => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map((match) => match[1]);

test('the committed bundle matches the sources (build is fresh)', () => {
  const built = buildAdminBundle();
  const { indexHtml, loginHtml } = renderHtml(built);
  assert.equal(publicFile('index.html'), indexHtml, 'index.html names the current bundle');
  assert.equal(publicFile('login.html'), loginHtml, 'login.html names the current stylesheet');
  assert.equal(publicFile(built.jsName), built.jsBody, `${built.jsName} is current`);
  assert.equal(publicFile(built.cssName), built.cssSource, `${built.cssName} is current`);
  const stale = readdirSync(PUBLIC_DIR).filter(
    (name) => /^bo(-styles)?-[0-9a-f]+\.(js|css)$/.test(name) && name !== built.jsName && name !== built.cssName,
  );
  assert.deepEqual(stale, [], 'no stale hashed bundle files');
  assert.match(built.jsName, /^bo-[0-9a-f]{12}\.js$/, 'bundle name carries its content hash');
  assert.match(built.cssName, /^bo-styles-[0-9a-f]{12}\.css$/, 'stylesheet name carries its content hash');
  assert.ok(built.order.includes('app.js'), 'the entry is in the bundle');
  assert.ok(built.order.length > 30, `the cascade is gone from the wire (${built.order.length} modules bundled)`);
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

test('first access loads at most 3 JS files, all versioned', () => {
  const { indexHtml } = renderHtml(buildAdminBundle());
  const srcs = scriptSrcs(indexHtml);
  assert.ok(srcs.length >= 1 && srcs.length <= 3, `first access loads ${srcs.length} JS file(s), not 30+`);
  for (const src of srcs) {
    assert.match(src, /^bo-[0-9a-f]+\.js$/, `first-access script is versioned: ${src}`);
  }
  assert.ok(!indexHtml.includes('app.js'), 'the module cascade entry is not referenced');
  assert.ok(!/admin-[a-z-]+\.js/.test(indexHtml), 'no per-module script survives in the shell HTML');
});

test('the shell never serves a blank page: a branded splash paints before the bundle', () => {
  const { indexHtml } = renderHtml(buildAdminBundle());
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
  assert.equal(staticCacheControl('/'), 'no-store');
  assert.equal(staticCacheControl('/index.html'), 'no-store');
  assert.equal(staticCacheControl('/bo/'), 'no-store');
  assert.equal(staticCacheControl('/bo/index.html'), 'no-store');
  assert.equal(staticCacheControl('/bo/login.html'), 'no-store');
  assert.equal(staticCacheControl('/bo/bo-1f2165ae444e.js'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('/bo/bo-styles-af86892bbdd2.css'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('/bo/app.js'), 'no-cache');
  assert.equal(staticCacheControl('/bo/styles.css'), 'no-cache');
  assert.equal(staticCacheControl('/bo/login.js'), 'no-cache');
});

test('served /bo answers carry the cache policy, the splash and one script', async () => {
  const built = buildAdminBundle();
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
