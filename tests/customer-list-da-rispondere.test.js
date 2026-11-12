import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';
import { awaitingReplyFor, CUSTOMER_VIEWS } from '../packages/customer-data/src/customers.js';
import { isNotificationMessage } from '../packages/core/sender-kind.js';

/**
 * backlog:c2bf6b206d96 (giro esplorativo 11/11, punti 3, 4 e 6): Oggi said
 * «Nessun messaggio aspetta una risposta» while Clienti counted unread
 * customers, and Oggi read only the latest 100 messages. «Da rispondere» is
 * now a Clienti server view — customers whose last conversation message is
 * a person's, never answered — and Oggi reads it.
 */

const at = (minute) => `2026-10-20T09:${String(minute).padStart(2, '0')}:00.000Z`;
const msg = (over) => ({
  id: `m-${Math.random().toString(36).slice(2)}`, channel: 'whatsapp', direction: 'inbound', body: 'Ciao',
  subjectResource: 'contact', subjectId: 'c1', conversationId: 'wa:1', occurredAt: at(0), ...over,
});

test('c2bf6b206d96: a thread waits when its last message is a person’s, inbound and not answered', () => {
  assert.equal(awaitingReplyFor([msg({ occurredAt: at(1) })]).count, 1);
  assert.equal(awaitingReplyFor([msg({ occurredAt: at(1) }), msg({ direction: 'outbound', occurredAt: at(2) })]).count, 0,
    'an answer after it closes the wait');
  const reopened = awaitingReplyFor([
    msg({ occurredAt: at(1) }), msg({ direction: 'outbound', occurredAt: at(2) }), msg({ occurredAt: at(3), body: 'E quindi?' }),
  ]);
  assert.equal(reopened.count, 1, 'a new inbound after the answer waits again');
  assert.equal(reopened.lastAt, at(3));
  assert.equal(reopened.text, 'E quindi?');
  assert.equal(reopened.channel, 'whatsapp');
  assert.equal(awaitingReplyFor([msg({ occurredAt: at(1) })], [{ id: 'wa:1', status: 'closed' }]).count, 0, 'a closed thread never waits');
  const two = awaitingReplyFor([msg({ occurredAt: at(1) }), msg({ conversationId: 'mail:9', channel: 'email', remoteHandle: 'lia@gmail.com', occurredAt: at(4) })]);
  assert.equal(two.count, 2, 'one per thread');
  assert.equal(two.lastAt, at(4), 'the newest waiting message leads');
  assert.equal(awaitingReplyFor([msg({ conversationId: null, occurredAt: at(1) })]).count, 1, 'a thread without conversation groups by channel');
  assert.equal(awaitingReplyFor([{ ...msg({ occurredAt: at(1) }), entry: 'call' }]).count, 0, 'calls never wait');
  assert.deepEqual(awaitingReplyFor([]), { count: 0, lastAt: null, text: null, subject: null, channel: null });
});

test('c2bf6b206d96: notifications never wait — the same kernel rule as Oggi — and a contact form does', () => {
  const mail = (over) => msg({ channel: 'email', conversationId: `mail:${over.remoteHandle}`, ...over });
  assert.equal(awaitingReplyFor([mail({ remoteHandle: 'assistenza@paypal.it', subjectLabel: 'PayPal', body: 'Hai pagato 4,99 €' })]).count, 0);
  assert.equal(awaitingReplyFor([mail({ remoteHandle: 'daniele.pelleri@pec.libero.it', body: 'Copia di messaggio di Posta Elettronica Certificata' })]).count, 0);
  assert.equal(awaitingReplyFor([mail({ remoteHandle: 'comments-noreply@docs.google.com', subjectLabel: 'Francesco Tirsi (Documenti Google)' })]).count, 0);
  assert.equal(awaitingReplyFor([mail({ remoteHandle: 'noreply@arvo.app', subjectLabel: 'Arvo Contact', body: 'NEW CONTACT FORM SUBMISSION Name: Julian Ross' })]).count, 1,
    'a website contact form is a person writing');
  // The conversation handle stands in when the message kept none.
  assert.equal(awaitingReplyFor([mail({ remoteHandle: null, conversationId: 'mail:x' })], [{ id: 'mail:x', remoteHandle: 'noreply@namecheap.com' }]).count, 0);
});

test('c2bf6b206d96: no 100-message ceiling — every message of the customer counts', () => {
  const many = Array.from({ length: 150 }, (_, index) => msg({ direction: 'outbound', occurredAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() }));
  many.push(msg({ occurredAt: '2026-10-20T08:00:00.000Z', body: 'Dopo 150 messaggi' }));
  assert.equal(awaitingReplyFor(many).count, 1);
});

function fakeModules({ contacts, companies, messages, listOnlyMessages = false }) {
  const match = (rows, filters) => rows.filter((row) => Object.entries(filters).every(([key, value]) => (
    Array.isArray(value) ? value.includes(row?.[key]) : row?.[key] === value)));
  const exact = (rows) => ({ listWhere: async (filters) => match(rows, filters) });
  const map = new Map([
    ['contact', { service: { list: async () => contacts } }],
    ['company', { service: { list: async () => companies } }],
    ['external-identity', { service: exact([]) }],
    ['interaction-message', { service: listOnlyMessages ? { list: async () => messages } : exact(messages) }],
    ['interaction-call', { service: exact([]) }],
  ]);
  return {
    get: (name) => {
      const entry = map.get(name);
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
}

const SCENE = {
  contacts: [
    { id: 'c1', companyId: 'co1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it' },
    { id: 'c2', companyId: 'co1', firstName: 'Anna', lastName: 'Bianchi', email: 'anna@example.it' },
    { id: 'c3', companyId: 'co1', firstName: 'PayPal', lastName: '—', email: 'assistenza@paypal.it' },
    { id: 'c4', companyId: 'co1', firstName: 'Lia', lastName: 'Marroni', email: 'lia@gmail.com' },
  ],
  companies: [{ id: 'co1', name: 'Palestra Esempio' }],
  messages: [
    msg({ subjectId: 'c1', conversationId: 'wa:1', occurredAt: at(1), body: 'Ci sono posti giovedì?' }),
    msg({ subjectId: 'c2', conversationId: 'wa:2', occurredAt: at(5), body: 'Mi richiami?' }),
    msg({ subjectId: 'c3', conversationId: 'mail:3', channel: 'email', remoteHandle: 'assistenza@paypal.it', occurredAt: at(7), body: 'Hai pagato' }),
    msg({ subjectId: 'c4', conversationId: 'wa:4', occurredAt: at(2) }),
    msg({ subjectId: 'c4', conversationId: 'wa:4', direction: 'outbound', occurredAt: at(3), body: 'Sì!' }),
  ],
};

test('c2bf6b206d96: Clienti › Da rispondere is a server view — total, newest waiting first, a pill count, clean names', async () => {
  assert.ok(CUSTOMER_VIEWS.some((view) => view.id === 'da-rispondere' && view.label === 'Da rispondere'));
  const base = { modules: fakeModules(SCENE), core: {}, names: { identity: 'external-identity' } };
  const page = await listCustomerRecords(base, { vista: 'da-rispondere' });
  assert.equal(page.total, 2, 'Guido and Anna wait; PayPal is a notification, Lia was answered');
  assert.deepEqual(page.items.map((item) => item.name), ['Anna Bianchi', 'Guido Presti'], 'newest waiting first');
  assert.equal(page.items[0].awaitingReplyCount, 1);
  assert.equal(page.items[0].lastAwaitingAt, at(5));
  assert.equal(page.items[0].awaitingText, 'Mi richiami?');
  assert.equal(page.items[0].awaitingChannel, 'whatsapp');
  const pills = Object.fromEntries(page.views.map((view) => [view.id, view]));
  assert.equal(pills['da-rispondere'].count, 2, 'the pill counts the same predicate');
  const all = await listCustomerRecords(base, { vista: 'tutti', sort: 'name' });
  const lia = all.items.find((item) => item.name === 'Lia Marroni');
  assert.equal(lia.awaitingReplyCount, 0, 'an answered customer counts zero, never null');
});

test('c2bf6b206d96: over a partial message read the view refuses and names no count, never «nobody waits»', async () => {
  const base = { modules: fakeModules({ ...SCENE, listOnlyMessages: true }), core: {}, names: { identity: 'external-identity' } };
  await assert.rejects(
    listCustomerRecords(base, { vista: 'da-rispondere' }),
    (error) => error.code === 'CUSTOMER_LIST_UNAVAILABLE' && /da-rispondere/.test(error.message),
  );
  const page = await listCustomerRecords(base, { vista: 'tutti' });
  const pill = page.views.find((view) => view.id === 'da-rispondere');
  assert.ok(!('count' in pill), 'no exact-looking count over a partial read');
});

test('c2bf6b206d96: the kernel sender rule ships byte-identical to the /bo shell', () => {
  const source = readFileSync(fileURLToPath(new URL('../packages/core/src/sender-kind.js', import.meta.url)), 'utf8');
  const copy = readFileSync(fileURLToPath(new URL('../apps/admin/public/admin-sender-kind.js', import.meta.url)), 'utf8');
  assert.equal(copy, source);
  assert.equal(typeof isNotificationMessage, 'function');
});

test('review #795 P2: a partial or failing conversation read refuses the view and names no count, never closed threads as waiting', async () => {
  const closedForGuido = [{ id: 'wa:1', status: 'closed', subjectResource: 'contact', subjectId: 'c1' }];
  const withConversations = (service) => {
    const modules = fakeModules(SCENE);
    return { get: (name) => (name === 'conversation' ? { service } : modules.get(name)) };
  };
  // Exact read: Guido's closed thread does not wait.
  const exact = { modules: withConversations({ listWhere: async (filters) => closedForGuido.filter((row) => (filters.subjectId ?? []).includes(row.subjectId) && row.subjectResource === filters.subjectResource) }), core: {}, names: { identity: 'external-identity' } };
  const page = await listCustomerRecords(exact, { vista: 'da-rispondere' });
  assert.deepEqual(page.items.map((item) => item.name), ['Anna Bianchi'], 'the closed thread is not waiting');
  // Partial read (bounded list only): refuse, no pill count.
  const partial = { modules: withConversations({ list: async () => [] }), core: {}, names: { identity: 'external-identity' } };
  await assert.rejects(listCustomerRecords(partial, { vista: 'da-rispondere' }),
    (error) => error.code === 'CUSTOMER_LIST_UNAVAILABLE' && /conversation/.test(error.message));
  const all = await listCustomerRecords(partial, { vista: 'tutti' });
  assert.ok(!('count' in all.views.find((view) => view.id === 'da-rispondere')), 'no exact-looking pill');
  assert.ok(all.items.every((item) => item.awaitingReplyCount === null), 'rows carry no invented count');
  // No conversation module at all: nothing to close, the view still answers.
  const none = { modules: fakeModules(SCENE), core: {}, names: { identity: 'external-identity' } };
  assert.equal((await listCustomerRecords(none, { vista: 'da-rispondere' })).total, 2);
});

// Pin of the pilot #543 (12/11): the «visita completa al /bo» opens Oggi on a
// space with no customer yet. The scan held no subject, every read fell
// through to the bounded page, read as partial, and da-rispondere answered
// 409 — the /bo counted a failed read. No customer, no row can belong to
// one: the exact answer is the empty one.
test('c2bf6b206d96 (pin #543): a space with no customer answers da-rispondere 200, empty and exact — never 409', async () => {
  const pageOf = (rows) => ({ listWhere: async () => rows, list: async () => rows });
  const strangers = [msg({ subjectId: 'nobody', conversationId: 'wa:x' })];
  const modules = fakeModules({ contacts: [], companies: [], messages: [] });
  const empty = { get: (name) => (name === 'interaction-message' || name === 'conversation' ? { service: pageOf(name === 'interaction-message' ? strangers : []) } : modules.get(name)) };
  const page = await listCustomerRecords({ modules: empty, core: {}, names: { identity: 'external-identity' } }, { vista: 'da-rispondere' });
  assert.equal(page.total, 0);
  assert.equal(page.totalIsExact, true);
  assert.equal(page.views.find((view) => view.id === 'da-rispondere').count, 0, 'an exact zero, with its pill');
});

test('review #821 P2: the view reads the space’s own mailboxes from its email connections', async () => {
  const modules = fakeModules({
    ...SCENE,
    messages: [...SCENE.messages, msg({ subjectId: 'c4', conversationId: 'mail:own', channel: 'email', remoteHandle: 'op@palestra-esempio.it', occurredAt: at(9), body: 'Copia' })],
  });
  const withConnections = { get: (name) => (name === 'channel-connection'
    ? { service: { listWhere: async (filters) => [{ channel: 'email', account: 'op@palestra-esempio.it', status: 'active' }].filter((row) => !filters.channel || row.channel === filters.channel) } }
    : modules.get(name)) };
  const page = await listCustomerRecords({ modules: withConnections, core: {}, names: { identity: 'external-identity' } }, { vista: 'da-rispondere' });
  assert.ok(!page.items.some((item) => item.name === 'Lia Marroni'), 'the copy from the own mailbox does not make Lia wait');
  const without = await listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, { vista: 'da-rispondere' });
  assert.ok(without.items.some((item) => item.name === 'Lia Marroni'), 'without the connection it would');
});

test('review #821 giro 2: the view weighs «never written to» over the whole scan, and logs an unreadable mailbox list', async () => {
  const news = 'news@palestra-amica.it';
  const modules = fakeModules({
    ...SCENE,
    messages: [
      ...SCENE.messages,
      msg({ subjectId: 'c1', conversationId: 'z', channel: 'email', direction: 'outbound', remoteHandle: news, occurredAt: at(0), body: 'Grazie' }),
      msg({ subjectId: 'c4', conversationId: 'n', channel: 'email', remoteHandle: news, occurredAt: at(8), body: 'Le novità. Unsubscribe' }),
    ],
  });
  const page = await listCustomerRecords({ modules, core: {}, names: { identity: 'external-identity' } }, { vista: 'da-rispondere' });
  assert.ok(page.items.some((item) => item.name === 'Lia Marroni'), 'a sender the team wrote to (for Guido) waits for Lia too, as in Oggi');
  const failing = { get: (name) => (name === 'channel-connection'
    ? { service: { listWhere: async () => { throw Object.assign(new Error('down'), { code: 'BOOM' }); } } }
    : modules.get(name)) };
  const logged = [];
  const original = console.error;
  console.error = (line) => { logged.push(String(line)); };
  try {
    await listCustomerRecords({ modules: failing, core: {}, names: { identity: 'external-identity' } }, { vista: 'tutti' });
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((line) => line.includes('own mailboxes unreadable') && line.includes('BOOM')), logged.join('\n'));
});
