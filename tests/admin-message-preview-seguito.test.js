import test from 'node:test';
import assert from 'node:assert/strict';

import * as preview from '../packages/core/message-preview.js';
import * as card from '../apps/admin/public/admin-customer-card.js';
import { previewLastContactText } from '../packages/customer-data/src/customers.js';
import { normalizeGmailRestMessage } from '../packages/channels/src/gmail-http.js';

/**
 * Follow-up of backlog:1a98085b74c9 (verifica browser 10/11 on Presti,
 * NON PASSA): stand-in bodies in the scheda, words glued by table cells,
 * a currency named twice, the same mail shown three times.
 */

test('1. the «view this email in an HTML-capable client / in your browser» family drops, line breaks included', () => {
  for (const standIn of [
    'Please view this email in an HTML-capable email client.',
    'Please view this email in an\nHTML-capable email client.',
    'PLEASE VIEW THIS EMAIL IN AN HTML-CAPABLE EMAIL CLIENT.',
    'Please view this mail in an HTML capable mail client.',
    'Please view this email in your browser.',
    'Please view this email\nin your web browser',
  ]) {
    assert.equal(previewLastContactText(standIn), null, `nothing readable: ${JSON.stringify(standIn)}`);
    assert.equal(previewLastContactText(standIn, 'Il tuo allenamento di oggi'), 'Il tuo allenamento di oggi');
    assert.equal(preview.isPlaceholderBody(standIn), true);
  }
  // Still only as a whole unit (Muse giro 3): the customer's sentence stays.
  assert.equal(previewLastContactText('Please view this email in your browser and tell me if the logo is right'),
    'Please view this email in your browser and tell me if the logo is right');
});

test('1. the scheda shows the mail subject, never the stand-in body', () => {
  const item = { entry: 'message', channel: 'email', body: 'Please view this email in an HTML-capable email client.', subject: 'Nuovi esercizi per te' };
  assert.equal(card.passageText(item), 'Nuovi esercizi per te');
  assert.equal(card.passageText({ ...item, subject: null }), '', 'no subject: nothing, never the stand-in');
  const real = { entry: 'message', channel: 'email', body: 'Ciao,\nci vediamo giovedì https://example.com/agenda', subject: 'Appuntamento' };
  assert.equal(card.passageText(real), 'Ciao,\nci vediamo giovedì https://example.com/agenda', 'a real body stays whole');
});

test('2. table cells, line breaks and closing blocks never glue words', () => {
  const html = '<table><tr><td>Danielepelleri</td><td>400 internal URLs</td></tr></table>'
    + '<div>Ciao<br>Mario</div><p>prima</p><p>seconda</p><th>Totale</th><td>12</td>';
  const text = preview.htmlToText(html);
  assert.doesNotMatch(text, /Danielepelleri400|CiaoMario|primaseconda|Totale12/, JSON.stringify(text));
  assert.equal(previewLastContactText(html), 'Danielepelleri 400 internal URLs Ciao Mario prima seconda Totale 12');
});

test('2. a Gmail HTML body with table cells stores separated words', () => {
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
  const event = normalizeGmailRestMessage({
    id: 'msg-cells-1',
    threadId: 'thread-cells-1',
    internalDate: String(Date.parse('2026-11-10T09:00:00.000Z')),
    snippet: '',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Report <report@example.com>' },
        { name: 'To', value: 'presti-pilota@example.com' },
        { name: 'Subject', value: 'Rapporto del sito' },
      ],
      parts: [
        { mimeType: 'text/plain', filename: '', body: { data: b64('Please view this email in an HTML-capable email client.') } },
        { mimeType: 'text/html', filename: '', body: { data: b64('<table><tr><td>Danielepelleri</td><td>400 internal URLs</td></tr></table>') } },
      ],
    },
  }, 'presti-pilota@example.com');
  assert.doesNotMatch(event.text, /Danielepelleri400/, JSON.stringify(event.text));
  assert.match(event.text, /Danielepelleri\s+400 internal URLs/);
});

test('3. an amount that names its currency twice reads once', () => {
  assert.equal(previewLastContactText('Totale pagato 4,99 € EUR, grazie'), 'Totale pagato 4,99 €, grazie');
  assert.equal(previewLastContactText('Total €4.99 EUR'), 'Total €4.99');
  assert.equal(previewLastContactText('Total $5.00 USD'), 'Total $5.00');
  assert.equal(previewLastContactText('Cambio 5 $ EUR'), 'Cambio 5 $ EUR', 'a symbol and a different code are two currencies, both stay');
});

test('4. the same mail synced three times reads once in the cronologia', () => {
  const mail = (id, at, extra = {}) => ({
    entry: 'message', id, channel: 'email', direction: 'inbound', remoteHandle: 'news@example.com',
    subject: 'Nuovi esercizi per te', body: 'Please view this email in an HTML-capable email client.', occurredAt: at, ...extra,
  });
  const entries = [
    mail('m1', '2026-11-10T08:00:05.000Z'),
    mail('m2', '2026-11-10T08:00:20.000Z'),
    mail('m3', '2026-11-10T08:00:41.000Z'),
    mail('m4', '2026-11-10T08:05:00.000Z'),
    mail('m5', '2026-11-10T08:00:30.000Z', { body: 'Un testo diverso' }),
    { entry: 'note', id: 'n1', body: 'nota', occurredAt: '2026-11-10T08:00:00.000Z' },
    { entry: 'note', id: 'n2', body: 'nota', occurredAt: '2026-11-10T08:00:00.000Z' },
  ];
  const shown = card.collapseDuplicatePassages(entries).map((item) => item.id);
  assert.deepEqual(shown, ['m1', 'm4', 'm5', 'n1', 'n2'],
    'one copy per minute; another minute, another text and notes stay');
});
