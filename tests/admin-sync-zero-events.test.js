// @ts-check
/**
 * Stato sync: una sola fonte per «sincronizzato» (backlog:9790f4df7a93).
 *
 * Il Mac del 17/11 sul live: WhatsApp dice «↔ sincronizzato» mentre Stato
 * sync dice «in attesa del primo evento · 0 eventi». Le due viste devono
 * dire lo stesso stato, e con 0 eventi nessuna vista dice «sincronizzato».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activityReceivedFor,
  hasObservedEvents,
  isChannelSynced,
  syncChannelTable,
} from '../apps/admin/public/admin-sync.js';

const inboxOf = (over = {}) => ({
  received: 0, applied: 0, quarantined: 0, ignored: 0, duplicate: 0, pending: 0,
  lastReceivedAt: null, ...over,
});

const entryOf = (over = {}) => ({
  connectionKey: 'wa-1',
  channel: 'whatsapp',
  account: '+39 333 1234567',
  adapter: 'whatsapp',
  adapterVersion: 1,
  status: 'active',
  importable: true,
  sync: null,
  inbox: inboxOf(),
  outbox: { openDeadLetters: 0, lastFailedAt: null },
  direction: 'both',
  health: 'ok',
  needsFix: 0,
  ...over,
});

const activityOf = (over = {}) => ({
  spaceId: 'prova',
  connections: [entryOf()],
  feed: [],
  needsFix: 0,
  lastActivityAt: null,
  ...over,
});

test('9790f4df7a93: solo un intero sopra zero conta come traffico osservato', () => {
  assert.equal(hasObservedEvents(1), true);
  assert.equal(hasObservedEvents(10), true);
  for (const hostile of [0, -1, null, undefined, '3', 1.5, NaN, Infinity, true, {}]) {
    assert.equal(hasObservedEvents(hostile), false, `«${String(hostile)}» non è traffico`);
  }
});

test('9790f4df7a93: il totale di un canale somma solo gli arrivi veri', () => {
  const activity = activityOf({
    connections: [
      entryOf({ inbox: inboxOf({ received: 10, lastReceivedAt: '2026-10-25T11:30:00.000Z' }) }),
      entryOf({ connectionKey: 'wa-2', inbox: inboxOf({ received: 5 }) }),
      entryOf({ connectionKey: 'ig-1', channel: 'instagram', inbox: inboxOf({ received: 4 }) }),
      entryOf({ connectionKey: 'wa-x', inbox: inboxOf({ received: '7' }) }),
    ],
  });
  assert.equal(activityReceivedFor(activity, 'whatsapp'), 15);
  assert.equal(activityReceivedFor(activity, 'instagram'), 4);
  assert.equal(activityReceivedFor(null, 'whatsapp'), 0);
  assert.equal(activityReceivedFor(activity, 'sconosciuto'), 0);
  assert.equal(activityReceivedFor(activity, ''), 0);
});

test('9790f4df7a93: con 0 eventi nessun canale è sincronizzato, anche con un istante registrato', () => {
  // Un invio fallito timbra lastAt (outbox.lastFailedAt) senza arrivi:
  // prima il rigo leggeva «Attivo», ora aspetta il primo evento.
  const failedOnly = activityOf({
    connections: [entryOf({
      inbox: inboxOf({ received: 0, lastReceivedAt: null }),
      outbox: { openDeadLetters: 1, lastFailedAt: '2026-11-17T10:17:00.000Z' },
    })],
  });
  assert.equal(isChannelSynced(failedOnly, 'whatsapp'), false);
  const rows = syncChannelTable(failedOnly);
  const wa = rows.find((row) => row.channel === 'whatsapp');
  assert.ok(wa.lastAt !== null, 'l\u2019invio fallito timbra comunque un istante');
  assert.deepEqual(wa.pill, { text: 'in attesa del primo evento', tone: 'attesa' });
  // Il primo arrivo ribalta rigo e fonte insieme.
  const arrived = activityOf({
    connections: [entryOf({ inbox: inboxOf({ received: 1, lastReceivedAt: '2026-11-17T10:20:00.000Z' }) })],
  });
  assert.equal(isChannelSynced(arrived, 'whatsapp'), true);
  const waArrived = syncChannelTable(arrived).find((row) => row.channel === 'whatsapp');
  assert.deepEqual(waArrived.pill, { text: 'Attivo', tone: 'attivo' });
});
