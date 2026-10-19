import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { fixtureWebhookHeaders } from '../packages/channels/src/fixture.js';
import {
  createMessengerChannelAdapter,
  messengerEventBody,
  messengerWebhookHeaders,
  MESSENGER_ADAPTER_NAME,
  MESSENGER_ADAPTER_VERSION,
  MESSENGER_HUMAN_AGENT_TAG,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * Messenger Graph adapter tests (backlog:23d5b455cb3a).
 *
 * The second Graph adapter on the common channel base, on the same Meta
 * app as Instagram wherever the provider allows: Page webhook bodies with
 * hub signatures in, Page replies with the 24-hour window rules out —
 * against a fake transport, no credentials (owner decision
 * MEM_ACC_DECISIONS). Proven the same way the acceptance names it: the
 * channel kit, plus a Messenger message reaching the right card. Every
 * batch/echo/window rule under test lives once in `meta-webhook.js`; the
 * adapter only owns the `page` object name, the `fb:` subject prefix and
 * its own texts.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const PAGE_ID = '1234567890123456';
const PAGE_B = '1234567890123457';
const SECRET_REF = 'vault://presti/messenger-a';
const SECRET = 'messenger-kit-secret-1';
const ACTOR = { type: 'user', id: 'messenger-kit' };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = new Date('2026-10-01T10:00:00.000Z').getTime();

function setup(options = {}) {
  let now = options.now ?? T0;
  const clock = { now: () => now, set: (value) => { now = value; } };
  const { definition, api } = createMessengerChannelAdapter({
    secret: SECRET,
    pageId: options.pageId ?? PAGE_ID,
    testOnly: options.testOnly ?? true,
    nowMs: () => clock.now(),
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'messenger-kit', config: options.config,
  });
  return { harness, api, definition, clock };
}

async function registeredActive(harness, space = SPACE_A, account = PAGE_ID) {
  const reg = await harness.register(space, {
    channel: 'facebook', account, adapter: MESSENGER_ADAPTER_NAME, adapterVersion: MESSENGER_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function pageBody({ mid, sender = 'fb-user-7', text = 'Avete posto sabato?', atMs = T0 }) {
  return messengerEventBody({ mid, sender, recipient: PAGE_ID, text, timestampMs: atMs });
}

test('the messenger adapter passes the channel kit', async (t) => {
  const { harness, definition } = setup({ tenantId: 'messenger-kit-acceptance' });
  t.after(() => harness.close());
  // Page bodies travel hub-signed (the production scheme), so the kit's
  // seeded window proves the real Page path: break hub verification or
  // Page parsing and the seed — hence the send — fails. The kit's own
  // minimal envelopes keep the fixture scheme.
  const sign = (rawBody) => {
    try {
      const parsed = JSON.parse(String(rawBody));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entry)) {
        return messengerWebhookHeaders(rawBody, SECRET);
      }
    } catch {
      // Not JSON: the fixture scheme signs it like before.
    }
    return harness.faults.sign(rawBody);
  };
  const results = await runChannelAdapterKit({
    adapter: definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    spaceA: SPACE_A,
    spaceB: SPACE_B,
    accountA: PAGE_ID,
    accountB: PAGE_B,
    actor: harness.userActor,
    harness: {
      register: (spaceId, input) => harness.register(spaceId, input),
      activate: (spaceId, key) => harness.activate(spaceId, key),
      ingest: (spaceId, args) => harness.ingest(spaceId, args),
      queue: (spaceId, args) => harness.queue(spaceId, args),
      pump: (jobId) => harness.pump(jobId),
      faults: { ...harness.faults, sign },
      connections: (spaceId) => harness.connections(spaceId),
      inbox: (spaceId) => harness.inbox(spaceId),
      letters: (spaceId, state) => harness.letters(spaceId, state),
      dumpStorage: () => harness.dumpStorage(),
    },
  });
  assert.deepEqual(
    results.map((row) => `${row.name}:${row.pass ? 'pass' : `FAIL ${row.detail}`}`),
    ['receive:pass', 'send:pass', 'replay:pass', 'bad-signature:pass', 'out-of-order:pass', 'no-secrets:pass', 'space-isolation:pass', 'history:pass'],
  );
});

test('a signed Page webhook applies with the sender subject; forgeries write nothing', async (t) => {
  const { harness, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = pageBody({ mid: 'm_in_1' });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: messengerWebhookHeaders(rawBody, SECRET) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_in_1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'fb:fb-user-7');
  assert.equal(rows[0].occurredAt, new Date(T0).toISOString());

  const normalized = definition.normalizeInbound(rawBody);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].from, 'fb-user-7');
  assert.equal(normalized[0].text, 'Avete posto sabato?');

  const forged = pageBody({ mid: 'm_forged' });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: messengerWebhookHeaders(forged, 'wrong-secret') }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_forged').length, 0);
});

test('non-Page deliveries refuse as malformed and write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const sign = (body) => messengerWebhookHeaders(body, SECRET);
  const bodies = [
    'not json',
    // The sister adapter's object on the same Meta app routes elsewhere:
    // an Instagram delivery to the Messenger adapter refuses, never applies.
    JSON.stringify({ object: 'instagram', entry: [] }),
    JSON.stringify({ object: 'page', entry: [{ id: PAGE_ID, messaging: [{ sender: { id: 'u' }, recipient: { id: PAGE_ID }, timestamp: T0 }] }] }),
    JSON.stringify({ object: 'page', entry: [{ id: PAGE_ID, messaging: [] }] }),
  ];
  for (const [index, rawBody] of bodies.entries()) {
    await assert.rejects(
      harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: sign(rawBody) }),
      (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
      `body ${index} refuses`,
    );
  }
  assert.equal(harness.inbox(SPACE_A).length, 0);
});

test('a max-length sender still fits the 256-char subject; one char more refuses', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const fitting = pageBody({ mid: 'm_edge_fit', sender: `u${'x'.repeat(252)}` });
  const ok = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: fitting, headers: messengerWebhookHeaders(fitting, SECRET) });
  assert.equal(ok.effect, 'applied');
  assert.equal(harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_edge_fit')[0].subject.length, 256);

  const overflowing = pageBody({ mid: 'm_edge_over', sender: `u${'x'.repeat(253)}` });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: overflowing, headers: messengerWebhookHeaders(overflowing, SECRET) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
});

test('a reply inside the window sends once; the same key queued twice sends once', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const inbound = pageBody({ mid: 'm_win_1', sender: 'fb-user-9', atMs: T0 });
  const applied = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: messengerWebhookHeaders(inbound, SECRET) });
  assert.equal(applied.effect, 'applied');
  // The window lives in the inbox row, never in adapter memory.
  const observed = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_win_1');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].subject, 'fb:fb-user-9');
  assert.equal(observed[0].occurredAt, new Date(T0).toISOString());

  const message = { to: 'fb-user-9', text: 'Certo, alle 18!' };
  const first = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'm-win-fresh' });
  const second = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'm-win-fresh' });
  assert.equal(first.jobId, second.jobId, 'the idempotency root resolves identically');
  assert.equal((await harness.pump(first.jobId)).state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1, 'one effective provider send');
  assert.ok(api.sentMessages()[0].text.includes('alle 18'));
});

test('window enforcement uses the injected clock: late replies refuse at queue time, tagged ones pass', async (t) => {
  const { harness, clock } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const inbound = pageBody({ mid: 'm_win_2', sender: 'fb-user-11', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: messengerWebhookHeaders(inbound, SECRET) });

  // A late standard reply refuses before the outbox: no job, no letter.
  clock.set(T0 + 26 * HOUR_MS);
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'fb-user-11', text: 'Sei ancora lì?' }, messageKey: 'm-win-late' }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );

  const tagged = await harness.queue(SPACE_A, {
    connectionKey: key,
    message: { to: 'fb-user-11', text: 'Riprendiamo da qui', tag: MESSENGER_HUMAN_AGENT_TAG },
    messageKey: 'm-win-tagged',
  });
  assert.equal((await harness.pump(tagged.jobId)).state, 'succeeded');

  // Past 7 days even the tag is closed.
  clock.set(T0 + 8 * DAY_MS);
  await assert.rejects(
    harness.queue(SPACE_A, {
      connectionKey: key,
      message: { to: 'fb-user-11', text: 'Ultimo tentativo', tag: MESSENGER_HUMAN_AGENT_TAG },
      messageKey: 'm-win-toolate',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );

  // A stranger with no inbound at all is closed too — never an open relay.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'fb-stranger-1', text: 'Ciao' }, messageKey: 'm-win-stranger' }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );

  // Unknown tags refuse at queue time, before the outbox.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'fb-user-11', text: 'x', tag: 'PROMO' }, messageKey: 'm-win-badtag' }),
    (error) => error.code === 'CHANNEL_MESSAGE_MALFORMED',
  );
});

test('production composition refuses the kit dialect and closes the window for the page itself', async (t) => {
  const { harness } = setup({ testOnly: false, tenantId: 'messenger-production' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const minimal = JSON.stringify({ id: 'evt-prod-1', subject: 'chat-1', seq: 1 });
  await assert.rejects(
    harness.ingest(SPACE_A, {
      connectionKey: key,
      rawBody: minimal,
      headers: fixtureWebhookHeaders(minimal, SECRET, Math.floor(Date.now() / 1000)),
    }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );

  // No test-only loopback: the page itself is an ordinary recipient, so
  // with no inbound from it the window is closed at queue time.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: PAGE_ID, text: 'self' }, messageKey: 'm-prod-loop' }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
});

test('a Messenger message creates the right card, and the next one updates it', async (t) => {
  const { harness, definition } = setup({ tenantId: 'messenger-card' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);

  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'messenger-card.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  // The handle the adapter extracts from a real Page delivery.
  const rawBody = pageBody({ mid: 'm_card_1', sender: 'fb-giulia-verdi', text: 'Quanto costa il pacchetto?' });
  const applied = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: messengerWebhookHeaders(rawBody, SECRET) });
  assert.equal(applied.effect, 'applied');
  const sender = definition.normalizeInbound(rawBody)[0];

  const created = await app.resolveChannelSender({
    channel: 'facebook', handle: sender.from, email: 'giulia.verdi@example.com',
    firstName: 'Giulia', lastName: 'Verdi', actor: ACTOR,
  });
  assert.equal(created.outcome, 'created');

  const secondBody = pageBody({ mid: 'm_card_2', sender: 'fb-giulia-verdi', text: 'E gli orari?' });
  const appliedAgain = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: secondBody, headers: messengerWebhookHeaders(secondBody, SECRET) });
  assert.equal(appliedAgain.effect, 'applied');
  const again = definition.normalizeInbound(secondBody)[0];
  const matched = await app.resolveChannelSender({ channel: 'facebook', handle: again.from, actor: ACTOR });
  assert.equal(matched.outcome, 'matched');
  assert.equal(matched.contact.id, created.contact.id, 'the second Messenger message names the same card');

  const identities = app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: created.contact.id, status: 'active' });
  assert.equal(identities.filter((row) => row.system === 'facebook').length, 1, 'one Facebook identity, never a duplicate');
  assert.equal(identities.find((row) => row.system === 'facebook').externalId, 'fb-giulia-verdi');

  const profile = await app.readCustomerProfile({ resource: 'contact', id: created.contact.id });
  assert.ok(
    profile.externalIdentities.some((identity) => identity.system === 'facebook' && identity.externalId === 'fb-giulia-verdi'),
    'the card carries the Messenger handle',
  );
});

test('a batched Page delivery stores one row per message; echoes stay out', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const sign = (body) => messengerWebhookHeaders(body, SECRET);

  // Three texts across two entries plus our own echo: three rows, the
  // echo stays out — the same list path the Instagram adapter uses.
  const batch = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        messaging: [
          { sender: { id: 'fb-user-7' }, recipient: { id: PAGE_ID }, timestamp: T0, message: { mid: 'm_batch_1', text: 'one' } },
          { sender: { id: PAGE_ID }, recipient: { id: 'fb-user-7' }, timestamp: T0, is_echo: true, message: { mid: 'm_echo_1', text: 'our own reply' } },
        ],
      },
      {
        id: PAGE_ID,
        messaging: [
          { sender: { id: 'fb-user-8' }, recipient: { id: PAGE_ID }, timestamp: T0, message: { mid: 'm_batch_2', text: 'two' } },
          { sender: { id: 'fb-user-9' }, recipient: { id: PAGE_ID }, timestamp: T0, message: { mid: 'm_batch_3', text: 'three' } },
        ],
      },
    ],
  });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: batch, headers: sign(batch) });
  assert.equal(out.batched, true);
  assert.equal(out.events.length, 3);
  for (const item of out.events) {
    assert.equal(item.effect, 'applied', `every batch item applies, got ${JSON.stringify(item)}`);
    assert.equal(item.duplicate, false);
  }
  assert.deepEqual(
    harness.inbox(SPACE_A).map((row) => row.providerEventId).sort(),
    ['m_batch_1', 'm_batch_2', 'm_batch_3'],
  );

  // Redelivering the same batch resolves per item: duplicates, no new rows.
  const replay = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: batch, headers: sign(batch) });
  assert.equal(replay.batched, true);
  assert.equal(replay.events.length, 3);
  for (const item of replay.events) {
    assert.equal(item.duplicate, true);
  }
  assert.equal(harness.inbox(SPACE_A).length, 3, 'a batch redelivery stores nothing twice');

  // One text next to an echo: the echo is skipped, the text applies alone.
  const singleEcho = messengerEventBody({
    mid: 'm_single_1', sender: 'fb-user-7', text: 'solo', timestampMs: T0,
    extra: [{
      sender: { id: PAGE_ID }, recipient: { id: 'fb-user-7' }, timestamp: T0,
      is_echo: true, message: { mid: 'm_echo_2', text: 'our own reply' },
    }],
  });
  const single = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: singleEcho, headers: sign(singleEcho) });
  assert.equal(single.effect, 'applied');
  assert.deepEqual(
    harness.inbox(SPACE_A).map((row) => row.providerEventId).sort(),
    ['m_batch_1', 'm_batch_2', 'm_batch_3', 'm_single_1'],
  );

  // An echo alone is not an inbound: refuses, writes nothing.
  const echoOnly = messengerEventBody({
    mid: 'm_echo_3', sender: PAGE_ID, recipient: 'fb-user-7', text: 'our own reply',
    timestampMs: T0, echo: true,
  });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: echoOnly, headers: sign(echoOnly) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).length, 4);
});

test('the window is per space and connection: one space never sends on another consent', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, SPACE_A, PAGE_ID);
  const keyB = await registeredActive(harness, SPACE_B, PAGE_B);

  const inbound = pageBody({ mid: 'm_xspace_1', sender: 'fb-user-7', atMs: T0 });
  const applied = await harness.ingest(SPACE_A, { connectionKey: keyA, rawBody: inbound, headers: messengerWebhookHeaders(inbound, SECRET) });
  assert.equal(applied.effect, 'applied');

  // Same user, but space B never heard from them: closed.
  await assert.rejects(
    harness.queue(SPACE_B, { connectionKey: keyB, message: { to: 'fb-user-7', text: 'Ciao' }, messageKey: 'm-xspace-b' }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );

  // Space A, which holds the inbound, sends fine through the real queue path.
  const queued = await harness.queue(SPACE_A, { connectionKey: keyA, message: { to: 'fb-user-7', text: 'Ciao' }, messageKey: 'm-xspace-a' });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
});

test('a forged caller instant never opens the window; a future provider stamp quarantines', async (t) => {
  const { harness, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);

  // message.lastInboundAt is never read: a forged future instant on the
  // message with no inbox behind it still refuses.
  await assert.rejects(
    harness.queue(SPACE_A, {
      connectionKey: key,
      message: { to: 'fb-user-7', text: 'Ciao', lastInboundAt: new Date(T0 + DAY_MS).toISOString() },
      messageKey: 'm-forge-1',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );

  // And a stale caller instant cannot close a window the inbox holds open.
  const inbound = pageBody({ mid: 'm_forge_2', sender: 'fb-user-7', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: messengerWebhookHeaders(inbound, SECRET) });
  const queued = await harness.queue(SPACE_A, {
    connectionKey: key,
    message: { to: 'fb-user-7', text: 'Ciao', lastInboundAt: new Date(T0 - 30 * DAY_MS).toISOString() },
    messageKey: 'm-forge-2',
  });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');

  // A provider stamp a year in the future is kept as quarantine evidence
  // at receive time: never a window observation, never a sequence — the
  // same central rule the Instagram adapter shares.
  const future = pageBody({ mid: 'm_future_1', sender: 'fb-user-9', atMs: T0 + 366 * DAY_MS });
  const skewed = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: future, headers: messengerWebhookHeaders(future, SECRET) });
  assert.equal(skewed.effect, 'quarantined');
  const skewedRows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_future_1');
  assert.equal(skewedRows.length, 1);
  assert.equal(skewedRows[0].sequence, null);
  assert.match(skewedRows[0].effectReason, /beyond \+5min skew/);

  // The window stays closed: the skewed row is not an observation.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'fb-user-9', text: 'Dal futuro' }, messageKey: 'm-skew-closed' }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );

  // A legitimate message after the skewed one still applies (never
  // suppressed by it) and opens the window again.
  const real = pageBody({ mid: 'm_future_2', sender: 'fb-user-9', atMs: T0 });
  const appliedReal = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: real, headers: messengerWebhookHeaders(real, SECRET) });
  assert.equal(appliedReal.effect, 'applied');
  const reopened = await harness.queue(SPACE_A, { connectionKey: key, message: { to: 'fb-user-9', text: 'Di nuovo dentro' }, messageKey: 'm-skew-after' });
  assert.equal((await harness.pump(reopened.jobId)).state, 'succeeded');

  // Direct calls prove the same fail-closed shape without the queue.
  assert.throws(
    () => definition.normalizeOutbound({ to: 'fb-user-7', text: 'x' }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
  assert.throws(
    () => definition.normalizeOutbound({ to: 'fb-user-7', text: 'x' }, { lastInboundAt: new Date(T0 + DAY_MS).toISOString() }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
});

test('reset clears every adapter-held state; the inbox stays the window source', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const inbound = pageBody({ mid: 'm_reset_1', sender: 'fb-user-7', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: messengerWebhookHeaders(inbound, SECRET) });

  api.reset();
  assert.ok(!('lastInboundMs' in api.state), 'no per-recipient window memory survives a reset');
  assert.equal(api.state.sentByKey.size, 0);
  assert.equal(api.state.sendCalls, 0);

  // The inbox row (operations storage, per space and connection) is the
  // window source of truth, so it intentionally survives an adapter reset —
  // the kit itself relies on this: it resets before its send check and the
  // seeded window must still open the send.
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: 'fb-user-7', text: 'Ciao' }, messageKey: 'm-reset-1' });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
});
