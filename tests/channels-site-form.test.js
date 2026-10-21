import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { fixtureWebhookHeaders } from '../packages/channels/src/fixture.js';
import {
  createSiteFormChannelAdapter,
  siteFormEventBody,
  SITE_FORM_ADAPTER_NAME,
  SITE_FORM_ADAPTER_VERSION,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Site-form adapter tests (backlog:ffce3d1cd636).
 *
 * The inbound-only website-form binding on the common channel base:
 * visitor submissions in, no send ever out — against a fake transport, no
 * credentials (owner decision MEM_ACC_DECISIONS). Proven the same way the
 * acceptance names it: the channel kit (whose send check asserts the
 * contract refusal instead of a delivery), plus one submission reaching
 * the inbox and the outbound refusal, direct and through the real queue
 * path.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const ACCOUNT_A = 'contatti';
const ACCOUNT_B = 'prenota-prova';
const SECRET_REF = 'vault://presti/site-form-a';
const SECRET = 'site-form-kit-secret-1';
const ACTOR = { type: 'user', id: 'site-form-kit' };

const signedHeaders = (rawBody) => fixtureWebhookHeaders(rawBody, SECRET, Math.floor(Date.now() / 1000));

function setup(options = {}) {
  const { definition, api } = createSiteFormChannelAdapter({ ...(options.adapter ?? {}) });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'site-form-kit',
  });
  return { harness, api, definition };
}

async function registeredActive(harness, space = SPACE_A, account = ACCOUNT_A) {
  const reg = await harness.register(space, {
    channel: 'site-form', account, adapter: SITE_FORM_ADAPTER_NAME, adapterVersion: SITE_FORM_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

test('the site-form adapter passes the channel kit, refusing sends by contract', async (t) => {
  const { harness, definition } = setup({ tenantId: 'site-form-kit-acceptance' });
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

test('a form submission applies on its submission thread; forgeries write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = siteFormEventBody({
    submissionId: 'sub.in.1', formId: ACCOUNT_A,
    name: 'Rossi', email: 'rossi@example.com', phone: '+393331234567', message: 'Vorrei una prova',
  });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'sub.in.1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'form:sub.in.1');

  const forged = siteFormEventBody({ submissionId: 'sub.forged.1' });
  const tampered = { ...signedHeaders(forged), 'x-channel-signature-256': '0'.repeat(64) };
  const countBefore = harness.inbox(SPACE_A).length;
  await assert.rejects(
    () => harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: tampered }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).length, countBefore);
});

test('site-form refuses every send by contract, direct and through the queue', async (t) => {
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

test('a submission without an id refuses without writing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = JSON.stringify({ event: 'form.submitted', form_id: ACCOUNT_A });
  const countBefore = harness.inbox(SPACE_A).length;
  await assert.rejects(
    () => harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).length, countBefore);
});
