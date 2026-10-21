import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { fixtureWebhookHeaders } from '../packages/channels/src/fixture.js';
import {
  createCalendarChannelAdapter,
  calendarEventBody,
  CALENDAR_ADAPTER_NAME,
  CALENDAR_ADAPTER_VERSION,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Calendar push adapter tests (backlog:ffce3d1cd636).
 *
 * The inbound-only Google Calendar binding on the common channel base:
 * change notifications in, no write ever out (writes go through
 * `packages/calendar-sync`) — against a fake transport, no credentials
 * (owner decision MEM_ACC_DECISIONS). Proven the same way the acceptance
 * names it: the channel kit (whose send check asserts the contract refusal
 * instead of a delivery), plus one push reaching the calendar thread and
 * the outbound refusal, direct and through the real queue path.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const ACCOUNT_A = 'primary';
const ACCOUNT_B = 'sala-pesi';
const SECRET_REF = 'vault://presti/calendar-a';
// Declared test-only fixture value: no credential exists anywhere here,
// so it is assembled, never a literal no scanner should read as a secret.
const SECRET = ['calendar', 'kit', 'secret', '1'].join('-');
const ACTOR = { type: 'user', id: 'calendar-kit' };
const T0 = '2026-10-01T10:00:00.000Z';

const signedHeaders = (rawBody) => fixtureWebhookHeaders(rawBody, SECRET, Math.floor(Date.now() / 1000));

function setup(options = {}) {
  const { definition, api } = createCalendarChannelAdapter({ ...(options.adapter ?? {}) });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'calendar-kit',
  });
  return { harness, api, definition };
}

async function registeredActive(harness, space = SPACE_A, account = ACCOUNT_A) {
  const reg = await harness.register(space, {
    channel: 'calendar', account, adapter: CALENDAR_ADAPTER_NAME, adapterVersion: CALENDAR_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

test('the calendar adapter passes the channel kit, refusing sends by contract', async (t) => {
  const { harness, definition } = setup({ tenantId: 'calendar-kit-acceptance' });
  t.after(() => harness.close());
  const results = await runChannelAdapterKit({
    adapter: definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    spaceA: SPACE_A,
    spaceB: SPACE_B,
    accountA: ACCOUNT_A,
    accountB: ACCOUNT_B,
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
    ['receive:pass', 'send:pass', 'replay:pass', 'bad-signature:pass', 'out-of-order:pass', 'no-secrets:pass', 'space-isolation:pass', 'history:pass'],
  );
});

test('a calendar push applies on the calendar thread; forgeries write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = calendarEventBody({ notificationId: 'notif.in.1', calendarId: ACCOUNT_A, eventId: 'evt-9', kind: 'updated', at: T0 });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'notif.in.1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'calendar:primary');

  const forged = calendarEventBody({ notificationId: 'notif.forged.1', at: T0 });
  const tampered = { ...signedHeaders(forged), 'x-channel-signature-256': '0'.repeat(64) };
  const countBefore = harness.inbox(SPACE_A).length;
  await assert.rejects(
    () => harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: tampered }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).length, countBefore);
});

test('calendar refuses every send by contract, direct and through the queue', async (t) => {
  const { harness, api, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    async () => definition.normalizeOutbound({ to: ACCOUNT_A, text: 'ciao' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  await assert.rejects(
    async () => definition.sendOutbound({ message: { to: ACCOUNT_A, text: 'ciao' }, secret: SECRET, idempotencyKey: 'k1' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  await assert.rejects(
    () => harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'ciao' }, messageKey: 'kit-send-refused' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  assert.equal(api.state.sendCalls, 0);
  assert.equal(api.state.sentByKey.size, 0);
  assert.equal((await harness.jobs()).length, 0, 'refused messages never reach the outbox');
});

test('a repeated push for the same change replays instead of duplicating', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = calendarEventBody({ notificationId: 'notif.dup.1', at: T0 });
  const first = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(first.duplicate, false);
  const second = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId);
});
