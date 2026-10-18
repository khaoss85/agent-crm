import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import {
  createFixtureChannelAdapter,
  fixtureEventBody,
} from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Channels behavior tests (backlog:e5532d1c9146): registration, activation,
 * verified ingest (apply / replay / forgery / out-of-order / quarantine /
 * verify-timeout / system-actor), sends with retries, the dead-letter queue,
 * cross-space refusal and the no-secrets scan — on real sqlite, real module
 * services, the real durable-job store and the real worker. The kit
 * acceptance itself runs last, against the same harness. Dead-letter requeue
 * is deferred to a follow-up voice and has no test here.
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

test('kernel-shaped secret keys and hostile keys are refused with the channel code', async (t) => {
  // MEM_ACC_REUSE: the package fails fast on the kernel SENSITIVE_KEY itself
  // (connectionString, databaseUrl) and on __proto__/constructor/prototype,
  // so callers always see CHANNEL_MESSAGE_MALFORMED, never a raw
  // DURABLE_JOB_PAYLOAD_INVALID from the enqueue.
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const passthrough = {
    ...definition,
    name: 'passthrough-channel',
    normalizeOutbound: (message) => message,
  };
  const harness = createChannelsHarness({
    adapterDefinition: passthrough, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-sensitive-reuse',
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'passthrough-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  for (const [name, message] of [
    ['connectionString', { to: ACCOUNT_A, text: 'hi', connectionString: 'postgres://user:pass@host/db' }],
    ['databaseUrl', { to: ACCOUNT_A, text: 'hi', databaseUrl: 'postgres://user:pass@host/db' }],
    ['proto', JSON.parse('{"to":"+390200000001","text":"hi","__proto__":{"polluted":true}}')],
  ]) {
    await assert.rejects(
      harness.queue(SPACE_A, { connectionKey: reg.connection.sourceKey, message, messageKey: `m-${name}` }),
      (e) => e.code === 'CHANNEL_MESSAGE_MALFORMED',
      `${name} refuses with the channel code`,
    );
  }
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
  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes(SECRET), 'secret value appears nowhere in stored rows, audit or jobs');
  assert.ok(dump.includes(SECRET_REF), 'the reference is what is stored');
  assert.ok(dump.includes('"jobs":'), 'the outbox is part of the scanned evidence');
  assert.ok(dump.includes('m-sec'), 'the queued job payload is scanned, not just rows and audit');
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

test('the fixture adapter passes the channel kit (receive, send, replay, bad signature, out-of-order, history)', async (t) => {
  const { harness, api, definition } = setup({ tenantId: 'channel-kit-acceptance' });
  t.after(() => harness.close());
  // Two recent items, so the history check pages a real past (limit 2:
  // one full page, then the exhausted tail) instead of an empty double.
  const at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  api.seedHistory([
    { id: 'evt-hist-1', subject: 'chat-kit-hist', seq: 1, at, sender: { handle: '+390200000011' } },
    { id: 'evt-hist-2', subject: 'chat-kit-hist', seq: 2, at, sender: { handle: '+390200000022' } },
  ]);
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
    'receive', 'send', 'replay', 'bad-signature', 'out-of-order', 'no-secrets', 'space-isolation', 'history',
  ]);
});

test('two connections in one space keep separate inbox identities', async (t) => {
  // The provider may reuse an event id across two accounts of one space:
  // each connection owns its event, never a single row for the space.
  const { harness } = setup();
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, SPACE_A, '+390200000001');
  const keyB = await registeredActive(harness, SPACE_A, '+390200000002');
  assert.notEqual(keyA, keyB);
  const rawBody = fixtureEventBody({ id: 'evt-shared-1', subject: 'chat-shared', seq: 1 });
  const headers = harness.faults.sign(rawBody);
  const first = await harness.ingest(SPACE_A, { connectionKey: keyA, rawBody, headers });
  const second = await harness.ingest(SPACE_A, { connectionKey: keyB, rawBody, headers });
  assert.equal(first.duplicate ?? false, false);
  assert.equal(second.duplicate ?? false, false);
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'evt-shared-1');
  assert.equal(rows.length, 2, 'one row per connection, never one row for the space');
  assert.deepEqual(rows.map((row) => row.connectionKey).sort(), [keyA, keyB].sort());
});

test('registration and rotation refuse a raw secret value as secretRef', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  await assert.rejects(
    harness.register(SPACE_A, {
      channel: 'whatsapp', account: ACCOUNT_A,
      adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET,
    }),
    /secretRef must be a bounded reference locator/,
  );
  assert.equal(harness.connections(SPACE_A).length, 0, 'a refused registration stores nothing');
  const rotate = buildChannelConnectionActions().find((action) => action.name === 'rotate-connection-secret');
  await assert.rejects(
    rotate.execute({
      record: { id: 'conn-1', status: 'active' },
      input: { secretRef: SECRET },
      actor: harness.userActor,
      managed: async () => { throw new Error('a refused reference must never write'); },
      now: () => new Date().toISOString(),
    }),
    /secretRef must be a bounded reference locator/,
  );
  let written = null;
  const rotated = await rotate.execute({
    record: { id: 'conn-1', status: 'active' },
    input: { secretRef: 'vault://kit/rotated' },
    actor: harness.userActor,
    managed: async (id, patch) => { written = patch; return { id, ...patch }; },
    now: () => '2026-10-17T00:00:00.000Z',
  });
  assert.equal(rotated.connection.secretRef, 'vault://kit/rotated');
  assert.equal(written.secretRef, 'vault://kit/rotated');
  assert.ok(!(await harness.dumpStorage()).includes(SECRET), 'the refused value appears nowhere in stored rows or audit');
});

test('a raced conflicting delivery reports CHANNEL_EVENT_ID_CONFLICT, not the raw violation', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = fixtureEventBody({ id: 'evt-race-1', subject: 'chat-race', seq: 1 });
  const headers = harness.faults.sign(rawBody);
  // A concurrent delivery commits first under the same identity with
  // different bytes; the loser's insert then fails with a raw violation.
  const entry = harness.internals.modules.get('channel-inbox-event');
  const real = entry.service;
  const realCreate = real.createManaged.bind(real);
  let armed = true;
  const raced = Object.create(real);
  raced.createManaged = async (row, opts) => {
    if (armed) {
      armed = false;
      await realCreate({ ...row, payloadFingerprint: '0'.repeat(64), subject: 'chat-race-other' }, opts);
      throw Object.assign(new Error('UNIQUE constraint failed: channel-inbox-event.sourceKey'), { code: 'CONFLICT' });
    }
    return realCreate(row, opts);
  };
  entry.service = raced;
  try {
    await assert.rejects(
      harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers }),
      (error) => error.code === 'CHANNEL_EVENT_ID_CONFLICT' && error.status === 409,
    );
  } finally {
    entry.service = real;
  }
});

test('concurrent redeliveries of one unprocessed row resolve idempotently, never CHANNEL_TRANSITION_INVALID', async (t) => {
  // Follow-up 8b8f6d1a42ad: two redeliveries racing the same received row
  // both read it as unprocessed; the winner moves it and the loser's
  // transition lands on the committed state. The loser adopts the winner's
  // row instead of 409ing.
  const { harness } = setup();
  t.after(() => harness.close());
  // Store the row while the connection is inactive: processed stays false.
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  const key = reg.connection.sourceKey;
  const rawBody = fixtureEventBody({ id: 'evt-resume-race', subject: 'chat-1', seq: 1 });
  const headers = harness.faults.sign(rawBody);
  const parked = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers });
  assert.equal(parked.quarantined, true);
  await harness.activate(SPACE_A, key);
  // Script the interleave a second process would produce: between this
  // delivery's pre-read (still received) and its transition, a concurrent
  // winner commits the move, so the transition re-read lands on applied.
  const entry = harness.internals.modules.get('channel-inbox-event');
  const real = entry.service;
  const realGet = real.get.bind(real);
  const realApply = real.applyManaged.bind(real);
  let winnerCommitted = false;
  const raced = Object.create(real);
  raced.get = async (id) => {
    if (!winnerCommitted) {
      winnerCommitted = true;
      await realApply(id, { processed: true, effect: 'applied', effectReason: 'concurrent winner' }, { actor: harness.userActor });
    }
    return realGet(id);
  };
  entry.service = raced;
  let out;
  try {
    out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers });
  } finally {
    entry.service = real;
  }
  assert.equal(out.duplicate, true, 'the loser adopts the winner instead of conflicting');
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'evt-resume-race');
  assert.equal(rows.length, 1, 'one event, one row');
  assert.equal(rows[0].processed, true);
  assert.equal(rows[0].effect, 'applied');
});

test('a max-length account and message key still queue under the outbox bound', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const account = 'a'.repeat(256);
  const messageKey = 'm'.repeat(256);
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  const message = { to: account, text: 'boundary' };
  const first = await harness.queue(SPACE_A, { connectionKey: reg.connection.sourceKey, message, messageKey });
  assert.ok(first.idempotencyKey.length <= 256, `the key fits the outbox bound, got ${first.idempotencyKey.length}`);
  const second = await harness.queue(SPACE_A, { connectionKey: reg.connection.sourceKey, message, messageKey });
  assert.equal(first.jobId, second.jobId, 'the length-safe key still dedups');
  const settled = await harness.pump(first.jobId);
  assert.equal(settled.state, 'succeeded');
});

test('redelivery while the connection is inactive stays quarantined; activation resumes it', async (t) => {
  // Review round 3 P1: replaying a quarantined row while its connection was
  // still inactive flipped it to applied. Provider state must never apply
  // to a binding that was never activated.
  const { harness } = setup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  const rawBody = fixtureEventBody({ id: 'evt-quar-replay-1', subject: 'chat-1', seq: 1 });
  const first = await harness.ingest(SPACE_A, { connectionKey: reg.connection.sourceKey, rawBody, headers: harness.faults.sign(rawBody) });
  assert.equal(first.effect, 'quarantined');
  const redelivery = await harness.ingest(SPACE_A, { connectionKey: reg.connection.sourceKey, rawBody, headers: harness.faults.sign(rawBody) });
  assert.equal(redelivery.effect, 'quarantined', 'an inactive binding never applies on redelivery');
  assert.equal(redelivery.duplicate, true);
  const held = harness.inbox(SPACE_A);
  assert.equal(held.length, 1);
  assert.equal(held[0].processed, false, 'the row is still undecided evidence');
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  const resumed = await harness.ingest(SPACE_A, { connectionKey: reg.connection.sourceKey, rawBody, headers: harness.faults.sign(rawBody) });
  assert.equal(resumed.effect, 'applied', 'after activation the same redelivery resumes the row');
  assert.equal(resumed.resumed, true);
  assert.equal(harness.inbox(SPACE_A)[0].processed, true);
});

test('an adapter that throws a worker-control code still lands in the dead letter', async (t) => {
  // Review round 3 P1: an adapter throwing JOB_HANDLER_FAILED bypassed the
  // dead-letter write and settled terminal with no inventory. Worker-control
  // codes are never adapter vocabulary: they land as a refusal, with a row.
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const hostile = {
    ...definition,
    name: 'hostile-channel',
    sendOutbound: async () => {
      throw Object.assign(new Error('adapter speaks worker codes'), { code: 'JOB_HANDLER_FAILED' });
    },
  };
  const harness = createChannelsHarness({
    adapterDefinition: hostile, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-hostile',
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'hostile-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  const queued = await harness.queue(SPACE_A, {
    connectionKey: reg.connection.sourceKey, message: { to: ACCOUNT_A, text: 'hostile' }, messageKey: 'm-hostile',
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  const letters = harness.letters(SPACE_A, 'open');
  assert.equal(letters.length, 1, 'the terminal failure leaves inventory');
  assert.equal(letters[0].errorCode, 'CHANNEL_SEND_REFUSED', 'the worker code is not trusted as an error code');
});

test('a verification timeout is retryable 503 and writes nothing; redelivery applies', async (t) => {
  // Review round 4 P1: a slow verify used to report 401 invalid-signature,
  // telling the provider to drop a delivery that was never recorded. It now
  // reports a retryable 503, so the provider redelivers and the event lands.
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  let hangVerify = true;
  const hanging = {
    ...definition,
    name: 'hanging-channel',
    verifyInbound: (...args) => (hangVerify ? new Promise(() => {}) : definition.verifyInbound(...args)),
  };
  const harness = createChannelsHarness({
    adapterDefinition: hanging, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-verify-timeout', config: { verifyTimeoutMs: 50 },
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A,
    adapter: 'hanging-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  const rawBody = fixtureEventBody({ id: 'evt-stalled-1', subject: 'chat-1', seq: 1 });
  await assert.rejects(
    harness.ops.ingestChannelEvent({
      spaceId: SPACE_A, connectionKey: reg.connection.sourceKey,
      rawBody, headers: harness.faults.sign(rawBody),
    }),
    (error) => error.code === 'CHANNEL_VERIFY_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(harness.inbox(SPACE_A).length, 0, 'a stalled verification writes nothing');
  hangVerify = false;
  const redelivered = await harness.ops.ingestChannelEvent({
    spaceId: SPACE_A, connectionKey: reg.connection.sourceKey,
    rawBody, headers: harness.faults.sign(rawBody),
  });
  assert.equal(redelivered.effect, 'applied', 'the redelivery the 503 asked for lands');
});

test('an adapter verification failure is retryable 503; only a bad signature is 401', async (t) => {
  // Follow-up 8b8f6d1a42ad: any verifyInbound throw used to report 401
  // invalid-signature, telling the provider to drop a delivery that was
  // never recorded. Only an explicit `{ ok: false }` is a forgery now;
  // anything the adapter raises is a server-side stall the provider must
  // redeliver, and the redelivery lands.
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  let failVerify = true;
  const flaky = {
    ...definition,
    name: 'flaky-verify-channel',
    verifyInbound: (...args) => {
      if (failVerify) throw Object.assign(new Error('verify downstream exploded'), { code: 'VERIFY_BOOM' });
      return definition.verifyInbound(...args);
    },
  };
  const harness = createChannelsHarness({
    adapterDefinition: flaky, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-verify-failure',
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_A, {
    channel: 'whatsapp', account: ACCOUNT_A, adapter: 'flaky-verify-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, reg.connection.sourceKey);
  const rawBody = fixtureEventBody({ id: 'evt-boom-1', subject: 'chat-1', seq: 1 });
  await assert.rejects(
    harness.ops.ingestChannelEvent({
      spaceId: SPACE_A, connectionKey: reg.connection.sourceKey, rawBody, headers: harness.faults.sign(rawBody),
    }),
    (error) => error.code === 'CHANNEL_VERIFY_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(harness.inbox(SPACE_A).length, 0, 'a failed verification writes nothing');
  failVerify = false;
  const tampered = { ...harness.faults.sign(rawBody), 'x-channel-signature-256': '0'.repeat(64) };
  await assert.rejects(
    harness.ops.ingestChannelEvent({
      spaceId: SPACE_A, connectionKey: reg.connection.sourceKey, rawBody, headers: tampered,
    }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID' && error.status === 401,
  );
  const redelivered = await harness.ops.ingestChannelEvent({
    spaceId: SPACE_A, connectionKey: reg.connection.sourceKey, rawBody, headers: harness.faults.sign(rawBody),
  });
  assert.equal(redelivered.effect, 'applied', 'the redelivery the 503 asked for lands');
});

test('ingest ignores a caller-supplied actor and writes as the system actor', async (t) => {
  // Review round 4 P2: a caller-supplied actor reached the managed writes,
  // forging audit provenance on evidence rows. Provider-driven ingest always
  // runs under the package system actor now.
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = fixtureEventBody({ id: 'evt-spoof-1', subject: 'chat-1', seq: 1 });
  const out = await harness.ops.ingestChannelEvent({
    spaceId: SPACE_A, connectionKey: key, rawBody, headers: harness.faults.sign(rawBody),
    actor: { type: 'user', id: 'victim-1' },
  });
  assert.equal(out.effect, 'applied');
  const audit = harness.auditRows();
  assert.ok(audit.length > 0, 'the ingest wrote audited rows');
  assert.ok(!JSON.stringify(audit).includes('victim-1'), 'the spoofed actor appears nowhere in the audit trail');
  assert.ok(
    audit.some((row) => row.actorType === 'system'),
    'the provider-driven writes are attributed to the system actor',
  );
});

test('dead-letter requeue is deferred: the operations surface has no retry path', async (t) => {
  // Supervisor scope cut (review round 4): the human retry of an open dead
  // letter moves to its own follow-up voice with its own state machine. This
  // PR keeps the dead-letter inventory readable; nothing here moves a letter.
  const { harness, api } = setup({ config: { maxSendAttempts: 2 } });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.setMode('refuse');
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'first try' }, messageKey: 'm-noreq' });
  await harness.pump(queued.jobId);
  assert.equal(harness.letters(SPACE_A, 'open').length, 1);
  assert.equal(typeof harness.ops.requeueChannelLetter, 'undefined', 'no requeue path on this surface');
});
