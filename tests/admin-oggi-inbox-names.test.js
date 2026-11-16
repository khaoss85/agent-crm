import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInbox, loadOggiData, readInboxNames, readNotificationNames } from '../apps/admin/public/admin-oggi.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { nameFromProfile, readableName } from '../apps/admin/public/admin-labels.js';

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

// backlog:5083e7a77c26 (c): Oggi read «PayPal Unknown». Before #606
// (fe6e8299) the Gmail sender path created contacts with
// `lastName: 'Unknown'`; those rows are still stored. The sender reads by
// its real words, and a name made only of placeholders falls to the handle.
test('5083e7a77c26: a stored «Unknown» never reaches the sender name', () => {
  assert.equal(nameFromProfile({ identity: { contact: { firstName: 'PayPal', lastName: 'Unknown' } } }), 'PayPal');
  assert.equal(nameFromProfile({ identity: { contact: { firstName: 'Unknown', lastName: 'Unknown' }, company: { name: 'paypal.com' } } }), 'paypal.com');
  assert.equal(nameFromProfile({ identity: { contact: { firstName: 'Guido', lastName: '—' } } }), 'Guido');
  assert.equal(nameFromProfile({ identity: { contact: { firstName: 'Unknown', lastName: 'unknown' } } }), null);
  assert.equal(readableName('Mario Rossi'), 'Mario Rossi', 'a real name is untouched');

  const message = { conversationId: 'cp', direction: 'inbound', channel: 'email', body: 'Ricevuta', occurredAt: '2026-11-07T14:50:00Z', ...host, subjectId: 'pp', remoteHandle: 'service@paypal.it' };
  const fromLabel = buildInbox({
    messages: [message],
    conversations: [{ id: 'cp', channel: 'email', status: 'open', ...host, subjectId: 'pp', subjectLabel: 'PayPal Unknown' }],
    now: NOW,
  });
  // A PayPal receipt is a notification (backlog:bab63e32acdb): it lists in
  // «Notifiche automatiche», named by the same rule.
  assert.equal(fromLabel.rows.length, 0);
  assert.equal(fromLabel.notifications.rows[0].name, 'PayPal', 'the stored label drops its placeholder word');
  const onlyPlaceholder = buildInbox({
    messages: [message],
    conversations: [{ id: 'cp', channel: 'email', status: 'open', ...host, subjectId: 'pp', subjectLabel: 'Unknown Unknown' }],
    now: NOW,
  });
  // Nothing real left: a notification names its sender's brand, like Clienti,
  // never the bare address (backlog:bab63e32acdb, verification 12/11).
  assert.equal(onlyPlaceholder.notifications.rows[0].name, 'Paypal');
});

// backlog:971b3e0e (rilascio 30, pilot 2111df8): «Notifiche automatiche»
// titled a known customer by the brand of their domain («Prestisport»)
// while Clienti showed their profile name («Daniele Pelleri»). A
// notification with a customer subject reads the profile with the same
// function the waiting rows (and Clienti) use — never the stored label,
// the brand or the address.
test('971b3e0e: a notification with a customer subject shows the profile name like Clienti', async () => {
  const own = 'daniele.pelleri@prestisport.it';
  const message = {
    conversationId: 'cd', direction: 'inbound', channel: 'email', body: 'Promemoria',
    occurredAt: '2026-11-07T14:50:00.000Z', ...host, subjectId: 'dp', remoteHandle: own,
  };
  const conversations = [
    { id: 'cd', channel: 'email', status: 'open', ...host, subjectId: 'dp', subjectLabel: null, remoteHandle: own },
  ];
  const seen = [];
  const client = {
    async request(path) {
      seen.push(path);
      if (path === '/api/customer-data/profile/contact/dp') {
        return { identity: { contact: { firstName: 'Daniele', lastName: 'Pelleri', email: own } } };
      }
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const names = await readInboxNames(client, [message], conversations, NOW, { ownAddresses: [own] });
  assert.deepEqual(names, { 'contact:dp': 'Daniele Pelleri' }, 'the notification subject reads its profile like a waiting row');
  const inbox = buildInbox({ messages: [message], conversations, now: NOW, names, ownAddresses: [own] });
  assert.equal(inbox.rows.length, 0, 'the owner writing to themselves waits for nobody');
  assert.equal(inbox.notifications.rows[0].name, 'Daniele Pelleri');
  assert.ok(!inbox.notifications.rows[0].name.includes('@'), 'never an address');
});

// backlog:971b3e0e: the server «Da rispondere» view names the waiting rows
// itself — it never names the notifications, so Oggi reads only their
// subjects, with the same function, and never the waiting ones twice.
test('971b3e0e: with the server view only notification subjects read profiles', async () => {
  const own = 'daniele.pelleri@prestisport.it';
  const waiting = {
    conversationId: 'cw', direction: 'inbound', channel: 'whatsapp', body: 'Ciao',
    occurredAt: '2026-11-07T14:00:00.000Z', ...host, subjectId: 'wp', remoteHandle: '@lia.marroni',
  };
  const notice = {
    conversationId: 'cn', direction: 'inbound', channel: 'email', body: 'Promemoria',
    occurredAt: '2026-11-07T14:50:00.000Z', ...host, subjectId: 'np', remoteHandle: own,
  };
  const conversations = [
    { id: 'cw', channel: 'whatsapp', status: 'open', ...host, subjectId: 'wp', subjectLabel: null },
    { id: 'cn', channel: 'email', status: 'open', ...host, subjectId: 'np', subjectLabel: null, remoteHandle: own },
  ];
  const seen = [];
  const client = {
    async request(path) {
      seen.push(path);
      if (path === '/api/customer-data/profile/contact/np') {
        return { identity: { contact: { firstName: 'Daniele', lastName: 'Pelleri', email: own } } };
      }
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const names = await readNotificationNames(client, [waiting, notice], conversations, NOW, { ownAddresses: [own] });
  assert.deepEqual(names, { 'contact:np': 'Daniele Pelleri' });
  assert.ok(!seen.some((path) => path.includes('/wp')), 'the waiting subject is the server view’s job');
});

// backlog:971b3e0e: end to end on the server branch — the view answers,
// the local messages lend the notifications, and the notification with a
// subject still shows the profile name like Clienti.
test('971b3e0e: loadOggiData names notification subjects when the server view answers', async () => {
  const own = 'daniele.pelleri@prestisport.it';
  const notice = {
    conversationId: 'cn', direction: 'inbound', channel: 'email', body: 'Promemoria',
    occurredAt: '2026-11-07T14:50:00.000Z', subjectOwner: 'host', subjectResource: 'contact', subjectId: 'np', remoteHandle: own,
  };
  const data = await loadOggiData({
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { domains: { interactions: {}, 'customer-data': {} } };
      if (path === '/api/profile') return { member: { email: own }, connections: { available: false, items: [] } };
      if (path.startsWith('/api/spine/memberships')) return { items: [] };
      if (path.startsWith('/api/customer-data/customers?')) {
        return {
          items: [{
            subject: { resource: 'contact', id: 'p0' }, resource: 'contact', id: 'p0',
            name: 'Persona 0', awaitingChannel: 'whatsapp', awaitingText: 'Ciao',
            lastAwaitingAt: '2026-11-07T14:00:00.000Z',
          }],
          total: 1, totalIsExact: true,
          views: [{ id: 'da-leggere', label: 'Da leggere', count: 0 }],
        };
      }
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: [notice] };
      if (path.startsWith('/api/modules/conversation/records')) {
        return { items: [{ id: 'cn', channel: 'email', status: 'open', subjectOwner: 'host', subjectResource: 'contact', subjectId: 'np', subjectLabel: null, remoteHandle: own }] };
      }
      if (path === '/api/customer-data/profile/contact/np') {
        return { identity: { contact: { firstName: 'Daniele', lastName: 'Pelleri', email: own } } };
      }
      throw new Error(`unexpected read: ${path}`);
    },
  }, NOW);
  assert.ok(data.replies !== null, 'the server view answered');
  assert.deepEqual(data.inboxNames, { 'contact:np': 'Daniele Pelleri' });
  const inbox = buildInbox({
    messages: data.inboxMessages, conversations: data.inboxConversations,
    now: NOW, names: data.inboxNames, ownAddresses: [own],
  });
  assert.equal(inbox.notifications.rows[0].name, 'Daniele Pelleri');
});
