import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { previewLastContactText, shapeCustomerRow } from '../packages/customer-data/src/customers.js';
import { normalizeGmailRestMessage } from '../packages/channels/src/gmail-http.js';
import { buildInbox } from '../apps/admin/public/admin-oggi.js';
import * as shell from '../apps/admin/public/admin-message-preview.js';
import * as core from '../packages/core/index.js';

/**
 * Message previews read like Gmail (Dan 10/11): «Oggetto — estratto
 * pulito», never URLs, HTML residue, hidden preheaders, rows of asterisks
 * or newsletter service lines. The bodies below are the previews Dan saw
 * in production on the Clienti page (domains anonymized).
 */

const FASTWEB = 'Visualizza la versione Web <http://app.go.example.it/e/es?s=424899536&e=945994&elqTrackId=351b1d1e143e9f>\n'
  + 'Ciao Mario, la tua offerta Fibra è pronta.';
const NOW_SURVEY = 'contribuisci a rendere l\'esperienza NOW ancora più straordinaria! Now Logo ****************************************\n'
  + 'Rispondi al sondaggio entro venerdì.';
const AMAZON = 'I tuoi ordini https://www.example.it/gp/css/order-history?ref_=fed_yo_default Il tuo account https://www.example.it/your-account\n'
  + 'Il tuo pacco è in consegna oggi.';
const PADDLE = 'Ricevuta del tuo pagamento a favore di Paddle.net id="preHeader" style="display:none;color:#F5F7FA;font-size:0px;line-height:0px;max-height:0px">'
  + 'Grazie per il tuo acquisto.';
const PREHEADER_FIRST = 'style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">'
  + 'Pagamento confermato per il tuo ordine.';
const HTML_CAPABLE = 'Please view this email in an HTML-capable email client.';
const VERCEL = 'Vercel [https://assets.example.com/email/vercel.png] LOG IN TO VERCEL Hi Dan, your deployment is ready.';

/** Whatever a clean preview must never contain. */
function assertClean(preview, label) {
  assert.equal(typeof preview, 'string', `${label}: a preview`);
  assert.doesNotMatch(preview, /https?:|www\.|<|>|\[|\]/, `${label}: no URL or bracket left: ${preview}`);
  assert.doesNotMatch(preview, /\b(?:id|style|data-[\w-]+)\s*=/, `${label}: no attribute fragment: ${preview}`);
  assert.doesNotMatch(preview, /\*{3,}|-{4,}|={4,}|_{4,}/, `${label}: no decorative row: ${preview}`);
  assert.doesNotMatch(preview, /display\s*:\s*none/i, `${label}: no hidden-style text: ${preview}`);
  assert.ok(preview.length <= 140, `${label}: bounded: ${preview.length}`);
}

test('the /bo shell copy is byte-identical to the core source', () => {
  const source = readFileSync(fileURLToPath(new URL('../packages/core/src/message-preview.js', import.meta.url)), 'utf8');
  const copy = readFileSync(fileURLToPath(new URL('../apps/admin/public/admin-message-preview.js', import.meta.url)), 'utf8');
  assert.equal(copy, source, 'apps/admin/public/admin-message-preview.js must be a copy of packages/core/src/message-preview.js');
  assert.equal(shell.messagePreview, shell.messagePreview);
  assert.equal(typeof core.messagePreview, 'function', 'the core index exports the preview');
});

test('the Clienti row previews Dan\'s production examples clean', () => {
  const cases = [
    [FASTWEB, 'Ciao Mario, la tua offerta Fibra è pronta.'],
    [NOW_SURVEY, 'contribuisci a rendere l\'esperienza NOW ancora più straordinaria! Now Logo Rispondi al sondaggio entro venerdì.'],
    [AMAZON, 'I tuoi ordini Il tuo account Il tuo pacco è in consegna oggi.'],
    [PADDLE, 'Ricevuta del tuo pagamento a favore di Paddle.net Grazie per il tuo acquisto.'],
    [PREHEADER_FIRST, 'Pagamento confermato per il tuo ordine.'],
    [VERCEL, 'Vercel LOG IN TO VERCEL Hi Dan, your deployment is ready.'],
  ];
  for (const [body, expected] of cases) {
    const preview = previewLastContactText(body);
    assertClean(preview, body.slice(0, 30));
    assert.equal(preview, expected);
  }
});

test('an email previews «Oggetto — estratto», the subject alone when the body is only boilerplate', () => {
  assert.equal(
    previewLastContactText(FASTWEB, 'La tua offerta Fibra'),
    'La tua offerta Fibra — Ciao Mario, la tua offerta Fibra è pronta.',
  );
  assert.equal(previewLastContactText(HTML_CAPABLE, 'Benvenuto in Example'), 'Benvenuto in Example',
    'a placeholder body falls back to the subject');
  assert.equal(previewLastContactText(HTML_CAPABLE), null, 'nothing readable and no subject previews as nothing');
  assert.equal(previewLastContactText('Il tuo ordine è partito. Arriva domani.', 'Il tuo ordine è partito'),
    'Il tuo ordine è partito — Arriva domani.', 'a body that repeats its subject does not say it twice');
  assert.equal(previewLastContactText('Ordinario il ritiro di oggi', 'Ordin'), 'Ordin — Ordinario il ritiro di oggi',
    'only a whole-word repeat is folded');
  assert.equal(previewLastContactText(null, 'Solo oggetto'), 'Solo oggetto', 'a mail with only its subject previews the subject');
  const long = previewLastContactText(`${'parola '.repeat(40)}fine`, 'Oggetto');
  assert.ok(long.startsWith('Oggetto — parola'));
  assert.ok(long.length <= 140 && long.endsWith('…'), 'the 140-character bound holds with the subject');
});

test('the service lines of Italian and English newsletters drop, the customer\'s words stay', () => {
  for (const [body, expected] of [
    ['Se non visualizzi correttamente questa email clicca qui\n-----\nCiao, ecco le novità.', 'Ciao, ecco le novità.'],
    ['View this email in your browser\n===========\nHello Dan, here is your invoice.', 'Hello Dan, here is your invoice.'],
    ['Having trouble viewing this email? Your order shipped.', 'Your order shipped.'],
    ['[image: Logo Example] Il tuo preventivo è pronto.', 'Il tuo preventivo è pronto.'],
  ]) {
    assert.equal(previewLastContactText(body), expected);
  }
  // A customer's own words are never a service line.
  assert.equal(previewLastContactText('La versione web del sito non si apre, mi aiuti?'), 'La versione web del sito non si apre, mi aiuti?');
  assert.equal(previewLastContactText('Ha detto "va bene" per giovedì'), 'Ha detto "va bene" per giovedì');
  assert.equal(previewLastContactText('Scrivimi a mario@example.com, grazie'), 'Scrivimi a mario@example.com, grazie');
});

test('format and zero-width characters never reach a preview', () => {
  // Presti 10/11: «Pagamento confermato» followed by runs of LRM/RLM.
  const hidden = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff, 0x034f, 0x00ad];
  const run = String.fromCharCode(0x200e, 0x200f, 0x20, 0x200e, 0x200f);
  assert.equal(previewLastContactText(`Pagamento confermato ${run} ${run}`), 'Pagamento confermato');
  for (const code of hidden) {
    const mark = String.fromCharCode(code);
    const preview = previewLastContactText(`${mark}Paga${mark}mento ${mark} confermato${mark}`, `Ricevuta${mark}`);
    assert.equal(preview, 'Ricevuta — Pagamento confermato', `U+${code.toString(16).padStart(4, '0')} is removed, the word stays whole`);
  }
});

test('the Clienti row reads the stored mail subject of the latest message', () => {
  const row = shapeCustomerRow(
    { contact: { id: 'c1', firstName: 'Mario', lastName: 'Rossi', email: 'mario@example.com' }, company: null },
    {
      activityBySubject: new Map([['contact:c1', {
        occurredAt: '2026-11-10T09:00:00.000Z', channel: 'email', text: HTML_CAPABLE, subject: 'Pagamento ricevuto',
      }]]),
    },
  );
  assert.equal(row.lastContactText, 'Pagamento ricevuto');
});

test('the Oggi «Da rispondere» row previews clean, with the subject', () => {
  const now = new Date('2026-11-10T12:00:00.000Z');
  const inbox = buildInbox({
    now,
    conversations: [],
    messages: [
      { id: 'm1', conversationId: 'k1', channel: 'email', direction: 'inbound', occurredAt: '2026-11-10T10:00:00.000Z', body: PADDLE, mailSubject: 'La tua ricevuta Paddle', remoteHandle: 'a@example.com' },
      { id: 'm2', conversationId: 'k2', channel: 'email', direction: 'inbound', occurredAt: '2026-11-10T09:00:00.000Z', body: HTML_CAPABLE, mailSubject: 'Benvenuto', remoteHandle: 'b@example.com' },
      { id: 'm3', conversationId: 'k3', channel: 'email', direction: 'inbound', occurredAt: '2026-11-10T08:00:00.000Z', body: AMAZON, remoteHandle: 'c@example.com' },
    ],
  });
  const previews = Object.fromEntries(inbox.rows.map((row) => [row.id, row.preview]));
  assert.ok(previews.k1.startsWith('La tua ricevuta Paddle — Ricevuta del tuo pagamento'), previews.k1);
  assert.equal(previews.k2, 'Benvenuto', 'a placeholder body reads as its subject, never «Messaggio senza testo»');
  for (const preview of Object.values(previews)) assertClean(preview, 'inbox');
});

/** A Gmail REST `format=full` message with a plain and an HTML part. */
function restMail({ plain, html, subject = 'Il tuo pagamento' }) {
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
  return {
    id: 'msg-preview-1',
    threadId: 'thread-preview-1',
    internalDate: String(Date.parse('2026-11-10T09:00:00.000Z')),
    snippet: 'Grazie per il tuo acquisto',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Mario Rossi <mario@example.com>' },
        { name: 'To', value: 'presti-pilota@example.com' },
        { name: 'Subject', value: subject },
      ],
      parts: [
        { mimeType: 'text/plain', filename: '', body: { data: b64(plain) } },
        { mimeType: 'text/html', filename: '', body: { data: b64(html) } },
      ],
    },
  };
}

const RECEIPT_HTML = '<html><head><title>Ricevuta</title><style>p{color:#333}</style></head><body>'
  + '<div id="preHeader" style="display:none;color:#F5F7FA;font-size:0px;max-height:0px">Pagamento confermato, testo nascosto</div>'
  + '<p class="lead" data-x="a>b">Ciao Mario,<br>il pagamento di <b>49 €</b> è confermato.</p>'
  + '<span style="opacity:0">nascosto anche questo</span>'
  + '<div style="color:#333">Grazie per il tuo acquisto.</div></body></html>';

test('the Gmail reader skips a placeholder plain part and strips the HTML part clean', () => {
  for (const plain of [HTML_CAPABLE, FASTWEB.split('\n')[0], 'https://example.com/a?x=1\nhttps://example.com/b?y=2 Vai']) {
    const event = normalizeGmailRestMessage(restMail({ plain, html: RECEIPT_HTML }), 'presti-pilota@example.com');
    assert.match(event.text, /Ciao Mario,\nil pagamento di 49 € è confermato\./, `a stand-in plain part (${plain.slice(0, 20)}) gives way to the HTML`);
    assert.match(event.text, /Grazie per il tuo acquisto\./);
    assert.doesNotMatch(event.text, /nascost/, 'hidden preheaders never land in the stored body');
    assert.doesNotMatch(event.text, /<|>|style=|class=|data-x|preHeader|color:/, `no tag or attribute fragment: ${event.text}`);
    assert.doesNotMatch(event.text, /Ricevuta|p\{/, 'head, title and style never land in the body');
  }
  const real = normalizeGmailRestMessage(restMail({ plain: 'Ciao, confermo per giovedì.', html: RECEIPT_HTML }), 'presti-pilota@example.com');
  assert.equal(real.text, 'Ciao, confermo per giovedì.', 'a real plain part still wins');
});

test('a full body keeps its text and loses only markup residue', () => {
  const plain = 'Riga uno\nhttps://example.com/link\n\nRiga due';
  assert.equal(core.cleanMessageBody(plain), plain, 'a body without markup is untouched, URLs and line breaks included');
  assert.equal(core.cleanMessageBody(PREHEADER_FIRST), 'Pagamento confermato per il tuo ordine.');
  assert.equal(core.cleanMessageBody('Ciao <b>Mario</b>,<br>a presto'), 'Ciao Mario,\na presto');
  assert.equal(core.cleanMessageBody('Mario <mario@example.com> ha scritto'), 'Mario <mario@example.com> ha scritto',
    'an address in angle brackets is not markup');
});
