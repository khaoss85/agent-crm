import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNELS,
  ChannelRegistries,
  validateChannelAdapter,
} from '../packages/channels/src/adapter.js';
import {
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  assertConnectionInput,
  assertConnectionTransition,
  assertSecretReference,
  assertSpaceId,
  boundedKey,
  channelSendIdempotencyKey,
} from '../packages/channels/src/connection.js';
import {
  fingerprintPayload,
  hmacWebhookHeaders,
  verifyHmacWebhook,
} from '../packages/channels/src/crypto.js';

/**
 * Channels contract tests (backlog:e5532d1c9146): the adapter contract, the
 * connection identity rules, webhook verification primitives. No database,
 * no worker — pure contract.
 */

const adapter = (overrides = {}) => ({
  name: 'fixture-channel',
  version: 1,
  label: 'Fixture',
  channel: 'whatsapp',
  config: { testOnly: true },
  verifyInbound: async () => ({ ok: true, event: '{}' }),
  normalizeInbound: () => ({ providerEventId: 'e1' }),
  normalizeOutbound: (message) => message,
  sendOutbound: async () => ({ providerMessageId: 'wamid.1' }),
  ...overrides,
});

const registries = () => new ChannelRegistries({ channelAdapters: [adapter()] });

const connectionInput = (overrides = {}) => ({
  spaceId: 'presti',
  channel: 'whatsapp',
  account: '+390200000001',
  adapter: 'fixture-channel',
  adapterVersion: 1,
  secretRef: 'vault://presti/whatsapp-a',
  ...overrides,
});

test('adapter identity validates fail-closed', () => {
  assert.doesNotThrow(() => validateChannelAdapter(adapter()));
  assert.throws(() => validateChannelAdapter(adapter({ name: 'Fixture Channel' })), /adapter name must match/);
  assert.throws(() => validateChannelAdapter(adapter({ name: '__proto__' })), /adapter name must match/);
  assert.throws(() => validateChannelAdapter(adapter({ version: 0 })), /positive integer/);
  assert.throws(() => validateChannelAdapter(adapter({ channel: 'pigeon' })), /channel must be one of/);
  assert.throws(() => validateChannelAdapter(adapter({ config: { when: new Date(0) } })), /JSON-safe/);
  assert.throws(() => validateChannelAdapter(adapter({ config: 'x' })), /JSON-safe/);
  for (const handler of ['verifyInbound', 'normalizeInbound', 'normalizeOutbound', 'sendOutbound']) {
    assert.throws(() => validateChannelAdapter(adapter({ [handler]: 'nope' })), new RegExp(`${handler} must be a function`));
  }
  assert.throws(() => validateChannelAdapter({ ...adapter(), extra: 1 }), /unsupported field/);
  assert.deepEqual([...CHANNELS].length > 0, true);
});

test('adapter registry is unique per identity and fingerprinted', () => {
  const registry = registries();
  const entry = registry.getAdapter('fixture-channel', 1);
  assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  assert.throws(() => registry.getAdapter('fixture-channel', 2), (e) => e.code === 'CHANNEL_ADAPTER_UNKNOWN');
  assert.throws(() => registry.getAdapter('__proto__', 1), (e) => e.code === 'CHANNEL_ADAPTER_UNKNOWN');
  assert.throws(() => new ChannelRegistries({ channelAdapters: [adapter(), adapter()] }), /Duplicate channel adapter identity/);
  // Same name, another version coexists; config drift changes the fingerprint.
  const two = new ChannelRegistries({ channelAdapters: [adapter(), adapter({ version: 2 })] });
  assert.equal(two.getAdapter('fixture-channel', 2).definition.version, 2);
  const drifted = new ChannelRegistries({ channelAdapters: [adapter({ config: { testOnly: false } })] });
  assert.notEqual(drifted.getAdapter('fixture-channel', 1).fingerprint, entry.fingerprint);
  const metadata = registry.metadata();
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), metadata, 'metadata JSON round-trips');
  assert.equal(JSON.stringify(metadata).includes('function'), false);
});

test('space ids are slugs, never inferred', () => {
  assert.equal(assertSpaceId('presti'), 'presti');
  for (const bad of ['', 'Presti', 'pre sti', 'a'.repeat(64), null, 42, 'pre_sti']) {
    assert.throws(() => assertSpaceId(bad), /spaceId must be a lowercase slug/);
  }
});

test('secret references are locators, never values', () => {
  assert.equal(assertSecretReference('vault://presti/whatsapp-a'), 'vault://presti/whatsapp-a');
  assert.equal(assertSecretReference('secret://presti/whatsapp-a'), 'secret://presti/whatsapp-a');
  for (const bad of ['', 'has space', 'emoji-🔑', 'a'.repeat(257), '__proto__', 'constructor', 'line\nbreak', 'sk-live-abc def',
    // A bare token — however bounded — is not a locator: the fixture secret
    // VALUE itself must be refused, so a rotated value pasted in place of
    // its reference can never land in a row or an audit trail.
    'kit-secret-value-1', 'simplereference123', 'vault://', 'vault:// with space']) {
    assert.throws(() => assertSecretReference(bad), /secretRef must be a bounded reference locator/);
  }
});

test('connection input binds one account per space and channel', () => {
  const out = assertConnectionInput(connectionInput(), registries());
  assert.equal(out.sourceKey, 'ch-conn:presti:whatsapp:+390200000001'.toLowerCase());
  assert.equal(out.adapterFingerprint.length, 64);
  assert.throws(() => assertConnectionInput(connectionInput({ channel: 'sms' }), registries()), /serves channel "whatsapp", not "sms"/);
  assert.throws(() => assertConnectionInput(connectionInput({ adapter: 'nope' }), registries()), (e) => e.code === 'CHANNEL_ADAPTER_UNKNOWN');
  assert.throws(() => assertConnectionInput(connectionInput({ account: '' }), registries()), /account must be bounded/);
  assert.throws(() => assertConnectionInput(connectionInput({ secretRef: 'plain-secret-value with space' }), registries()), /secretRef/);
});

test('connection status moves on an explicit table; revoked never regresses', () => {
  assert.deepEqual([...CONNECTION_STATUSES], ['pending', 'active', 'suspended', 'revoked']);
  assert.doesNotThrow(() => assertConnectionTransition('pending', 'active'));
  assert.doesNotThrow(() => assertConnectionTransition('active', 'suspended'));
  assert.doesNotThrow(() => assertConnectionTransition('suspended', 'active'));
  assert.doesNotThrow(() => assertConnectionTransition('active', 'revoked'));
  for (const [from, to] of [['revoked', 'active'], ['revoked', 'pending'], ['active', 'pending'], ['suspended', 'pending'], ['active', 'active']]) {
    assert.throws(() => assertConnectionTransition(from, to), /cannot move/);
  }
  assert.deepEqual(CONNECTION_TRANSITIONS.revoked, []);
});

test('send idempotency keys are deterministic per space, connection and message', () => {
  const key = channelSendIdempotencyKey({ spaceId: 'presti', connectionKey: 'ch-conn:presti:whatsapp:x', messageKey: 'm1' });
  assert.equal(key, 'ch-send:presti:ch-conn:presti:whatsapp:x:m1', 'short keys stay readable');
  assert.equal(key, channelSendIdempotencyKey({ spaceId: 'presti', connectionKey: 'ch-conn:presti:whatsapp:x', messageKey: 'm1' }));
  assert.notEqual(key, channelSendIdempotencyKey({ spaceId: 'arvo', connectionKey: 'ch-conn:presti:whatsapp:x', messageKey: 'm1' }));
});

test('boundedKey keeps every package key within 128 per part and 256 total', () => {
  // One function for every key of the package (review round 2): send,
  // requeue, connection/inbox/dead-letter source keys. Each shape is tried
  // at its legal maximum, and every ':'-separated part stays within 128.
  const shapes = [
    ['ch-send', 'presti', `ch-conn:presti:whatsapp:${'a'.repeat(256)}`, 'm'.repeat(256)],
    ['ch-send', 'presti', 'ch-conn:presti:whatsapp:x', `requeue:letter-id-1`, 'f'.repeat(64)],
    ['ch-conn', 'presti', 'whatsapp', 'a'.repeat(256)],
    ['ch-in', 'presti', `ch-conn:presti:whatsapp:${'a'.repeat(256)}`, 'e'.repeat(256)],
    ['ch-dl', 'k'.repeat(256)],
  ];
  for (const parts of shapes) {
    const key = boundedKey(...parts);
    assert.ok(key.length <= 256, `bounded key fits 256, got ${key.length} for ${parts[0]}`);
    for (const component of key.split(':')) {
      assert.ok(component.length <= 128, `component fits 128, got ${component.length} in ${key}`);
    }
    assert.equal(key, boundedKey(...parts), 'the bounded form is deterministic, so redelivery dedups');
  }
  assert.equal(boundedKey('ch-send', 'presti', 'c', 'm'), 'ch-send:presti:c:m', 'short keys stay readable');
  assert.notEqual(
    boundedKey('ch-send', 'presti', 'c', 'f'.repeat(64)),
    boundedKey('ch-send', 'presti', 'c', 'e'.repeat(64)),
    'the message fingerprint is part of the key, so different content keys differently',
  );
});

test('send idempotency keys stay within the outbox bound at max-length inputs', () => {
  // A 256-char account is legal at registration, so its connection key is
  // ~280 chars: the readable form would overflow both the old 128-char
  // component bound and the durable-jobs 256-char idempotencyRoot bound.
  const connectionKey = `ch-conn:presti:whatsapp:${'a'.repeat(256)}`;
  const messageKey = 'm'.repeat(256);
  const key = channelSendIdempotencyKey({ spaceId: 'presti', connectionKey, messageKey });
  assert.ok(key.length <= 256, `hashed form fits the outbox bound, got ${key.length}`);
  assert.equal(key, channelSendIdempotencyKey({ spaceId: 'presti', connectionKey, messageKey }), 'the long form is deterministic, so redelivery dedups');
  assert.notEqual(
    key,
    channelSendIdempotencyKey({ spaceId: 'presti', connectionKey, messageKey: `${'m'.repeat(255)}n` }),
    'a different message still keys differently',
  );
});

test('HMAC webhook verification sees the exact bytes and echoes nothing', () => {
  const secret = 'kit-secret-value-1';
  const body = JSON.stringify({ id: 'e1' });
  const nowSec = Math.floor(Date.now() / 1000);
  const headers = hmacWebhookHeaders(body, secret, nowSec);
  assert.equal(verifyHmacWebhook({ rawBody: body, signature: headers['x-channel-signature-256'], timestamp: headers['x-channel-timestamp'], secret }), true);
  assert.equal(verifyHmacWebhook({ rawBody: `${body} `, signature: headers['x-channel-signature-256'], timestamp: headers['x-channel-timestamp'], secret }), false);
  assert.equal(verifyHmacWebhook({ rawBody: body, signature: '0'.repeat(64), timestamp: headers['x-channel-timestamp'], secret }), false);
  assert.equal(verifyHmacWebhook({ rawBody: body, signature: headers['x-channel-signature-256'], timestamp: headers['x-channel-timestamp'], secret: 'wrong' }), false);
  assert.equal(verifyHmacWebhook({ rawBody: body, signature: headers['x-channel-signature-256'], timestamp: String(nowSec - 3600), secret }), false, 'stale timestamp refused');
  assert.equal(verifyHmacWebhook({ rawBody: body, signature: 'zz', timestamp: headers['x-channel-timestamp'], secret }), false);
  assert.equal(fingerprintPayload(body).length, 64);
  assert.notEqual(fingerprintPayload(body), fingerprintPayload(`${body} `));
});
