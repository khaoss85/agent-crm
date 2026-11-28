// @ts-check
/**
 * Repro per backlog:8d976add (seguito di 9790f4df7a93, prova del Mac
 * 18/11 03:50-04:12Z): Google Calendar mostrava «0 eventi ricevuti» con
 * eventi arrivati, e «Attivo» con zero eventi. Il server riporta i pull
 * accanto all'inbox (`inbox.pulled`, `lastPulledAt`): qui la piega nelle
 * righe, nella tabella e nell'hero — con pull la riga legge Attivo, senza
 * resta «in attesa del primo evento», mai «Attivo»/«sincronizzato».
 *
 * Rosso sul codice prima della cura, verde dopo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { activityReceived, inboxArrived } from '../apps/admin/public/admin-channels-count.js';
import {
  syncChannelRows,
  syncChannelTable,
  syncIndicator,
} from '../apps/admin/public/admin-sync.js';

const PULLED_AT = '2026-11-18T03:55:00.000Z';
const NOW = Date.parse('2026-11-18T04:12:00.000Z');

const calendarEntry = (inbox) => ({
  connectionKey: 'profile:calendar',
  channel: 'calendar',
  account: 'spazio-di-test@example.it',
  status: 'active',
  importable: false,
  grantExpiresAt: null,
  sync: null,
  inbox,
  outbox: { openDeadLetters: 0, lastFailedAt: null },
  direction: 'in',
  health: 'ok',
  needsFix: 0,
});

const pulledInbox = () => ({
  received: 0,
  applied: 0,
  quarantined: 0,
  ignored: 0,
  duplicate: 0,
  pending: 0,
  lastReceivedAt: null,
  pulled: 2,
  lastPulledAt: PULLED_AT,
});

const activityOf = (connections) => ({ spaceId: 'spazio-di-test', connections, feed: [], needsFix: 0 });

test('8d976add: inboxArrived somma i pull, ignora i malformati', () => {
  assert.deepEqual(inboxArrived(pulledInbox()), { received: 2, lastAt: PULLED_AT });
  assert.deepEqual(inboxArrived({ received: 0 }), { received: 0, lastAt: null });
  assert.deepEqual(inboxArrived(null), { received: 0, lastAt: null });
  assert.deepEqual(inboxArrived({ received: 3, lastReceivedAt: PULLED_AT, pulled: -5, lastPulledAt: 42 }),
    { received: 3, lastAt: PULLED_AT }, 'pull malformati mai contati, mai indovinati');
  assert.deepEqual(inboxArrived({ received: 1, lastReceivedAt: '2026-11-18T03:50:00.000Z', pulled: 2, lastPulledAt: PULLED_AT }),
    { received: 3, lastAt: PULLED_AT }, 'vince l\u2019istante pi\u00f9 fresco');
});

test('8d976add: con 2 pull la riga calendario legge Attivo', () => {
  const rows = syncChannelRows(activityOf([calendarEntry(pulledInbox())]));
  const row = rows.find((item) => item.key === 'profile:calendar');
  assert.ok(row, 'la riga calendario resta in tabella');
  assert.equal(row.received, 2, 'due eventi letti davvero dal sync');
  assert.deepEqual(row.last, { kind: 'arrivo', at: PULLED_AT });
  const table = syncChannelTable(activityOf([calendarEntry(pulledInbox())]), NOW);
  const calendar = table.find((item) => item.channel === 'calendar');
  assert.equal(calendar.pill.text, 'Attivo');
  assert.equal(calendar.pill.tone, 'attivo');
  assert.equal(calendar.received, 2);
});

test('8d976add: con 2 pull l\u2019hero legge Tutto sincronizzato', () => {
  const hero = syncIndicator(activityOf([calendarEntry(pulledInbox())]), NOW);
  assert.equal(hero.tone, 'ok');
  assert.equal(hero.title, 'Tutto sincronizzato');
  assert.ok(hero.detail.includes('2 eventi ricevuti'), `dettaglio con conteggio, letto: ${hero.detail}`);
});

test('8d976add: senza pull la riga resta in attesa, mai Attivo', () => {
  const inbox = { received: 0, lastReceivedAt: null };
  const rows = syncChannelRows(activityOf([calendarEntry(inbox)]));
  assert.equal(rows.find((item) => item.key === 'profile:calendar').received, 0);
  const table = syncChannelTable(activityOf([calendarEntry(inbox)]), NOW);
  const calendar = table.find((item) => item.channel === 'calendar');
  assert.equal(calendar.pill.text, 'in attesa del primo evento');
  assert.equal(calendar.pill.tone, 'attesa');
  const hero = syncIndicator(activityOf([calendarEntry(inbox)]), NOW);
  assert.equal(hero.tone, 'wait');
  assert.ok(hero.title.includes('in attesa del primo evento'), `titolo d\u2019attesa, letto: ${hero.title}`);
});

test('8d976add: activityReceived somma i pull come la tabella', () => {
  const activity = activityOf([calendarEntry(pulledInbox())]);
  assert.equal(activityReceived(activity, 'calendar'), 2);
  assert.equal(activityReceived(activityOf([calendarEntry({ received: 0 })]), 'calendar'), 0,
    'uno zero misurato resta zero');
  assert.equal(activityReceived(null, 'calendar'), null, 'un payload illeggibile resta ignoto');
});
