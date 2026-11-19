// @ts-check
// backlog:9790f4df7a93 (seguito di #1028): una sola fonte dello stato del
// canale per le due viste. Con 0 eventi nessuna vista dice «sincronizzato»
// o «Attivo», neanche con un aggiornamento di 1 minuto fa (OWNER_ANSWER
// 18/11 sul live: «0 eventi ricevuti · Attivo» con «aggiornato 1 min fa»).
// Repro: prima della cura la scheda diceva «↔ sincronizzato» con canale
// collegato + traffico nei due versi e zero eventi (la riga di Stato sync
// diceva gia «in attesa» dopo #1028, la card no); dopo la cura entrambe le
// viste leggono `channelSynced` da admin-channels-count.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityReceived,
  channelState,
  channelSynced,
  identitySyncText,
} from '../apps/admin/public/admin-channels-count.js';
import {
  channelSynced as syncChannelSynced,
  syncChannelTable,
  syncIndicator,
} from '../apps/admin/public/admin-sync.js';

const NOW = Date.parse('2026-11-18T09:00:00.000Z');
const ONE_MIN_AGO = new Date(NOW - 60_000).toISOString();

test('9790f4df7a93: the shared synced rule needs a first event, never recency', () => {
  assert.equal(channelSynced({ linked: true, received: 3, lastAt: ONE_MIN_AGO }), true);
  assert.equal(channelSynced({ linked: true, received: 1, lastAt: null }), true);
  // OWNER_ANSWER 18/11: «aggiornato 1 min fa» with zero events is not synced.
  assert.equal(channelSynced({ linked: true, received: 0, lastAt: ONE_MIN_AGO }), false);
  assert.equal(channelSynced({ linked: true, received: 0, lastAt: null }), false);
  assert.equal(channelSynced({ linked: true, received: null, lastAt: ONE_MIN_AGO }), false);
  assert.equal(channelSynced({ linked: false, received: 10, lastAt: ONE_MIN_AGO }), false);
  assert.equal(syncChannelSynced({ linked: true, received: 0, lastAt: ONE_MIN_AGO }), false,
    'Stato sync reads the same rule');
});

test('9790f4df7a93: activityReceived sums like the Stato sync table', () => {
  const activity = { connections: [
    { channel: 'email', status: 'active', inbox: { received: 2 } },
    { channel: 'gmail', status: 'active', inbox: { received: 3 } },
    { channel: 'calendar', status: 'active', inbox: { received: 0 } },
  ] };
  assert.equal(activityReceived(activity, 'email'), 5, 'gmail counts as email');
  assert.equal(activityReceived(activity, 'calendar'), 0, 'a measured zero stays zero');
  assert.equal(activityReceived(activity, 'whatsapp'), 0, 'an unseen channel reads zero');
  assert.equal(activityReceived(null, 'email'), null, 'an unread payload stays unknown');
  assert.equal(activityReceived({ connectors: [] }, 'email'), null, 'a non-activity shape stays unknown');
});

test('9790f4df7a93: Identita collegate never reads sincronizzato with zero events', () => {
  const traffic = '↔ in entrata e in uscita';
  assert.equal(
    identitySyncText({ linked: true, both: true, traffic, received: 3, profileRead: true }),
    '↔ sincronizzato', 'two-way traffic on a linked channel with events syncs');
  assert.equal(
    identitySyncText({ linked: true, both: true, traffic, received: 0, profileRead: true }),
    traffic, 'zero events never sync, even linked with two-way traffic');
  assert.equal(
    identitySyncText({ linked: true, both: true, traffic, received: null, profileRead: true }),
    traffic, 'unknown events never sync');
  assert.equal(
    identitySyncText({ linked: true, both: false, traffic: '← in entrata', received: 5, profileRead: true }),
    '← in entrata', 'one-way traffic never syncs');
  assert.equal(
    identitySyncText({ linked: false, both: true, traffic, received: 0, profileRead: true }),
    `${traffic} · canale non collegato`, 'unlinked stays honest');
  assert.equal(channelState('whatsapp', { rows: [], profile: null }).state === 'collegato', false);
});

test('9790f4df7a93: Stato sync with 0 events and a 1-minute-ago update waits, hero included', () => {
  const activity = { connections: [
    { connectionKey: 'cal-1', channel: 'calendar', status: 'active', health: 'ok',
      importable: true, inbox: { received: 0, lastReceivedAt: null },
      outbox: { openDeadLetters: 0, lastFailedAt: ONE_MIN_AGO } },
  ] };
  const rows = syncChannelTable(activity, NOW);
  const row = rows.find((entry) => entry.channel === 'calendar');
  assert.ok(row && row.connected, 'the calendar stays linked');
  assert.equal(row.received, 0);
  assert.deepEqual(row.pill, { text: 'in attesa del primo evento', tone: 'attesa' },
    'a fresh update instant with zero events waits, never Attivo');
  assert.equal(syncIndicator(activity, NOW).title, 'Google Calendar in attesa del primo evento',
    'the hero never calls a zero-event channel synced');
});
