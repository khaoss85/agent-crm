// @ts-check
/**
 * Magic-link pure rules (backlog:0cbae947, BO-F0-05).
 *
 * No database, no clock, no network: every decidable rule is pinned here.
 * The operations that use these rules are proven in tests/magic-link.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOGIN_EMAIL_MAX,
  MAGIC_LINK_REASON,
  MAGIC_LINK_TOKEN_RE,
  MAGIC_LINK_TTL_MS,
  assertEmailHashSecretRef,
  hashLoginEmail,
  isMagicLinkExpired,
  magicLinkExpiry,
  magicLinkRequestReceipt,
  magicLinkSendKey,
  mintMagicLinkToken,
  normalizeLoginEmail,
  requireClockMs,
  requireMagicLinkToken,
} from '../packages/magic-link/src/rules.js';

test('validity is exactly ten minutes', () => {
  assert.equal(MAGIC_LINK_TTL_MS, 10 * 60 * 1000);
  assert.equal(magicLinkExpiry(1_000_000), 1_000_000 + 600_000);
});

test('expiry boundary: the deadline instant itself is already dead', () => {
  const issuedAt = 1_000_000;
  const record = { expiresAtMs: magicLinkExpiry(issuedAt) };
  assert.equal(isMagicLinkExpired(record, record.expiresAtMs - 1), false);
  assert.equal(isMagicLinkExpired(record, record.expiresAtMs), true);
  assert.equal(isMagicLinkExpired(record, record.expiresAtMs + 1), true);
});

test('minted tokens are closed-format and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const token = mintMagicLinkToken();
    assert.match(token, MAGIC_LINK_TOKEN_RE);
    assert.ok(!seen.has(token), 'two mints must never collide');
    seen.add(token);
  }
});

test('malformed tokens are refused before any store is touched', () => {
  for (const junk of ['', 'ml1.', 'ml1.xyz', 'ML1.abcdef', 'ml1.' + 'a'.repeat(31), 'ml1.' + 'a'.repeat(33), 'ml2.' + 'a'.repeat(32), null, 42, {}, ' ml1.' + 'a'.repeat(32)]) {
    assert.throws(() => requireMagicLinkToken(junk), /ml1\.<32-hex>/, JSON.stringify(junk));
  }
  assert.equal(requireMagicLinkToken(`ml1.${'b'.repeat(32)}`), `ml1.${'b'.repeat(32)}`);
});

test('login emails normalize and refuse like the rest of the framework', () => {
  assert.equal(normalizeLoginEmail('  Elena@StudioAurora.it '), 'elena@studioaurora.it');
  assert.throws(() => normalizeLoginEmail('not-an-email'), /valid email/);
  assert.throws(() => normalizeLoginEmail('a@b'), /valid email/);
  assert.throws(() => normalizeLoginEmail(''), /1-200/);
  assert.throws(() => normalizeLoginEmail(`a@${'b'.repeat(LOGIN_EMAIL_MAX)}.it`), /1-200/);
  assert.throws(() => normalizeLoginEmail('a\u0000@b.it'), /control characters/);
  assert.throws(() => normalizeLoginEmail(null), /must be a string/);
});

test('email hashes are HMACs under the deployment secret, never the address', () => {
  const first = hashLoginEmail('elena@studioaurora.it', 'deployment-secret');
  assert.equal(first, hashLoginEmail('elena@studioaurora.it', 'deployment-secret'));
  assert.equal(first.length, 64);
  assert.ok(!first.includes('elena'), 'the hash must not contain the address');
  assert.notEqual(first, hashLoginEmail('elena@other.it', 'deployment-secret'));
  assert.notEqual(first, hashLoginEmail('elena@studioaurora.it', 'another-secret'),
    'without the secret a dump cannot be dictionary-attacked back to the mailbox');
  for (const missing of ['', undefined]) {
    try {
      hashLoginEmail('elena@studioaurora.it', /** @type {any} */ (missing));
      assert.fail('must refuse without custody');
    } catch (error) {
      assert.equal(/** @type {any} */ (error)?.details?.field, 'emailHashSecretRef');
    }
  }
});

test('the email-hash secret locator is a reference, never a value', () => {
  assert.equal(assertEmailHashSecretRef('vault://production/magic-link-email-hash'), 'vault://production/magic-link-email-hash');
  assert.equal(assertEmailHashSecretRef('secret://tenant/login-hash'), 'secret://tenant/login-hash');
  for (const junk of ['', 'raw-secret-value', 'tok_abc123', 'vault://', 'http://vault/x', null, 42, {}, 'a'.repeat(257)]) {
    assert.throws(() => assertEmailHashSecretRef(junk), /emailHashSecretRef/, JSON.stringify(junk));
  }
});

test('the request receipt is a fresh identical envelope on every call', () => {
  const first = magicLinkRequestReceipt();
  const second = magicLinkRequestReceipt();
  assert.deepEqual(first, second);
  assert.equal(first.status, 'link-requested');
  assert.ok(String(first.message).includes('10 minuti'));
  assert.notEqual(first, second, 'mutating one receipt must not poison the next');
});

test('refusal codes are stable', () => {
  assert.deepEqual({ ...MAGIC_LINK_REASON }, {
    INVALID: 'MAGIC_LINK_INVALID',
    EXPIRED: 'MAGIC_LINK_EXPIRED',
    NOT_CONFIGURED: 'MAGIC_LINK_NOT_CONFIGURED',
    CLOCK_FAILED: 'MAGIC_LINK_CLOCK_FAILED',
    SECRET_UNAVAILABLE: 'MAGIC_LINK_SECRET_UNAVAILABLE',
    STORE_FAILED: 'MAGIC_LINK_STORE_FAILED',
  });
});

test('the send key is deterministic per token and refuses junk', () => {
  const token = `ml1.${'a'.repeat(32)}`;
  assert.equal(magicLinkSendKey(token), `magic-link:${token}`);
  assert.throws(() => magicLinkSendKey('not-a-token'), /ml1\.<32-hex>/);
  assert.throws(() => magicLinkSendKey(''), /ml1\.<32-hex>/);
});

test('clock readings fail closed: only finite integer ms >= 0 pass', () => {
  assert.equal(requireClockMs(0), 0);
  assert.equal(requireClockMs(1_700_000_000_000), 1_700_000_000_000);
  /** @param {any} error */
  const isClockFailure = (error) => error?.code === 'MAGIC_LINK_CLOCK_FAILED' && error?.status === 502;
  for (const broken of [NaN, Infinity, -Infinity, -1, 1.5, 'now', null, undefined, {}, true]) {
    assert.throws(() => requireClockMs(broken), isClockFailure, `clock ${String(broken)} must refuse`);
  }
  try {
    requireClockMs(NaN);
    assert.fail('must refuse');
  } catch (error) {
    assert.ok(isClockFailure(error), 'the refusal carries the clock code with a 502, never a receipt');
  }
});
