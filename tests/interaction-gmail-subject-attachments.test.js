import test from 'node:test';
import assert from 'node:assert/strict';

import { GMAIL_MAX_STORED_TEXT, normalizeGmailRestMessage } from '../packages/channels/src/gmail-http.js';
import { createGmailChannelAdapter, gmailPushBody } from '../packages/channels/src/gmail.js';
import { bounds } from '../packages/interactions/src/interactions.js';
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

test('a body longer than the record fence still stores, truncated to 2000', () => {
  // P1 backlog:3055d50330b5 — a 2500-character plain part used to normalize
  // to a 2500-character text that validateMessageRequest refused (MAX_BODY
  // 2000), so the message was never stored. Both readers truncate first.
  // An anonymized long newsletter (over 2000 characters, real paragraphs
  // with line breaks, like the billing receipt Dan checked on Presti).
  const long = [
    'Le offerte di novembre, solo fino a domenica.',
    '',
    'Ciao, ecco le novità del mese per i soci del centro.',
    '',
    ...Array.from({ length: 40 }, (_, i) => `Offerta ${i + 1}: lezione di prova gratuita su prenotazione, valida fino al 30 novembre.`),
    '',
    'Per disdire rispondi a questa email. A presto!',
  ].join('\n');
  assert.ok(long.length > 2000, `the fixture is a long mail, got ${long.length}`);
  const wire = newsletterFullMessage();
  wire.payload.parts[0].body = { data: b64url(long), size: long.length };
  const rest = normalizeGmailRestMessage(wire, MAILBOX);
  assert.ok(rest.text.length <= 2000, `REST text fits the record fence, got ${rest.text.length}`);
  assert.ok(rest.text.startsWith('Le offerte di novembre, solo fino a domenica.'), 'the preheader stays on top after truncation');
  assert.ok(rest.text.includes('\n'), 'line breaks survive truncation');
  const validated = validateMessageRequest({
    sourceKey: 'gmail:long:1', conversationId: 'email:thread-news-1', direction: 'inbound',
    channel: 'email', body: rest.text, mailSubject: rest.mailSubject,
    mailAttachments: rest.attachments, subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z',
    source: SOURCE,
  });
  assert.equal(validated.body, rest.text, 'the truncated body passes the record fence');

  const definition = createGmailChannelAdapter({ mailbox: MAILBOX, secret: 'gmail-test-secret' }).definition;
  const [push] = definition.normalizeInbound(gmailPushBody({
    id: 'gmail-long-1', threadId: 'thread-news-1',
    from: 'Novità Esempio <novita@example-news.com>', to: MAILBOX,
    subject: 'Novità di novembre', snippet: long, internalDateMs: AT,
  }));
  assert.ok(push.text.length <= 2000, `push text fits the record fence, got ${push.text.length}`);
  assert.ok(push.text.startsWith('Le offerte di novembre, solo fino a domenica.'), 'push keeps the preheader on top after truncation');
  assert.ok(push.text.includes('\n'), 'push keeps line breaks after truncation');
});

test('push and history readers agree on the mail subject and attachments', () => {
  // P1 backlog:3055d50330b5 — the same message arriving via Pub/Sub push and
  // via history (format=full) must expose the same mailSubject and the same
  // attachment descriptors, or the timeline depends on the ingress path.
  const wire = receiptFullMessage();
  const { htmlBody, ...rest } = wire;
  rest.payload.parts[0].body = { data: b64url(htmlBody), size: htmlBody.length };
  const history = normalizeGmailRestMessage(rest, MAILBOX);

  const definition = createGmailChannelAdapter({ mailbox: MAILBOX, secret: 'gmail-test-secret' }).definition;
  const [push] = definition.normalizeInbound(gmailPushBody({
    id: 'gmail-receipt-1', threadId: 'thread-receipt-1',
    from: 'Ricevute Esempio <ricevute@example-billing.com>', to: MAILBOX,
    subject: 'La tua ricevuta n. 1234', snippet: 'Grazie per il tuo acquisto.',
    internalDateMs: AT,
    attachments: [{ filename: 'ricevuta-1234.pdf', mimeType: 'application/pdf', size: 48210, attachmentId: 'gmail-att-receipt-1' }],
  }));
  assert.equal(push.mailSubject, history.mailSubject, 'same decoded Subject on both paths');
  assert.equal(push.mailSubject, 'La tua ricevuta n. 1234');
  assert.deepEqual(push.attachments, history.attachments, 'same descriptors on both paths');
  assert.deepEqual(push.attachments, [{
    name: 'ricevuta-1234.pdf', mimeType: 'application/pdf', sizeBytes: 48210,
  }]);
});

test('self-closing breaks keep their line break instead of joining words', () => {
  // P1 backlog:3055d50330b5 — `<br/>` never matched the block-break regex,
  // so it was stripped silently and words joined in the stored body.
  const html = '<p>Grazie<br/>di oggi</p><p>A domani<br />alle nove.</p>';
  const wire = {
    id: 'gmail-br-1',
    threadId: 'thread-br-1',
    snippet: 'Grazie di oggi',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Esempio <mittente@example.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'A capo' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', filename: '', body: { data: b64url(html), size: html.length } },
      ],
    },
  };
  const event = normalizeGmailRestMessage(wire, MAILBOX);
  assert.ok(event.text.includes('Grazie\ndi oggi'), `br/ becomes a line break, got ${JSON.stringify(event.text)}`);
  assert.ok(event.text.includes('A domani\nalle nove.'), `br / becomes a line break, got ${JSON.stringify(event.text)}`);
});

test('a text part with a filename is a descriptor, never the stored body', () => {
  // P1 backlog:3055d50330b5 — `collectPartTexts` read every text/* part, so
  // a small text attachment became the message body and leaked into the row.
  const html = '<p>Il corpo vero della mail.</p>';
  const wire = {
    id: 'gmail-att-text-1',
    threadId: 'thread-att-text-1',
    snippet: 'Il corpo vero',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Esempio <mittente@example.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'Nota allegata' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/html', filename: '', body: { data: b64url(html), size: html.length } },
        {
          mimeType: 'text/plain',
          filename: 'note.txt',
          body: { data: b64url('QUESTO E UN ALLEGATO'), attachmentId: 'gmail-att-note-1', size: 20 },
        },
      ],
    },
  };
  const event = normalizeGmailRestMessage(wire, MAILBOX);
  assert.ok(event.text.includes('Il corpo vero della mail.'), 'the HTML body wins');
  assert.ok(!event.text.includes('QUESTO E UN ALLEGATO'), 'attachment bytes never land in the body');
  assert.deepEqual(event.attachments, [{
    name: 'note.txt', mimeType: 'text/plain', sizeBytes: 20,
  }], 'the filename part is still listed as a descriptor');
});

test('tabs and folded subjects store instead of refusing the message', () => {
  // P1 backlog:3055d50330b5 — a tab in the body or a CRLF+TAB folded
  // Subject survived the reader, then `validateMessageRequest` refused the
  // whole message over a cosmetic field and the mail was lost.
  const plain = 'colonna1\tcolonna2 e poi continua';
  const wire = {
    id: 'gmail-tab-1',
    threadId: 'thread-tab-1',
    snippet: 'colonna1 colonna2',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Esempio <mittente@example.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'Lunga\r\n\tsuite di novembre' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', filename: '', body: { data: b64url(plain), size: plain.length } },
      ],
    },
  };
  const event = normalizeGmailRestMessage(wire, MAILBOX);
  assert.equal(event.mailSubject, 'Lunga suite di novembre', 'folded lines join with one space');
  assert.ok(!event.text.includes('\t'), 'no tab survives in the stored body');
  const validated = validateMessageRequest({
    sourceKey: 'gmail:tab:1', conversationId: 'email:thread-tab-1', direction: 'inbound',
    channel: 'email', body: event.text, mailSubject: event.mailSubject,
    mailAttachments: event.attachments, subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z',
    source: SOURCE,
  });
  assert.equal(validated.body, event.text, 'the cleaned body passes the record fence');
});

test('a snippet-only message decodes the wider entity table', () => {
  // P2 backlog:3055d50330b5 — the snippet fallback decoded only 6 named
  // entities, so `&hellip;` and friends were stored raw; the old assertion
  // read the plain-part path and could never fail.
  const wire = {
    id: 'gmail-snippet-1',
    threadId: 'thread-snippet-1',
    snippet: 'Le offerte&hellip; da &euro;10 &mdash; per te &rsquo;amico&rsquo; &laquo;ciao&raquo;',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Esempio <mittente@example.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'Offerte' },
      ],
      mimeType: 'multipart/mixed',
      parts: [],
    },
  };
  const event = normalizeGmailRestMessage(wire, MAILBOX);
  assert.ok(!event.text.includes('&'), `no raw entity survives, got ${JSON.stringify(event.text)}`);
  assert.ok(event.text.includes('…'), 'hellip decodes on the snippet path');
  assert.ok(event.text.includes('—'), 'mdash decodes on the snippet path');
  assert.ok(event.text.includes('€10'), 'euro decodes on the snippet path');
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

test('a mail with only its subject stores with a null body', async () => {
  // P1 backlog:3055d50330b5 — a decoded subject with empty readable text
  // (empty snippet, image-only body, padding-only text) normalized to '' and
  // the record refused the whole message, losing the synced subject.
  const wire = {
    id: 'gmail-subject-only-1',
    threadId: 'thread-subject-only-1',
    snippet: '',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Esempio <mittente@example.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'Solo oggetto' },
      ],
      mimeType: 'multipart/mixed',
      parts: [],
    },
  };
  const event = normalizeGmailRestMessage(wire, MAILBOX);
  assert.equal(event.mailSubject, 'Solo oggetto');
  assert.equal(event.text, '');
  const { stored } = await hostLogsMail(event, 'gmail:subject-only:1');
  assert.equal(stored.mailSubject, 'Solo oggetto');
  assert.equal(stored.body, null, 'the subject-only mail stores with a null body');
});

test('a dirty attachment name degrades to a skipped descriptor, never a refused message', () => {
  // P1 backlog:3055d50330b5 — a provider filename with controls passed both
  // readers unchanged, then the record refused the whole mail over the
  // cosmetic field. Both readers sanitize the same way now.
  const wire = {
    id: 'gmail-dirty-1',
    threadId: 'thread-dirty-1',
    snippet: 'Corpo vero.',
    internalDate: String(AT),
    labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Esempio <mittente@example.com>' },
        { name: 'To', value: MAILBOX },
        { name: 'Subject', value: 'Nomi sporchi' },
      ],
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'application/pdf',
          filename: 'ricevuta\n1234\t.pdf',
          body: { attachmentId: 'gmail-att-dirty-1', size: 10 },
        },
        {
          mimeType: 'application/pdf',
          filename: '   ',
          body: { attachmentId: 'gmail-att-blank-1', size: 10 },
        },
      ],
    },
  };
  const rest = normalizeGmailRestMessage(wire, MAILBOX);
  assert.deepEqual(rest.attachments, [{
    name: 'ricevuta 1234 .pdf', mimeType: 'application/pdf', sizeBytes: 10,
  }], 'controls become spaces, the blank name drops out');

  const definition = createGmailChannelAdapter({ mailbox: MAILBOX, secret: 'gmail-test-secret' }).definition;
  const [push] = definition.normalizeInbound(gmailPushBody({
    id: 'gmail-dirty-1', threadId: 'thread-dirty-1',
    from: 'Esempio <mittente@example.com>', to: MAILBOX,
    subject: 'Nomi sporchi', snippet: 'Corpo vero.', internalDateMs: AT,
    attachments: [
      { filename: 'ricevuta\n1234\t.pdf', mimeType: 'application/pdf', size: 10, attachmentId: 'gmail-att-dirty-1' },
      { filename: '   ', mimeType: 'application/pdf', size: 10, attachmentId: 'gmail-att-blank-1' },
    ],
  }));
  assert.deepEqual(push.attachments, rest.attachments, 'push sanitizes exactly like history');

  const validated = validateMessageRequest({
    sourceKey: 'gmail:dirty:1', conversationId: 'email:thread-dirty-1', direction: 'inbound',
    channel: 'email', body: rest.text, mailSubject: rest.mailSubject,
    mailAttachments: rest.attachments, subject: SUBJECT, occurredAt: '2026-11-05T09:00:00.000Z',
    source: SOURCE,
  });
  assert.deepEqual(JSON.parse(validated.mailAttachmentsJson), rest.attachments);
});

test('the reader fence mirrors the record fence', () => {
  // P3 backlog:3055d50330b5 — the two 2000 fences live in different
  // packages by convention, so this test pins them equal instead of a
  // shared import: a drift would truncate wrong or refuse downstream.
  assert.equal(GMAIL_MAX_STORED_TEXT, bounds.body);
});
