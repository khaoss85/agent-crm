import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError } from '../packages/core/index.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Progressive initial history import (backlog:66282d13d81c): one bounded
 * page per advance call, one inbox row per event through the deduped
 * webhook path, every applied sender reconciled, an interrupted import
 * resumed from its stored cursor — on real sqlite with real module
 * services. Every event writes one `channel-import-outcome` row under its
 * unique (import, event) key and the progress surface counts those rows
 * (one COUNT per state) instead of trusting hand tallies, so racing
 * advances and crash retries converge to a clean run's numbers — the
 * number is always the rows themselves. The stub sender stands in for the
 * composed `channel-sender@1` capability where this file proves the
 * engine; the real reconciliation path is proven end-to-end in
 * `tests/channels-import-reconcile.test.js`.
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
  if (options.senderThrows || options.senderThrowsOnce) {
    const inner = sender.resolveSender;
    const spec = options.senderThrows ?? options.senderThrowsOnce;
    const once = Boolean(options.senderThrowsOnce);
    let armed = true;
    sender.resolveSender = async (request) => {
      if (request.handle === spec.handle && (!once || armed)) {
        armed = false;
        const error = new Error(spec.message);
        error.code = spec.code;
        if (spec.status !== undefined) error.status = spec.status;
        throw error;
      }
      return inner(request);
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
    imported: 2, duplicates: 0, failed: 0, matched: 0, created: 2, unresolved: 0, withoutSender: 0,
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
  const { harness, api, sender } = setup({ tenantId: 'channel-import-adopt' });
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
  // The row stays one, but the applied row's sender is still reconciled:
  // the first store was a webhook, and webhooks never resolve senders —
  // without this replay the common webhook-before-backfill flow would
  // leave the sender with no external identity and no contact.
  assert.deepEqual(advanced.page, {
    imported: 0, duplicates: 1, failed: 0, matched: 0, created: 1, unresolved: 0, withoutSender: 0,
  });
  assert.ok(
    sender.calls.some((request) => request.handle === '+390200007001'),
    'the duplicate replays the idempotent sender resolution',
  );
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.createdContacts, 1);
  assert.equal(harness.inbox(SPACE).length, 1, 'one message, one row, whichever path saw it first');
});

test('two advances racing one import keep exactly one outcome per event', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-import-race' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();
  api.seedHistory(historySeed(2, at));

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  // Two schedulers advance the same import before either finishes: both
  // read the same row and the same page token, so both process the same
  // page. The advances serialize in one slot and the loser replays to the
  // winner's outcome rows — final outcomes are kept, never recounted — so
  // every event ends with exactly one outcome and the loser's page is all
  // zeros instead of a second tally of the same page.
  const [first, second] = await Promise.all([
    harness.advanceImport(SPACE, { connectionKey: key }),
    harness.advanceImport(SPACE, { connectionKey: key }),
  ]);
  assert.equal(first.done, true);
  assert.equal(second.done, true);
  assert.deepEqual(first.page, {
    imported: 2, duplicates: 0, failed: 0, matched: 0, created: 2, unresolved: 0, withoutSender: 0,
  });
  assert.deepEqual(second.page, {
    imported: 0, duplicates: 0, failed: 0, matched: 0, created: 0, unresolved: 0, withoutSender: 0,
  }, 'the loser replays to kept outcomes: nothing recounted, nothing re-resolved');
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'done');
  assert.equal(state.importedEvents, 2, 'every event stored exactly once across both racers');
  assert.equal(state.duplicateEvents, 0, 'no event double-stored, so none replays as a duplicate');
  assert.equal(
    state.importedEvents + state.duplicateEvents + state.failedEvents, 2,
    'one outcome per event: the COUNT is the events, not the attempts',
  );
  assert.equal(state.createdContacts, 2);
  assert.equal(state.matchedContacts, 0, 'each sender resolved once: the replay skips final outcomes');
  assert.equal(harness.inbox(SPACE).length, 2, 'two events, two rows — the race doubled nothing');
  const outcomes = harness.internals.modules.get('channel-import-outcome').service.listWhere({});
  assert.equal(outcomes.length, 2, 'two events, two outcome rows');
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
    imported: 5, duplicates: 0, failed: 0, matched: 1, created: 1, unresolved: 1, withoutSender: 1,
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

test('without customer-data the import stores everything and leaves senders pending', async (t) => {
  // The optional edge (review on #242): a composition without the
  // channel-sender@1 capability boots and imports — conversations and
  // messages land, reconciliation waits as pending (counted unresolved),
  // and no contact is invented.
  const { harness, api } = setup({ noSender: true, tenantId: 'channel-import-nosender' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.seedHistory(historySeed(2, nowIso()));

  const started = await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  assert.equal(started.started, true, 'starting never requires the sender path');
  const advanced = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(advanced.done, true);
  assert.deepEqual(advanced.page, {
    imported: 2, duplicates: 0, failed: 0, matched: 0, created: 0, unresolved: 2, withoutSender: 0,
  });
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'done');
  assert.equal(state.importedEvents, 2);
  assert.equal(state.unresolvedContacts, 2, 'pending reconciliation counts as unresolved');
  assert.equal(state.createdContacts, 0, 'no capability: no contact invented');
  assert.equal(harness.inbox(SPACE).length, 2, 'both messages stored');
  const outcomes = harness.internals.modules.get('channel-import-outcome').service.listWhere({});
  assert.deepEqual(
    outcomes.map((entry) => entry.sender).sort(),
    ['pending', 'pending'],
    'reconciliation waits, visibly, for the capability',
  );
});

test('starting refuses without readable past and off an inactive binding', async (t) => {
  const { harness } = setup({ noHistory: true, tenantId: 'channel-import-nohistory' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    harness.startImport(SPACE, { connectionKey: key, actor: ACTOR }),
    (error) => error.code === 'CHANNEL_HISTORY_UNAVAILABLE',
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
  // Pure-input bounds fail before any storage lookup: a malformed limit never
  // oracles whether an import row exists for the connection.
  await assert.rejects(
    idle.harness.advanceImport(SPACE, { connectionKey: key3, limit: 101 }),
    (error) => error.code === 'VALIDATION_ERROR',
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

/**
 * Import failure hygiene (review on #242): a provider or sender throw may
 * echo secrets or PII from the request, so the import row keeps the failure
 * code plus a static note only, the caller gets a fixed message, and no
 * provider-controlled text lands anywhere durable — rows, progress surface,
 * or audit.
 */
const LEAK_PROBE = 'leak-probe-token-7f3a9c2e41';

function scanDurable(harness, space) {
  return JSON.stringify([
    [...harness.internals.modules.get('channel-import-state').service.listWhere({})],
    [...harness.internals.modules.get('channel-import-outcome').service.listWhere({})],
    harness.inbox(space),
    harness.auditRows(),
  ]);
}

test('a provider error carrying a secret never lands in the import row or the progress surface', async (t) => {
  const { harness, api } = setup({
    tenantId: 'channel-import-secret',
    throwingHistory: { message: `history refused for token ${LEAK_PROBE}`, code: 'CHANNEL_HISTORY_UNAVAILABLE' },
  });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.seedHistory(historySeed(1, nowIso()));

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const failure = await harness.advanceImport(SPACE, { connectionKey: key }).then(
    () => { throw new Error('advance should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CHANNEL_HISTORY_UNAVAILABLE');
  assert.ok(!String(failure.message).includes(LEAK_PROBE), 'the caller gets a fixed message, not the adapter text');
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'running');
  assert.equal(state.lastErrorCode, 'CHANNEL_HISTORY_UNAVAILABLE');
  assert.ok(state.lastErrorReason !== null && !state.lastErrorReason.includes(LEAK_PROBE));
  assert.ok(!scanDurable(harness, SPACE).includes(LEAK_PROBE), 'no provider text at rest in rows or audit');
});

test('a sender error carrying a secret never lands in the import row or the progress surface', async (t) => {
  const handle = '+390200006101';
  const { harness, api } = setup({
    tenantId: 'channel-import-sender-secret',
    senderThrows: { handle, message: `sender store refused token ${LEAK_PROBE}`, code: 'CHANNEL_SENDER_TRANSIENT' },
  });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();
  api.seedHistory([
    { id: 'evt-x-1', subject: 'chat-x', seq: 1, at, sender: { handle: '+390200006100' } },
    { id: 'evt-x-2', subject: 'chat-x', seq: 2, at, sender: { handle } },
  ]);

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const failure = await harness.advanceImport(SPACE, { connectionKey: key }).then(
    () => { throw new Error('advance should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CHANNEL_SENDER_TRANSIENT');
  assert.ok(!String(failure.message).includes(LEAK_PROBE), 'the caller gets a fixed message, not the sender text');
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'running');
  assert.equal(state.lastErrorCode, 'CHANNEL_SENDER_TRANSIENT');
  assert.ok(state.lastErrorReason !== null && !state.lastErrorReason.includes(LEAK_PROBE));
  // The completed event's outcome is still committed: the abort keeps what
  // the page earned instead of discarding it.
  assert.equal(state.importedEvents, 2, 'both rows landed before the sender failed');
  assert.equal(state.createdContacts, 1);
  assert.ok(!scanDurable(harness, SPACE).includes(LEAK_PROBE), 'no provider text at rest in rows or audit');
});

/**
 * Mid-page abort convergence (review on #242): a page that fails after
 * partial writes commits what its completed events earned and keeps the
 * cursor, so the retry replays to the same rows and the same counts as a
 * clean run — never a permanent drift.
 */
const CONVERGE_FIELDS = [
  'importedEvents', 'duplicateEvents', 'failedEvents', 'matchedContacts',
  'createdContacts', 'unresolvedContacts', 'eventsWithoutSender',
];

function convergeSeed(at) {
  return [
    { id: 'evt-cv-1', subject: 'chat-cv', seq: 1, at, sender: { handle: '+390200005101' } },
    { id: 'evt-cv-2', subject: 'chat-cv', seq: 2, at, sender: { handle: '+390200005102' } },
  ];
}

async function cleanRun(t, tag) {
  const scene = setup({ tenantId: `channel-import-${tag}-clean` });
  t.after(() => scene.harness.close());
  const key = await registeredActive(scene.harness);
  scene.api.seedHistory(convergeSeed(nowIso()));
  await scene.harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const run = await scene.harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(run.done, true);
  return { ...scene, key };
}

test('a mid-page sender failure replays to the same rows and the same counts as a clean run', async (t) => {
  const clean = await cleanRun(t, 'sender');

  const flaky = setup({
    tenantId: 'channel-import-sender-converge',
    senderThrowsOnce: { handle: '+390200005102', message: 'sender store transiently unavailable', code: 'CHANNEL_SENDER_TRANSIENT' },
  });
  t.after(() => flaky.harness.close());
  const key = await registeredActive(flaky.harness);
  flaky.api.seedHistory(convergeSeed(nowIso()));
  await flaky.harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });

  const failure = await flaky.harness.advanceImport(SPACE, { connectionKey: key }).then(
    () => { throw new Error('advance should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CHANNEL_SENDER_TRANSIENT');
  const partial = flaky.harness.readImport(SPACE, { connectionKey: key });
  assert.equal(partial.status, 'running');
  assert.equal(partial.importedEvents, 2, 'both rows landed before the sender failed');
  assert.equal(partial.createdContacts, 1);
  assert.equal(partial.lastErrorCode, 'CHANNEL_SENDER_TRANSIENT');

  const retried = await flaky.harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(retried.done, true);
  // unresolved goes 1 → 0: the pending sender the failed attempt left
  // behind resolves now, so the honest delta reads -1 next to the +1 create.
  assert.deepEqual(retried.page, {
    imported: 0, duplicates: 0, failed: 0, matched: 0, created: 1, unresolved: -1, withoutSender: 0,
  }, 'the retry finishes only the pending sender: nothing already counted is tallied again');
  const cleanState = clean.harness.readImport(SPACE, { connectionKey: clean.key });
  for (const field of CONVERGE_FIELDS) {
    assert.equal(retried.state[field], cleanState[field], `${field} converges to the clean run`);
  }
  assert.deepEqual(
    flaky.harness.inbox(SPACE).map((row) => row.sourceKey).sort(),
    clean.harness.inbox(SPACE).map((row) => row.sourceKey).sort(),
    'the retry stores the same rows as the clean run',
  );
  assert.equal(flaky.harness.readImport(SPACE, { connectionKey: key }).lastErrorCode, null);
});

test('a mid-page row-store failure replays to the same rows and the same counts as a clean run', async (t) => {
  const clean = await cleanRun(t, 'store');

  const stumb = setup({ tenantId: 'channel-import-store-converge' });
  t.after(() => stumb.harness.close());
  // A transient outage on the second row write: the first event is fully
  // earned and ledgered, the second leaves no trace, and the abort carries
  // no provider text.
  const inboxEntry = stumb.harness.internals.modules.get('channel-inbox-event');
  const innerService = inboxEntry.service;
  let writes = 0;
  const throwingService = Object.create(innerService, {
    createManaged: {
      value: async (...args) => {
        writes += 1;
        if (writes === 2) {
          const error = new Error('inbox store transiently unavailable');
          error.code = 'CHANNEL_STORE_TRANSIENT';
          throw error;
        }
        return innerService.createManaged(...args);
      },
    },
  });
  stumb.harness.internals.modules.set('channel-inbox-event', { service: throwingService });

  const key = await registeredActive(stumb.harness);
  stumb.api.seedHistory(convergeSeed(nowIso()));
  await stumb.harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });

  const failure = await stumb.harness.advanceImport(SPACE, { connectionKey: key }).then(
    () => { throw new Error('advance should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CHANNEL_STORE_TRANSIENT');
  const partial = stumb.harness.readImport(SPACE, { connectionKey: key });
  assert.equal(partial.status, 'running');
  assert.equal(partial.importedEvents, 1);
  assert.equal(partial.failedEvents, 1, 'the unstored event is recorded failed, not lost');
  assert.equal(partial.createdContacts, 1);
  assert.equal(partial.lastErrorCode, 'CHANNEL_STORE_TRANSIENT');

  const retried = await stumb.harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(retried.done, true);
  // failed goes 1 → 0: the page answer reports honest before/after deltas,
  // so resolving a recorded failure reads as -1 next to the +1 import.
  assert.deepEqual(retried.page, {
    imported: 1, duplicates: 0, failed: -1, matched: 0, created: 1, unresolved: 0, withoutSender: 0,
  }, 'the retry skips the recorded event and processes only the missing one');
  const cleanState = clean.harness.readImport(SPACE, { connectionKey: clean.key });
  for (const field of CONVERGE_FIELDS) {
    assert.equal(retried.state[field], cleanState[field], `${field} converges to the clean run`);
  }
  assert.deepEqual(
    stumb.harness.inbox(SPACE).map((row) => row.sourceKey).sort(),
    clean.harness.inbox(SPACE).map((row) => row.sourceKey).sort(),
    'the retry stores the same rows as the clean run',
  );
  assert.equal(stumb.harness.readImport(SPACE, { connectionKey: key }).lastErrorCode, null);
});

/**
 * Dropped cursor commit (review on #242): the worker dies after the rows
 * and outcomes are durable but before the cursor moves. Nothing tallies in
 * memory, so the retry replays the same page to the same rows and the COUNT
 * reads them — no drift, no recount.
 */
test('a dropped cursor commit replays to the same rows and counts', async (t) => {
  const clean = await cleanRun(t, 'cursor');

  const scene = setup({ tenantId: 'channel-import-cursor-drop' });
  t.after(() => scene.harness.close());
  // Drop exactly one cursor commit: any import-state write carrying a
  // nextPageToken throws, everything else (rows, outcomes, error stamps)
  // lands. The next advance retries the same page.
  const stateEntry = scene.harness.internals.modules.get('channel-import-state');
  const innerState = stateEntry.service;
  let armed = true;
  const droppingService = Object.create(innerState, {
    applyManaged: {
      value: async (id, patch, context) => {
        if (armed && patch && Object.hasOwn(patch, 'nextPageToken')) {
          armed = false;
          const error = new Error('cursor commit lost with the worker');
          error.code = 'CHANNEL_STORE_TRANSIENT';
          throw error;
        }
        return innerState.applyManaged(id, patch, context);
      },
    },
  });
  scene.harness.internals.modules.set('channel-import-state', { service: droppingService });

  const key = await registeredActive(scene.harness);
  scene.api.seedHistory(convergeSeed(nowIso()));
  await scene.harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });

  await assert.rejects(
    scene.harness.advanceImport(SPACE, { connectionKey: key }),
    (error) => error.code === 'CHANNEL_STORE_TRANSIENT',
  );
  const interrupted = scene.harness.readImport(SPACE, { connectionKey: key });
  assert.equal(interrupted.status, 'running', 'the cursor never moved');
  assert.equal(interrupted.importedEvents, 2, 'rows and outcomes are durable without the cursor');
  assert.equal(interrupted.createdContacts, 2);

  scene.harness.internals.modules.set('channel-import-state', { service: innerState });
  const retried = await scene.harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(retried.done, true);
  assert.deepEqual(retried.page, {
    imported: 0, duplicates: 0, failed: 0, matched: 0, created: 0, unresolved: 0, withoutSender: 0,
  }, 'every outcome already final: the replay recounts nothing');
  const cleanState = clean.harness.readImport(SPACE, { connectionKey: clean.key });
  for (const field of CONVERGE_FIELDS) {
    assert.equal(retried.state[field], cleanState[field], `${field} converges to the clean run`);
  }
  assert.deepEqual(
    scene.harness.inbox(SPACE).map((row) => row.sourceKey).sort(),
    clean.harness.inbox(SPACE).map((row) => row.sourceKey).sort(),
    'the retry stores the same rows as the clean run',
  );
});

/**
 * Two processes, one store (review on #242): two operations instances over
 * two connections to one file database advance the same import at once,
 * like two schedulers on two dynos. Every event keeps exactly one outcome
 * row (unique key, loser keeps the winner), so the COUNTs equal the rows —
 * no lost increments, no matter the interleave.
 */
test('two processes on one store converge counts to the rows', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'channel-import-twoproc-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, 'shared.sqlite');
  const sender = stubSender();
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const common = {
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: 'channel-import-twoproc',
    resolveSender: sender.resolveSender,
    dbPath,
  };
  const first = createChannelsHarness(common);
  t.after(() => first.close());
  const second = createChannelsHarness({ ...common });
  t.after(() => second.close());

  const reg = await first.register(SPACE, {
    channel: 'whatsapp', account: ACCOUNT, adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await first.activate(SPACE, reg.connection.sourceKey);
  const key = reg.connection.sourceKey;
  api.seedHistory(historySeed(4, nowIso()));
  await first.startImport(SPACE, { connectionKey: key, actor: ACTOR });

  const [one, two] = await Promise.all([
    first.advanceImport(SPACE, { connectionKey: key }),
    second.advanceImport(SPACE, { connectionKey: key }),
  ]);
  assert.equal(one.done, true);
  assert.equal(two.done, true);
  const state = first.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'done');
  assert.equal(state.failedEvents, 0);
  assert.equal(
    state.importedEvents + state.duplicateEvents + state.failedEvents, 4,
    'one outcome per event across both processes',
  );
  assert.equal(
    state.createdContacts + state.matchedContacts, 4,
    'every sender resolved exactly once net, however the racers interleaved',
  );
  assert.equal(first.inbox(SPACE).length, 4, 'four events, four rows');
  const outcomes = first.internals.modules.get('channel-import-outcome').service.listWhere({});
  assert.equal(outcomes.length, 4, 'four events, four outcome rows — the race doubled nothing');
  assert.equal(sender.seen.size, 4, 'four senders, four contacts — no duplicate identity per handle');
});

/**
 * Pending reconciliation is not a dead end: an advance that brings the
 * capability resolves the senders an earlier capability-less attempt left
 * pending, over the same store.
 */
test('a pending sender resolves when a later advance brings the capability', async (t) => {
  const scene = setup({ noSender: true, tenantId: 'channel-import-pending-then-capable' });
  t.after(() => scene.harness.close());
  // A transient outage on the second row write: the first event is stored
  // with its sender pending, the second leaves a failed outcome, and the
  // page aborts with the cursor unmoved.
  const inboxEntry = scene.harness.internals.modules.get('channel-inbox-event');
  const innerService = inboxEntry.service;
  let writes = 0;
  const throwingService = Object.create(innerService, {
    createManaged: {
      value: async (...args) => {
        writes += 1;
        if (writes === 2) {
          const error = new Error('inbox store transiently unavailable');
          error.code = 'CHANNEL_STORE_TRANSIENT';
          throw error;
        }
        return innerService.createManaged(...args);
      },
    },
  });
  scene.harness.internals.modules.set('channel-inbox-event', { service: throwingService });

  const key = await registeredActive(scene.harness);
  scene.api.seedHistory(convergeSeed(nowIso()));
  await scene.harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  await assert.rejects(
    scene.harness.advanceImport(SPACE, { connectionKey: key }),
    (error) => error.code === 'CHANNEL_STORE_TRANSIENT',
  );
  const partial = scene.harness.readImport(SPACE, { connectionKey: key });
  assert.equal(partial.importedEvents, 1);
  assert.equal(partial.unresolvedContacts, 1, 'the stored sender waits, visibly');

  // A restarted worker with the capability composed opens the same store:
  // nothing about the run lives in the closed composition.
  scene.harness.internals.modules.set('channel-inbox-event', { service: innerService });
  const sender = stubSender();
  const { database, modules, registries } = scene.harness.internals;
  const capable = createChannelOperations({
    database,
    modules,
    registries,
    resolveSecret: async () => SECRET,
    tenantId: 'channel-import-pending-capable',
    resolveSender: sender.resolveSender,
  });
  const retried = await capable.advanceInitialImport({ spaceId: SPACE, connectionKey: key, limit: 50 });
  assert.equal(retried.done, true);
  assert.equal(retried.state.importedEvents, 2);
  assert.equal(retried.state.failedEvents, 0);
  assert.equal(retried.state.createdContacts, 2, 'both pending and failed senders resolved');
  assert.equal(retried.state.unresolvedContacts, 0, 'nothing waits anymore');
  assert.ok(
    sender.calls.some((request) => request.handle === '+390200005101')
    && sender.calls.some((request) => request.handle === '+390200005102'),
    'the retry resolves the senders the earlier attempt left pending',
  );
});

/**
 * Stable import identity (giro 3 della #242): an event is its
 * (connection, providerEventId). A webhook-first echo stored without its
 * provider instant, later listed with it, is adopted as the same event —
 * a duplicate with the drift annotated, never a 409 that bricks the run.
 */
test('a webhook-first echo listed later with its provider instant is adopted, never a 409', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-import-echo-adopt' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();

  // The live webhook arrives first without its provider instant (an echo of
  // our own send): stored as quarantine evidence, no sender resolved.
  const { fixtureEventBody } = await import('../packages/channels/src/fixture.js');
  const rawBody = fixtureEventBody({ id: 'evt-echo-1', subject: '', seq: null, at: null });
  const delivered = await harness.ingest(SPACE, {
    connectionKey: key, rawBody, headers: harness.faults.sign(rawBody),
  });
  assert.equal(delivered.effect, 'quarantined');

  // The backfill lists the same id with its provider instant and sender.
  api.seedHistory([{ id: 'evt-echo-1', subject: 'chat-echo', seq: 1, at, sender: { handle: '+390200007101' } }]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const advanced = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(advanced.done, true);
  assert.deepEqual(advanced.page, {
    imported: 0, duplicates: 1, failed: 0, matched: 0, created: 0, unresolved: 0, withoutSender: 0,
  });
  assert.equal(harness.inbox(SPACE).length, 1, 'one message, one row, whichever path saw it first');
  const outcomes = harness.internals.modules.get('channel-import-outcome').service.listWhere({});
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, 'duplicate');
  assert.ok(
    outcomes[0].note && outcomes[0].note.includes('occurredAt differs'),
    `the drift is annotated on the import row, got ${JSON.stringify(outcomes[0].note)}`,
  );
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'done');
  assert.equal(state.duplicateEvents, 1);
});

/**
 * Idempotent start (giro 3 della #242): two overlapping starts resolve to
 * the single stored row — one winner, one resume — never a raw unique
 * violation, never a second import of one connection.
 */
test('two overlapping starts resolve to one running import', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-import-start-race' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  api.seedHistory(historySeed(1, nowIso()));

  const [first, second] = await Promise.all([
    harness.startImport(SPACE, { connectionKey: key, actor: ACTOR }),
    harness.startImport(SPACE, { connectionKey: key, actor: ACTOR }),
  ]);
  assert.deepEqual(
    [first.started, second.started].sort(),
    [false, true],
    'exactly one start wins, the other resumes',
  );
  assert.equal(first.state.status, 'running');
  assert.equal(second.state.status, 'running');
  const states = harness.internals.modules.get('channel-import-state').service.listWhere({});
  assert.equal(states.length, 1, 'one connection, one import row');
});

/**
 * Poison skip (giro 3 della #242): an event that fails deterministically
 * is recorded failed and skipped — the page completes and the cursor
 * advances past it, so one bad event can never brick the run.
 */
test('a deterministically failing event is recorded failed and skipped: the page completes', async (t) => {
  const poison = '+390200008101';
  const { harness, api } = setup({
    tenantId: 'channel-import-poison',
    senderThrows: { handle: poison, message: 'sender evidence refused', code: 'CHANNEL_SENDER_REFUSED', status: 422 },
  });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = nowIso();
  api.seedHistory([
    { id: 'evt-p-1', subject: 'chat-p', seq: 1, at, sender: { handle: '+390200008100' } },
    { id: 'evt-p-2', subject: 'chat-p', seq: 2, at, sender: { handle: poison } },
    { id: 'evt-p-3', subject: 'chat-p', seq: 3, at, sender: { handle: '+390200008102' } },
  ]);

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const advanced = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(advanced.done, true, 'one poisoned event never bricks the page');
  assert.deepEqual(advanced.page, {
    imported: 2, duplicates: 0, failed: 1, matched: 0, created: 2, unresolved: 1, withoutSender: 0,
  });
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.status, 'done');
  assert.equal(state.failedEvents, 1);
  assert.equal(state.importedEvents, 2);
  assert.equal(harness.inbox(SPACE).length, 3, 'the poisoned row is stored; only its reconciliation failed');
  const outcomes = harness.internals.modules.get('channel-import-outcome').service.listWhere({});
  const poisoned = outcomes.find((entry) => entry.providerEventId === 'evt-p-2');
  assert.equal(poisoned.outcome, 'failed');
  assert.ok(
    poisoned.note && poisoned.note.includes('sender resolution refused'),
    `the refusal is annotated, got ${JSON.stringify(poisoned.note)}`,
  );
  // The cursor moved past the poison: the next advance answers done
  // without reprocessing it.
  const again = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(again.done, true);
  assert.equal(again.page, null);
});

/**
 * Conflicting sender across sightings (giro 3 della #242): the same
 * provider id re-listed with conflicting sender evidence refines a
 * previously final sender toward unresolved — the human confirm queue —
 * never a 409, and the conflict is annotated on the import row.
 */
test('a re-listed same event with conflicting sender evidence refines to unresolved for a human', async (t) => {
  const { harness, api, sender } = setup({ tenantId: 'channel-import-sender-conflict' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.parse(nowIso());
  // Same provider id on two pages (oldest first): the first sighting
  // reconciles, the second carries conflicting sender evidence.
  api.seedHistory([
    { id: 'evt-d-1', subject: 'chat-d', seq: 1, at: new Date(at).toISOString(), sender: { handle: '+390200009101' } },
    { id: 'evt-d-1', subject: 'chat-d', seq: 1, at: new Date(at + 1000).toISOString(), sender: { handle: 'ambiguous-case' } },
  ]);

  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const first = await harness.advanceImport(SPACE, { connectionKey: key, limit: 1 });
  assert.equal(first.done, false);
  assert.equal(first.page.imported, 1);

  const second = await harness.advanceImport(SPACE, { connectionKey: key, limit: 1 });
  assert.equal(second.done, true);
  assert.deepEqual(second.page, {
    imported: 0, duplicates: 0, failed: 0, matched: 0, created: -1, unresolved: 1, withoutSender: 0,
  }, 'the conflict moves the sender to unresolved: nothing recounted, nothing doubled');
  assert.ok(
    sender.calls.some((request) => request.handle === '+390200009101')
    && sender.calls.some((request) => request.handle === 'ambiguous-case'),
    'both sightings reached the reconciliation',
  );
  const outcomes = harness.internals.modules.get('channel-import-outcome').service.listWhere({});
  assert.equal(outcomes.length, 1, 'one event, one outcome row');
  assert.equal(outcomes[0].outcome, 'imported');
  assert.equal(outcomes[0].sender, 'unresolved');
  assert.ok(
    outcomes[0].note && outcomes[0].note.includes('sender evidence conflicts'),
    `the conflict is annotated, got ${JSON.stringify(outcomes[0].note)}`,
  );
  assert.equal(harness.inbox(SPACE).length, 1, 'one event, one row');
  const state = harness.readImport(SPACE, { connectionKey: key });
  assert.equal(state.unresolvedContacts, 1);
  assert.equal(state.createdContacts, 0);
});
