import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { fixtureWebhookHeaders } from '../packages/channels/src/fixture.js';
import {
  createInstagramChannelAdapter,
  instagramEventBody,
  instagramWebhookHeaders,
  INSTAGRAM_ADAPTER_NAME,
  INSTAGRAM_ADAPTER_VERSION,
  INSTAGRAM_HUMAN_AGENT_TAG,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * Instagram Graph adapter tests (backlog:8e7f99e7741e).
 *
 * The first provider-shaped adapter on the common channel base: Graph
 * webhook bodies with hub signatures in, Graph replies with the 24-hour
 * window rules out — against a fake transport, no credentials (owner
 * decision MEM_ACC_DECISIONS). Proven the same way the acceptance names
 * it: the channel kit, plus an Instagram message reaching the right card.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const PAGE_ID = '17841400008460056';
const PAGE_B = '17841400008460057';
const SECRET_REF = 'vault://presti/instagram-a';
const SECRET = 'instagram-kit-secret-1';
const ACTOR = { type: 'user', id: 'instagram-kit' };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const T0 = new Date('2026-10-01T10:00:00.000Z').getTime();

function setup(options = {}) {
  let now = options.now ?? T0;
  const clock = { now: () => now, set: (value) => { now = value; } };
  const { definition, api } = createInstagramChannelAdapter({
    secret: SECRET,
    pageId: options.pageId ?? PAGE_ID,
    testOnly: options.testOnly ?? true,
    nowMs: () => clock.now(),
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'instagram-kit', config: options.config,
  });
  return { harness, api, definition, clock };
}

async function registeredActive(harness, space = SPACE_A, account = PAGE_ID) {
  const reg = await harness.register(space, {
    channel: 'instagram', account, adapter: INSTAGRAM_ADAPTER_NAME, adapterVersion: INSTAGRAM_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function graphBody({ mid, sender = 'ig-user-7', text = 'Avete posto sabato?', atMs = T0 }) {
  return instagramEventBody({ mid, sender, recipient: PAGE_ID, text, timestampMs: atMs });
}

test('the instagram adapter passes the channel kit', async (t) => {
  const { harness, definition } = setup({ tenantId: 'instagram-kit-acceptance' });
  t.after(() => harness.close());
  // Graph bodies travel hub-signed (the production scheme), so the kit's
  // seeded window proves the real Graph path: break hub verification or
  // Graph parsing and the seed — hence the send — fails. The kit's own
  // minimal envelopes keep the fixture scheme.
  const sign = (rawBody) => {
    try {
      const parsed = JSON.parse(String(rawBody));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entry)) {
        return instagramWebhookHeaders(rawBody, SECRET);
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
    ['receive:pass', 'send:pass', 'replay:pass', 'bad-signature:pass', 'out-of-order:pass', 'no-secrets:pass', 'space-isolation:pass'],
  );
});

test('a signed Graph webhook applies with the sender subject; forgeries write nothing', async (t) => {
  const { harness, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = graphBody({ mid: 'm_in_1' });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: instagramWebhookHeaders(rawBody, SECRET) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_in_1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'ig:ig-user-7');
  assert.equal(rows[0].occurredAt, new Date(T0).toISOString());

  const normalized = definition.normalizeInbound(rawBody);
  assert.equal(normalized.from, 'ig-user-7');
  assert.equal(normalized.text, 'Avete posto sabato?');

  const forged = graphBody({ mid: 'm_forged' });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: instagramWebhookHeaders(forged, 'wrong-secret') }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_forged').length, 0);
});

test('non-Graph deliveries refuse as malformed and write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const sign = (body) => instagramWebhookHeaders(body, SECRET);
  const bodies = [
    'not json',
    JSON.stringify({ object: 'page', entry: [] }),
    JSON.stringify({ object: 'instagram', entry: [{ id: PAGE_ID, messaging: [{ sender: { id: 'u' }, recipient: { id: PAGE_ID }, timestamp: T0 }] }] }),
    JSON.stringify({ object: 'instagram', entry: [{ id: PAGE_ID, messaging: [] }] }),
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
  const fitting = graphBody({ mid: 'm_edge_fit', sender: `u${'x'.repeat(252)}` });
  const ok = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: fitting, headers: instagramWebhookHeaders(fitting, SECRET) });
  assert.equal(ok.effect, 'applied');
  assert.equal(harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_edge_fit')[0].subject.length, 256);

  const overflowing = graphBody({ mid: 'm_edge_over', sender: `u${'x'.repeat(253)}` });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: overflowing, headers: instagramWebhookHeaders(overflowing, SECRET) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
});

test('a reply inside the window sends once; the same key queued twice sends once', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const inbound = graphBody({ mid: 'm_win_1', sender: 'ig-user-9', atMs: T0 });
  const applied = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: instagramWebhookHeaders(inbound, SECRET) });
  assert.equal(applied.effect, 'applied');
  // The window lives in the inbox row, never in adapter memory.
  const observed = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_win_1');
  assert.equal(observed.length, 1);
  assert.equal(observed[0].subject, 'ig:ig-user-9');
  assert.equal(observed[0].occurredAt, new Date(T0).toISOString());

  const message = { to: 'ig-user-9', text: 'Certo, alle 18!' };
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
  const inbound = graphBody({ mid: 'm_win_2', sender: 'ig-user-11', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: instagramWebhookHeaders(inbound, SECRET) });

  // A late standard reply refuses before the outbox: no job, no letter.
  clock.set(T0 + 26 * HOUR_MS);
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-user-11', text: 'Sei ancora lì?' }, messageKey: 'm-win-late' }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );

  const tagged = await harness.queue(SPACE_A, {
    connectionKey: key,
    message: { to: 'ig-user-11', text: 'Riprendiamo da qui', tag: INSTAGRAM_HUMAN_AGENT_TAG },
    messageKey: 'm-win-tagged',
  });
  assert.equal((await harness.pump(tagged.jobId)).state, 'succeeded');

  // Past 7 days even the tag is closed.
  clock.set(T0 + 8 * DAY_MS);
  await assert.rejects(
    harness.queue(SPACE_A, {
      connectionKey: key,
      message: { to: 'ig-user-11', text: 'Ultimo tentativo', tag: INSTAGRAM_HUMAN_AGENT_TAG },
      messageKey: 'm-win-toolate',
    }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );

  // A stranger with no inbound at all is closed too — never an open relay.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-stranger-1', text: 'Ciao' }, messageKey: 'm-win-stranger' }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );

  // Unknown tags refuse at queue time, before the outbox.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-user-11', text: 'x', tag: 'PROMO' }, messageKey: 'm-win-badtag' }),
    (error) => error.code === 'CHANNEL_MESSAGE_MALFORMED',
  );
});

test('production composition refuses the kit dialect and closes the window for the page itself', async (t) => {
  const { harness } = setup({ testOnly: false, tenantId: 'instagram-production' });
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
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );
});

test('an Instagram message creates the right card, and the next one updates it', async (t) => {
  const { harness, definition } = setup({ tenantId: 'instagram-card' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);

  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'instagram-card.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  // The handle the adapter extracts from a real Graph delivery.
  const rawBody = graphBody({ mid: 'm_card_1', sender: 'ig-giulia-verdi', text: 'Quanto costa il pacchetto?' });
  const applied = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: instagramWebhookHeaders(rawBody, SECRET) });
  assert.equal(applied.effect, 'applied');
  const sender = definition.normalizeInbound(rawBody);

  const created = await app.resolveChannelSender({
    channel: 'instagram', handle: sender.from, email: 'giulia.verdi@example.com',
    firstName: 'Giulia', lastName: 'Verdi', actor: ACTOR,
  });
  assert.equal(created.outcome, 'created');

  const secondBody = graphBody({ mid: 'm_card_2', sender: 'ig-giulia-verdi', text: 'E gli orari?' });
  const appliedAgain = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: secondBody, headers: instagramWebhookHeaders(secondBody, SECRET) });
  assert.equal(appliedAgain.effect, 'applied');
  const again = definition.normalizeInbound(secondBody);
  const matched = await app.resolveChannelSender({ channel: 'instagram', handle: again.from, actor: ACTOR });
  assert.equal(matched.outcome, 'matched');
  assert.equal(matched.contact.id, created.contact.id, 'the second Instagram message names the same card');

  const identities = app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: created.contact.id, status: 'active' });
  assert.equal(identities.filter((row) => row.system === 'instagram').length, 1, 'one Instagram identity, never a duplicate');
  assert.equal(identities.find((row) => row.system === 'instagram').externalId, 'ig-giulia-verdi');

  const profile = await app.readCustomerProfile({ resource: 'contact', id: created.contact.id });
  assert.ok(
    profile.externalIdentities.some((identity) => identity.system === 'instagram' && identity.externalId === 'ig-giulia-verdi'),
    'the card carries the Instagram handle',
  );
});

test('a batched delivery refuses loudly and writes nothing; echoes stay out', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const sign = (body) => instagramWebhookHeaders(body, SECRET);

  // Two texts in one delivery: refused, never half-ingested.
  const batch = instagramEventBody({
    mid: 'm_batch_1', sender: 'ig-user-7', text: 'one', timestampMs: T0,
    extra: [{
      sender: { id: 'ig-user-8' }, recipient: { id: PAGE_ID }, timestamp: T0,
      message: { mid: 'm_batch_2', text: 'two' },
    }],
  });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: batch, headers: sign(batch) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).length, 0);

  // An echo next to a batch does not hide it: still two texts, still refused.
  const batchEcho = instagramEventBody({
    mid: 'm_batch_3', sender: 'ig-user-7', text: 'one', timestampMs: T0,
    extra: [
      {
        sender: { id: PAGE_ID }, recipient: { id: 'ig-user-7' }, timestamp: T0,
        is_echo: true, message: { mid: 'm_echo_1', text: 'our own reply' },
      },
      {
        sender: { id: 'ig-user-8' }, recipient: { id: PAGE_ID }, timestamp: T0,
        message: { mid: 'm_batch_4', text: 'two' },
      },
    ],
  });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: batchEcho, headers: sign(batchEcho) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).length, 0);

  // One text next to an echo: the echo is skipped, the text applies alone.
  const singleEcho = instagramEventBody({
    mid: 'm_single_1', sender: 'ig-user-7', text: 'solo', timestampMs: T0,
    extra: [{
      sender: { id: PAGE_ID }, recipient: { id: 'ig-user-7' }, timestamp: T0,
      is_echo: true, message: { mid: 'm_echo_2', text: 'our own reply' },
    }],
  });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: singleEcho, headers: sign(singleEcho) });
  assert.equal(out.effect, 'applied');
  assert.deepEqual(
    harness.inbox(SPACE_A).map((row) => row.providerEventId),
    ['m_single_1'],
  );

  // An echo alone is not an inbound: nothing to apply.
  const echoOnly = instagramEventBody({
    mid: 'm_echo_3', sender: PAGE_ID, recipient: 'ig-user-7', text: 'our own reply',
    timestampMs: T0, echo: true,
  });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: echoOnly, headers: sign(echoOnly) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).length, 1);
});

test('the window is per space and connection: one space never sends on another consent', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, SPACE_A, PAGE_ID);
  const keyB = await registeredActive(harness, SPACE_B, PAGE_B);

  const inbound = graphBody({ mid: 'm_xspace_1', sender: 'ig-user-7', atMs: T0 });
  const applied = await harness.ingest(SPACE_A, { connectionKey: keyA, rawBody: inbound, headers: instagramWebhookHeaders(inbound, SECRET) });
  assert.equal(applied.effect, 'applied');

  // Same user, but space B never heard from them: closed.
  await assert.rejects(
    harness.queue(SPACE_B, { connectionKey: keyB, message: { to: 'ig-user-7', text: 'Ciao' }, messageKey: 'm-xspace-b' }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );

  // Space A, which holds the inbound, sends fine through the real queue path.
  const queued = await harness.queue(SPACE_A, { connectionKey: keyA, message: { to: 'ig-user-7', text: 'Ciao' }, messageKey: 'm-xspace-a' });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
});

test('a forged caller instant never opens the window; a future provider stamp refuses', async (t) => {
  const { harness, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);

  // message.lastInboundAt is never read: a forged future instant on the
  // message with no inbox behind it still refuses.
  await assert.rejects(
    harness.queue(SPACE_A, {
      connectionKey: key,
      message: { to: 'ig-user-7', text: 'Ciao', lastInboundAt: new Date(T0 + DAY_MS).toISOString() },
      messageKey: 'm-forge-1',
    }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );

  // And a stale caller instant cannot close a window the inbox holds open.
  const inbound = graphBody({ mid: 'm_forge_2', sender: 'ig-user-7', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: instagramWebhookHeaders(inbound, SECRET) });
  const queued = await harness.queue(SPACE_A, {
    connectionKey: key,
    message: { to: 'ig-user-7', text: 'Ciao', lastInboundAt: new Date(T0 - 30 * DAY_MS).toISOString() },
    messageKey: 'm-forge-2',
  });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');

  // A provider stamp a year in the future refuses at ingest: it would
  // otherwise hold the window open indefinitely.
  const future = graphBody({ mid: 'm_future_1', sender: 'ig-user-9', atMs: T0 + 366 * DAY_MS });
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: future, headers: instagramWebhookHeaders(future, SECRET) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'm_future_1').length, 0);

  // Direct calls prove the same fail-closed shape without the queue.
  assert.throws(
    () => definition.normalizeOutbound({ to: 'ig-user-7', text: 'x' }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );
  assert.throws(
    () => definition.normalizeOutbound({ to: 'ig-user-7', text: 'x' }, { lastInboundAt: new Date(T0 + DAY_MS).toISOString() }),
    (error) => error.code === 'CHANNEL_WINDOW_CLOSED',
  );
});

test('reset clears every adapter-held state; the inbox stays the window source', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const inbound = graphBody({ mid: 'm_reset_1', sender: 'ig-user-7', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: instagramWebhookHeaders(inbound, SECRET) });

  api.reset();
  assert.ok(!('lastInboundMs' in api.state), 'no per-recipient window memory survives a reset');
  assert.equal(api.state.sentByKey.size, 0);
  assert.equal(api.state.sendCalls, 0);

  // The inbox row (operations storage, per space and connection) is the
  // window source of truth, so it intentionally survives an adapter reset —
  // the kit itself relies on this: it resets before its send check and the
  // seeded window must still open the send.
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-user-7', text: 'Ciao' }, messageKey: 'm-reset-1' });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
});
