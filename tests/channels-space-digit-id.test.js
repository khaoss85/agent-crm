// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertTenantId } from '../packages/core/src/tenant-storage.js';
import { assertSpaceId, connectionSecretRef } from '../packages/channels/src/connection.js';
import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Spazi con id che comincia con una cifra (backlog:09505d633c18).
 * Un UUID canonico minuscolo collega, sincronizza e invia come gli altri:
 * nessun assertSpaceId/assertTenantId lo rifiuta.
 */

const SPACE_DIGIT = '2f07eeb9-1111-4222-8333-444455556666';
const ACCOUNT = '+390200000099';
const SECRET_REF = 'vault://kit/channel-digit';
const SECRET = 'kit-secret-value-digit';

function setup() {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'channel-kit-digit',
  });
  return { harness, api };
}

test('assertTenantId e assertSpaceId accettano un id che comincia con una cifra', () => {
  assert.equal(assertTenantId(SPACE_DIGIT), SPACE_DIGIT);
  assert.equal(assertSpaceId(SPACE_DIGIT), SPACE_DIGIT);
  const ref = connectionSecretRef({ spaceId: SPACE_DIGIT, channel: 'whatsapp', account: ACCOUNT });
  assert.ok(ref.startsWith(`vault://${SPACE_DIGIT}/whatsapp/`));
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
