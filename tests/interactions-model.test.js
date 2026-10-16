import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALL_OUTCOMES,
  CHANNELS,
  CONVERSATION_TRANSITIONS,
  MESSAGE_INITIAL,
  MESSAGE_STATES,
  MESSAGE_TERMINAL,
  MESSAGE_TRANSITIONS,
  advanceMessage,
  logMessage,
  sortEntries,
  validateCallRequest,
  validateConversationRequest,
  validateMessageRequest,
  validateSubject,
} from '../packages/interactions/src/index.js';
import { ConflictError } from '../packages/core/index.js';

/**
 * Interactions v1 model and message-state tests, with no application boot:
 * every claim here is about the transition tables and the validation, so a
 * database would prove nothing and only slow the answer.
 */

const SUBJECT = { resource: 'contact', id: 'c-1', owner: 'host' };
const SOURCE = { package: 'host', action: 'seed' };

const message = (overrides = {}) => ({
  sourceKey: 'wa:msg:1',
  conversationId: 'conv-1',
  direction: 'outbound',
  channel: 'whatsapp',
  body: 'Ciao, confermiamo domani alle 18?',
  teamAuthorId: 'guido',
  subject: SUBJECT,
  occurredAt: '2026-09-15T10:00:00.000Z',
  source: SOURCE,
  ...overrides,
});

const call = (overrides = {}) => ({
  sourceKey: 'tel:call:1',
  direction: 'inbound',
  channel: 'phone',
  outcome: 'completed',
  durationSec: 187,
  remoteHandle: '+3902000001',
  subject: SUBJECT,
  occurredAt: '2026-09-15T10:00:00.000Z',
  source: SOURCE,
  ...overrides,
});

test('the channel vocabulary is exactly the customer channels, and nothing else', () => {
  assert.deepEqual([...CHANNELS], ['whatsapp', 'instagram', 'facebook', 'tiktok', 'website-form', 'email', 'phone']);
});

test('the message transition table is the whole answer, with no other moves', () => {
  assert.deepEqual(MESSAGE_STATES, ['received', 'sent', 'delivered', 'read', 'failed']);
  assert.deepEqual(MESSAGE_TRANSITIONS, {
    received: [],
    sent: ['delivered', 'failed'],
    delivered: ['read', 'failed'],
    read: [],
    failed: [],
  });
  assert.deepEqual(MESSAGE_TERMINAL, ['received', 'read', 'failed']);
  assert.deepEqual(MESSAGE_INITIAL, { inbound: 'received', outbound: 'sent' });
  assert.deepEqual(CONVERSATION_TRANSITIONS, { open: ['closed'], closed: [] });
});

test('inbound messages are stored received; outbound messages start sent', () => {
  assert.equal(validateMessageRequest(message({ direction: 'inbound', teamAuthorId: undefined })).direction, 'inbound');
  const outbound = validateMessageRequest(message());
  assert.equal(outbound.direction, 'outbound');
  assert.equal(outbound.teamAuthorId, 'guido');
});

test('an outbound message without a team author is refused, and an inbound one with it is refused', () => {
  assert.throws(() => validateMessageRequest(message({ teamAuthorId: undefined })), /teamAuthorId is required/);
  assert.throws(
    () => validateMessageRequest(message({ direction: 'inbound', teamAuthorId: 'guido' })),
    /teamAuthorId is not allowed on an inbound message/,
  );
});

test('a fresh message never carries a failure, and a failure is a validated move', async () => {
  assert.throws(() => validateMessageRequest(message({ errorCode: 'PROVIDER_500' })), /only when a message advances to failed/);
  const applied = [];
  const service = { applyManaged: async (id, patch) => { applied.push([id, patch]); return { id, ...patch }; } };
  const moved = await advanceMessage({ messages: service, actor: { type: 'user', id: 'e2e' } }, { id: 'm1', status: 'sent' }, 'delivered');
  assert.equal(moved.status, 'delivered');
  assert.equal(applied.length, 1);
  await assert.rejects(
    advanceMessage({ messages: service, actor: { type: 'user', id: 'e2e' } }, { id: 'm1', status: 'sent' }, 'failed'),
    (error) => error.code === 'ValidationError' || /errorCode is required/.test(error.message),
  );
  const failed = await advanceMessage(
    { messages: service, actor: { type: 'user', id: 'e2e' } }, { id: 'm1', status: 'sent' }, 'failed', 'PROVIDER_500',
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'PROVIDER_500');
});

test('terminal message states never regress, and skipping a step is refused', async () => {
  const service = { applyManaged: async (id, patch) => ({ id, ...patch }) };
  const actor = { type: 'user', id: 'e2e' };
  for (const status of ['received', 'read', 'failed']) {
    await assert.rejects(
      advanceMessage({ messages: service, actor }, { id: 'm1', status }, 'delivered'),
      (error) => error.code === 'INTERACTIONS_INVALID_STATE' && error.status === 409,
      `from ${status}`,
    );
  }
  // sent -> read skips delivered: refused, naming the allowed moves.
  await assert.rejects(
    advanceMessage({ messages: service, actor }, { id: 'm1', status: 'sent' }, 'read'),
    (error) => error.code === 'INTERACTIONS_INVALID_STATE' && /delivered or failed/.test(error.message),
  );
  // delivered -> delivered is not a move either.
  await assert.rejects(
    advanceMessage({ messages: service, actor }, { id: 'm1', status: 'delivered' }, 'delivered'),
    (error) => error.code === 'INTERACTIONS_INVALID_STATE',
  );
});

test('a call outcome is recorded once, with a duration only a completed call may carry', () => {
  assert.equal(validateCallRequest(call()).durationSec, 187);
  assert.equal(validateCallRequest(call({ outcome: 'missed', durationSec: 0 })).outcome, 'missed');
  assert.throws(() => validateCallRequest(call({ outcome: 'missed', durationSec: 12 })), /durationSec must be 0/);
  assert.throws(() => validateCallRequest(call({ outcome: 'failed', durationSec: 0, errorCode: undefined })), /errorCode is required/);
  assert.throws(() => validateCallRequest(call({ errorCode: 'E1' })), /only when the outcome is failed/);
  assert.throws(
    () => validateCallRequest(call({ direction: 'outbound', teamAuthorId: undefined })),
    /teamAuthorId is required for an outbound call/,
  );
  assert.throws(
    () => validateCallRequest(call({ teamAuthorId: 'guido' })),
    /teamAuthorId is not allowed on an inbound call/,
  );
});

test('the subject envelope keeps the ADR-030 shape rules: no package on a host record', () => {
  assert.deepEqual(validateSubject(SUBJECT).owner, 'host');
  assert.throws(
    () => validateSubject({ resource: 'contact', id: 'c-1', owner: 'host', ownerPackage: 'work' }),
    /not allowed when subject.owner is "host"/,
  );
  assert.throws(
    () => validateSubject({ resource: 'contact', id: 'c-1', owner: 'package' }),
    /subject.ownerPackage/,
  );
  assert.deepEqual(
    validateConversationRequest({ sourceKey: 'wa:thread:9', subject: SUBJECT, channel: 'tiktok', source: SOURCE }).channel,
    'tiktok',
  );
  assert.throws(() => validateConversationRequest({ sourceKey: 'x', subject: SUBJECT, channel: 'sms', source: SOURCE }), /channel must be one of/);
});

test('an impossible instant is refused, not rolled over into a plausible one', () => {
  assert.throws(() => validateMessageRequest(message({ occurredAt: '2027-02-30T10:00:00.000Z' })), /never existed/);
  assert.throws(() => validateCallRequest(call({ occurredAt: 'not-a-date' })), /occurredAt/);
});

test('hostile text never becomes evidence: control characters and over-long bodies are refused', () => {
  assert.throws(() => validateMessageRequest(message({ body: 'line one\u2028line two' })), /control characters/);
  assert.throws(() => validateMessageRequest(message({ body: 'x'.repeat(2001) })), /at most 2000/);
  assert.throws(() => validateMessageRequest(message({ body: '   ' })), /body is required/);
});

test('the loser of a source-key race replays the winner row instead of surfacing driver text', async () => {
  const winner = {
    id: 'm-winner', sourceKey: 'wa:msg:race', conversationId: 'conv-1', direction: 'outbound',
    channel: 'whatsapp', body: 'Si, alle 18.', teamAuthorId: 'guido', remoteHandle: null,
    subjectResource: 'contact', subjectId: 'c-1', occurredAt: '2026-09-15T10:00:00.000Z',
    sourcePackage: 'host', sourceAction: 'seed', status: 'sent',
  };
  let reads = 0;
  const service = {
    listWhere: async () => (reads++ === 0 ? [] : [winner]),
    createManaged: async () => { throw new ConflictError('already exists', { transient: false }); },
  };
  const request = {
    sourceKey: 'wa:msg:race', conversationId: 'conv-1', direction: 'outbound',
    channel: 'whatsapp', body: 'Si, alle 18.', teamAuthorId: 'guido',
    subject: { resource: 'contact', id: 'c-1', owner: 'host' },
    occurredAt: '2026-09-15T10:00:00.000Z', source: { package: 'host', action: 'seed' },
  };
  const { message: replayed, replayed: wasReplay } = await logMessage(
    { modules: { get: () => ({ service }) }, actor: { type: 'user', id: 'e2e' } }, request,
  );
  assert.equal(wasReplay, true);
  assert.equal(replayed.id, 'm-winner');
});

test('the timeline order is occurredAt oldest-first, with deterministic tie-breaks', () => {
  const rows = [
    { id: 'c', occurredAt: '2026-09-15T10:00:02.000Z', createdAt: 'b' },
    { id: 'a', occurredAt: '2026-09-15T10:00:01.000Z', createdAt: 'z' },
    { id: 'b', occurredAt: '2026-09-15T10:00:01.000Z', createdAt: 'a' },
  ];
  assert.deepEqual(sortEntries(rows).map((row) => row.id), ['b', 'a', 'c']);
});
