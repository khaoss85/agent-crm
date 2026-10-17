import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import {
  createFixtureChannelAdapter,
  fixtureEventBody,
} from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Channels behavior tests (backlog:e5532d1c9146): registration, activation,
 * verified ingest (apply / replay / forgery / out-of-order / quarantine),
 * sends with retries, the dead-letter queue, requeue, cross-space refusal
 * and the no-secrets scan — on real sqlite, real module services, the real
 * durable-job store and the real worker. The kit acceptance itself runs
 * last, against the same harness.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const ACCOUNT_A = '+390200000001';
const SECRET_REF = 'vault://kit/channel-a';
const SECRET = 'kit-secret-value-1';

function setup(options = {}) {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'channel-kit-ops', config: options.config,
  });
  return { harness, api, definition };
}

async function registeredActive(harness, space = SPACE_A, account = ACCOUNT_A) {
  const reg = await harness.register(space, {
    channel: 'whatsapp', account, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

test('registration binds one account per space; repeats resolve, conflicts refuse', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const input = {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  };
  const first = await harness.register(SPACE_A, input);
  assert.equal(first.duplicate, false);
  assert.equal(first.connection.status, 'pending');
  assert.equal(first.connection.secretRef, SECRET_REF);
  const second = await harness.register(SPACE_A, input);
  assert.equal(second.duplicate, true);
  assert.equal(second.connection.id, first.connection.id);
  await assert.rejects(
    harness.register(SPACE_A, { ...input, secretRef: 'vault://kit/other' }),
    (e) => e.code === 'CHANNEL_CONNECTION_CONFLICT',
  );
  await assert.rejects(
    harness.register(SPACE_A, { ...input, actor: { type: 'system', id: 'x' } }),
    (e) => e.code === 'HUMAN_APPROVAL_REQUIRED',
  );
});

test('status actions move pending to active through the real action', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const row = harness.ops.getConnection(SPACE_A, key);
  assert.equal(row.status, 'active');
});

test('ingest applies, replays idempotently and refuses forgeries without writing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = fixtureEventBody({ id: 'evt-1', subject: 'chat-1', seq: 1 });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: harness.faults.sign(rawBody) });
  assert.equal(out.effect, 'applied');
  assert.equal(out.duplicate ?? false, false);
  const replay = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: harness.faults.sign(rawBody) });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.eventId, out.eventId);
  assert.equal(harness.inbox(SPACE_A).length, 1, 'a replay creates no row and no audit beyond the read');
  const forged = fixtureEventBody({ id: 'evt-forged', subject: 'chat-1', seq: 2 });
  const headers = harness.faults.sign(forged);
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: { ...headers, 'x-channel-signature-256': '0'.repeat(64) } }),
    (e) => e.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).length, 1, 'a forgery writes nothing');
});

test('out-of-order deliveries never regress the subject; unknown subjects quarantine', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const newer = fixtureEventBody({ id: 'evt-n', subject: 'chat-ooo', seq: 2 });
  const older = fixtureEventBody({ id: 'evt-o', subject: 'chat-ooo', seq: 1 });
  const applied = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: newer, headers: harness.faults.sign(newer) });
  assert.equal(applied.effect, 'applied');
  const ignored = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: older, headers: harness.faults.sign(older) });
  assert.equal(ignored.effect, 'ignored');
  const noSubject = fixtureEventBody({ id: 'evt-nosub', subject: '', seq: 1 });
  const quarantined = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: noSubject, headers: harness.faults.sign(noSubject) });
  assert.equal(quarantined.effect, 'quarantined');
});

test('inactive connections quarantine inbound as evidence and refuse sends', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  const rawBody = fixtureEventBody({ id: 'evt-pending-1', subject: 'chat-1', seq: 1 });
  const out = await harness.ingest(SPACE_A, { connectionKey: reg.connection.sourceKey, rawBody, headers: harness.faults.sign(rawBody) });
  assert.equal(out.effect, 'quarantined');
  assert.equal(out.quarantined, true);
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: reg.connection.sourceKey, message: { to: ACCOUNT_A, text: 'hi' }, messageKey: 'k1' }),
    (e) => e.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );
});

test('sends ride the outbox: same key queues once, the provider sends once', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const message = { to: ACCOUNT_A, text: 'hello' };
  const first = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'm-once' });
  const second = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'm-once' });
  assert.equal(first.jobId, second.jobId, 'the idempotency root resolves identically');
  const settled = await harness.pump(first.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1);
  assert.equal(harness.letters(SPACE_A).length, 0);
});

test('transient failures retry with backoff and then succeed; the provider sends once', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.setMode('flaky', 2);
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'retry me' }, messageKey: 'm-retry' });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(settled.attempt, 3, 'two failures then success on the third execution');
  assert.equal(api.state.sendCalls, 3);
  assert.equal(api.state.sentByKey.size, 1, 'one effective provider send under retries');
});

test('permanent failures settle terminally on the first attempt, with a dead letter', async (t) => {
  const { harness, api } = setup({ config: { maxSendAttempts: 3 } });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.setMode('refuse');
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'doomed' }, messageKey: 'm-doom' });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  assert.equal(settled.attempt, 1, 'a permanent refusal never rides a retry');
  const letters = harness.letters(SPACE_A, 'open');
  assert.equal(letters.length, 1);
  assert.equal(letters[0].errorCode, 'CHANNEL_SEND_REFUSED');
  assert.equal(letters[0].attempts, 1);
  assert.match(letters[0].payloadFingerprint, /^[0-9a-f]{64}$/);
  const dumped = JSON.stringify(letters[0]);
  assert.ok(!dumped.includes('doomed'), 'the letter carries a fingerprint, never the payload');
});

test('transient failures that never heal exhaust the bounded attempts, then letter', async (t) => {
  const { harness, api } = setup({ config: { maxSendAttempts: 3 } });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.setMode('flaky', 99);
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'unlucky' }, messageKey: 'm-unlucky' });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  assert.equal(settled.attempt, 3, 'exactly the bounded attempts, then stop — never silent infinite retry');
  const letters = harness.letters(SPACE_A, 'open');
  assert.equal(letters.length, 1);
  assert.equal(letters[0].errorCode, 'CHANNEL_SEND_TRANSIENT');
  assert.equal(letters[0].attempts, 3);
});

test('requeue retries an open letter with a human-supplied message', async (t) => {
  const { harness, api } = setup({ config: { maxSendAttempts: 2 } });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.setMode('refuse');
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'first try' }, messageKey: 'm-req' });
  await harness.pump(queued.jobId);
  const [letter] = harness.letters(SPACE_A, 'open');
  api.setMode('ok');
  const requeued = await harness.ops.requeueChannelLetter({
    spaceId: SPACE_A, letterId: letter.id,
    message: { to: ACCOUNT_A, text: 'second try' }, actor: harness.userActor,
  });
  const settled = await harness.pump(requeued.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(harness.letters(SPACE_A, 'open').length, 0);
  assert.equal(harness.letters(SPACE_A, 'requeued').length, 1);
});

test('messages carrying secret-shaped keys are refused before the outbox', async (t) => {
  // A pass-through adapter normalization keeps the hostile key, so the
  // package scan — not just the adapter — must refuse it.
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const passthrough = {
    ...definition,
    name: 'passthrough-channel',
    normalizeOutbound: (message) => message,
  };
  const harness = createChannelsHarness({
    adapterDefinition: passthrough, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-passthrough',
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'passthrough-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  await assert.rejects(
    harness.queue(SPACE_A, {
      connectionKey: reg.connection.sourceKey,
      message: { to: ACCOUNT_A, text: 'hi', apiKey: 'xxx' }, messageKey: 'm-bad',
    }),
    (e) => e.code === 'CHANNEL_MESSAGE_MALFORMED',
  );
  assert.equal((await harness.jobs()).length, 0, 'refused messages never reach the outbox');
});

test('cross-space calls never touch another space', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, SPACE_A, ACCOUNT_A);
  await assert.rejects(
    harness.ingest(SPACE_B, { connectionKey: keyA, rawBody: fixtureEventBody({ id: 'x' }), headers: harness.faults.sign('{}') }),
    (e) => e.code === 'CHANNEL_CONNECTION_UNKNOWN',
  );
  await assert.rejects(
    harness.queue(SPACE_B, { connectionKey: keyA, message: { to: ACCOUNT_A, text: 'x' }, messageKey: 'x' }),
    (e) => e.code === 'CHANNEL_CONNECTION_UNKNOWN',
  );
  assert.equal(harness.inbox(SPACE_B).length, 0);
  assert.equal(harness.letters(SPACE_B).length, 0);
});

test('no secret material rests in rows, audit or jobs', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = fixtureEventBody({ id: 'evt-sec-1', subject: 'chat-1', seq: 1 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: harness.faults.sign(rawBody) });
  api.setMode('flaky', 1);
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'secretless' }, messageKey: 'm-sec' });
  await harness.pump(queued.jobId);
  const dump = harness.dumpStorage();
  assert.ok(!dump.includes(SECRET), 'secret value appears nowhere in stored rows, audit or jobs');
  assert.ok(dump.includes(SECRET_REF), 'the reference is what is stored');
});

test('unwired composition refuses instead of inventing custody or tenancy', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const bare = createChannelOperations({ ...harness.internals });
  await assert.rejects(
    bare.queueChannelSend({ spaceId: SPACE_A, connectionKey: key, message: { to: ACCOUNT_A, text: 'hi' }, messageKey: 'k', actor: harness.userActor }),
    (e) => e.code === 'CHANNEL_TENANT_UNBOUND',
  );
  const rawBody = fixtureEventBody({ id: 'evt-bare-1', subject: 'chat-1', seq: 1 });
  await assert.rejects(
    bare.ingestChannelEvent({ spaceId: SPACE_A, connectionKey: key, rawBody, headers: harness.faults.sign(rawBody) }),
    (e) => e.code === 'CHANNEL_SECRET_UNAVAILABLE',
  );
});

test('the fixture adapter passes the channel kit (receive, send, replay, bad signature, out-of-order)', async (t) => {
  const { harness, api, definition } = setup({ tenantId: 'channel-kit-acceptance' });
  t.after(() => harness.close());
  const results = await runChannelAdapterKit({
    adapter: definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    spaceA: SPACE_A,
    spaceB: SPACE_B,
    accountA: ACCOUNT_A,
    accountB: '+390200000099',
    actor: harness.userActor,
    harness: {
      register: (spaceId, input) => harness.register(spaceId, input),
      activate: (spaceId, key) => harness.activate(spaceId, key),
      ingest: (spaceId, args) => harness.ingest(spaceId, args),
      queue: (spaceId, args) => harness.queue(spaceId, args),
      pump: (jobId) => harness.pump(jobId),
      faults: harness.faults,
      connections: (spaceId) => harness.connections(spaceId),
      inbox: (spaceId) => harness.inbox(spaceId),
      letters: (spaceId, state) => harness.letters(spaceId, state),
      dumpStorage: () => harness.dumpStorage(),
    },
  });
  void api;
  const failed = results.filter((row) => !row.pass);
  assert.deepEqual(failed, [], `kit failures: ${JSON.stringify(failed)}`);
  assert.deepEqual(results.map((row) => row.name), [
    'receive', 'send', 'replay', 'bad-signature', 'out-of-order', 'no-secrets', 'space-isolation',
  ]);
});
