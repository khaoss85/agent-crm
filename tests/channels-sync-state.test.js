import test from 'node:test';
import assert from 'node:assert/strict';

import { createChannelOperations } from '../packages/channels/src/operations.js';
import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { buildChannelConnectionActions, createChannelsPackage } from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Space sync state (backlog:f815763b7aa5): one read over every connection
 * of a space — each binding with its first-import progress — plus the
 * connected/completed totals the pilot's banner reads. Only `active`
 * connections whose adapter keeps a readable history count as connected;
 * a connection whose import never started reads `sync: null`, never an
 * invented report. The per-connection
 * progress is the same surface `readInitialImport` returns, never a
 * second computation of it.
 */

const SPACE = 'presti-sync';
const ACCOUNT_A = '+390200000011';
const ACCOUNT_B = '+390200000022';
const SECRET_REF = 'vault://kit/channel-sync';
const SECRET = 'kit-secret-sync-1';
const ACTOR = { type: 'user', id: 'channel-sync-kit' };
const LEAK_PROBE = 'leak-probe-token-9c41f77a02';

const nowIso = () => new Date().toISOString();

function setup(options = {}) {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const adapterDefinition = definition;
  if (options.throwingHistory) {
    adapterDefinition.historyImport = {
      ...adapterDefinition.historyImport,
      async listHistory() {
        const error = new Error(options.throwingHistory.message);
        error.code = options.throwingHistory.code;
        throw error;
      },
    };
  }
  const harness = createChannelsHarness({
    adapterDefinition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: options.tenantId ?? 'channel-sync-kit',
    resolveSender: null,
  });
  return { harness, api };
}

async function registeredActive(harness, account) {
  const reg = await harness.register(SPACE, {
    channel: 'whatsapp', account, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function historySeed(count, at, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-sync-${offset + index + 1}`,
    subject: `chat-sync-${(offset + index) % 2}`,
    seq: offset + index + 1,
    at,
    sender: { handle: `+39020000${String(200 + offset + index)}` },
  }));
}

async function suspend(harness, spaceId, connectionKey) {
  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const service = harness.internals.modules.get('channel-connection').service;
  const record = harness.ops.getConnection(spaceId, connectionKey);
  assert.ok(record, 'connection to suspend exists');
  return actions['suspend-connection'].execute({
    record,
    input: { reason: 'kit suspend' },
    actor: harness.userActor,
    modules: harness.internals.modules,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: harness.userActor }),
    now: () => new Date().toISOString(),
  });
}

function readSync(harness, spaceId = SPACE) {
  return harness.ops.readSyncState({ spaceId });
}

test('an empty space reads connected 0 of 0, never null', async (t) => {
  const { harness } = setup({ tenantId: 'channel-sync-empty' });
  t.after(() => harness.close());
  assert.deepEqual(readSync(harness), {
    spaceId: SPACE, connectors: [], connected: 0, completed: 0,
  });
});

test('two connectors: one finishes first, the state counts 1 of 2 until the second finishes', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-sync-two' });
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, ACCOUNT_A);
  const keyB = await registeredActive(harness, ACCOUNT_B);
  api.seedHistory(historySeed(2, nowIso()));

  let state = readSync(harness);
  assert.equal(state.connected, 2);
  assert.equal(state.completed, 0);
  assert.deepEqual(state.connectors.map((entry) => entry.sync), [null, null],
    'no import started: honest absence on both connectors');

  await harness.startImport(SPACE, { connectionKey: keyA, actor: ACTOR });
  await harness.startImport(SPACE, { connectionKey: keyB, actor: ACTOR });
  const doneA = await harness.advanceImport(SPACE, { connectionKey: keyA, limit: 50 });
  assert.equal(doneA.done, true);
  const partialB = await harness.advanceImport(SPACE, { connectionKey: keyB, limit: 1 });
  assert.equal(partialB.done, false);

  state = readSync(harness);
  assert.equal(state.connected, 2);
  assert.equal(state.completed, 1);
  assert.deepEqual(
    state.connectors.map((entry) => entry.connectionKey),
    [...state.connectors.map((entry) => entry.connectionKey)].sort(),
    'entries sort by connection key, so two reads always agree',
  );
  const entryA = state.connectors.find((entry) => entry.connectionKey === keyA);
  const entryB = state.connectors.find((entry) => entry.connectionKey === keyB);
  assert.equal(entryA?.status, 'active');
  assert.equal(entryA?.account, ACCOUNT_A,
    'the entry carries the account, so the backoffice can resume through authorize');
  assert.equal(entryA?.sync?.status, 'done');
  assert.equal(entryA?.sync?.importedEvents, 2);
  assert.ok(entryA?.sync?.finishedAt, 'a finished import stamps its end');
  assert.equal(entryB?.status, 'active');
  assert.equal(entryB?.sync?.status, 'running');
  assert.equal(entryB?.sync?.importedEvents, 1);
  assert.equal(entryB?.sync?.finishedAt, null);
  // The per-connection progress is the readInitialImport surface, not a copy.
  assert.deepEqual(entryA?.sync, harness.readImport(SPACE, { connectionKey: keyA }));
  assert.deepEqual(entryB?.sync, harness.readImport(SPACE, { connectionKey: keyB }));

  const doneB = await harness.advanceImport(SPACE, { connectionKey: keyB, limit: 50 });
  assert.equal(doneB.done, true);
  state = readSync(harness);
  assert.deepEqual([state.connected, state.completed], [2, 2]);
});

test('a connection that cannot sync never holds the totals back', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-sync-status' });
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, ACCOUNT_A);
  const keyB = await registeredActive(harness, ACCOUNT_B);
  // Registered but never activated: pending, so never connected.
  const pending = await harness.register(SPACE, {
    channel: 'whatsapp', account: '+390200000033',
    adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  api.seedHistory(historySeed(1, nowIso()));
  await harness.startImport(SPACE, { connectionKey: keyA, actor: ACTOR });
  await harness.startImport(SPACE, { connectionKey: keyB, actor: ACTOR });
  await harness.advanceImport(SPACE, { connectionKey: keyA, limit: 50 });
  await harness.advanceImport(SPACE, { connectionKey: keyB, limit: 50 });

  let state = readSync(harness);
  assert.deepEqual([state.connected, state.completed], [2, 2]);
  const pendingEntry = state.connectors.find(
    (entry) => entry.connectionKey === pending.connection.sourceKey,
  );
  assert.equal(pendingEntry?.status, 'pending');
  assert.equal(pendingEntry?.sync, null);

  await suspend(harness, SPACE, keyB);
  state = readSync(harness);
  assert.deepEqual([state.connected, state.completed], [1, 1],
    'a suspended binding leaves the totals: only active connections count');
});

test('an active connection whose adapter keeps no history never holds the banner back', async (t) => {
  const { definition: plain } = createFixtureChannelAdapter({ name: 'fixture-no-history', secret: SECRET });
  const noHistory = { ...plain, historyImport: undefined };
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    extraAdapters: [noHistory],
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: 'channel-sync-no-history',
    resolveSender: null,
  });
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, ACCOUNT_A);
  const regB = await harness.register(SPACE, {
    channel: 'whatsapp', account: ACCOUNT_B,
    adapter: 'fixture-no-history', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, regB.connection.sourceKey);
  const keyB = regB.connection.sourceKey;
  api.seedHistory(historySeed(2, nowIso()));

  // The refusal that proves B can never finish an import: the totals must
  // therefore never wait on it.
  const refusal = await harness.startImport(SPACE, { connectionKey: keyB, actor: ACTOR }).then(
    () => { throw new Error('start should have refused a history-less adapter'); },
    (error) => error,
  );
  assert.equal(refusal.code, 'CHANNEL_HISTORY_UNAVAILABLE');

  await harness.startImport(SPACE, { connectionKey: keyA, actor: ACTOR });
  const done = await harness.advanceImport(SPACE, { connectionKey: keyA, limit: 50 });
  assert.equal(done.done, true);

  const state = readSync(harness);
  assert.deepEqual([state.connected, state.completed], [1, 1],
    'only the importable connector counts: the banner completes when its import does');
  const entryA = state.connectors.find((entry) => entry.connectionKey === keyA);
  assert.equal(entryA?.importable, true);
  assert.equal(entryA?.sync?.status, 'done');
  const entryB = state.connectors.find((entry) => entry.connectionKey === keyB);
  assert.equal(entryB?.status, 'active');
  assert.equal(entryB?.importable, false);
  assert.equal(entryB?.sync, null);
  assert.ok(!JSON.stringify(state).includes(SECRET_REF), 'no secret reference in the aggregate');
});

test('a provider failure stamps the normalized code on its connector, never the provider text', async (t) => {
  const { harness, api } = setup({
    tenantId: 'channel-sync-failure',
    throwingHistory: { message: `history refused for token ${LEAK_PROBE}`, code: 'CHANNEL_HISTORY_UNAVAILABLE' },
  });
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, ACCOUNT_A);
  api.seedHistory(historySeed(1, nowIso()));
  await harness.startImport(SPACE, { connectionKey: keyA, actor: ACTOR });
  const failure = await harness.advanceImport(SPACE, { connectionKey: keyA }).then(
    () => { throw new Error('advance should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CHANNEL_HISTORY_UNAVAILABLE');

  const state = readSync(harness);
  assert.deepEqual([state.connected, state.completed], [1, 0]);
  const entry = state.connectors.find((row) => row.connectionKey === keyA);
  assert.equal(entry?.sync?.status, 'running');
  assert.equal(entry?.sync?.lastErrorCode, 'CHANNEL_HISTORY_UNAVAILABLE');
  assert.ok(!JSON.stringify(state).includes(LEAK_PROBE), 'no provider text in the aggregate');
  assert.ok(!JSON.stringify(state).includes(SECRET_REF), 'no secret reference in the aggregate');
});

test('the package manifest publishes read-sync-state beside read-initial-import', () => {
  const pkg = createChannelsPackage();
  const methods = pkg.operations.map((op) => op.appMethod);
  assert.ok(methods.includes('readInitialImport'), 'the per-connection read stays published');
  assert.ok(methods.includes('readSyncState'), 'the space aggregate is published');
  assert.equal(typeof createChannelOperations, 'function');
});
