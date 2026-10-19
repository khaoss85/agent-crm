// @ts-check
/**
 * BO-F0-05 — the login page (backlog:0cbae947).
 *
 * The "01 Login" screen of the backoffice prototype, painted into
 * `apps/admin/public/login.html`: the four-channel story on the left, Google
 * plus the magic-link email form on the right, no passwords anywhere.
 *
 * Google non-regression: the framework owns no OAuth client and emits no
 * Google request — "Continua con Google" targets the deployment's entry
 * (`/auth/google`, served by the control plane today), and this test fails
 * if the framework ever grows its own Google handler, client ID or secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const page = readFileSync(join(root, 'apps/admin/public/login.html'), 'utf8');

test('the login page tells the four-channel story like the prototype', () => {
  for (const text of [
    'Ogni conversazione, un solo cliente.',
    'Instagram, email, telefono e WhatsApp',
    'Fate anche consulenze a Milano?',
    'Info ristrutturazione cucina',
    'Chiamata in entrata',
    'va benissimo!',
    'Giulia Romano',
    'Prima call gioved',
  ]) {
    assert.ok(page.includes(text), `the story keeps: ${text}`);
  }
});

test('the login form matches the prototype: Google, email, ten minutes, no password', () => {
  for (const text of [
    'Accedi',
    'Bentornata',
    'Ritrova clienti, conversazioni e agenda del team',
    'Continua con Google',
    'oppure',
    'Email di lavoro',
    'Ricevi il link di accesso',
    'Niente password',
    'link valido 10 minuti',
    'Crea uno spazio gratuito',
  ]) {
    assert.ok(page.includes(text), `the form keeps: ${text}`);
  }
  assert.match(page, /<html lang="it"/, 'the page speaks Italian');
  assert.match(page, /<form[^>]*method="post"[^>]*action="\/api\/auth\/magic-link\/request"/, 'the email form posts to the magic-link request route');
  assert.match(page, /type="email"/, 'the email field is a real email input');
  assert.ok(!/type="password"/.test(page), 'no password field, ever');
  assert.ok(!/password/i.test(page.replace('Niente password', '')), 'no password anywhere but the note that there is none');
});

test('the page stacks on narrow viewports like the prototype', () => {
  assert.match(page, /name="viewport"[^>]*width=device-width/, 'viewport meta for mobile');
  assert.match(page, /repeat\(auto-fit,\s*minmax\(min\(100%,\s*460px\),\s*1fr\)\)/, 'the two columns stack under ~920px');
});

test('Google sign-in stays deployment-owned: the framework adds no Google machinery', () => {
  assert.match(page, /href="\/auth\/google"/, 'the Google button targets the deployment entry');
  const sources = [
    ...readdirSync(join(root, 'packages/magic-link/src')).map((file) => join(root, 'packages/magic-link/src', file)),
    ...readdirSync(join(root, 'apps/server/src')).map((file) => join(root, 'apps/server/src', file)),
  ];
  assert.ok(sources.length >= 5, 'the login surface files are all read');
  for (const file of sources) {
    const body = readFileSync(file, 'utf8');
    assert.ok(!/accounts\.google|oauth2\/v\d|client_secret|clientSecret/i.test(body),
      `${file} must not grow a Google client`);
  }
});
