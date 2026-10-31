import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPOSER_TIMELINE_BODY_MAX,
  composerTimelineRefusal,
} from '../packages/channels/src/composer-text.js';
import { resolveSentConversationId } from '../packages/channels/src/operations.js';
import { gmailThreadIdForSubject } from '../packages/channels/src/gmail.js';

/**
 * Scheda cliente composer «Scrivi» (backlog:e9b4fc2f): one source of truth
 * for what a composer text may hold and what conversation a proven send is
 * logged under — the table every review round named, held in one place.
 *
 * Round history pinned here: the previous head refused at the queue what the
 * route allowed (30000 chars, tabs, lone CR vs the 2000-char timeline row),
 * and logged a provider message id as `email:<id>`, mixing it into the
 * thread namespace. Both cures share this file: the route and the queue
 * refuse the same text the same way, and every `email:` conversation maps
 * through the Gmail THREAD rule both ways.
 */

test('e9b4fc2f: the composer timeline bound is the honest composer limit', () => {
  assert.equal(COMPOSER_TIMELINE_BODY_MAX, 2000);
});

const TEXT_CASES = [
  // [label, text, storable]
  ['empty', '', false],
  ['blank spaces', '   \n  ', false],
  ['non-string null', null, false],
  ['non-string number', 42, false],
  ['one char', 'C', true],
  ['1999 chars', `${'a'.repeat(1999)}`, true],
  ['exactly 2000 chars', `${'a'.repeat(2000)}`, true],
  ['2001 chars', `${'a'.repeat(2001)}`, false],
  ['2500 chars (previous round)', `Salve, ${'dettaglio '.repeat(250)}`, false],
  ['30000 chars (the old route bound)', `${'b'.repeat(30000)}`, false],
  ['tab (adapter allows, row refuses)', 'Ciao,\tecco il preventivo.', false],
  ['lone CR (adapter allows, row refuses)', 'riga uno\rriga due', false],
  ['vertical tab', 'a\vb', false],
  ['unicode separator', 'a\u2028b', false],
  ['DEL', 'ab', false],
  ['CRLF pair normalizes to LF', 'riga uno\r\nriga due', true],
  ['LF spans lines', 'riga uno\nriga due', true],
  ['surrounding whitespace trims', '  ok  ', true],
  ['2000 chars with a trailing CRLF', `${'c'.repeat(1998)}\r\n`, true],
  ['2001 chars cannot hide behind trim', `  ${'d'.repeat(2001)}  `, false],
];

for (const [label, text, storable] of TEXT_CASES) {
  test(`e9b4fc2f: composer text — ${label} ${storable ? 'stores' : 'refuses'}`, () => {
    const refusal = composerTimelineRefusal(text);
    assert.equal(refusal === null, storable, `${label}: ${refusal ?? 'storable'}`);
  });
}

const WINDOWED = {
  outboundWindow: { subjectForRecipient: (to) => `wa:${to}` },
};

const CONVERSATION_CASES = [
  ['explicit thread wins over everything', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it', threadId: 'thread-B' },
    providerMessageId: 'gmailmsg.fake-1', providerThreadId: 'gmailthread.fake-9',
    explicitConversationId: 'email:thread-A',
  }, 'email:thread-A'],
  ['provider receipt names a new thread', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it' },
    providerMessageId: 'gmailmsg.fake-1', providerThreadId: 'gmailthread.fake-1',
    explicitConversationId: null,
  }, 'email:gmailthread.fake-1'],
  ['queued reply thread without a receipt yet', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it', threadId: 'thread-B' },
    providerMessageId: 'gmailmsg.fake-2', providerThreadId: null,
    explicitConversationId: null,
  }, 'email:thread-B'],
  ['provider receipt wins over the queued thread', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it', threadId: 'thread-B' },
    providerMessageId: 'gmailmsg.fake-3', providerThreadId: 'thread-C',
    explicitConversationId: null,
  }, 'email:thread-C'],
  ['a spaced receipt is not a thread', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it', threadId: 'thread-B' },
    providerMessageId: 'gmailmsg.fake-4', providerThreadId: 'has space',
    explicitConversationId: null,
  }, 'email:thread-B'],
  ['a colon receipt is not a thread', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it' },
    providerMessageId: 'm', providerThreadId: 'a:b',
    explicitConversationId: null,
  }, 'email:send:m'],
  ['no receipt and no thread never logs the bare message id', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it' },
    providerMessageId: 'gmailmsg.fake-5', providerThreadId: null,
    explicitConversationId: null,
  }, 'email:send:gmailmsg.fake-5'],
  ['non-string receipt never logs the bare message id', {
    channel: 'email', adapter: {}, message: { to: 'c@x.it' },
    providerMessageId: 'gmailmsg.fake-6', providerThreadId: 42,
    explicitConversationId: null,
  }, 'email:send:gmailmsg.fake-6'],
  ['windowed peer routes by recipient', {
    channel: 'whatsapp', adapter: WINDOWED, message: { to: '+390200000001' },
    providerMessageId: 'wamid.x', providerThreadId: null,
    explicitConversationId: null,
  }, 'wa:+390200000001'],
  ['windowless channel keeps the legacy message fallback', {
    channel: 'sms', adapter: {}, message: { to: '+390200000001' },
    providerMessageId: 'sms.1', providerThreadId: null,
    explicitConversationId: null,
  }, 'sms:sms.1'],
];

for (const [label, input, expected] of CONVERSATION_CASES) {
  test(`e9b4fc2f: sent conversation — ${label}`, () => {
    assert.equal(resolveSentConversationId(input), expected);
  });
}

test('e9b4fc2f: every email fallback stays outside the thread namespace', () => {
  for (const [, input] of CONVERSATION_CASES.filter(([, expected]) => String(expected).startsWith('email:send:'))) {
    const conversation = resolveSentConversationId(input);
    assert.equal(gmailThreadIdForSubject(conversation), null, `${conversation} must never parse as a thread`);
  }
  assert.equal(gmailThreadIdForSubject('email:colon:inside'), null);
  assert.equal(gmailThreadIdForSubject('email:has space'), null);
});
