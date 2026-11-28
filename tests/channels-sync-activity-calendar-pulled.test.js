// @ts-check
/**
 * Repro per backlog:8d976add (seguito di 9790f4df7a93): il conteggio eventi
 * di un canale deve leggere gli eventi davvero arrivati, anche quando non
 * passano dall'inbox — i pull del calendar-sync non scrivono mai righe
 * inbox, così un Google Calendar sincronizzato restava a «0 eventi
 * ricevuti» pur avendo eventi (Mac 18/11). La deployment apre il conteggio
 * dei pull (`calendarReads`); l'activity lo riporta accanto al tally
 * inbox (`pulled`, `lastPulledAt`), mai dentro `received`, così le
 * quadrature per effetto restano esatte.
 *
 * Rosso sul codice prima della cura (capability ignorata), verde dopo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFixtureChannelAdapter } from '../packages/channels/src/fixture.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

const SPACE = 'presti-sync-pulled';
const ACCOUNT = 'spazio-di-test@example.it';
const SECRET_REF = 'vault://kit/channel-sync-pulled';
const SECRET = 'kit-secret-pulled-1';
const PULLED_AT = '2026-11-18T03:55:00.000Z';

function setup(options = {}) {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  const { definition: plain } = createFixtureChannelAdapter({
    name: 'fixture-calendar', channel: 'calendar', secret: SECRET,
  });
  const calendarAdapter = { ...plain, historyImport: undefined };
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    extraAdapters: [calendarAdapter],
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: 'channel-pulled-kit',
    ...(options.calendarReads === undefined ? {} : { calendarReads: options.calendarReads }),
  });
  return { harness, api };
}

async function registeredCalendar(harness, space = SPACE) {
  const reg = await harness.register(space, {
    channel: 'calendar', account: ACCOUNT, adapter: 'fixture-calendar', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

test('8d976add: i pull contano sulla chiave giusta, direzione in e salute ok', async (t) => {
  let key = null;
  const { harness } = setup({
    calendarReads: ({ spaceId }) => {
      assert.equal(spaceId, SPACE, 'il tally riceve lo spazio letto');
      return key === null ? [] : [{ connectionKey: key, received: 2, lastReceivedAt: PULLED_AT }];
    },
  });
  t.after(() => harness.close());
  key = await registeredCalendar(harness);
  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  const entry = activity.connections.find((row) => row.connectionKey === key);
  assert.ok(entry, 'la riga calendario resta in activity');
  assert.equal(entry.inbox.received, 0, 'nessuna riga inbox per i pull');
  assert.deepEqual(
    { applied: entry.inbox.applied, quarantined: entry.inbox.quarantined, ignored: entry.inbox.ignored },
    { applied: 0, quarantined: 0, ignored: 0 },
    'le quadrature per effetto restano esatte',
  );
  assert.equal(entry.inbox.pulled, 2, 'due eventi letti davvero dal sync');
  assert.equal(entry.inbox.lastPulledAt, PULLED_AT);
  assert.equal(entry.direction, 'in', 'i pull sono traffico in entrata');
  assert.equal(entry.health, 'ok');
});

test('8d976add: una chiave diversa non attribuisce pull altrui', async (t) => {
  const { harness } = setup({
    calendarReads: () => [{ connectionKey: 'ALTRA-CHIAVE', received: 9, lastReceivedAt: PULLED_AT }],
  });
  t.after(() => harness.close());
  const key = await registeredCalendar(harness);
  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  const entry = activity.connections.find((row) => row.connectionKey === key);
  assert.equal(entry.inbox.pulled, 0, 'zero misurato, mai inventato');
  assert.equal(entry.inbox.lastPulledAt, null);
  assert.equal(entry.direction, null, 'senza pull la direzione resta ignota');
});

test('8d976add: senza capability i tally restano solo-inbox', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredCalendar(harness);
  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  const entry = activity.connections.find((row) => row.connectionKey === key);
  assert.equal(entry.inbox.received, 0);
  assert.equal(entry.inbox.pulled, 0, 'zero misurato, mai inventato');
  assert.equal(entry.inbox.lastPulledAt, null);
  assert.equal(entry.direction, null);
});

test('8d976add: un tally che fallisce non rompe la lettura', async (t) => {
  const { harness } = setup({
    calendarReads: () => { throw new Error('downstream guasto'); },
  });
  t.after(() => harness.close());
  await registeredCalendar(harness);
  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  assert.ok(Array.isArray(activity.connections), 'la lettura resta disponibile');
  const entry = activity.connections[0];
  assert.equal(entry.inbox.pulled, 0);
  assert.equal(entry.inbox.lastPulledAt, null);
});

test('8d976add: voci malformate ignorate, il primo ben formato vince', async (t) => {
  let key = null;
  const { harness } = setup({
    calendarReads: () => (key === null ? [] : [
      { connectionKey: key, received: 2, lastReceivedAt: PULLED_AT },
      { connectionKey: key, received: 50, lastReceivedAt: PULLED_AT },
      { connectionKey: key, received: -4, lastReceivedAt: PULLED_AT },
      { connectionKey: key, received: 'due', lastReceivedAt: PULLED_AT },
      { connectionKey: key, received: 7, lastReceivedAt: 42 },
      { connectionKey: '', received: 99, lastReceivedAt: PULLED_AT },
      { received: 99, lastReceivedAt: PULLED_AT },
      'non-un-oggetto',
      null,
    ]),
  });
  t.after(() => harness.close());
  key = await registeredCalendar(harness);
  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  const entry = activity.connections.find((row) => row.connectionKey === key);
  assert.equal(entry.inbox.pulled, 2, 'il primo ben formato vince, niente doppi conteggi');
  assert.equal(entry.inbox.lastPulledAt, PULLED_AT);
});

test('8d976add: tally non lista legge come zero', async (t) => {
  const { harness } = setup({ calendarReads: () => 'due' });
  t.after(() => harness.close());
  await registeredCalendar(harness);
  const activity = harness.ops.readSyncActivity({ spaceId: SPACE });
  assert.equal(activity.connections[0].inbox.pulled, 0);
});

test('8d976add: calendarReads non funzione rifiuta in composizione', () => {
  const { definition, api } = createFixtureChannelAdapter({ secret: SECRET });
  assert.throws(
    () => createChannelsHarness({
      adapterDefinition: definition,
      fixtureApi: api,
      secretRef: SECRET_REF,
      secretValue: SECRET,
      calendarReads: 42,
    }),
    (error) => error.message.includes('calendarReads'),
  );
});
