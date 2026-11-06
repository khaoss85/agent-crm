import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeGmailRestMessage } from '../packages/channels/src/gmail-http.js';
import {
  logMessage,
  readTimeline,
  shapeMailAttachments,
  validateMessageRequest,
} from '../packages/interactions/src/index.js';
import { shapeCustomerTimeline } from '../packages/customer-hub/src/timeline.js';

/**
 * Gmail scheda acceptance (backlog:3055d50330b5): every synced Gmail message
 * saves its Subject, exposes it as `message.subject` on the timeline, fills
 * `message.attachments` with descriptors (never content) and stores text
 * with entities decoded and no padding invisibles. Two anonymized real
 * shapes: a billing receipt with a PDF and a newsletter with a preheader.
 */

const MAILBOX = 'presti-pilota@example.com';
const AT = Date.parse('2026-11-05T09:00:00.000Z');
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'google-sync-import' };
const ACTOR = { type: 'system', id: 'google-sync' };

const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
const INVISIBLES_RE = /[\u034F\u200B-\u200D\uFEFF\u00AD]/;

/** An anonymized billing receipt: HTML body with entities, one PDF part. */
function receiptFullMessage() {
  const html = [
    '<html><body>',
    '<p>Grazie per l&#39;acquisto&nbsp;di oggi.</p>',
    '<p>In allegato la tua ricevuta in PDF.</p>',
    '</body></html>',
  ].join('');
  return {
    id: 'gmail-receipt-1',
    threadId: 'thread-receipt-1',
    snippet: 'Grazie per l&#39;acquisto di oggi.',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Ricevute Esempio <ricevute@example-billing.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'La tua ricevuta n. 1234' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/html', filename: '', body: { size: html.length } },
        {
          mimeType: 'application/pdf',
          filename: 'ricevuta-1234.pdf',
          body: { attachmentId: 'gmail-att-receipt-1', size: 48210 },
        },
      ],
    },
    htmlBody: html,
  };
}

/** An anonymized newsletter: plain + HTML with a padded preheader. */
function newsletterFullMessage() {
  const preheader = `Le offerte di novembre\u200B\u200B\u200B\uFEFF\u00AD\u034F — solo fino a domenica.`;
  const plain = `${preheader}\n\nCiao, ecco le novit\u00E0 del mese & le scadenze.`;
  return {
    id: 'gmail-news-1',
    threadId: 'thread-news-1',
    snippet: 'Le offerte di novembre &hellip;',
    internalDate: String(AT + 1000),
    labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    payload: {
      headers: [
        { name: 'From', value: 'Novit\u00E0 Esempio <novita@example-news.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: '=?UTF-8?Q?Novit=C3=A0_di_novembre?=' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', filename: '', body: { data: b64url(plain), size: plain.length } },
      ],
    },
  };
}

test('a receipt with a PDF saves its subject, clean text and attachment descriptors', () => {
  const wire = receiptFullMessage();
  const { htmlBody, ...rest } = wire;
  rest.payload.parts[0].body = { data: b64url(htmlBody), size: htmlBody.length };
  const event = normalizeGmailRestMessage(rest, MAILBOX);
  assert.equal(event.mailSubject, 'La tua ricevuta n. 1234');
  assert.ok(event.text.includes("Grazie per l'acquisto"), 'entities decode before storage');
  assert.ok(!event.text.includes('&#'), 'no raw entity survives');
  assert.ok(event.text.includes('di oggi.'), 'the nbsp spacing survives as spacing');
  assert.ok(!INVISIBLES_RE.test(event.text), 'no padding invisible survives');
  assert.deepEqual(event.attachments, [{
    name: 'ricevuta-1234.pdf', mimeType: 'application/pdf', sizeBytes: 48210,
  }]);
});

test('a newsletter keeps its preheader without padding invisibles or entities', () => {
  const event = normalizeGmailRestMessage(newsletterFullMessage(), MAILBOX);
  assert.equal(event.mailSubject, 'Novità di novembre', 'RFC 2047 words decode');
  assert.ok(event.text.startsWith('Le offerte di novembre'), 'the preheader stays on top');
  assert.ok(!INVISIBLES_RE.test(event.text), 'preheader padding is stripped');
  assert.ok(!event.text.includes('&hellip;'), 'snippet entities decode');
  assert.deepEqual(event.attachments, [], 'no attachment reads as the empty list');
});

/** The host stores an applied Gmail event through the interaction record. */
async function hostLogsMail(event, sourceKey) {
  let stored = null;
  const service = {
    listWhere: async () => [],
    createManaged: async (row) => { stored = row; return { id: 'm-mail-1', ...row }; },
  };
  const modules = { get: () => ({ service }) };
  const { message } = await logMessage({
    modules,
    actor: ACTOR,
  }, {
    sourceKey,
    conversationId: 'email:thread-1',
    direction: 'inbound',
    channel: 'email',
    body: event.text,
    mailSubject: event.mailSubject,
    mailAttachments: event.attachments,
    subject: SUBJECT,
    occurredAt: '2026-11-05T09:00:00.000Z',
    source: SOURCE,
  });
  assert.ok(stored, 'the host stores the message row');
  return { message, stored };
}

test('the record keeps the mail subject and descriptors, and the timeline exposes them', async () => {
  const wire = receiptFullMessage();
  const { htmlBody, ...rest } = wire;
  rest.payload.parts[0].body = { data: b64url(htmlBody), size: htmlBody.length };
  const event = normalizeGmailRestMessage(rest, MAILBOX);
  const { message, stored } = await hostLogsMail(event, 'gmail:thread-receipt-1:gmail-receipt-1');
  assert.equal(stored.mailSubject, 'La tua ricevuta n. 1234');
  assert.deepEqual(JSON.parse(stored.mailAttachmentsJson), [{
    name: 'ricevuta-1234.pdf', mimeType: 'application/pdf', sizeBytes: 48210,
  }]);
  assert.equal(message.body, stored.body);

  const messageRows = [{ ...stored, id: 'm-mail-1' }];
  const modules = {
    get: (name) => {
      if (name === 'interaction-message') return { service: { listWhere: async () => messageRows } };
      if (name === 'interaction-call') return { service: { listWhere: async () => [] } };
      return null;
    },
  };
  const history = await readTimeline({ modules, moduleNames: {} }, SUBJECT);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].subject, 'La tua ricevuta n. 1234');
  assert.deepEqual(history.entries[0].attachments, [{
    name: 'ricevuta-1234.pdf', mimeType: 'application/pdf', sizeBytes: 48210,
  }]);
  assert.ok(!history.entries[0].body.includes('&#'), 'the timeline serves the stored clean text');

  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [],
    },
    threads: [],
    history,
    schedule: [],
    subject: { resource: 'contact', id: 'c-presti' },
  });
  assert.equal(timeline.entries.items[0].subject, 'La tua ricevuta n. 1234');
  assert.deepEqual(timeline.entries.items[0].attachments, [{
    name: 'ricevuta-1234.pdf', mimeType: 'application/pdf', sizeBytes: 48210,
  }]);
});

test('a mail without attachments stores nothing and reads the empty list', () => {
  const validated = validateMessageRequest({
    sourceKey: 'gmail:news:1', conversationId: 'email:thread-news-1', direction: 'inbound',
    channel: 'email', body: 'Le offerte di novembre.',
    mailSubject: 'Novità di novembre',
    subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z', source: SOURCE,
  });
  assert.equal(validated.mailSubject, 'Novità di novembre');
  assert.equal(validated.mailAttachmentsJson, null);
  assert.deepEqual(shapeMailAttachments({ mailAttachmentsJson: null }), []);
  assert.deepEqual(shapeMailAttachments({}), [], 'pre-rev3 rows read the empty list');
});

test('mail extras are email-only and fail closed', () => {
  assert.throws(
    () => validateMessageRequest({
      sourceKey: 'wa:mail:1', conversationId: 'conv-1', direction: 'inbound',
      channel: 'whatsapp', body: 'ciao', mailSubject: 'Non mio',
      subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z', source: SOURCE,
    }),
    /email-only/,
  );
  assert.throws(
    () => validateMessageRequest({
      sourceKey: 'gmail:bad:1', conversationId: 'email:t', direction: 'inbound',
      channel: 'email', body: 'ciao',
      mailAttachments: [{ name: 'x.pdf', mimeType: 'application/pdf' }],
      subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z', source: SOURCE,
    }),
    /mailAttachments/,
    'a descriptor without a byte size is refused, never stored half-shaped',
  );
  assert.throws(
    () => validateMessageRequest({
      sourceKey: 'gmail:many:1', conversationId: 'email:t', direction: 'inbound',
      channel: 'email', body: 'ciao',
      mailAttachments: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.pdf`, mimeType: 'application/pdf', sizeBytes: 10 })),
      subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z', source: SOURCE,
    }),
    /at most 20/,
  );
});
