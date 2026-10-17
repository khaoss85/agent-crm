import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BODY_MAX,
  MIN_DWELL_MS,
  RATE_MAX_PER_WINDOW,
  RATE_WINDOW_MS,
  REASON,
  buildSnippet,
  evaluateSpam,
  hashIp,
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
  ipHash: 'h'.repeat(64),
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
  assert.throws(() => validateFormFields({ ...FIELDS, ipHash: '' }), /ipHash is required/);
  assert.throws(() => validateFormFields({ ...FIELDS, dwellMs: -1 }), /dwellMs/);
  assert.throws(() => validateFormFields({ ...FIELDS, email: null, phone: null }), /phone number or an email/);
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

test('ip hashes are deterministic per space and never the address', () => {
  const first = hashIp('203.0.113.7', 'presti');
  assert.equal(first, hashIp('203.0.113.7', 'presti'));
  assert.notEqual(first, hashIp('203.0.113.7', 'altro'));
  assert.ok(!first.includes('203.0.113.7'));
  assert.throws(() => hashIp('', 'presti'), /ip is required/);
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
