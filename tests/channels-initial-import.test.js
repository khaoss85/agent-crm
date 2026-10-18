import test from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError } from '../packages/core/index.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Progressive initial history import (backlog:66282d13d81c): one bounded
 * page per advance call, one inbox row per event through the deduped
 * webhook path, every applied sender reconciled, an interrupted import
 * resumed from its stored cursor — on real sqlite with real module
 * services. The stub sender stands in for the composed `channel-sender@1`
 * capability where this file proves the engine; the real reconciliation
 * path is proven end-to-end in `tests/channels-import-reconcile.test.js`.
 */

const SPACE = 'presti';
const ACCOUNT = '+390200000001';
const SECRET_REF = 'vault://kit/channel-import';
const SECRET = 'kit-secret-import-1';
const ACTOR = { type: 'user', id: 'channel-import-kit' };

const nowIso = () => new Date().toISOString();

/** Emulates the resolution contract: first sighting creates, repeats match. */
function stubSender() {
  const seen = new Map();
  const calls = [];
  let n = 0;
  const resolveSender = async (request) => {
    calls.push(request);
    if (request.handle === 'ambiguous-case') {
      return { outcome: 'unresolved', contact: null, candidates: [], candidatesWritten: 1 };
    }
    if (request.handle === 'broken-case') {
      throw new ValidationError('the sender handle names nobody', { field: 'handle' });
    }
    if (seen.has(request.handle)) {
      return { outcome: 'matched', contact: { id: seen.get(request.handle) } };
    }
    n += 1;
    const id = `contact-${n}`;
    seen.set(request.handle, id);
    return { outcome: 'created', contact: { id } };
  };
  return { resolveSender, calls, seen };
}

function setup(options = {}) {
  const sender = stubSender();
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const adapterDefinition = options.noHistory ? { ...definition, historyImport: undefined } : definition;
  if (options.flakyHistory) {
    let failures = options.flakyHistory;
    const listHistory = adapterDefinition.historyImport.listHistory.bind(adapterDefinition.historyImport);
    adapterDefinition.historyImport = {
      ...adapterDefinition.historyImport,
      async listHistory(args) {
        if (failures > 0) {
          failures -= 1;
          const error = new Error('provider history temporarily unavailable');
          error.code = options.flakyCode ?? 'CHANNEL_HISTORY_TRANSIENT';
          throw error;
        }
        return listHistory(args);
      },
    };
  }
  if (options.hangingHistory) {
    adapterDefinition.historyImport = {
      ...adapterDefinition.historyImport,
      listHistory: () => new Promise(() => {}),
    };
  }
  const harness = createChannelsHarness({
    adapterDefinition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: options.tenantId ?? 'channel-import-kit',
    resolveSender: options.noSender ? null : sender.resolveSender,
  });
  return { harness, api, definition: adapterDefinition, sender };
}

async function registeredActive(harness, space = SPACE, account = ACCOUNT) {
  const reg = await harness.register(space, {
    channel: 'whatsapp', account, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function historySeed(count, at, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `evt-hist-${offset + index + 1}`,
    subject: `chat-hist-${(offset + index) % 2}`,
    seq: offset + index + 1,
    at,
    sender: { handle: `+39020000${String(100 + offset + index)}` },
  }));
}

test('a paged import stores one row per event, reconciles every sender, and reports progress', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-import-paged' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();
  api.seedHistory(historySeed(5, at));

  assert.equal(harness.readImport(SPACE, { connectionKey: key }), null, 'no import started: honest absence, not an empty report');

  const started = await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  assert.equal(started.started, true);
  assert.equal(started.resumed, false);
  assert.equal(started.state.status, 'running');

  const first = await harness.advanceImport(SPACE, { connectionKey: key, limit: 2 });
  assert.equal(first.done, false);
  assert.deepEqual(first.page, {
    imported: 2, duplicates: 0, matched: 0, created: 2, unresolved: 0, withoutSender: 0,
  });
  const progress = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(progress.status, 'running');
  assert.equal(progress.importedEvents, 2);
  assert.equal(progress.createdContacts, 2);
  assert.equal(progress.finishedAt, null);

  const second = await harness.advanceImport(SPACE, { connectionKey: key, limit: 2 });
  assert.equal(second.done, false);
  assert.equal(second.page.imported, 2);

  const third = await harness.advanceImport(SPACE, { connectionKey: key, limit: 2 });
  assert.equal(third.done, true);
  assert.equal(third.page.imported, 1);
  assert.equal(third.state.status, 'done');
  assert.equal(third.state.importedEvents, 5);
  assert.equal(third.state.createdContacts, 5);
  assert.ok(third.state.finishedAt, 'a finished import stamps its end');
  assert.equal(harness.inbox(SPACE).length, 5, 'one inbox row per history event');

  const again = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(again.done, true);
  assert.equal(again.page, null, 'advancing a done import answers done, never a second import');
  await assert.rejects(
    harness.startImport(SPACE, { connectionKey: key, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_IMPORT_COMPLETE',
  );
});

test('an interrupted import resumes from its stored cursor and stores nothing twice', async (t) => {
  const { harness, api, sender } = setup({ tenantId: 'channel-import-resume' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();
  api.seedHistory(historySeed(4, at));

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const first = await harness.advanceImport(SPACE, { connectionKey: key, limit: 2 });
  assert.equal(first.done, false);

  // The crash: a brand-new operations instance over the same storage, as a
  // restarted worker would open it. Nothing about the run lives in memory.
  const { database, modules, registries } = harness.internals;
  const reopened = createChannelOperations({
    database,
    modules,
    registries,
    resolveSecret: async () => SECRET,
    tenantId: 'channel-import-resume-restart',
    resolveSender: sender.resolveSender,
  });
  const resumed = await reopened.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 2 });
  assert.equal(resumed.done, true);
  assert.equal(resumed.page.imported, 2);
  assert.equal(resumed.page.duplicates, 0, 'the cursor moved: no page replays');
  assert.equal(resumed.state.importedEvents, 4);
  assert.equal(harness.inbox(SPACE).length, 4);

  // The webhook path meets the history path on the same source key: a
  // delivery of the same message in the webhook envelope is a duplicate
  // through the import marker, never a row and never a 409.
  const { fixtureEventBody } = await import('../packages/channels/src/fixture.js');
  const rawBody = fixtureEventBody({ id: 'evt-hist-1', subject: 'chat-hist-0', seq: 1, at });
  const replay = await harness.ingest(SPACE, {
    connectionKey: key, rawBody, headers: harness.faults.sign(rawBody),
  });
  assert.equal(replay.duplicate, true);
  assert.equal(harness.inbox(SPACE).length, 4);
  // ...while a genuinely conflicting redelivery still 409s: same id, a
  // different conversation is a provider violation, not the same message.
  const conflictBody = fixtureEventBody({ id: 'evt-hist-2', subject: 'chat-other', seq: 2, at });
  await assert.rejects(
    harness.ingest(SPACE, {
      connectionKey: key, rawBody: conflictBody, headers: harness.faults.sign(conflictBody),
    }),
    (error) => error.code === 'CHANNEL_EVENT_ID_CONFLICT',
  );
});

test('a webhook stored first is adopted by the later import, never doubled', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-import-adopt' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();

  // The live webhook arrives before the backfill lists it.
  const { fixtureEventBody } = await import('../packages/channels/src/fixture.js');
  const rawBody = fixtureEventBody({ id: 'evt-w1', subject: 'chat-w', seq: 1, at });
  const delivered = await harness.ingest(SPACE, {
    connectionKey: key, rawBody, headers: harness.faults.sign(rawBody),
  });
  assert.equal(delivered.effect, 'applied');

  api.seedHistory([{ id: 'evt-w1', subject: 'chat-w', seq: 1, at, sender: { handle: '+390200007001' } }]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const advanced = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(advanced.done, true);
  assert.deepEqual(advanced.page, {
    imported: 0, duplicates: 1, matched: 0, created: 0, unresolved: 0, withoutSender: 0,
  });
  assert.equal(harness.inbox(SPACE).length, 1, 'one message, one row, whichever path saw it first');
});

test('a sender seen twice reconciles to one contact; ambiguity stays unresolved', async (t) => {
  const { harness, api, sender } = setup({ tenantId: 'channel-import-senders' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();
  api.seedHistory([
    { id: 'evt-s-1', subject: 'chat-s', seq: 1, at, sender: { handle: '+390200009001' } },
    { id: 'evt-s-2', subject: 'chat-s', seq: 2, at, sender: { handle: '+390200009001' } },
    { id: 'evt-s-3', subject: 'chat-s', seq: 3, at, sender: { handle: 'ambiguous-case' } },
    { id: 'evt-s-4', subject: 'chat-s', seq: 4, at, sender: { handle: 'broken-case' } },
    { id: 'evt-s-5', subject: '', seq: 5, at, sender: { handle: '+390200009002' } },
  ]);

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const advanced = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(advanced.done, true);
  assert.deepEqual(advanced.page, {
    imported: 5, duplicates: 0, matched: 1, created: 1, unresolved: 1, withoutSender: 1,
  });
  // created once for the repeated handle, matched on its replay;
  // ambiguous evidence unresolved; malformed evidence kept without a
  // contact; the subject-less row quarantined without resolving.
  assert.equal(sender.seen.size, 1);
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.createdContacts, 1);
  assert.equal(state.matchedContacts, 1);
  assert.equal(state.unresolvedContacts, 1);
  assert.equal(state.eventsWithoutSender, 1);
  const quarantined = harness.inbox(SPACE).filter((row) => row.providerEventId === 'evt-s-5');
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].effect, 'quarantined');
});

test('starting refuses without readable past, without a sender path, and off an inactive binding', async (t) => {
  const { harness } = setup({ noHistory: true, tenantId: 'channel-import-nohistory' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    harness.startImport(SPACE, { connectionKey: key, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_HISTORY_UNAVAILABLE',
  );

  const unsolved = setup({ noSender: true, tenantId: 'channel-import-nosender' });
  t.after(() => unsolved.harness.close());
  const key2 = await registeredActive(unsolved.harness);
  await assert.rejects(
    unsolved.harness.startImport(SPACE, { connectionKey: key2, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_SENDER_UNAVAILABLE',
  );

  const idle = setup({ tenantId: 'channel-import-idle' });
  t.after(() => idle.harness.close());
  const pending = await idle.harness.register(SPACE, {
    channel: 'whatsapp', account: ACCOUNT, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await assert.rejects(
    idle.harness.startImport(SPACE, { connectionKey: pending.connection.sourceKey, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );
  await assert.rejects(
    idle.harness.advanceImport(SPACE, { connectionKey: pending.connection.sourceKey }),
    (error) => error.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );

  const key3 = await registeredActive(idle.harness);
  await assert.rejects(
    idle.harness.advanceImport(SPACE, { connectionKey: key3 }),
    (error) => error.code === 'CHANNEL_IMPORT_UNKNOWN',
  );
  await assert.rejects(
    idle.harness.startImport(SPACE, { connectionKey: key3, actor: { type: 'agent', id: 'bot' } }),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  await assert.rejects(
    idle.harness.advanceImport(SPACE, { connectionKey: key3, limit: 101 }),
    (error) => error.code === 'CHANNEL_IMPORT_UNKNOWN',
  );
});

test('a failing page keeps its cursor: the retry replays it to the same rows', async (t) => {
  const { harness, api } = setup({ flakyHistory: 1, tenantId: 'channel-import-flaky' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.seedHistory(historySeed(2, nowIso()));

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  await assert.rejects(
    harness.advanceImport(SPACE, { connectionKey: key }),
    (error) => error.code === 'CHANNEL_HISTORY_TRANSIENT',
  );
  const failed = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(failed.status, 'running');
  assert.equal(failed.importedEvents, 0);
  assert.equal(failed.lastErrorCode, 'CHANNEL_HISTORY_TRANSIENT');

  const retried = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(retried.done, true);
  assert.equal(retried.state.importedEvents, 2);
  assert.equal(retried.state.lastErrorCode, null, 'a good page clears the failure');
  assert.equal(harness.inbox(SPACE).length, 2);
});

test('a provider stall stays retryable and writes nothing', async (t) => {
  const { harness, api } = setup({ hangingHistory: true, tenantId: 'channel-import-hang' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.seedHistory(historySeed(1, nowIso()));

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  await assert.rejects(
    harness.advanceImport(SPACE, { connectionKey: key }),
    (error) => error.code === 'CHANNEL_HISTORY_TRANSIENT',
  );
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'running');
  assert.equal(state.importedEvents, 0);
  assert.equal(harness.inbox(SPACE).length, 0);
}, { timeout: 30000 });
