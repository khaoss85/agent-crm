// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertTenantId } from '../packages/core/src/tenant-storage.js';
import { assertSpaceId as assertChannelSpaceId, connectionSecretRef } from '../packages/channels/src/connection.js';
import { assertSpaceId as assertPaymentSpaceId } from '../packages/payments/src/connection.js';
import { validateReminderChannel } from '../packages/appointments/src/appointments.js';
import { createCallIntelligence } from '../packages/intelligence/src/call-intelligence.js';
import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Spazi con id che comincia con una cifra (backlog:09505d633c18).
 * Il tenant resta uno slug con lettera iniziale; lo spazio accetta
 * slug oppure UUID canonico minuscolo, mai un digit-slug parziale.
 */

const SPACE_DIGIT = '2f07eeb9-1111-4222-8333-444455556666';
const SPACE_SLUG = 'spazio-prova';
const NON_UUID_DIGIT = '2abc';
const UPPER_UUID = '2F07EEB9-1111-4222-8333-444455556666';
const ACCOUNT = '+390200000099';
const SECRET_REF = 'vault://kit/channel-digit';
const SECRET = 'kit-secret-value-digit';
const ACTOR = { type: 'system', id: 'test' };

function setup() {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-digit',
  });
  return { harness, api };
}

test('il tenant resta slug con lettera iniziale, lo spazio accetta UUID cifra', () => {
  assert.equal(assertTenantId('channel-kit-digit'), 'channel-kit-digit');
  assert.throws(() => assertTenantId(SPACE_DIGIT), /starting with a letter/);
  assert.equal(assertChannelSpaceId(SPACE_DIGIT), SPACE_DIGIT);
  assert.equal(assertPaymentSpaceId(SPACE_DIGIT), SPACE_DIGIT);
  const ref = connectionSecretRef({ spaceId: SPACE_DIGIT, channel: 'whatsapp', account: ACCOUNT });
  assert.ok(ref.startsWith(`vault://${SPACE_DIGIT}/whatsapp/`));
});

test('2abc e UUID maiuscolo rifiutati ovunque, UUID cifra e slug accettati', async () => {
  assert.equal(assertChannelSpaceId(SPACE_SLUG), SPACE_SLUG);
  assert.equal(assertPaymentSpaceId(SPACE_SLUG), SPACE_SLUG);
  for (const fn of [assertChannelSpaceId, assertPaymentSpaceId]) {
    assert.throws(() => fn(NON_UUID_DIGIT), /spaceId must be/);
    assert.throws(() => fn(UPPER_UUID), /spaceId must be/);
  }
  const channel = (spaceId) => ({
    spaceId, connectionKey: 'k1', to: '+390200000099',
    template: { name: 'hello_world', language: 'it', variables: [] },
  });
  assert.equal(validateReminderChannel(channel(SPACE_DIGIT), '2026-11-07T10:00:00.000Z').spaceId, SPACE_DIGIT);
  assert.equal(validateReminderChannel(channel(SPACE_SLUG), '2026-11-07T10:00:00.000Z').spaceId, SPACE_SLUG);
  assert.throws(() => validateReminderChannel(channel(NON_UUID_DIGIT), '2026-11-07T10:00:00.000Z'), /reminderChannel\.spaceId/);
  assert.throws(() => validateReminderChannel(channel(UPPER_UUID), '2026-11-07T10:00:00.000Z'), /reminderChannel\.spaceId/);

  const calls = createCallIntelligence({ modules: new Map() });
  const notice = (spaceId) => ({
    actor: ACTOR, spaceId, subjectResource: 'contact', subjectId: 'c1', callRef: 'r1', channel: 'voce',
  });
  await assert.rejects(() => calls.recordCallNotice(notice(NON_UUID_DIGIT)), /spaceId/);
  await assert.rejects(() => calls.recordCallNotice(notice(UPPER_UUID)), /spaceId/);
  await assert.rejects(() => calls.recordCallNotice(notice(SPACE_DIGIT)), /record service/);
  await assert.rejects(() => calls.recordCallNotice(notice(SPACE_SLUG)), /record service/);
});

test('Collega, sync e invio con id che comincia con una cifra', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE_DIGIT, {
    channel: 'whatsapp', account: ACCOUNT,
    adapter: 'fixture-channel', adapterVersion: 1, secretRef: SECRET_REF,
  });
  assert.equal(reg.connection.status, 'pending');
  await harness.activate(SPACE_DIGIT, reg.connection.sourceKey);
  const active = harness.ops.getConnection(SPACE_DIGIT, reg.connection.sourceKey);
  assert.equal(active.status, 'active');
  const listed = harness.connections(SPACE_DIGIT);
  assert.ok(listed.some((row) => row.sourceKey === reg.connection.sourceKey), 'sync legge la riga dello spazio cifra');
  const queued = await harness.queue(SPACE_DIGIT, {
    connectionKey: reg.connection.sourceKey,
    message: { to: ACCOUNT, text: 'ciao da spazio cifra' },
    messageKey: 'm-digit-1',
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded', 'invio riuscito');
  assert.equal(api.state.sentByKey.size, 1, 'il provider riceve un invio');
});
