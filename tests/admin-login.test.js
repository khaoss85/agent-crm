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
import {
  LOGIN_COPY,
  createLoginForm,
  isSendableLoginEmail,
  postMagicLinkRequest,
} from '../apps/admin/public/login.js';
import { createFakeDocument } from './helpers/fake-dom.js';

const root = join(import.meta.dirname, '..');
const page = readFileSync(join(root, 'apps/admin/public/login.html'), 'utf8');
const loginSource = readFileSync(join(root, 'apps/admin/public/login.js'), 'utf8');

test('the login page tells the four-channel story like the prototype', () => {
  // C2 pin, bounded to the logo row: the brand container holds no nested
  // <div>, so the first closing tag ends it, and a brand moved elsewhere
  // no longer matches (an unbounded [\s\S]*? would cross </div> tags).
  const brandOf = (html) => html.match(/<div class="login-brand">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const brand = brandOf(page);
  assert.ok(/<svg/.test(brand) && /<span>Accordo<\/span>/.test(brand),
    'the brand names Accordo inside the logo row, next to the mark (C2)');
  const displaced = page
    .replace('          <span>Accordo</span>\n', '')
    .replace('    </main>', '          <span>Accordo</span>\n    </main>');
  assert.ok(displaced !== page && displaced.includes('<span>Accordo</span>'),
    'the displaced-brand probe really moves the brand out of the logo row');
  assert.ok(!/<span>Accordo<\/span>/.test(brandOf(displaced)),
    'a brand moved out of the logo row is rejected (C2)');
  for (const text of [
    'Ogni conversazione, un solo cliente.',
    'Instagram, email, telefono e WhatsApp',
    'Posso provare una lezione gratuita?',
    'Info abbonamento mensile',
    'Chiamata in entrata',
    'va benissimo!',
    'Giulia Romano',
    'Lezione di prova gioved',
  ]) {
    assert.ok(page.includes(text), `the story keeps: ${text}`);
  }
});

test('the login form matches the prototype: Google, email, ten minutes, no password', () => {
  for (const text of [
    'Accedi',
    'Rieccoti',
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

test('every login control rides the visual system: no raw button, input or link-button', () => {
  // BO-F6-06 acceptance: the screen renders through the design-system
  // classes, so a control added later without a ui-* class fails here.
  const tags = [...page.matchAll(/<(button|input|select|textarea)\b([^>]*)>/gi)];
  assert.ok(tags.length >= 2, `the login form keeps its controls (saw ${tags.length})`);
  for (const [, tag, attrs] of tags) {
    const classes = (attrs.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).filter(Boolean);
    assert.ok(
      classes.some((cls) => cls === 'ui' || cls.startsWith('ui-')),
      `<${tag}> carries a ui-* system class (has: ${classes.join('.') || 'none'})`,
    );
  }
  // The Google entry is a link painted as the secondary button: same rule.
  const google = page.match(/<a\b[^>]*class="([^"]*)"[^>]*href="\/auth\/google"/)
    ?? page.match(/<a\b[^>]*href="\/auth\/google"[^>]*class="([^"]*)"/);
  assert.ok(google, 'the Google entry keeps its link-button markup');
  const googleClasses = google[1].split(/\s+/).filter(Boolean);
  assert.ok(
    googleClasses.some((cls) => cls === 'ui' || cls.startsWith('ui-')),
    'the Google link-button carries a ui-* system class',
  );
});

test('the story panel keeps its structure: four rows plus the client card', () => {
  const rows = [...page.matchAll(/<div class="login-msg"[^>]*>([\s\S]*?)<\/div>/g)];
  assert.equal(rows.length, 4, 'four staggered message rows, like the prototype');
  for (const [, body] of rows) {
    assert.ok(/class="chan"/.test(body), 'every row shows a channel badge');
    assert.ok(/class="text"/.test(body), 'every row shows one line of text');
    assert.ok(/<time>/.test(body), 'every row shows a day or time hint');
  }
  const card = page.match(/<div class="login-card">([\s\S]*?)<\/div>\s*<\/div>/)?.[1] ?? '';
  assert.ok(/class="avatar"/.test(card), 'the card shows initials');
  assert.ok(/<strong>/.test(card), 'the card shows a name');
  assert.ok(/<small>/.test(card), 'the card shows an agenda line');
  assert.ok(/class="dot"/.test(card), 'the card shows the green status dot');
});

test('the columns keep their source order: story first, form second', () => {
  const storyAt = page.indexOf('login-story');
  const formAt = page.indexOf('login-form-wrap');
  assert.ok(storyAt !== -1 && formAt !== -1 && storyAt < formAt,
    'the story panel precedes the form in the DOM, as in the prototype (phones reorder with CSS)');
  assert.match(page, /<main class="login">/, 'a single two-column main holds both panels');
});

test('the page ships no app surface and no prefilled address', () => {
  assert.ok(!/admin-shell|bo-shell|<nav|sidebar|data-bo-technical/.test(page),
    'no app navigation or shell leaks into the login page');
  const scripts = [...page.matchAll(/<script\b[^>]*src="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, [], 'no classic scripts; the one module below is inline');
  assert.ok(page.includes("from './login.js'"), 'the inline module wires the shared login behavior');
  const input = page.match(/<input\b[^>]*>/i)?.[0] ?? '';
  assert.ok(!/\bvalue=/.test(input), 'the email field ships empty: the demo address stays a placeholder');
  assert.match(input, /placeholder="[^"]*"/, 'the demo address stays a placeholder, never a value');
  assert.match(input, /maxlength="200"/, 'the client bound matches the server bound');
  assert.ok(!/\bdisabled\b/.test(input) && !/\breadonly\b/.test(input),
    'the email field stays editable: no disabled/readonly gate blocks keyboard entry (C17)');
  assert.ok(!/aria-disabled/.test(input),
    'the email field carries no aria-disabled gate (C17)');
  assert.match(page, /<label\b[^>]*for="login-email"[^>]*>/, 'the exact label names its field');
  assert.match(page, /<form\b[^>]*method="post"[^>]*action="\/api\/auth\/magic-link\/request"/,
    'no-JS visitors still POST to the deployment route');
  const submit = page.match(/<button\b[^>]*>/i)?.[0] ?? '';
  assert.match(submit, /type="submit"/,
    'the primary button submits the form: keyboard visitors send with Invio (C17)');
  assert.ok(page.includes('>Ricevi il link di accesso</button>'),
    'the submit button keeps its exact label (C14)');
});

test('the login copy never leaks machinery: no codes, no English internals', () => {
  for (const [name, text] of Object.entries(LOGIN_COPY)) {
    assert.ok(!/MAGIC_LINK_[A-Z_]+/.test(text), `${name} names no reason code`);
    assert.ok(!/NOT_FOUND|non composto/i.test(text), `${name} stays Italian and product-level`);
  }
  for (const source of [page, loginSource]) {
    assert.ok(!/MAGIC_LINK_(INVALID|EXPIRED|NOT_CONFIGURED|CLOCK_FAILED|SECRET_UNAVAILABLE|STORE_FAILED)/.test(source),
      'no reason code reaches the page or its script');
    assert.ok(!/NOT_FOUND/.test(source), 'no technical NOT_FOUND reaches the page or its script');
    assert.ok(!/non composto/.test(source), 'no technical jargon reaches the page or its script');
  }
});

test('the enhancement replaces native validation only when it installs', () => {
  const input = page.match(/<input\b[^>]*>/i)?.[0] ?? '';
  assert.ok(/\brequired\b/.test(input), 'no-JS visitors keep the required gate');
  assert.ok(/type="email"/.test(input), 'no-JS visitors keep the email keyboard and shape check');
  const { form } = wireFakeLogin(async () => true);
  assert.equal(form.noValidate, true, 'wired pages show the Italian guidance, never the browser bubble');
});

test('isSendableLoginEmail mirrors the server bounds without normalizing', () => {
  assert.equal(isSendableLoginEmail('elena@studioaurora.it'), true);
  assert.equal(isSendableLoginEmail('  Elena@StudioAurora.it  '), true, 'casing and padding pass: the server normalizes');
  assert.equal(isSendableLoginEmail(''), false);
  assert.equal(isSendableLoginEmail('   '), false);
  assert.equal(isSendableLoginEmail('not-an-email'), false);
  assert.equal(isSendableLoginEmail('a@b'), false, 'the domain keeps its dot, like the server rule');
  assert.equal(isSendableLoginEmail(`a@${'b'.repeat(196)}.it`), false, 'over 200 characters never leaves the page');
  assert.equal(isSendableLoginEmail(undefined), false);
});

/**
 * @param {(email: string) => Promise<boolean>} request
 */
function wireFakeLogin(request) {
  const doc = createFakeDocument();
  const form = doc.createElement('form');
  form.setAttribute('class', 'login-magic');
  const email = doc.createElement('input');
  email.setAttribute('id', 'login-email');
  const submit = doc.createElement('button');
  submit.textContent = 'Ricevi il link di accesso';
  const google = doc.createElement('a');
  const api = createLoginForm({ doc, form, email, submit, google, request });
  return { form, email, submit, google, api };
}

const noopEvent = { preventDefault() {} };

test('the native submit event reaches the login handler: Enter sends (C17)', async () => {
  let calls = 0;
  const { form, email } = wireFakeLogin(async () => { calls += 1; return true; });
  email.value = 'elena@studioaurora.it';
  form.dispatch('submit', noopEvent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'the same event Enter fires natively reaches onSubmit');
});

test('an empty or invalid address shows Italian guidance and never requests', async () => {
  for (const [typed, expected] of [
    ['', LOGIN_COPY.emptyEmail],
    ['not-an-email', LOGIN_COPY.invalidEmail],
  ]) {
    let calls = 0;
    const { form, email, api } = wireFakeLogin(async () => { calls += 1; return true; });
    email.value = typed;
    await api.onSubmit(noopEvent);
    assert.equal(calls, 0, 'no request leaves the page for junk input');
    assert.equal(email.getAttribute('aria-invalid'), 'true');
    const notes = form.findAll('p');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].getAttribute('role'), 'alert');
    assert.equal(notes[0].textContent, expected);
  }
});

test('a valid address disables the controls, sends once, then confirms in Italian', async () => {
  let calls = 0;
  let resolveRequest = (value) => {};
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const { form, email, submit, google, api } = wireFakeLogin(async () => {
    calls += 1;
    return pending;
  });
  email.value = 'Elena@StudioAurora.it ';
  const flight = api.onSubmit(noopEvent);
  assert.equal(calls, 1, 'one request per submit');
  await api.onSubmit(noopEvent);
  assert.equal(calls, 1, 'a second submit while busy sends nothing');
  assert.equal(email.disabled, true);
  assert.equal(submit.disabled, true);
  assert.equal(submit.getAttribute('aria-busy'), 'true');
  assert.equal(submit.textContent, LOGIN_COPY.sending);
  assert.equal(google.getAttribute('aria-disabled'), 'true');
  let googleWent = false;
  google.dispatch('click', { preventDefault() { googleWent = true; } });
  assert.equal(googleWent, true, 'the Google entry waits while a send is in flight');
  resolveRequest(true);
  await flight;
  assert.equal(email.disabled, false, 'the form returns usable after the answer');
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, 'Ricevi il link di accesso');
  const notes = form.findAll('p');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].getAttribute('role'), 'status');
  assert.ok(notes[0].textContent.includes(LOGIN_COPY.sentTitle));
  assert.ok(notes[0].textContent.includes('10 minuti'));
});

test('a refused or failed request shows the Italian retry note and re-enables', async () => {
  for (const request of [async () => false, async () => { throw new Error('downstream 500'); }]) {
    const { form, email, submit, api } = wireFakeLogin(request);
    email.value = 'elena@studioaurora.it';
    await api.onSubmit(noopEvent);
    const notes = form.findAll('p');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].getAttribute('role'), 'alert');
    assert.equal(notes[0].textContent, LOGIN_COPY.failed);
    assert.equal(email.disabled, false, 'retry stays possible');
    assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, 'Ricevi il link di accesso');
  }
});

test('postMagicLinkRequest posts JSON and turns every failure into false', async () => {
  const seen = [];
  const ok = await postMagicLinkRequest('/api/auth/magic-link/request', 'elena@studioaurora.it',
    async (url, init) => {
      seen.push([url, init]);
      return { ok: true };
    });
  assert.equal(ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], '/api/auth/magic-link/request');
  assert.equal(seen[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(seen[0][1].body), { email: 'elena@studioaurora.it' });
  assert.equal(
    await postMagicLinkRequest('/x', 'a@b.it', async () => ({ ok: false })),
    false,
    'a non-2xx answer is a plain retry, never an exception',
  );
  assert.equal(
    await postMagicLinkRequest('/x', 'a@b.it', async () => { throw new Error('network down'); }),
    false,
    'a network failure is a plain retry, never an exception',
  );
  assert.equal(
    await postMagicLinkRequest('/x', 'a@b.it', () => new Promise(() => {}), { timeoutMs: 20 }),
    false,
    'a hanging request times out into the same retry note',
  );
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

/** The page's style block, for the CSS-level slices below. */
const pageStyle = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';

/**
 * Visible text of a static page: no style, script or comments, tags
 * dropped, entities for the apostrophe decoded.
 * @param {string} html
 */
function visibleText(html) {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2019;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

test('27a0b924 C5: the four rows step to the right like the prototype, from the stylesheet', () => {
  assert.match(pageStyle, /\.login-msg:nth-child\(2\)\s*\{\s*margin-left:\s*20px;/, 'second row steps 20px');
  assert.match(pageStyle, /\.login-msg:nth-child\(3\)\s*\{\s*margin-left:\s*40px;/, 'third row steps 40px');
  assert.match(pageStyle, /\.login-msg:nth-child\(4\)\s*\{\s*margin-left:\s*60px;/, 'fourth row steps 60px');
  assert.ok(!/class="login-msg" style=/.test(page), 'the stagger lives in the stylesheet, so the phone layout can narrow it');
});

test('27a0b924 C20-C22: on phone the sign-in comes first and the story turns compact', () => {
  const phone = pageStyle.match(/@media \(max-width: 520px\) \{([\s\S]*?)\n {6}\}/)?.[1] ?? '';
  assert.ok(phone !== '', 'the page carries a phone breakpoint');
  // Less is more: a person opening the login on a phone signs in without
  // scrolling past the story. CSS order, so the DOM stays the prototype's.
  assert.match(phone, /\.login-form-wrap \{ order: -1;/, 'under 520px the form precedes the story visually');
  assert.ok(page.indexOf('login-story') < page.indexOf('login-form-wrap'), 'the DOM keeps the desktop order');
  assert.match(phone, /\.login-thread \{ display: none; \}/, 'the four rows and the client card hide on phone');
  assert.match(phone, /\.login-story \{ padding: 32px 28px;[^}]*min-height: 0;/,
    'the compact story uses the form side margins and no desktop minimum height');
  assert.ok(!/@media[^{]*\{[^}]*\.login-thread/.test(pageStyle.replace(/@media \(max-width: 520px\)/, '')),
    'the rows hide only under the phone breakpoint');
  assert.match(pageStyle, /\.login-form \{ width: 100%; max-width: 380px;/, 'the form spans the column (C22)');
});

test('27a0b924 C18-C19: error, sent, invalid and busy states are painted, not just set', () => {
  assert.match(pageStyle, /\.login-error \{[^}]*color: var\(--danger\);/, 'the Italian error note reads as an error');
  assert.match(pageStyle, /\.login-sent \{[^}]*background: var\(--accent-soft\);/, 'the sent note reads as a confirmation');
  assert.match(pageStyle, /\.login-field input\[aria-invalid="true"\] \{ border-color: var\(--danger\); \}/,
    'an invalid address turns the field border red');
  assert.match(pageStyle, /\.login-google\[aria-disabled="true"\] \{[^}]*pointer-events: none;/,
    'the Google entry looks and acts disabled during a send');
  assert.match(pageStyle, /\.login-google:active, \.login-submit:active \{ transform: translateY\(1px\); \}/,
    'both buttons show the press');
  // The classes the behaviour script writes are the ones the page paints.
  assert.ok(loginSource.includes("'login-error'") && loginSource.includes("'login-sent'"));
});

test('27a0b924 Dati: no demo person in the email field, only a neutral shape hint', () => {
  const input = page.match(/<input\b[^>]*>/i)?.[0] ?? '';
  assert.match(input, /placeholder="nome@azienda\.it"/, 'a neutral example address');
  assert.ok(!/studioaurora|elena/i.test(input), 'the prototype demo address never ships');
});

test('27a0b924 C2-C16: every fixed text is visible, in Italian, with no English word', () => {
  const text = visibleText(page);
  for (const fixed of [
    'Accordo',
    'Ogni conversazione, un solo cliente.',
    'Instagram, email, telefono e WhatsApp confluiscono in un’unica scheda. L’AI tiene il filo, tu decidi.',
    'Accedi',
    'Rieccoti',
    'Ritrova clienti, conversazioni e agenda del team dove li hai lasciati.',
    'Continua con Google',
    'oppure',
    'Email di lavoro',
    'Ricevi il link di accesso',
    'Niente password: ti inviamo un link valido 10 minuti.',
    'Nuovo su Accordo? Crea uno spazio gratuito',
  ]) {
    assert.ok(text.includes(fixed), `visible: ${fixed}`);
  }
  for (const copy of [text, ...Object.values(LOGIN_COPY)]) {
    assert.ok(!/\b(Sign in|Log in|Login|Continue|Send|Email address|Welcome|Loading|Error|Submit|Password)\b/.test(copy),
      `no English UI word in: ${copy.slice(0, 60)}`);
  }
});

test('owner decision 07/11: the greeting is gender-neutral «Rieccoti» and the examples come from a fitness studio', () => {
  const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = visibleText(page);
  assert.ok(text.includes('Rieccoti'), 'the greeting reads «Rieccoti»');
  assert.ok(!/Bentornat/.test(page), 'no gendered «Bentornata/o» anywhere on the page');
  for (const old of ['consulenze a Milano', 'ristrutturazione cucina', 'Prima call']) {
    assert.ok(!page.includes(old), `the old non-fitness example is gone: ${old}`);
  }
  for (const [chan, line, time] of [
    ['IG', 'Posso provare una lezione gratuita?', 'ven'],
    ['@', 'Info abbonamento mensile', '09:10'],
    ['TEL', 'Chiamata in entrata · 3:12', '09:47'],
    ['WA', 'Giovedì alle 18 va benissimo!', '10:20'],
  ]) {
    const row = new RegExp(`>${esc(chan)}</span><span class="text">${esc(line)}</span><time>${time}</time>`);
    assert.match(page, row, `the ${chan} row keeps its badge, text and time`);
  }
  assert.ok(page.includes('<strong>Giulia Romano</strong><small>Lezione di prova giovedì 18:00 con coach Marco</small>'), 'the client card speaks fitness');
});
