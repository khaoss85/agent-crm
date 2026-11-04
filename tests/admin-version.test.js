import test from 'node:test';
import assert from 'node:assert/strict';
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
  BO_VERSION_POLL_MS,
  checkBundleVersion,
  currentBundleName,
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
 * bundle identity and the shell polls it — reloading when nothing is
 * unsaved, waiting behind a persistent notice when text is on screen.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(root, 'apps/admin/public');

const fakeScript = (src) => ({ getAttribute: (name) => (name === 'src' ? src : null) });
const fakeDoc = ({ scripts = [], fields = [], banner = null } = {}) => {
  const state = { appended: [], banner };
  return {
    querySelectorAll: (selector) => {
      if (String(selector).includes('script')) return scripts;
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
      appendChild: (el) => {
        state.appended.push(el);
        state.banner = el;
        return el;
      },
    },
    _state: state,
  };
};
const fakeField = ({ tag = 'TEXTAREA', value = '', type = null, disabled = false } = {}) => ({
  tagName: tag,
  value,
  disabled,
  getAttribute: (name) => (name === 'type' ? type : null),
});
const okFetch = (jsName) => async (url, options) => ({
  url,
  options,
  ok: true,
  text: async () => JSON.stringify({ jsName, cssName: 'bo-styles-000000000000.css' }),
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
    assert.equal(parseVersionPayload(answer.body.toString('utf8')).jsName, built.jsName);
  } finally {
    app.close();
  }
});

test('parseVersionPayload reads only a shaped bundle identity', () => {
  assert.deepEqual(parseVersionPayload(JSON.stringify({ jsName: 'bo-abcdef123456.js' })), { jsName: 'bo-abcdef123456.js' });
  assert.equal(parseVersionPayload(''), null);
  assert.equal(parseVersionPayload('not json'), null);
  assert.equal(parseVersionPayload(JSON.stringify({ jsName: 'app.js' })), null);
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

test('isUpdateAvailable compares names, unknown never mandates a reload', () => {
  assert.equal(isUpdateAvailable('bo-aaaa.js', { jsName: 'bo-aaaa.js' }), false);
  assert.equal(isUpdateAvailable('bo-aaaa.js', { jsName: 'bo-bbbb123456.js' }), true);
  assert.equal(isUpdateAvailable(null, { jsName: 'bo-bbbb123456.js' }), false);
  assert.equal(isUpdateAvailable('bo-aaaa.js', null), false);
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
    false,
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

test('checkBundleVersion reloads when clean, waits when text is on screen', async () => {
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
  assert.equal(clean, 'reloaded');
  assert.equal(reloaded, 1);

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
  dirtyDoc._state.banner.click();
  assert.equal(dirtyReloads, 1, 'the operator confirms the waiting reload');
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
