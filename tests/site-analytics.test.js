// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../site/assets/analytics.js', import.meta.url), 'utf8');
function boot({ href = 'https://accordo.dev/developers.html', referrer = '', navigator = {}, window: overrides = {} } = {}) {
  const appended = [];
  const listeners = {};
  const window = { ...overrides };
  const document = {
    currentScript: { getAttribute: () => 'https://accordo.dev/developers.html' },
    referrer,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    createElement: () => ({}),
    head: { appendChild: (node) => appended.push(node) },
  };
  runInNewContext(script, { document, window, navigator, location: new URL(href), URL, Set });
  const clean = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  return { appended, window, navigator,
    beforeSend: (event) => clean(window.vaq[0][1](event)),
    click: (name) => listeners.click?.({ target: { closest: () => ({ getAttribute: () => name }) } }),
    events: () => clean((window.vaq ?? []).filter(([name]) => name === 'event').map((args) => Array.from(args))) };
}

test('site analytics loads only on the canonical production origin and respects browser controls', () => {
  for (const options of [
    { href: 'http://localhost:3000/developers.html' },
    { href: 'https://accordo-preview.vercel.app/developers.html' },
    { href: 'file:///tmp/developers.html' },
    { navigator: { doNotTrack: '1' } },
    { navigator: { globalPrivacyControl: true } },
    { window: { doNotTrack: '1' } },
    { referrer: 'https://external.example/user/private?email=secret' },
    { referrer: 'https://external.example/?token=secret' },
    { referrer: 'https://external.example/#secret' },
    { referrer: 'not a URL' },
  ]) assert.equal(boot(options).appended.length, 0);
  const enabled = boot({ referrer: 'https://external.example/' });
  assert.equal(enabled.appended.length, 1);
  assert.equal(enabled.appended[0].src, '/_vercel/insights/script.js');
  assert.equal(enabled.appended[0].referrerPolicy, 'no-referrer');
});

test('the site CTA and beforeSend call sites sanitize URLs, payloads and event names', () => {
  const app = boot({ href: 'https://accordo.dev/developers.html?email=secret&utm_source=dev&utm_campaign=quote-approval#token' });
  assert.deepEqual(app.beforeSend({ type: 'pageview', url: 'https://evil.example/customer/secret?password=secret', payload: { secret: true } }),
    { type: 'pageview', url: 'https://accordo.dev/developers.html' });
  for (const name of ['purchase', '__proto__', 'constructor', 'email=secret', null]) {
    app.click(name);
    assert.equal(app.beforeSend({ type: 'event', payload: { name } }), null);
  }
  assert.equal(app.events().length, 0);
  for (const name of ['tutorial_open', 'example_open', 'quickstart_open']) {
    app.click(name);
    assert.deepEqual(app.beforeSend({ type: 'event', url: 'secret', payload: { name, data: { email: 'secret' } } }), {
      type: 'event', url: 'https://accordo.dev/developers.html',
      payload: { name, data: { source: 'dev', campaign_id: 'quote-approval' } },
    });
  }
  assert.equal(app.events().length, 3);
  assert.doesNotMatch(JSON.stringify(app.events()), /secret|email|token/);
  assert.equal(app.beforeSend({ type: 'identify', payload: { userId: 'secret' } }), null);
  app.navigator.globalPrivacyControl = true;
  app.click('tutorial_open');
  assert.equal(app.events().length, 3);
  assert.equal(app.beforeSend({ type: 'pageview' }), null);
});

test('site attribution admits only the fixed campaign and source enum, with no persistence', () => {
  for (const source of ['dev', 'hashnode', 'skills', 'gemini', 'smithery']) {
    const app = boot({ href: `https://accordo.dev/developers.html?utm_source=${source}&utm_campaign=quote-approval` });
    app.click('example_open');
    assert.deepEqual(app.events(), [['event', { name: 'example_open', data: { source, campaign_id: 'quote-approval' } }]]);
  }
  for (const query of ['', '?utm_source=private@example.org&utm_campaign=quote-approval', '?utm_source=dev&utm_campaign=secret']) {
    const app = boot({ href: `https://accordo.dev/developers.html${query}` });
    app.click('example_open');
    assert.deepEqual(app.events(), [['event', { name: 'example_open' }]]);
  }
  assert.doesNotMatch(script, /localStorage|sessionStorage|document\.cookie|enableCookie/);
  assert.doesNotMatch(script, /options\s*:|flags\s*:|route\s*:|window\.va\(['"](?:identify|group|pageview)['"]/);
});

test('site analytics uses the shared emitter and same-origin CSP without inline execution', () => {
  const build = readFileSync(new URL('../scripts/site-build.js', import.meta.url), 'utf8');
  assert.match(build, /analytics\.js.*data-page=/);
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const headers = config.headers.flatMap((entry) => entry.headers);
  const csp = headers.find((entry) => entry.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self';/);
  assert.doesNotMatch(csp, /script-src[^;]*(unsafe-inline|unsafe-eval|https:)/);
  assert.equal(headers.find((entry) => entry.key === 'Referrer-Policy').value, 'no-referrer');
});
