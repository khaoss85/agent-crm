import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInbox, loadOggiData } from '../apps/admin/public/admin-oggi.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Production 07/11: every «Da rispondere» row read «Cliente». The pilot's
 * channel syncs (Gmail, Meta) store the conversation without a subject
 * label, so the stored snapshot is empty and the row fell to the generic
 * word. The row now names the customer from their profile, else the stored
 * label, else the sender handle the message kept — never «Cliente».
 */

const NOW = new Date('2026-11-07T15:00:00Z');
const host = { subjectOwner: 'host', subjectResource: 'contact' };

// The production shape: conversations and messages with no subject label,
// only the opaque subject and the handle the channel gave.
const CONVERSATIONS = [
  { id: 'c1', channel: 'email', status: 'open', ...host, subjectId: 'p1', subjectLabel: null, remoteHandle: 'ada@example.com' },
  { id: 'c2', channel: 'instagram', status: 'open', ...host, subjectId: 'p2', subjectLabel: null, remoteHandle: null },
  { id: 'c3', channel: 'whatsapp', status: 'open', ...host, subjectId: 'p3', subjectLabel: 'Cliente', remoteHandle: null },
];
const MESSAGES = [
  { conversationId: 'c1', direction: 'inbound', channel: 'email', body: 'Info sui prezzi', occurredAt: '2026-11-07T14:00:00Z', ...host, subjectId: 'p1', remoteHandle: 'ada@example.com' },
  { conversationId: 'c2', direction: 'inbound', channel: 'instagram', body: 'Ciao', occurredAt: '2026-11-07T14:30:00Z', ...host, subjectId: 'p2', remoteHandle: '@lia.marroni' },
  { conversationId: 'c3', direction: 'inbound', channel: 'whatsapp', body: 'Ci sono?', occurredAt: '2026-11-07T13:00:00Z', ...host, subjectId: 'p3' },
];

test('Da rispondere names the customer, else the handle, never «Cliente»', () => {
  const bare = buildInbox({ messages: MESSAGES, conversations: CONVERSATIONS, now: NOW });
  assert.deepEqual(
    bare.rows.map((row) => row.name),
    ['@lia.marroni', 'ada@example.com', 'Contatto senza nome'],
    'without a profile name the sender handle names the row; the generic «Cliente» label never does',
  );
  assert.ok(bare.rows.every((row) => row.name !== 'Cliente'));
  assert.deepEqual(bare.rows.map((row) => row.subjectKey), ['contact:p2', 'contact:p1', 'contact:p3']);

  const named = buildInbox({
    messages: MESSAGES,
    conversations: CONVERSATIONS,
    now: NOW,
    names: { 'contact:p1': 'Ada Rossi', 'contact:p3': 'Fio Neri' },
  });
  assert.deepEqual(named.rows.map((row) => row.name), ['@lia.marroni', 'Ada Rossi', 'Fio Neri'], 'the profile name wins');
});

test('loadOggiData reads the shown customers’ names from their profiles, fail-soft', async () => {
  const seen = [];
  const data = await loadOggiData({
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      seen.push(path);
      if (path === '/api/schema') return { domains: { interactions: {} } };
      if (path === '/api/profile') return { connections: { available: false, items: [] } };
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: MESSAGES };
      if (path.startsWith('/api/modules/conversation/records')) return { items: CONVERSATIONS };
      if (path === '/api/customer-data/profile/contact/p1') {
        return { identity: { contact: { firstName: 'Ada', lastName: 'Rossi', email: 'ada@example.com' } } };
      }
      if (path === '/api/customer-data/profile/contact/p2') {
        throw Object.assign(new Error('not found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (path === '/api/customer-data/profile/contact/p3') return { identity: { contact: { email: 'x@example.com' } } };
      throw new Error(`unexpected read: ${path}`);
    },
  }, NOW);
  assert.deepEqual(data.inboxNames, { 'contact:p1': 'Ada Rossi' }, 'only real names travel; an e-mail is not a name');
  assert.equal(seen.filter((path) => path.startsWith('/api/customer-data/profile/')).length, 3, 'one read per shown subject');
  const inbox = buildInbox({ messages: data.inboxMessages, conversations: data.inboxConversations, names: data.inboxNames, now: NOW });
  assert.deepEqual(inbox.rows.map((row) => row.name), ['@lia.marroni', 'Ada Rossi', 'Contatto senza nome']);
});
