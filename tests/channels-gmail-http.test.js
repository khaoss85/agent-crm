import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  createGmailChannelAdapter,
} from '../packages/channels/src/gmail.js';
import {
  createGmailHttpIo,
  normalizeGmailRestMessage,
} from '../packages/channels/src/gmail-http.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Real-transport Gmail tests (backlog:d1da1ed51e9c): the adapter speaks
 * the Gmail REST API over an injected fetch — history paging lists the
 * mailbox past and a new message lands in the thread conversation, and a
 * reply sends through `messages.send`. The HTTP layer is scripted, so no
 * test dials Google and no token travels in a row, an error or a log.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const CUSTOMER = 'cliente@example.com';
const SECRET_REF = 'vault://presti/google-gmail';
const GRANT = 'oauth-access-token-gmail-kit';
const HOUR = 3600 * 1000;
const AT = Date.now() - 30 * 60 * 1000;

/** One Gmail REST `messages.get` body. */
function restMessage({ id, threadId, from = CUSTOMER, at = AT, snippet = 'Buongiorno, vorrei un preventivo' }) {
  return {
    id,
    threadId,
    snippet,
    internalDate: String(at),
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'Preventivo' },
      ],
    },
  };
}

/** A scripted Gmail REST double: list + get + send, Bearer-checked. */
function createGmailRestDouble({ messages = [], bearer = GRANT, pageSize = 0 } = {}) {
  const requests = [];
  const store = new Map(messages.map((m) => [m.id, m]));
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status) => ({ ok: false, status, json: async () => ({ error: { code: status, message: 'double refusal' } }) });
  return {
    requests,
    seed(m) { store.set(m.id, m); },
    async fetch(url, init = {}) {
      requests.push({ url, method: init.method ?? 'GET', auth: init.headers?.Authorization ?? null });
      if (init.headers?.Authorization !== `Bearer ${bearer}`) return fail(401);
      const parsed = new URL(url, 'https://gmail.googleapis.com');
      if (parsed.pathname === '/gmail/v1/users/me/messages' && (init.method ?? 'GET') === 'GET') {
        // pageSize simulates Gmail paging below maxResults: the provider
        // lists newest first, so page one can hold a newer message than
        // page two of the same thread.
        const all = [...store.values()].map((m) => ({ id: m.id, threadId: m.threadId }));
        const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : all.length;
        const at = Number.parseInt(parsed.searchParams.get('pageToken') ?? '0', 10);
        const start = Number.isSafeInteger(at) && at >= 0 ? at : 0;
        const slice = all.slice(start, start + size);
        return start + size < all.length
          ? ok({ messages: slice, nextPageToken: String(start + size) })
          : ok({ messages: slice });
      }
      const getMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(parsed.pathname);
      if (getMatch && (init.method ?? 'GET') === 'GET') {
        const found = store.get(decodeURIComponent(getMatch[1]));
        if (!found) return fail(404);
        return ok(found);
      }
      if (parsed.pathname === '/gmail/v1/users/me/messages/send' && init.method === 'POST') {
        const body = JSON.parse(init.body ?? '{}');
        if (typeof body.raw !== 'string' || body.raw === '') return fail(400);
        const id = `gmailmsg.rest-${store.size + 1}`;
        const threadId = typeof body.threadId === 'string' && body.threadId !== ''
          ? body.threadId
          : `gmailthread.rest-${store.size + 1}`;
        return ok({ id, threadId });
      }
      return fail(404);
    },
  };
}

function httpAdapter(double, options = {}) {
  const { definition, api } = createGmailChannelAdapter({
    mailbox: MAILBOX,
    httpFetch: (...args) => double.fetch(...args),
    ...options,
  });
  return { definition, api };
}

test('the REST normalizer keeps the thread namespace and quarantines our own copy', () => {
  const event = normalizeGmailRestMessage(restMessage({ id: 'm1', threadId: 'thread-A' }), MAILBOX);
  assert.equal(event.providerEventId, 'm1');
  assert.equal(event.subject, 'email:thread-A');
  assert.equal(event.sequence, AT);
  assert.equal(event.text, 'Buongiorno, vorrei un preventivo');
  const loopback = normalizeGmailRestMessage(
    restMessage({ id: 'm2', threadId: 'thread-A', from: MAILBOX }), MAILBOX,
  );
  assert.equal(loopback.subject, '', 'our sent copy loops back as evidence, never as a customer');
  assert.throws(
    () => normalizeGmailRestMessage(restMessage({ id: 'm1', threadId: 'not an id!!' }), MAILBOX),
    (error) => error?.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.throws(
    () => normalizeGmailRestMessage({ id: 'm1', threadId: 'thread-A' }, MAILBOX),
    (error) => error?.code === 'CHANNEL_EVENT_MALFORMED',
  );
});

test('history pages the mailbox past over REST with the Bearer grant', async () => {
  const double = createGmailRestDouble({
    messages: [
      restMessage({ id: 'gmail-g1', threadId: 'thread-A', at: AT }),
      restMessage({ id: 'gmail-g2', threadId: 'thread-B', from: 'cliente-b@example.com', at: AT + 1000 }),
    ],
  });
  const io = createGmailHttpIo({ fetchImpl: (...args) => double.fetch(...args), mailbox: MAILBOX });
  const page = await io.listHistory({ secret: GRANT, since: new Date(AT - HOUR).toISOString() });
  assert.equal(page.events.length, 2);
  assert.equal(page.events[0].subject, 'email:thread-A', 'oldest first');
  assert.equal(page.events[1].sender.handle, 'cliente-b@example.com');
  const list = double.requests.find((r) => r.method === 'GET' && !r.url.includes('/messages/'));
  assert.ok(list.url.includes('after%3A') || list.url.includes('after='), 'the window travels as a Gmail query');
  assert.ok(double.requests.every((r) => r.auth === `Bearer ${GRANT}`));
});

test('a refused grant and an unreachable Gmail stay coded and token-free', async () => {
  const double = createGmailRestDouble({ messages: [], bearer: 'someone-else' });
  const io = createGmailHttpIo({ fetchImpl: (...args) => double.fetch(...args), mailbox: MAILBOX });
  const failure = await io.listHistory({ secret: GRANT, since: new Date(AT).toISOString() }).then(
    () => { throw new Error('history should have refused'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CHANNEL_HISTORY_REFUSED');
  assert.ok(!String(failure.message).includes(GRANT));
  const down = createGmailHttpIo({
    fetchImpl: async () => { throw new Error('socket hang up'); },
    mailbox: MAILBOX,
  });
  const unreachable = await down.listHistory({ secret: GRANT, since: new Date(AT).toISOString() }).then(
    () => { throw new Error('history should have failed'); },
    (error) => error,
  );
  assert.equal(unreachable.code, 'CHANNEL_HISTORY_TRANSIENT');
  assert.throws(
    () => createGmailHttpIo({}),
    (error) => error?.code === 'CHANNEL_HISTORY_MALFORMED',
  );
  assert.throws(
    () => createGmailChannelAdapter({ mailbox: MAILBOX, httpFetch: 'not-a-function' }),
    /httpFetch must be a fetch-compatible function/,
  );
});

test('a reply sends through messages.send and keeps the thread', async () => {
  const double = createGmailRestDouble({ messages: [] });
  const io = createGmailHttpIo({ fetchImpl: (...args) => double.fetch(...args), mailbox: MAILBOX });
  const sent = await io.sendMessage({
    message: { to: CUSTOMER, text: 'Certo, ti aspetto giovedì', threadId: 'thread-A' },
    secret: GRANT,
    idempotencyKey: 'reply-1',
  });
  assert.match(sent.providerMessageId, /^gmailmsg\.rest-/);
  assert.equal(sent.providerThreadId, 'thread-A', 'the reply stays in the thread the inbound opened');
  const post = double.requests.find((r) => r.method === 'POST');
  assert.match(post.url, /\/messages\/send$/);
  assert.equal(post.auth, `Bearer ${GRANT}`);
});

test('a new Gmail message imports into the thread conversation over REST', async (t) => {
  const double = createGmailRestDouble({
    messages: [
      restMessage({ id: 'gmail-g1', threadId: 'thread-A', at: AT }),
      restMessage({ id: 'gmail-g2', threadId: 'thread-B', from: 'cliente-b@example.com', at: AT + 1000 }),
      restMessage({ id: 'gmail-g3', threadId: 'thread-A', at: AT + 2000 }),
    ],
  });
  const { definition, api } = httpAdapter(double);
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: GRANT,
    tenantId: 'channel-kit-gmail-http',
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'email', account: MAILBOX, adapter: GMAIL_ADAPTER_NAME,
    adapterVersion: GMAIL_ADAPTER_VERSION, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const started = await harness.startImport(SPACE, { connectionKey: reg.connection.sourceKey });
  assert.equal(started.started, true);
  const advanced = await harness.advanceImport(SPACE, { connectionKey: reg.connection.sourceKey });
  assert.equal(advanced.page?.imported, 3, 'the past arrives through the resolved grant');
  const subjects = new Set(harness.inbox(SPACE).map((row) => row.subject));
  assert.ok(subjects.has('email:thread-A') && subjects.has('email:thread-B'));
  const progress = harness.readImport(SPACE, { connectionKey: reg.connection.sourceKey });
  assert.ok(progress, 'the import status stays readable while it runs');
  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes(GRANT), 'the Bearer grant is in no row, job, or audit entry');
  assert.ok(dump.includes(SECRET_REF), 'the locator is the only secret shape at rest');
});

test('an older second page of the same thread still applies after a newer first page', async (t) => {
  // Gmail lists newest first and pages below maxResults: page one holds
  // the newer message, page two the older one of the same thread. The
  // import adopts by identity, so the older message applies instead of
  // being discarded by the live-delivery sequence rule.
  const double = createGmailRestDouble({
    messages: [
      restMessage({ id: 'gmail-n1', threadId: 'thread-A', at: AT + 2000 }),
      restMessage({ id: 'gmail-o1', threadId: 'thread-A', at: AT }),
    ],
    pageSize: 1,
  });
  const { definition, api } = httpAdapter(double);
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: GRANT,
    tenantId: 'channel-kit-gmail-http-pages',
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'email', account: MAILBOX, adapter: GMAIL_ADAPTER_NAME,
    adapterVersion: GMAIL_ADAPTER_VERSION, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  await harness.startImport(SPACE, { connectionKey: reg.connection.sourceKey });
  const first = await harness.advanceImport(SPACE, { connectionKey: reg.connection.sourceKey });
  assert.equal(first.page?.imported, 1, 'the newer first page applies');
  const second = await harness.advanceImport(SPACE, { connectionKey: reg.connection.sourceKey });
  assert.equal(second.page?.imported, 1, 'the older second page applies too');
  const rows = harness.inbox(SPACE).filter((row) => row.subject === 'email:thread-A');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.effect === 'applied'), 'no older message is discarded as out-of-order');
});

test('a 503 from messages.send is transient, a 422 stays a refusal', async () => {
  const failing = createGmailRestDouble({ messages: [] });
  const sendWith = (status) => async (url, init = {}) => {
    if (String(url).endsWith('/messages/send')) {
      return { ok: status >= 200 && status < 300, status, json: async () => ({}) };
    }
    return failing.fetch(url, init);
  };
  const outage = createGmailHttpIo({ fetchImpl: sendWith(503), mailbox: MAILBOX });
  const transient = await outage.sendMessage({
    message: { to: CUSTOMER, text: 'Ci vediamo giovedi', threadId: 'thread-A' },
    secret: GRANT,
    idempotencyKey: 'outage-1',
  }).then(
    () => { throw new Error('send should have failed transiently'); },
    (error) => error,
  );
  assert.equal(transient.code, 'CHANNEL_SEND_TRANSIENT', 'the outbox retries an outage instead of dead-lettering it');
  const refusing = createGmailHttpIo({ fetchImpl: sendWith(422), mailbox: MAILBOX });
  const refused = await refusing.sendMessage({
    message: { to: CUSTOMER, text: 'x', threadId: 'thread-A' },
    secret: GRANT,
    idempotencyKey: 'refused-1',
  }).then(
    () => { throw new Error('send should have been refused'); },
    (error) => error,
  );
  assert.equal(refused.code, 'CHANNEL_SEND_REFUSED');
});
