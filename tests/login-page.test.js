// @ts-check
/**
 * backlog:f9680c478410 — the framework owns the production login page.
 *
 * `loginPageHtml({ googleHref })` (packages/magic-link/src/login-page.js)
 * paints the prototype "01 Login" screen as one self-contained document
 * for hosts that cannot serve the backoffice assets (the shared pilot's
 * `/w/<spazio>/` today renders its own paler page instead). The backoffice
 * `apps/admin/public/login.html` is generated from the same fragments, so
 * the two can never duplicate the markup by hand: the last test below
 * fails on any byte of drift.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACKOFFICE_GOOGLE_HREF,
  backofficeLoginHtml,
  loginPageHtml,
} from '../packages/magic-link/src/login-page.js';

const root = join(import.meta.dirname, '..');
const googleHref = '/auth/google';
const page = loginPageHtml({ googleHref });

test('f9680c478410: the exported page paints the prototype login screen', () => {
  for (const text of [
    'Ogni conversazione, un solo cliente.',
    'Bentornata',
    'Continua con Google',
    'Accedi — Accordo',
  ]) {
    assert.ok(page.includes(text), `the page keeps: ${text}`);
  }
  assert.ok(page.includes(`href="${googleHref}"`), 'the Google entry links to the deployment googleHref');
  assert.match(page, /<html lang="it"/, 'the page speaks Italian');
});

test('f9680c478410: the exported page ships no form, no stylesheet and no script', () => {
  assert.ok(!/<form[\s>]/.test(page), 'no form: the pilot authenticates at the deployment entry, not here');
  assert.ok(!/<link[\s>]/.test(page), 'no stylesheet link: the page is self-contained');
  assert.ok(!/<script[\s>]/.test(page), 'no script at all, hence no script src');
});

test('f9680c478410: the exported page leaks no machinery and asks no password', () => {
  assert.ok(!/type="password"/.test(page), 'no password field, ever');
  assert.ok(!/password/i.test(page.replace('Niente password', '')), 'no password anywhere');
  assert.ok(!/MAGIC_LINK_[A-Z_]+/.test(page), 'no reason code reaches the page');
  assert.ok(!/client[_-]?id|client[_-]?secret/i.test(page), 'no OAuth client material in the page');
});

test('f9680c478410: googleHref is deployment-owned and validated fail-closed', () => {
  const https = loginPageHtml({ googleHref: 'https://control.accordo.dev/auth/google' });
  assert.ok(https.includes('href="https://control.accordo.dev/auth/google"'), 'an https entry is accepted');
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '//evil.example.com/auth/google',
    'data:text/html,<h1>x</h1>',
    'https://',
    '/auth/google"onmouseover="alert(1)',
    '/auth/<google>',
    '/auth\\google',
    '/auth/google x',
    '',
    null,
    undefined,
    42,
    { href: '/auth/google' },
  ]) {
    assert.throws(
      () => loginPageHtml({ googleHref: bad }),
      /googleHref/,
      `refused, never linked: ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => loginPageHtml({}), /googleHref/, 'googleHref is required, never defaulted');
});

test('f9680c478410: a query-bearing googleHref escapes inside the attribute', () => {
  const linked = loginPageHtml({ googleHref: '/auth/google?next=/w/a&x=1' });
  assert.ok(linked.includes('href="/auth/google?next=/w/a&amp;x=1"'), 'ampersands escape, the link stays one attribute');
  assert.equal(linked.match(/href="/g)?.length ?? 0, 1, 'exactly one link target on the page');
});

test('f9680c478410: login.html and the function share markup, never duplicate it', () => {
  assert.equal(BACKOFFICE_GOOGLE_HREF, '/auth/google', 'the backoffice entry stays the deployment path the tests pin');
  const onDisk = readFileSync(join(root, 'apps/admin/public/login.html'), 'utf8');
  assert.equal(onDisk, backofficeLoginHtml(), 'login.html is generated from the module: regenerate, never hand-edit');
  for (const fragment of ['Ogni conversazione, un solo cliente.', 'Bentornata', 'Continua con Google']) {
    assert.ok(onDisk.includes(fragment), `login.html keeps the shared fragment: ${fragment}`);
  }
});
