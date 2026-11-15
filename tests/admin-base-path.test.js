import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalShellPath } from '../apps/admin/public/admin-base.js';

/**
 * Every /bo in-page link (pilota 12/11): the mount serves the shell at
 * `/w/<space>/bo` with `<base href="/w/<space>/bo/">`, so each `#/…` link
 * resolved to another path and reloaded the whole app. At boot the address
 * settles on the base path with the same query and hash, once, with
 * history.replaceState — the console «Apri CRM» arrival, the login return
 * and a pasted deep link keep their page and never load twice.
 */

const BASE = '/w/2f07eeb9/bo/';

test('a slashless shell address settles on the base path, keeping query and hash', () => {
  assert.equal(canonicalShellPath({ pathname: '/w/2f07eeb9/bo', search: '', hash: '#/offerte/off-1' }, BASE), '/w/2f07eeb9/bo/#/offerte/off-1', 'a pasted deep link keeps its page');
  assert.equal(canonicalShellPath({ pathname: '/w/2f07eeb9/bo', search: '', hash: '' }, BASE), '/w/2f07eeb9/bo/', 'the console «Apri CRM» and the login return land on the shell');
  assert.equal(canonicalShellPath({ pathname: '/w/2f07eeb9/bo', search: '?x=1', hash: '#/' }, BASE), '/w/2f07eeb9/bo/?x=1#/');
});

test('nothing changes when the address already matches, or is not the shell', () => {
  assert.equal(canonicalShellPath({ pathname: '/w/2f07eeb9/bo/', hash: '#/' }, BASE), null, 'already settled');
  assert.equal(canonicalShellPath({ pathname: '/', hash: '#/' }, '/'), null, 'the standalone server at the root');
  assert.equal(canonicalShellPath({ pathname: '/altro', hash: '' }, BASE), null, 'another path is never rewritten');
  assert.equal(canonicalShellPath({ pathname: '/w/2f07eeb9/bo' }, null), null, 'no base element');
  assert.equal(canonicalShellPath({ pathname: '/w/2f07eeb9/bo' }, 'https://evil.example/'), null, 'only a same-origin path base');
});

test('the shell settles the address once at boot, before the router reads it', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const settle = app.indexOf("canonicalShellPath(window.location, document.querySelector('base')?.getAttribute('href'))");
  assert.ok(settle > 0, 'the boot reads the location and the base element');
  assert.match(app, /window\.history\.replaceState\(window\.history\.state, '', settled\)/, 'replaceState: no navigation, no second load');
  assert.ok(settle < app.indexOf('function parseRoute') || app.indexOf('function parseRoute') === -1, 'before any route is read');
  assert.ok(settle < app.indexOf('window.addEventListener(\'hashchange\''), 'before the router listens');
});
