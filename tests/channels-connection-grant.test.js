import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { createGmailChannelAdapter, GMAIL_ADAPTER_NAME, GMAIL_ADAPTER_VERSION } from '../packages/channels/src/gmail.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * **Connection grant expiry and renewal (backlog:c3061a002dd0, BO-F1-04).**
 *
 * The expiring permission on the Stato sync screen is a real record: the
 * provider-stated `grantExpiresAt` on `channel-connection`, recorded at
 * registration and refreshed by the human `renew-connection-grant` action
 * after re-authorizing at the provider. The grant value itself is never
 * stored — only its expiry, and the actor is audited by the managed write.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const SECRET_REF = 'vault://presti/google-gmail';
const GRANT = 'grant-vault-value-9c2f1a77e4';

const inThreeDays = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
const inNinetyDays = () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

function setup(tag) {
  const { definition, api } = createGmailChannelAdapter({ mailbox: MAILBOX, secret: GRANT });
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: GRANT,
    tenantId: `channel-kit-grant-${tag}`,
  });
  return harness;
}

function actionsOf(harness) {
  return Object.fromEntries(buildChannelConnectionActions().map((action) => [action.name, action]));
}

async function registeredActive(harness, input = {}) {
  const reg = await harness.register(SPACE, {
    channel: 'email',
    account: MAILBOX,
    adapter: GMAIL_ADAPTER_NAME,
    adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
    ...input,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function renew(harness, key, input) {
  const service = harness.internals.modules.get('channel-connection').service;
  return actionsOf(harness)['renew-connection-grant'].execute({
    record: harness.ops.getConnection(SPACE, key),
    input,
    actor: harness.userActor,
    modules: harness.internals.modules,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: harness.userActor }),
    now: () => new Date().toISOString(),
  });
}

test('registration records the provider-stated grant expiry', async (t) => {
  const harness = setup('record');
  t.after(() => harness.close());
  const expiry = inThreeDays();
  const key = await registeredActive(harness, { grantExpiresAt: expiry });
  const connection = harness.ops.getConnection(SPACE, key);
  assert.equal(connection.grantExpiresAt, expiry, 'the expiry is a real record, not a mock');

  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes(GRANT), 'the grant value is in no row');
});

test('registration without an expiry records null', async (t) => {
  const harness = setup('absent');
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  assert.equal(harness.ops.getConnection(SPACE, key).grantExpiresAt, null);
});

test('registration with a malformed expiry refuses', async (t) => {
  const harness = setup('malformed');
  t.after(() => harness.close());
  await assert.rejects(
    harness.register(SPACE, {
      channel: 'email',
      account: MAILBOX,
      adapter: GMAIL_ADAPTER_NAME,
      adapterVersion: GMAIL_ADAPTER_VERSION,
      secretRef: SECRET_REF,
      grantExpiresAt: 'in tre giorni',
    }),
    /grantExpiresAt/,
  );
});

test('renewal records the new expiry with a human actor', async (t) => {
  const harness = setup('renew');
  t.after(() => harness.close());
  const key = await registeredActive(harness, { grantExpiresAt: inThreeDays() });
  const expiry = inNinetyDays();
  const renewed = await renew(harness, key, { grantExpiresAt: expiry });
  assert.equal(renewed.connection.grantExpiresAt, expiry);
  assert.equal(
    harness.ops.getConnection(SPACE, key).grantExpiresAt,
    renewed.connection.grantExpiresAt,
    'the renewed expiry is the stored record',
  );
});

test('renewal without a human actor refuses', async (t) => {
  const harness = setup('no-actor');
  t.after(() => harness.close());
  const key = await registeredActive(harness, { grantExpiresAt: inThreeDays() });
  const service = harness.internals.modules.get('channel-connection').service;
  await assert.rejects(
    actionsOf(harness)['renew-connection-grant'].execute({
      record: harness.ops.getConnection(SPACE, key),
      input: { grantExpiresAt: inNinetyDays() },
      actor: { type: 'system', id: 'cron' },
      modules: harness.internals.modules,
      managed: (id, patch) => service.applyManaged(id, patch, { actor: { type: 'system', id: 'cron' } }),
      now: () => new Date().toISOString(),
    }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
  );
});

test('renewal without an expiry refuses, and a revoked grant is terminal', async (t) => {
  const harness = setup('terminal');
  t.after(() => harness.close());
  const key = await registeredActive(harness, { grantExpiresAt: inThreeDays() });
  await assert.rejects(renew(harness, key, {}), /grantExpiresAt/);
  assert.ok(
    !actionsOf(harness)['renew-connection-grant'].fromStates.includes('revoked'),
    'a revoked binding never reactivates through renewal — the action dispatcher refuses it by fromStates',
  );
});
