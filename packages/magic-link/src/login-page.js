// @ts-check
/**
 * The login page markup both deployments serve (backlog:f9680c478410).
 *
 * The backoffice (`apps/admin/public/login.html`) and the production
 * workspace login (`/w/<spazio>/`, served by the pilot from this
 * framework's export) paint the same "01 Login" screen of the Accordo
 * Backoffice prototype: the dark story column («Ogni conversazione, un
 * solo cliente.») beside «Bentornata» with «Continua con Google».
 *
 * Single source on purpose: the story section, the greeting header and
 * the Google entry live here as the only copy. `backofficeLoginHtml()`
 * composes the full backoffice document (with the deployment-owned
 * magic-link form, its enhancement script and the design-system
 * stylesheet), and `scripts/generate-login-html.js` writes exactly that
 * into `apps/admin/public/login.html` — `tests/login-page.test.js`
 * fails on any byte of drift between the file and this module, so the
 * two can never duplicate the markup by hand again.
 *
 * `loginPageHtml({ googleHref })` is the deployment surface: a
 * self-contained page (inline style only — no `<link rel=stylesheet>`,
 * no `<script>`, no `<form>`) for hosts that cannot serve the
 * backoffice assets, like the shared pilot. Google sign-in stays
 * deployment-owned: `googleHref` names the deployment's OAuth entry
 * (same-origin `/path` or `https://` URL, nothing else), the framework
 * owns no OAuth client and emits no Google request here.
 */

import { ValidationError } from '../../core/index.js';

/** The deployment entry behind «Continua con Google» on the backoffice page. */
export const BACKOFFICE_GOOGLE_HREF = '/auth/google';

/**
 * Escape one value for an HTML attribute delimited by double quotes.
 *
 * @param {string} value
 */
function escapeAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The `googleHref` names a deployment-owned OAuth entry, never framework
 * machinery: a same-origin absolute path (`/auth/google`) or an `https://`
 * URL. Anything else — `javascript:`, protocol-relative `//`, `data:`,
 * whitespace, quotes, angle brackets, backslashes — refuses fail-closed,
 * because the value lands in an `href` the visitor's browser follows.
 *
 * @param {unknown} value
 */
function requireGoogleHref(value) {
  if (typeof value !== 'string' || value === '' || value.length > 500) {
    throw new ValidationError('login googleHref must be a same-origin /path or an https:// URL', { field: 'googleHref' });
  }
  if (value.startsWith('/')) {
    if (value.startsWith('//') || /[\s"<>\\]/.test(value)) {
      throw new ValidationError('login googleHref must be a same-origin /path or an https:// URL', { field: 'googleHref' });
    }
    return value;
  }
  if (/^https:\/\/[^/\s"'<>\\]+\.[^/\s"'<>\\]+(\/\S*)?$/.test(value)) {
    return value;
  }
  throw new ValidationError('login googleHref must be a same-origin /path or an https:// URL', { field: 'googleHref' });
}

/**
 * The dark story column, byte-shared with the backoffice page: brand,
 * «Ogni conversazione, un solo cliente.», the four-channel thread and
 * the client card. Decorative thread rows stay `aria-hidden`; the card
 * names a demo customer, never a real one.
 */
export function loginStoryHtml() {
  return [
    '      <section class="login-story" aria-label="Come Accordo unisce i canali">',
    '        <div class="login-brand">',
    '          <svg width="30" height="30" viewBox="0 0 120 120" fill="none" aria-hidden="true"><circle cx="60" cy="60" r="44" stroke="#7457ff" stroke-width="14" stroke-linecap="round" stroke-dasharray="54 222.5"></circle><circle cx="60" cy="60" r="44" stroke="#f2c84b" stroke-width="14" stroke-linecap="round" stroke-dasharray="54 222.5" transform="rotate(90 60 60)"></circle><circle cx="60" cy="60" r="44" stroke="#ff6b69" stroke-width="14" stroke-linecap="round" stroke-dasharray="54 222.5" transform="rotate(180 60 60)"></circle><circle cx="60" cy="60" r="44" stroke="#20b8d8" stroke-width="14" stroke-linecap="round" stroke-dasharray="54 222.5" transform="rotate(270 60 60)"></circle><circle cx="60" cy="60" r="15" fill="#27b64a"></circle></svg>',
    '          <span>Accordo</span>',
    '        </div>',
    '        <div>',
    '          <h1>Ogni conversazione, un solo cliente.</h1>',
    '          <p class="lede">Instagram, email, telefono e WhatsApp confluiscono in un&#x2019;unica scheda. L&#x2019;AI tiene il filo, tu decidi.</p>',
    '        </div>',
    '        <div class="login-thread" aria-hidden="true">',
    '          <div class="login-msg"><span class="chan" style="background:#fde4ee;color:#a3184d">IG</span><span class="text">Fate anche consulenze a Milano?</span><time>ven</time></div>',
    '          <div class="login-msg" style="margin-left:20px"><span class="chan" style="background:#ecebe4;color:#171912">@</span><span class="text">Info ristrutturazione cucina</span><time>09:10</time></div>',
    '          <div class="login-msg" style="margin-left:40px"><span class="chan" style="background:#efe9da;color:#5a4a1a">TEL</span><span class="text">Chiamata in entrata · 6:12</span><time>09:47</time></div>',
    '          <div class="login-msg" style="margin-left:60px"><span class="chan" style="background:#dcf8e6;color:#0b6b33">WA</span><span class="text">Giovedì alle 15 va benissimo!</span><time>10:20</time></div>',
    '          <div class="login-card">',
    '            <span class="avatar">GR</span>',
    '            <div class="who"><strong>Giulia Romano</strong><small>Prima call giovedì 15:00 con Marco</small></div>',
    '            <span class="dot"></span>',
    '          </div>',
    '        </div>',
    '      </section>',
  ].join('\n');
}

/**
 * The «Accedi» / «Bentornata» header above the sign-in entries,
 * byte-shared with the backoffice page.
 */
export function loginGreetingHtml() {
  return [
    '          <div>',
    '            <p class="login-eyebrow">Accedi</p>',
    '            <h2>Bentornata</h2>',
    '            <p class="lede">Ritrova clienti, conversazioni e agenda del team dove li hai lasciati.</p>',
    '          </div>',
  ].join('\n');
}

/**
 * The «Continua con Google» entry: a plain link to the deployment's
 * OAuth entry, painted as the secondary button. The `ui-btn` classes
 * are the backoffice design-system hooks; on the self-contained page
 * the same classes are styled by its inline `<style>`.
 *
 * @param {unknown} googleHref the deployment's OAuth entry (validated)
 */
export function loginGoogleLinkHtml(googleHref) {
  const href = escapeAttribute(requireGoogleHref(googleHref));
  return `          <a class="login-google ui-btn ui-btn-secondary" href="${href}"><span class="g">G</span>Continua con Google</a>`;
}

/**
 * The inline style for the self-contained page. Same layout and palette
 * as the backoffice login (ink `#171912`, paper `#f7f3e9`, accent
 * `#176b2a` from the design system), with concrete values because this
 * page ships no stylesheet.
 */
const LOGIN_PAGE_STYLE = [
  '      body{margin:0;font-family:\'Bricolage Grotesque\',\'Avenir Next\',Avenir,ui-sans-serif,system-ui,sans-serif;color:#171912;background:#f7f3e9}',
  '      .login{min-height:100vh;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,460px),1fr))}',
  '      .login-story{background:#171912;color:#f7f3e9;padding:40px 48px;display:flex;flex-direction:column;justify-content:space-between;gap:44px;min-height:600px}',
  '      .login-brand{display:flex;align-items:center;gap:10px}',
  '      .login-brand span{font-weight:700;font-size:20px;letter-spacing:-0.02em}',
  '      .login-story h1{margin:0 0 22px;max-width:460px;font-size:clamp(40px,5vw,64px);line-height:0.98;letter-spacing:-0.032em;font-weight:700}',
  '      .login-story .lede{margin:0;font-size:18px;line-height:1.5;color:#c9c6b8;max-width:440px}',
  '      .login-thread{display:flex;flex-direction:column;gap:8px;max-width:420px}',
  '      .login-msg{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;background:rgba(255,253,247,0.06);border:1px solid rgba(255,253,247,0.1)}',
  '      .login-msg .chan{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;font-family:ui-monospace,Menlo,monospace;font-size:10px;font-weight:700;flex:none}',
  '      .login-msg .text{font-size:14px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '      .login-msg time{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#8f8c7f}',
  '      .login-card{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:14px;background:#f7f3e9;color:#171912;margin-top:8px}',
  '      .login-card .avatar{width:36px;height:36px;border-radius:50%;background:#e9e4d6;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}',
  '      .login-card .who{flex:1;min-width:0}',
  '      .login-card .who strong{display:block;font-size:15px}',
  '      .login-card .who small{font-size:13px;color:#62655b}',
  '      .login-card .dot{width:10px;height:10px;min-width:10px;padding:0;margin:0;border:none;border-radius:50%;background:#27b64a;flex:none}',
  '      .login-form-wrap{display:flex;align-items:center;justify-content:center;padding:48px 28px}',
  '      .login-form{width:100%;max-width:380px;display:flex;flex-direction:column;gap:20px}',
  '      .login-eyebrow{margin:0 0 10px;font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:600;letter-spacing:0.14em;text-transform:uppercase;color:#176b2a}',
  '      .login-form h2{margin:0;font-size:38px;line-height:1;letter-spacing:-0.028em;font-weight:700}',
  '      .login-form .lede{margin:10px 0 0;font-size:15px;line-height:1.5;color:#62655b}',
  '      .login-google{display:flex;align-items:center;justify-content:center;gap:10px;min-height:48px;padding:0 14px;border-radius:12px;border:1px solid #d9d5c8;background:#fffdf7;font-size:15px;font-weight:700;color:inherit;text-decoration:none}',
  '      .login-google:hover{border-color:#171912;text-decoration:none;color:inherit}',
  '      .login-google .g{width:22px;height:22px;border-radius:6px;background:#e3ecfd;color:#1a56c4;display:grid;place-items:center;font-size:12px;font-weight:800}',
].join('\n');

/**
 * The production login page for hosts that cannot serve the backoffice
 * assets: the prototype screen as one self-contained document. Italian
 * only, no reason codes, no English internals. No password field, ever.
 *
 * @param {{ googleHref: unknown }} options
 */
export function loginPageHtml(options) {
  const googleHref = requireGoogleHref(options?.googleHref);
  return [
    '<!doctype html>',
    '<html lang="it">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>Accedi — Accordo</title>',
    '    <style>',
    LOGIN_PAGE_STYLE,
    '    </style>',
    '  </head>',
    '  <body>',
    '    <main class="login">',
    loginStoryHtml(),
    '      <section class="login-form-wrap" aria-label="Accedi">',
    '        <div class="login-form">',
    loginGreetingHtml(),
    '          <!-- Google sign-in is deployment-owned: this entry targets the deployment\'s',
    '               OAuth entry, passed as googleHref. The framework adds no handler,',
    '               no client and no secret here (see tests/login-page.test.js). -->',
    loginGoogleLinkHtml(googleHref),
    '        </div>',
    '      </section>',
    '    </main>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The backoffice login document. Owns every byte of
 * `apps/admin/public/login.html`: the shared story, greeting and Google
 * entry above, plus the deployment-owned magic-link form, its
 * progressive-enhancement module and the design-system stylesheet link.
 * The file is generated, never edited by hand — see
 * `scripts/generate-login-html.js`.
 *
 * @param {{ googleHref?: unknown }} [options]
 */
export function backofficeLoginHtml(options = {}) {
  const googleHref = options?.googleHref === undefined ? BACKOFFICE_GOOGLE_HREF : requireGoogleHref(options.googleHref);
  return [
    '<!doctype html>',
    '<html lang="it">',
    '  <head>',
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '    <title>Accedi — Accordo</title>',
    '    <link rel="stylesheet" href="styles.css" />',
    '    <style>',
    '      .login { min-height: 100vh; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); }',
    '      .login-story { background: var(--ink); color: var(--paper); padding: 40px 48px; display: flex; flex-direction: column; justify-content: space-between; gap: 44px; min-height: 600px; }',
    '      .login-brand { display: flex; align-items: center; gap: 10px; }',
    '      .login-brand span { font-weight: 700; font-size: 20px; letter-spacing: -0.02em; }',
    '      .login-story h1 { margin: 0 0 22px; max-width: 460px; font-size: clamp(40px, 5vw, 64px); line-height: 0.98; letter-spacing: -0.032em; font-weight: 700; text-wrap: balance; }',
    '      .login-story .lede { margin: 0; font-size: 18px; line-height: 1.5; color: #c9c6b8; max-width: 440px; text-wrap: pretty; }',
    '      .login-thread { display: flex; flex-direction: column; gap: 8px; max-width: 420px; }',
    '      .login-msg { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: rgba(255, 253, 247, 0.06); border: 1px solid rgba(255, 253, 247, 0.1); }',
    '      .login-msg .chan { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-family: var(--mono); font-size: 10px; font-weight: 700; flex: none; }',
    '      .login-msg .text { font-size: 14px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '      .login-msg time { font-family: var(--mono); font-size: 11px; color: #8f8c7f; }',
    '      .login-card { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-radius: 14px; background: var(--paper); color: var(--ink); margin-top: 8px; }',
    '      .login-card .avatar { width: 36px; height: 36px; border-radius: 50%; background: #e9e4d6; display: grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; }',
    '      .login-card .who { flex: 1; min-width: 0; }',
    '      .login-card .who strong { display: block; font-size: 15px; }',
    '      .login-card .who small { font-size: 13px; color: var(--muted); }',
    '      .login-card .dot, .login-card span.dot { width: 10px; height: 10px; min-width: 10px; padding: 0; margin: 0; border: none; border-radius: 50%; background: var(--accord); flex: none; }',
    '      .login-form-wrap { display: flex; align-items: center; justify-content: center; padding: 48px 28px; }',
    '      .login-form { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 20px; }',
    '      .login-eyebrow { margin: 0 0 10px; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }',
    '      .login-form h2 { margin: 0; font-size: 38px; line-height: 1; letter-spacing: -0.028em; font-weight: 700; }',
    '      .login-form .lede { margin: 10px 0 0; font-size: 15px; line-height: 1.5; color: var(--muted); }',
    '      .login-google { display: flex; align-items: center; justify-content: center; gap: 10px; min-height: 48px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); font-size: 15px; font-weight: 700; color: inherit; text-decoration: none; }',
    '      .login-google:hover { border-color: var(--ink); text-decoration: none; color: inherit; }',
    '      .login-google .g { width: 22px; height: 22px; border-radius: 6px; background: #e3ecfd; color: #1a56c4; display: grid; place-items: center; font-size: 12px; font-weight: 800; }',
    '      .login-or { display: flex; align-items: center; gap: 12px; color: var(--dim); font-size: 12px; }',
    '      .login-or::before, .login-or::after { content: ""; flex: 1; height: 1px; background: var(--line); }',
    '      .login-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 700; }',
    '      .login-field input { height: 48px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); font-size: 15px; font-weight: 400; outline: none; }',
    '      .login-field input:focus { border-color: var(--accent); }',
    '      .login-submit { min-height: 48px; border-radius: 12px; border: none; background: var(--accent); color: var(--paper); font-size: 15px; font-weight: 700; cursor: pointer; }',
    '      .login-submit:hover { background: #125a22; }',
    '      .login-note { margin: 0; font-size: 13px; color: var(--dim); line-height: 1.45; }',
    '      .login-signup { border-top: 1px solid var(--line); padding-top: 16px; font-size: 14px; color: var(--muted); }',
    '      .login-signup a { color: var(--accent); text-decoration: none; }',
    '      .login-signup a:hover { text-decoration: underline; }',
    '    </style>',
    '  </head>',
    '  <body>',
    '    <main class="login">',
    loginStoryHtml(),
    '      <section class="login-form-wrap" aria-label="Accedi">',
    '        <div class="login-form">',
    loginGreetingHtml(),
    '          <!-- Google sign-in is deployment-owned: this entry targets the deployment\'s',
    '               OAuth entry, which the control plane already serves. The framework adds',
    '               no handler, no client and no secret here (see tests/admin-login.test.js). -->',
    loginGoogleLinkHtml(googleHref),
    '          <div class="login-or">oppure</div>',
    '          <form class="login-magic" method="post" action="/api/auth/magic-link/request">',
    '            <label class="login-field" for="login-email">Email di lavoro',
    '              <input class="ui-field" id="login-email" name="email" type="email" autocomplete="email" required maxlength="200" placeholder="elena@studioaurora.it" />',
    '            </label>',
    '            <button class="login-submit ui-btn ui-btn-cta" type="submit" style="width:100%;margin-top:20px">Ricevi il link di accesso</button>',
    '          </form>',
    '          <script type="module">',
    '            import { createLoginForm, postMagicLinkRequest } from \'./login.js\';',
    '            // No fetch, no enhancement: the plain POST below stays the page.',
    '            const form = typeof window.fetch === \'function\'',
    '              ? document.querySelector(\'form.login-magic\')',
    '              : null;',
    '            if (form) {',
    '              createLoginForm({',
    '                doc: document,',
    '                form,',
    '                email: form.querySelector(\'#login-email\'),',
    '                submit: form.querySelector(\'.login-submit\'),',
    '                google: document.querySelector(\'.login-google\'),',
    '                request: (email) => postMagicLinkRequest(',
    '                  form.getAttribute(\'action\') || \'/api/auth/magic-link/request\',',
    '                  email,',
    '                  window.fetch.bind(window),',
    '                ),',
    '              });',
    '            }',
    '          </script>',
    '          <p class="login-note">Niente password: ti inviamo un link valido 10 minuti.</p>',
    '          <div class="login-signup">Nuovo su Accordo? <a href="/signup">Crea uno spazio gratuito</a></div>',
    '        </div>',
    '      </section>',
    '    </main>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}
