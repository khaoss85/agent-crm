import test from 'node:test';
import assert from 'node:assert/strict';

import { actorMemberId, countUnreadForSubject, isInboundUnread } from '../packages/interactions/src/read-state.js';

/**
 * La regola unica del non-letto (backlog:9e003582).
 *
 * Cosa deve provare: solo i messaggi in arrivo possono essere non letti;
 * senza watermark ogni arrivo è non letto; con watermark conta solo chi
 * arriva dopo; una riga senza istante non si accende per sempre; il
 * conteggio per cliente salta chiamate, fuori-conversazione e tabelle
 * illeggibili; l'attore anonimo non ha stato di lettura.
 */

test('9e003582: solo gli arrivi possono essere non letti, mai le nostre parole', () => {
  assert.equal(isInboundUnread({ direction: 'outbound', occurredAt: '2026-11-06T10:00:00.000Z' }, null), false);
  assert.equal(isInboundUnread({ direction: 'inbound', occurredAt: '2026-11-06T10:00:00.000Z' }, null), true);
  assert.equal(isInboundUnread({ direction: 'chat', occurredAt: '2026-11-06T10:00:00.000Z' }, null), false);
});

test('9e003582: senza watermark ogni arrivo è non letto, con watermark solo chi arriva dopo', () => {
  const msg = { direction: 'inbound', occurredAt: '2026-11-06T10:00:00.000Z' };
  assert.equal(isInboundUnread(msg, undefined), true);
  assert.equal(isInboundUnread(msg, ''), true);
  assert.equal(isInboundUnread(msg, '2026-11-06T09:59:59.000Z'), true);
  assert.equal(isInboundUnread(msg, '2026-11-06T10:00:00.000Z'), false);
  assert.equal(isInboundUnread(msg, '2026-11-06T10:00:01.000Z'), false);
});

test('9e003582: una riga senza istante non si accende per sempre', () => {
  assert.equal(isInboundUnread({ direction: 'inbound' }, null), true);
  assert.equal(isInboundUnread({ direction: 'inbound', occurredAt: '' }, '2026-11-06T10:00:00.000Z'), false);
  assert.equal(isInboundUnread({ direction: 'inbound', occurredAt: null }, '2026-11-06T10:00:00.000Z'), false);
});

test('9e003582: il conteggio salta chiamate, uscite e righe fuori conversazione', () => {
  const messages = [
    { entry: 'message', direction: 'inbound', conversationId: 'c1', occurredAt: '2026-11-06T10:01:00.000Z' },
    { entry: 'message', direction: 'inbound', conversationId: 'c1', occurredAt: '2026-11-06T10:02:00.000Z' },
    { entry: 'message', direction: 'outbound', conversationId: 'c1', occurredAt: '2026-11-06T10:03:00.000Z' },
    { entry: 'call', direction: 'inbound', conversationId: 'c1', occurredAt: '2026-11-06T10:04:00.000Z' },
    { entry: 'message', direction: 'inbound', conversationId: '', occurredAt: '2026-11-06T10:05:00.000Z' },
    { entry: 'message', direction: 'inbound', occurredAt: '2026-11-06T10:06:00.000Z' },
  ];
  const counted = countUnreadForSubject(messages, new Map());
  assert.equal(counted.unread, 2);
  assert.equal(counted.lastUnreadAt, '2026-11-06T10:02:00.000Z');
});

test('9e003582: il watermark zittisce solo la sua conversazione', () => {
  const messages = [
    { entry: 'message', direction: 'inbound', conversationId: 'letta', occurredAt: '2026-11-06T10:01:00.000Z' },
    { entry: 'message', direction: 'inbound', conversationId: 'aperta', occurredAt: '2026-11-06T10:02:00.000Z' },
  ];
  const counted = countUnreadForSubject(messages, new Map([['letta', '2026-11-06T10:05:00.000Z']]));
  assert.equal(counted.unread, 1);
  assert.equal(counted.lastUnreadAt, '2026-11-06T10:02:00.000Z');
});

test('9e003582: senza tabella leggibile il conteggio si omette, mai inventato', () => {
  const messages = [
    { entry: 'message', direction: 'inbound', conversationId: 'c1', occurredAt: '2026-11-06T10:01:00.000Z' },
  ];
  assert.equal(countUnreadForSubject(messages, null), null);
  assert.equal(countUnreadForSubject(messages, undefined), null);
});

test('9e003582: l\u2019attore anonimo non ha stato di lettura', () => {
  assert.equal(actorMemberId(null), null);
  assert.equal(actorMemberId({ type: 'user', id: 'anonymous' }), null);
  assert.equal(actorMemberId({ type: 'user', id: '' }), null);
  assert.equal(actorMemberId({ type: 'user', id: '__proto__' }), null);
  assert.equal(actorMemberId({ type: 'user', id: 'guido' }), 'guido');
});

test('9e003582 review: solo un attore user nomina un membro, mai agent o system', () => {
  assert.equal(actorMemberId({ type: 'agent', id: 'guido' }), null,
    'a colliding agent id reads no member watermarks');
  assert.equal(actorMemberId({ type: 'system', id: 'guido' }), null);
  assert.equal(actorMemberId({ id: 'guido' }), null, 'a missing actor type names nobody');
  assert.equal(actorMemberId({ type: 'user' }), null);
});
