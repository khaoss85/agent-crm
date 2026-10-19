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
  hashLoginEmail,
  isMagicLinkExpired,
  magicLinkExpiry,
  magicLinkRequestReceipt,
  mintMagicLinkToken,
  normalizeLoginEmail,
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

test('email hashes are stable, salted to this purpose, and never the address', () => {
  const first = hashLoginEmail('elena@studioaurora.it');
  assert.equal(first, hashLoginEmail('elena@studioaurora.it'));
  assert.equal(first.length, 64);
  assert.ok(!first.includes('elena'), 'the hash must not contain the address');
  assert.notEqual(first, hashLoginEmail('elena@other.it'));
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
  });
});
