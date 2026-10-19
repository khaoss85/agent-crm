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
import { join, sep } from 'node:path';

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
  // The whole framework surface, not just the login files: a Google OAuth
  // client, handler or secret added under any other package or app must fail
  // this test, not slip past it. Shipped markup and styles count too — a
  // client can hide in a page as easily as in a script.
  const roots = ['packages', 'apps'].map((dir) => join(root, dir));
  /** @type {string[]} */
  const sources = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
        walk(full);
      } else if (entry.isFile() && /\.(js|mjs|cjs|html|css)$/.test(entry.name) && !full.endsWith('.test.js')) {
        // Only shipped sources: tests may name Google freely.
        sources.push(full);
      }
    }
  };
  for (const dir of roots) walk(dir);
  assert.ok(sources.length >= 100, `the whole surface is read, not just the login files (saw ${sources.length})`);
  assert.ok(sources.some((file) => file.endsWith('.html')), 'shipped markup is scanned, not just scripts');
  assert.ok(
    sources.some((file) => {
      const parts = file.split(sep);
      return !parts.includes('src') && !parts.includes('scripts');
    }),
    'files outside src/scripts are scanned too',
  );
  // The deny-list a Google OAuth client cannot dodge: library imports,
  // client identifiers, token endpoints, identity scopes, service-account
  // material. Deliberately NOT in this list: the bare word "Google" (the
  // login page names the deployment button) and the Gmail API hostname
  // (the fake-backed Gmail adapter calls gmail.googleapis.com with no
  // OAuth client of its own).
  const GOOGLE_MACHINERY_RE = /from\s+['"]googleapis['"]|require\(\s*['"]googleapis['"]|google-auth|client_id|client_secret|clientSecret|token_endpoint|token_uri|tokenEndpoint|openid|service_account|serviceAccount|authorized_user|accounts\.google|oauth2\/v\d/i;
  // Positive control: the scanner flags every known-bad shape, so narrowing
  // this pattern — or the file set above — fails HERE, and a reappearing
  // Google client can never land with this test still green.
  for (const offender of [
    "import { google } from 'googleapis'",
    "const { google } = require('googleapis')",
    "import { OAuth2Client } from 'google-auth-library'",
    '"client_id": "123.apps.googleusercontent.com"',
    'token_endpoint: "https://oauth2.googleapis.com/token"',
    "scope: 'openid email profile'",
    '"type": "service_account"',
    'serviceAccountKey = readFileSync(keyFile)',
    '"authorized_user"',
    'accounts.google.com',
    'https://www.googleapis.com/oauth2/v3/userinfo',
    'clientSecret = process.env.GOOGLE_SECRET',
  ]) {
    assert.ok(GOOGLE_MACHINERY_RE.test(offender), `the scan flags a reappearing client: ${offender.slice(0, 44)}`);
  }
  for (const file of sources) {
    const body = readFileSync(file, 'utf8');
    assert.ok(!GOOGLE_MACHINERY_RE.test(body),
      `${file} must not grow a Google client`);
  }
});
