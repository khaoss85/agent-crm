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
      faults: harness.faults,
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
  assert.equal(api.lastInboundOf('ig-user-9'), T0);

  const message = { to: 'ig-user-9', text: 'Certo, alle 18!' };
  const first = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'm-win-fresh' });
  const second = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'm-win-fresh' });
  assert.equal(first.jobId, second.jobId, 'the idempotency root resolves identically');
  assert.equal((await harness.pump(first.jobId)).state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1, 'one effective provider send');
  assert.ok(api.sentMessages()[0].text.includes('alle 18'));
});

test('window enforcement uses the injected clock: late standard replies letter, tagged ones pass', async (t) => {
  const { harness, clock } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const inbound = graphBody({ mid: 'm_win_2', sender: 'ig-user-11', atMs: T0 });
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: inbound, headers: instagramWebhookHeaders(inbound, SECRET) });

  clock.set(T0 + 26 * HOUR_MS);
  const late = await harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-user-11', text: 'Sei ancora lì?' }, messageKey: 'm-win-late' });
  const settled = await harness.pump(late.jobId);
  assert.equal(settled.state, 'failed_terminal');
  const letters = harness.letters(SPACE_A, 'open');
  assert.equal(letters.length, 1);
  assert.equal(letters[0].errorCode, 'CHANNEL_WINDOW_CLOSED');

  const tagged = await harness.queue(SPACE_A, {
    connectionKey: key,
    message: { to: 'ig-user-11', text: 'Riprendiamo da qui', tag: INSTAGRAM_HUMAN_AGENT_TAG },
    messageKey: 'm-win-tagged',
  });
  assert.equal((await harness.pump(tagged.jobId)).state, 'succeeded');

  // Past 7 days even the tag is closed.
  clock.set(T0 + 8 * DAY_MS);
  const tooLate = await harness.queue(SPACE_A, {
    connectionKey: key,
    message: { to: 'ig-user-11', text: 'Ultimo tentativo', tag: INSTAGRAM_HUMAN_AGENT_TAG },
    messageKey: 'm-win-toolate',
  });
  const tooLateSettled = await harness.pump(tooLate.jobId);
  assert.equal(tooLateSettled.state, 'failed_terminal');
  assert.deepEqual(
    harness.letters(SPACE_A, 'open').map((row) => row.errorCode).sort(),
    ['CHANNEL_WINDOW_CLOSED', 'CHANNEL_WINDOW_CLOSED'],
  );

  // A stranger with no inbound at all is closed too — never an open relay.
  const stranger = await harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-stranger-1', text: 'Ciao' }, messageKey: 'm-win-stranger' });
  assert.equal((await harness.pump(stranger.jobId)).state, 'failed_terminal');

  // Unknown tags refuse at queue time, before the outbox.
  await assert.rejects(
    harness.queue(SPACE_A, { connectionKey: key, message: { to: 'ig-user-11', text: 'x', tag: 'PROMO' }, messageKey: 'm-win-badtag' }),
    (error) => error.code === 'CHANNEL_MESSAGE_MALFORMED',
  );
});

test('production composition refuses the kit dialect and the page loopback', async (t) => {
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

  // The page loopback is a test-only address: production enforces the window for it too.
  const queued = await harness.queue(SPACE_A, { connectionKey: key, message: { to: PAGE_ID, text: 'self' }, messageKey: 'm-prod-loop' });
  assert.equal((await harness.pump(queued.jobId)).state, 'failed_terminal');
  assert.equal(harness.letters(SPACE_A, 'open')[0].errorCode, 'CHANNEL_WINDOW_CLOSED');
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
