import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resetAdminBundleCache,
  getAdminBundle,
  bundleVersion,
} from '../apps/server/src/admin-bundle.js';
import { readStaticFile, staticCacheControl } from '../apps/server/src/index.js';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount } from '../packages/app/src/admin-mount.js';
import {
  BO_UPDATE_NOTICE,
  BO_UPDATE_UNSAVED_NOTICE,
  BO_VERSION_POLL_MS,
  checkBundleVersion,
  currentBundleName,
  currentStyleName,
  ensureUpdateBanner,
  hasUnsavedWork,
  isUpdateAvailable,
  markUnsaved,
  clearUnsaved,
  parseVersionPayload,
  resetVersionWatchState,
  startBundleWatch,
} from '../apps/admin/public/admin-version.js';

/**
 * Bundle-update notice (backlog:49bd3657b0f8): after a release an open tab
 * still runs the old bundle in memory, so the server exposes the served
 * bundle identity and the shell polls it — always showing a persistent
 * notice the operator confirms, never reloading on its own.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'apps/admin/public');

const fakeScript = (src) => ({ getAttribute: (name) => (name === 'src' ? src : null) });
const fakeLink = (href) => ({ getAttribute: (name) => (name === 'href' ? href : null) });
const fakeDoc = ({ scripts = [], links = [], fields = [], banner = null, existing = [] } = {}) => {
  const state = { appended: [], banner, insertedFirst: false };
  const children = [...existing];
  return {
    querySelectorAll: (selector) => {
      if (String(selector).includes('script')) return scripts;
      if (String(selector).includes('link')) return links;
      return fields;
    },
    getElementById: () => state.banner,
    createElement: () => {
      const listeners = {};
      return {
        setAttribute: () => {},
        addEventListener: (event, fn) => {
          listeners[event] = fn;
        },
        click: () => listeners.click?.(),
        _listeners: listeners,
        textContent: '',
      };
    },
    body: {
      get firstChild() {
        return children[0] ?? null;
      },
      appendChild: (el) => {
        children.push(el);
        state.appended.push(el);
        state.banner = el;
        return el;
      },
      insertBefore: (el, ref) => {
        const at = children.indexOf(ref);
        if (at === -1) {
          children.push(el);
        } else {
          children.splice(at, 0, el);
          if (at === 0) state.insertedFirst = true;
        }
        state.appended.push(el);
        state.banner = el;
        return el;
      },
      prepend: (el) => {
        children.unshift(el);
        state.appended.push(el);
        state.banner = el;
        state.insertedFirst = true;
        return el;
      },
    },
    _state: state,
    _children: children,
  };
};
const fakeField = ({ tag = 'TEXTAREA', value = '', type = null, disabled = false } = {}) => ({
  tagName: tag,
  value,
  disabled,
  getAttribute: (name) => (name === 'type' ? type : null),
});
const DEFAULT_CSS = 'bo-styles-000000000000.css';
const okFetch = (jsName, cssName = DEFAULT_CSS) => async (url, options) => ({
  url,
  options,
  ok: true,
  text: async () => JSON.stringify({ jsName, cssName }),
});

test('bundleVersion names the same in-memory build the entry HTML serves', async () => {
  resetAdminBundleCache();
  const version = bundleVersion(PUBLIC_DIR);
  const built = getAdminBundle(PUBLIC_DIR);
  assert.equal(version.jsName, built.jsName);
  assert.equal(version.cssName, built.cssName);
  const found = await readStaticFile(PUBLIC_DIR, '/index.html');
  assert.ok(found.data.toString('utf8').includes(version.jsName), 'the entry and the identity never disagree');
});

test('readStaticFile serves /version.json as JSON, never from disk', async () => {
  resetAdminBundleCache();
  const found = await readStaticFile(PUBLIC_DIR, '/version.json');
  assert.ok(found, 'the identity is served');
  assert.equal(found.contentType, 'application/json; charset=utf-8');
  const parsed = parseVersionPayload(found.data.toString('utf8'));
  assert.ok(parsed, 'the served body parses as a bundle identity');
  assert.equal(parsed.jsName, bundleVersion(PUBLIC_DIR).jsName);
  assert.equal(parsed.cssName, bundleVersion(PUBLIC_DIR).cssName);
});

test('staticCacheControl: /version.json is no-store, like the entries', () => {
  assert.equal(staticCacheControl('/version.json'), 'no-store');
  assert.equal(staticCacheControl('/bo/version.json'), 'no-store');
});

test('the mount serves /bo/version.json with no-store, without a profile', async () => {
  resetAdminBundleCache();
  const built = getAdminBundle(PUBLIC_DIR);
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const answer = await mount.handle({ method: 'GET', path: '/bo/version.json', headers: {} });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
    const served = parseVersionPayload(answer.body.toString('utf8'));
    assert.equal(served.jsName, built.jsName);
    assert.equal(served.cssName, built.cssName);
  } finally {
    app.close();
  }
});

test('parseVersionPayload reads only a shaped bundle identity', () => {
  assert.deepEqual(
    parseVersionPayload(JSON.stringify({ jsName: 'bo-abcdef123456.js', cssName: 'bo-styles-123456abcdef.css' })),
    { jsName: 'bo-abcdef123456.js', cssName: 'bo-styles-123456abcdef.css' },
  );
  assert.equal(parseVersionPayload(''), null);
  assert.equal(parseVersionPayload('not json'), null);
  assert.equal(parseVersionPayload(JSON.stringify({ jsName: 'app.js', cssName: 'bo-styles-123456abcdef.css' })), null);
  assert.equal(parseVersionPayload(JSON.stringify({ jsName: 'bo-abcdef123456.js', cssName: 'styles.css' })), null);
  assert.equal(parseVersionPayload(JSON.stringify({ jsName: 'bo-abcdef123456.js' })), null, 'a missing cssName is unknown, never an update');
  assert.equal(parseVersionPayload(JSON.stringify({})), null);
  assert.equal(parseVersionPayload(JSON.stringify([])), null);
  assert.equal(parseVersionPayload(null), null);
});

test('currentBundleName reads the hashed script, never the sources', () => {
  assert.equal(currentBundleName(fakeDoc({ scripts: [fakeScript('app.js')] })), null);
  assert.equal(currentBundleName(fakeDoc({ scripts: [] })), null);
  assert.equal(
    currentBundleName(fakeDoc({ scripts: [fakeScript('app.js'), fakeScript('/bo/bo-abcdef123456.js?v=2#/x')] })),
    'bo-abcdef123456.js',
  );
});

test('currentStyleName reads the hashed stylesheet, never the source', () => {
  assert.equal(currentStyleName(fakeDoc({ links: [] })), null);
  assert.equal(currentStyleName(fakeDoc({ links: [fakeLink('styles.css')] })), null);
  assert.equal(
    currentStyleName(fakeDoc({ links: [fakeLink('styles.css'), fakeLink('/bo/bo-styles-abcdef123456.css?v=3')] })),
    'bo-styles-abcdef123456.css',
  );
});

test('isUpdateAvailable compares names, unknown never mandates a notice', () => {
  assert.equal(isUpdateAvailable('bo-aaaa000000.js', { jsName: 'bo-aaaa000000.js' }), false);
  assert.equal(isUpdateAvailable('bo-aaaa000000.js', { jsName: 'bo-bbbb111111.js' }), true);
  assert.equal(isUpdateAvailable(null, { jsName: 'bo-bbbb111111.js' }), false);
  assert.equal(isUpdateAvailable('bo-aaaa000000.js', null), false);
  assert.equal(
    isUpdateAvailable(
      { jsName: 'bo-aaaa000000.js', cssName: 'bo-styles-000000000000.css' },
      { jsName: 'bo-aaaa000000.js', cssName: 'bo-styles-000000000000.css' },
    ),
    false,
  );
  assert.equal(
    isUpdateAvailable(
      { jsName: 'bo-aaaa000000.js', cssName: 'bo-styles-000000000000.css' },
      { jsName: 'bo-aaaa000000.js', cssName: 'bo-styles-111111111111.css' },
    ),
    true,
    'a CSS-only release shows the notice',
  );
  assert.equal(
    isUpdateAvailable(
      { jsName: 'bo-aaaa000000.js', cssName: null },
      { jsName: 'bo-aaaa000000.js', cssName: 'bo-styles-111111111111.css' },
    ),
    false,
    'unknown stylesheet never mandates a notice',
  );
});

test('hasUnsavedWork leans dirty: text counts, controls do not', () => {
  resetVersionWatchState();
  assert.equal(hasUnsavedWork(fakeDoc()), false);
  assert.equal(hasUnsavedWork(fakeDoc({ fields: [fakeField({ value: '' })] })), false);
  assert.equal(hasUnsavedWork(fakeDoc({ fields: [fakeField({ value: 'nota da salvare' })] })), true);
  assert.equal(
    hasUnsavedWork(fakeDoc({ fields: [fakeField({ tag: 'INPUT', type: 'text', value: 'dettaglio' })] })),
    true,
  );
  assert.equal(
    hasUnsavedWork(fakeDoc({ fields: [fakeField({ tag: 'INPUT', type: 'checkbox', value: 'on' })] })),
    false,
  );
  assert.equal(
    hasUnsavedWork(fakeDoc({ fields: [fakeField({ tag: 'INPUT', type: 'hidden', value: 'x' })] })),
    false,
  );
  assert.equal(
    hasUnsavedWork(fakeDoc({ fields: [fakeField({ value: 'bozza', disabled: true })] })),
    true,
  );
  markUnsaved('composer');
  assert.equal(hasUnsavedWork(fakeDoc()), true);
  clearUnsaved('composer');
  assert.equal(hasUnsavedWork(fakeDoc()), false);
});

test('ensureUpdateBanner shows the exact notice once, text only', () => {
  resetVersionWatchState();
  let updated = 0;
  const doc = fakeDoc();
  const first = ensureUpdateBanner(doc, { onUpdate: () => { updated++; } });
  assert.ok(first, 'the banner is created');
  assert.equal(first.textContent, BO_UPDATE_NOTICE);
  assert.equal(doc._state.appended.length, 1);
  const second = ensureUpdateBanner(doc, { onUpdate: () => { updated++; } });
  assert.equal(second, first, 'no second banner');
  assert.equal(doc._state.appended.length, 1);
  first.click();
  assert.equal(updated, 1);
});

test('0d4c5c44: the notice joins the flow first, never over the navigation', () => {
  resetVersionWatchState();
  const sidebar = { id: 'boSidebar' };
  const doc = fakeDoc({ existing: [sidebar] });
  const banner = ensureUpdateBanner(doc);
  assert.ok(banner, 'the banner is created');
  assert.equal(doc._children[0], banner, 'first child: it pushes the shell down');
  assert.equal(doc._children[1], sidebar, 'the sidebar follows the banner');
  assert.equal(doc._state.insertedFirst, true);
  assert.equal(doc._state.appended.length, 1, 'still a single banner');
});

test('0d4c5c44: the banner shows even where prepend is missing', () => {
  resetVersionWatchState();
  const doc = fakeDoc({ existing: [{ id: 'boSidebar' }] });
  delete doc.body.insertBefore;
  delete doc.body.prepend;
  const banner = ensureUpdateBanner(doc);
  assert.ok(banner, 'the banner falls back to append');
  assert.equal(doc._state.appended.length, 1);
  assert.equal(banner.textContent, BO_UPDATE_NOTICE);
});

test('0d4c5c44: the banner style is in-flow, never a fixed overlay', () => {
  const css = readFileSync(join(PUBLIC_DIR, 'styles.css'), 'utf8');
  const rule = css.match(/\.bo-update-banner\s*\{[^}]*\}/);
  assert.ok(rule, 'the banner rule exists');
  assert.ok(!/position\s*:\s*fixed/.test(rule[0]), 'no fixed overlay over sidebar and topbar');
  assert.ok(/position\s*:\s*static/.test(rule[0]), 'in-flow: it pushes the shell down at 1440 and 390');
});

test('checkBundleVersion never reloads on its own: clean or dirty, only the notice', async () => {
  resetVersionWatchState();
  const current = 'bo-aaaa000000.js';
  const served = 'bo-bbbb111111.js';
  const cleanDoc = fakeDoc({ scripts: [fakeScript(`/bo/${current}`)] });
  let reloaded = 0;
  const clean = await checkBundleVersion({
    adminBase: '/bo',
    doc: cleanDoc,
    fetchImpl: okFetch(served),
    reload: () => { reloaded++; },
  });
  assert.equal(clean, 'deferred');
  assert.equal(reloaded, 0, 'a clean screen waits for the operator too');
  assert.equal(cleanDoc._state.banner.textContent, BO_UPDATE_NOTICE);
  cleanDoc._state.banner.click();
  assert.equal(reloaded, 1, 'the operator confirms the waiting update');

  resetVersionWatchState();
  const dirtyDoc = fakeDoc({
    scripts: [fakeScript(`/bo/${current}`)],
    fields: [fakeField({ value: 'nota non salvata' })],
  });
  let dirtyReloads = 0;
  const deferred = await checkBundleVersion({
    adminBase: '/bo',
    doc: dirtyDoc,
    fetchImpl: okFetch(served),
    reload: () => { dirtyReloads++; },
  });
  assert.equal(deferred, 'deferred');
  assert.equal(dirtyReloads, 0);
  assert.equal(dirtyDoc._state.banner.textContent, BO_UPDATE_NOTICE);
  // 49bd3657: with text unsent the first press only warns in Italian, the
  // second press reloads — a reload never takes a draft by surprise.
  dirtyDoc._state.banner.click();
  assert.equal(dirtyReloads, 0, 'the first press with unsent text never reloads');
  assert.equal(dirtyDoc._state.banner.textContent, BO_UPDATE_UNSAVED_NOTICE);
  dirtyDoc._state.banner.click();
  assert.equal(dirtyReloads, 1, 'the second press confirms the reload');
});

test('49bd3657: the notice speaks Italian and offers Ricarica', () => {
  assert.equal(BO_UPDATE_NOTICE, 'È disponibile una nuova versione · Ricarica');
  assert.ok(/salvalo/.test(BO_UPDATE_UNSAVED_NOTICE) && /ricaricare/.test(BO_UPDATE_UNSAVED_NOTICE));
  for (const text of [BO_UPDATE_NOTICE, BO_UPDATE_UNSAVED_NOTICE]) {
    assert.ok(!/\b(update|reload|new version|refresh)\b/i.test(text), `no English: ${text}`);
  }
});

test('a CSS-only release shows the notice', async () => {
  resetVersionWatchState();
  const current = 'bo-aaaa000000.js';
  const sameJs = 'bo-aaaa000000.js';
  const newCss = 'bo-styles-111111111111.css';
  const doc = fakeDoc({
    scripts: [fakeScript(`/bo/${current}`)],
    links: [fakeLink(`/bo/${DEFAULT_CSS}`)],
  });
  let reloaded = 0;
  const outcome = await checkBundleVersion({
    adminBase: '/bo',
    doc,
    fetchImpl: okFetch(sameJs, newCss),
    reload: () => { reloaded++; },
  });
  assert.equal(outcome, 'deferred');
  assert.equal(reloaded, 0);
  assert.equal(doc._state.banner.textContent, BO_UPDATE_NOTICE);
});

test('a save in flight waits behind the notice: a disabled populated field', async () => {
  resetVersionWatchState();
  try {
    const current = 'bo-aaaa000000.js';
    const served = 'bo-bbbb111111.js';
    const busyDoc = fakeDoc({
      scripts: [fakeScript(`/bo/${current}`)],
      fields: [fakeField({ tag: 'INPUT', type: 'text', value: 'nota in volo', disabled: true })],
    });
    let reloaded = 0;
    const outcome = await checkBundleVersion({
      adminBase: '/bo',
      doc: busyDoc,
      fetchImpl: okFetch(served),
      reload: () => { reloaded++; },
    });
    assert.equal(outcome, 'deferred');
    assert.equal(reloaded, 0);
    assert.equal(busyDoc._state.banner.textContent, BO_UPDATE_NOTICE);
  } finally {
    resetVersionWatchState();
  }
});

test('checkBundleVersion stays silent on unknown, same and failed reads', async () => {
  resetVersionWatchState();
  let calls = 0;
  const counting = (jsName) => async (url, options) => {
    calls++;
    return okFetch(jsName)(url, options);
  };
  const noBundle = fakeDoc({ fields: [fakeField({ value: 'testo' })] });
  assert.equal(
    await checkBundleVersion({ adminBase: '/bo', doc: noBundle, fetchImpl: counting('bo-eeee000002.js') }),
    'unknown',
  );
  assert.equal(calls, 0, 'nothing to compare, nothing fetched');

  const sameDoc = fakeDoc({ scripts: [fakeScript('/bo/bo-cccc000000.js')] });
  let reloaded = 0;
  assert.equal(
    await checkBundleVersion({ adminBase: '/bo', doc: sameDoc, fetchImpl: counting('bo-cccc000000.js'), reload: () => { reloaded++; } }),
    'current',
  );
  assert.equal(reloaded, 0);
  assert.equal(sameDoc._state.appended.length, 0, 'no notice when current');

  const failingDoc = fakeDoc({ scripts: [fakeScript('/bo/bo-dddd000001.js')] });
  assert.equal(
    await checkBundleVersion({ adminBase: '/bo', doc: failingDoc, fetchImpl: async () => { throw new Error('down'); } }),
    'failed',
  );
  assert.equal(
    await checkBundleVersion({ adminBase: '/bo', doc: failingDoc, fetchImpl: async () => ({ ok: false }) }),
    'failed',
  );
  assert.equal(
    await checkBundleVersion({ adminBase: '/bo', doc: failingDoc, fetchImpl: async () => ({ ok: true, text: async () => 'garbage' }) }),
    'failed',
  );
  assert.equal(failingDoc._state.appended.length, 0, 'a failed read never shows a notice');
  assert.equal(reloaded, 0);
});

test('startBundleWatch checks now and on navigation, and stops', async () => {
  resetVersionWatchState();
  let fetches = 0;
  const listeners = {};
  const win = {
    addEventListener: (event, fn) => { listeners[event] = fn; },
    removeEventListener: (event) => { delete listeners[event]; },
  };
  const doc = fakeDoc({ scripts: [fakeScript('/bo/bo-cccc000000.js')] });
  const stop = startBundleWatch({
    adminBase: '/bo',
    doc,
    win,
    pollMs: BO_VERSION_POLL_MS,
    fetchImpl: async () => { fetches++; return okFetch('bo-cccc000000.js')(); },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetches, 1, 'the watch checks on start');
  assert.ok(typeof listeners.hashchange === 'function', 'the watch follows navigation');
  listeners.hashchange();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetches, 2, 'a navigation rechecks');
  stop();
  assert.equal(listeners.hashchange, undefined, 'stopping removes the navigation hook');
});
