import test from 'node:test';
import assert from 'node:assert/strict';
import { getRandomValues } from 'node:crypto';

import {
  BODY_MAX,
  MIN_DWELL_MS,
  RATE_MAX_PER_WINDOW,
  RATE_WINDOW_MS,
  REASON,
  assertIpHashSecretRef,
  buildSnippet,
  evaluateSpam,
  hashIp,
  isHoneypotFilled,
  replyChannels,
  submissionSourceKey,
  validateFormFields,
} from '../packages/site-forms/src/rules.js';

/**
 * **Site-form rules (backlog:9d42035eca26).** Pure-function pins: field
 * bounds, the base anti-spam verdict, the reply-channel rule, the snippet
 * contract. No database, no clock beyond the passed instant.
 */

const FIELDS = Object.freeze({
  spaceId: 'presti',
  firstName: 'Luca',
  lastName: 'Rossi',
  email: 'Luca@PrestiGroup.example',
  phone: '+39 333 123 4567',
  companyName: 'Presti Group',
  body: 'Vorrei informazioni sui pacchetti.',
  ip: '203.0.113.7',
  honeypotFilled: false,
  dwellMs: 5000,
});

test('valid fields normalize email case and collapse message line breaks', () => {
  const fields = validateFormFields({ ...FIELDS, body: '  riga uno\nriga due\r\n  riga tre  ' });
  assert.equal(fields.email, 'luca@prestigroup.example');
  assert.equal(fields.body, 'riga uno riga due riga tre');
  assert.equal(fields.spaceId, 'presti');
});

test('missing or hostile fields refuse fail-closed', () => {
  assert.throws(() => validateFormFields(null), /form request object is required/);
  assert.throws(() => validateFormFields({ ...FIELDS, spaceId: 'Presti!' }), /lowercase slug/);
  assert.throws(() => validateFormFields({ ...FIELDS, email: 'not-an-address' }), /valid address shape/);
  assert.throws(() => validateFormFields({ ...FIELDS, phone: 'abc' }), /at least 5 digits/);
  assert.throws(() => validateFormFields({ ...FIELDS, body: '   ' }), /body is required/);
  assert.throws(() => validateFormFields({ ...FIELDS, body: 'x'.repeat(BODY_MAX + 1) }), /at most 2000/);
  assert.throws(() => validateFormFields({ ...FIELDS, body: 'ok\x07bell' }), /control characters/);
  assert.throws(() => validateFormFields({ ...FIELDS, ip: '' }), /ip is required/);
  assert.throws(() => validateFormFields({ ...FIELDS, ip: undefined }), /ip is required/);
  assert.throws(
    () => validateFormFields({ ...FIELDS, ipHash: 'a'.repeat(64) }),
    /must not be supplied/,
    'even a well-formed caller ipHash is refused',
  );
  assert.throws(
    () => validateFormFields({ ...FIELDS, ipHash: '203.0.113.7' }),
    /must not be supplied/,
    'a raw address smuggled as ipHash is refused, never stored',
  );
  assert.throws(() => validateFormFields({ ...FIELDS, dwellMs: -1 }), /dwellMs/);
  assert.throws(() => validateFormFields({ ...FIELDS, email: null, phone: null }), /phone number or an email/);
});

test('the honeypot trap is strict: only an empty trap passes', () => {
  assert.equal(isHoneypotFilled(false), false);
  assert.equal(isHoneypotFilled(undefined), false);
  assert.equal(isHoneypotFilled(null), false);
  assert.equal(isHoneypotFilled(''), false);
  assert.equal(isHoneypotFilled(true), true);
  assert.equal(isHoneypotFilled(1), true);
  assert.equal(isHoneypotFilled(0), true, 'fail-closed: a number is never the snippet boolean');
  assert.equal(isHoneypotFilled('true'), true);
  assert.equal(isHoneypotFilled('x'), true);
  assert.equal(validateFormFields({ ...FIELDS, honeypotFilled: 1 }).honeypotFilled, true);
  assert.equal(validateFormFields({ ...FIELDS, honeypotFilled: 'true' }).honeypotFilled, true);
  assert.equal(validateFormFields({ ...FIELDS, honeypotFilled: false }).honeypotFilled, false);
});

test('the secret locator is a reference, never a value', () => {
  assert.equal(assertIpHashSecretRef('vault://presti/site-forms-ip'), 'vault://presti/site-forms-ip');
  assert.equal(assertIpHashSecretRef('secret://presti/site-forms-ip'), 'secret://presti/site-forms-ip');
  assert.throws(() => assertIpHashSecretRef('a'.repeat(64)), /never a secret value/);
  assert.throws(() => assertIpHashSecretRef('sk_live_abc'), /never a secret value/);
  assert.throws(() => assertIpHashSecretRef(''), /never a secret value/);
  assert.throws(() => assertIpHashSecretRef(42), /never a secret value/);
});

test('the reply-channel rule follows phone/email presence', () => {
  assert.deepEqual(replyChannels({ phone: '+393331234567', email: null }), { whatsapp: true, email: false });
  assert.deepEqual(replyChannels({ phone: null, email: 'a@b.example' }), { whatsapp: false, email: true });
  assert.deepEqual(
    replyChannels({ phone: '+393331234567', email: 'a@b.example' }),
    { whatsapp: true, email: true },
  );
  assert.throws(() => replyChannels({ phone: null, email: null }), /phone number or an email/);
});

test('spam verdict: honeypot, dwell and the rate window', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(
    evaluateSpam({ honeypotFilled: true, dwellMs: 9000 }, [], now),
    { spam: true, reasonCode: REASON.HONEYPOT },
  );
  assert.deepEqual(
    evaluateSpam({ honeypotFilled: false, dwellMs: MIN_DWELL_MS - 1 }, [], now),
    { spam: true, reasonCode: REASON.TOO_FAST },
  );
  assert.deepEqual(
    evaluateSpam({ honeypotFilled: false, dwellMs: MIN_DWELL_MS }, [], now),
    { spam: false, reasonCode: null },
  );
  for (const trap of [1, 'true', 'x']) {
    assert.deepEqual(
      evaluateSpam({ honeypotFilled: trap, dwellMs: 9000 }, [], now),
      { spam: true, reasonCode: REASON.HONEYPOT },
      `trap ${JSON.stringify(trap)} fills the honeypot`,
    );
  }
  const full = Array.from({ length: RATE_MAX_PER_WINDOW }, (_, index) => now - index * 1000);
  assert.deepEqual(
    evaluateSpam({ honeypotFilled: false, dwellMs: 9000 }, full, now),
    { spam: true, reasonCode: REASON.RATE_LIMITED },
  );
  const aged = Array.from({ length: RATE_MAX_PER_WINDOW }, () => now - RATE_WINDOW_MS - 1);
  assert.deepEqual(
    evaluateSpam({ honeypotFilled: false, dwellMs: 9000 }, aged, now),
    { spam: false, reasonCode: null },
  );
});

test('submission source keys are bounded and space-scoped', () => {
  assert.equal(submissionSourceKey('presti', 'k1'), 'site-form:presti:k1');
  assert.equal(submissionSourceKey('presti', 'k1'), submissionSourceKey('presti', 'k1'));
  assert.notEqual(submissionSourceKey('presti', 'k1'), submissionSourceKey('altro', 'k1'));
  assert.throws(() => submissionSourceKey('presti', ''), /idempotencyKey/);
  assert.throws(() => submissionSourceKey('presti', 'x'.repeat(129)), /idempotencyKey/);
});

test('ip hashes are HMACs with the per-space secret, never the address', () => {
  const first = hashIp('203.0.113.7', 'presti', 'secret-presti');
  assert.equal(first, hashIp('203.0.113.7', 'presti', 'secret-presti'));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, hashIp('203.0.113.7', 'altro', 'secret-altro'), 'two spaces hash differently');
  assert.notEqual(first, hashIp('203.0.113.7', 'presti', 'secret-altro'), 'two secrets hash differently');
  assert.notEqual(first, hashIp('203.0.113.7', 'altro', 'secret-presti'), 'the space binds the hash too');
  assert.ok(!first.includes('203.0.113.7'));
  assert.throws(() => hashIp('', 'presti', 'secret-presti'), /ip is required/);
  assert.throws(() => hashIp('203.0.113.7', 'presti', ''), /custody is not wired/);
});

test('the snippet posts to the per-space route with a trap field', () => {
  const snippet = buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev' });
  assert.equal(snippet.action, 'https://app.accordo.dev/site/presti/submit');
  assert.ok(snippet.html.includes('data-accordo-space="presti"'));
  assert.ok(snippet.html.includes('name="website"'), 'the honeypot trap field');
  assert.ok(snippet.html.includes('dwellMs'), 'the dwell measurement');
  assert.ok(snippet.html.includes('idempotencyKey'), 'one render, one key');
  assert.ok(!snippet.html.includes('http://'), 'no insecure URL');
  assert.ok(!snippet.html.includes('captcha'), 'no paid anti-spam');
  assert.ok(!snippet.html.toLowerCase().includes('google'), 'no third party');
  assert.throws(() => buildSnippet({ spaceId: 'Presti!', endpoint: 'https://app.accordo.dev' }), /lowercase slug/);
  assert.throws(() => buildSnippet({ spaceId: 'presti', endpoint: 'http://app.accordo.dev' }), /https URL/);
  assert.throws(
    () => buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev', formId: '" onmouseover="alert(1)' }),
    /formId must be a lowercase slug/,
    'a hostile formId never reaches the snippet HTML attribute',
  );
  const named = buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev', formId: 'richiesta-presti' });
  assert.ok(named.html.includes('data-accordo-form="richiesta-presti"'));
});

/**
 * Run the generated snippet the way a pasted page would: one fake form, one
 * submit, one captured POST. A selector the page cannot parse (or a key the
 * page never sends) fails here instead of on the customer's site.
 */
function runSnippet(html, { nowMs, cryptoImpl }) {
  const script = html.split('<script>')[1].split('</script>')[0];
  const seen = { selectors: [], posts: [] };
  const form = {
    action: 'https://app.accordo.dev/site/presti/submit',
    website: { value: '' },
    firstName: { value: 'Luca' },
    lastName: { value: 'Rossi' },
    email: { value: 'luca@prestigroup.example' },
    phone: { value: '+393331234567' },
    companyName: { value: 'Presti Group' },
    body: { value: 'Vorrei informazioni sui pacchetti.' },
    addEventListener(name, handler) { this[`on${name}`] = handler; },
  };
  const document = {
    querySelector(selector) { seen.selectors.push(selector); return form; },
  };
  const fakeWindow = {};
  if (cryptoImpl !== undefined) fakeWindow.crypto = cryptoImpl;
  const fakeFetch = async (url, options) => {
    seen.posts.push({ url, options });
    return { ok: true };
  };
  const fakeDate = { now: () => nowMs };
  const run = new Function('document', 'window', 'crypto', 'fetch', 'Date', script);
  run(document, fakeWindow, cryptoImpl, fakeFetch, fakeDate);
  form.onsubmit({ preventDefault() {} });
  return seen;
}

function postedBody(seen) {
  assert.equal(seen.posts.length, 1, 'one submit posts once');
  const [post] = seen.posts;
  assert.equal(post.url, 'https://app.accordo.dev/site/presti/submit');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  return JSON.parse(post.options.body);
}

test('the pasted snippet selects the form and posts JSON', () => {
  const snippet = buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev' });
  const seen = runSnippet(snippet.html, { nowMs: 1_700_000_000_000, cryptoImpl: undefined });
  assert.deepEqual(seen.selectors, ['form[data-accordo-space="presti"]']);
  const body = postedBody(seen);
  assert.equal(body.spaceId, 'presti');
  assert.equal(body.dwellMs, 0);
  assert.equal(body.honeypotFilled, false);
  assert.equal(typeof body.idempotencyKey, 'string');
  assert.ok(body.idempotencyKey.length > 0, 'one render, one key');
  assert.equal(body.firstName, 'Luca');
  assert.equal(body.companyName, 'Presti Group');
  assert.equal(body.body, 'Vorrei informazioni sui pacchetti.');
});

test('every collected snippet key has a named input', () => {
  const snippet = buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev' });
  for (const key of ['firstName', 'lastName', 'email', 'phone', 'companyName', 'body']) {
    assert.ok(snippet.html.includes(`name="${key}"`), `the snippet renders an input for ${key}`);
  }
});

test('the snippet prefers a random UUID for the idempotency key', () => {
  const snippet = buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev' });
  const seen = runSnippet(snippet.html, {
    nowMs: 1_700_000_000_000,
    cryptoImpl: { randomUUID: () => 'uuid-per-render' },
  });
  assert.equal(postedBody(seen).idempotencyKey, 'uuid-per-render');
});

test('two snippet renders in the same millisecond never share a key', () => {
  const snippet = buildSnippet({ spaceId: 'presti', endpoint: 'https://app.accordo.dev' });
  assert.ok(!snippet.html.includes('String(Date.now())'), 'no bare-timestamp key');
  const keys = [0, 1].map(() => runSnippet(snippet.html, {
    nowMs: 1_700_000_000_000,
    cryptoImpl: { getRandomValues: (array) => getRandomValues(array) },
  }).posts);
  const first = JSON.parse(keys[0][0].options.body).idempotencyKey;
  const second = JSON.parse(keys[1][0].options.body).idempotencyKey;
  assert.notEqual(first, second, 'same millisecond, two renders, two keys');
});
