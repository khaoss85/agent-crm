import test from 'node:test';
import assert from 'node:assert/strict';

import * as card from '../apps/admin/public/admin-customer-card.js';
import { buildInbox } from '../apps/admin/public/admin-oggi.js';
import { previewLastContactText } from '../packages/customer-data/src/customers.js';

/**
 * backlog:1a98085b74c9, verifica 12/11 on Presti (NON PASSA on agent-crm
 * 614f919): the Clienti «Ultimo contatto» cell and Oggi still showed
 * «<!DOCTYPE html>», «&zwnj;» and «4,99 € EUR». Both go through the shared
 * cleaning; these bodies are the shapes it did not recognise.
 */

const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);

/** The Oggi «Da rispondere» preview of one inbound email. */
function oggiPreview(body, mailSubject = null) {
  const inbox = buildInbox({
    now: new Date('2026-11-12T12:00:00.000Z'),
    conversations: [],
    messages: [{ id: 'm1', conversationId: 'k1', channel: 'email', direction: 'inbound', occurredAt: '2026-11-12T10:00:00.000Z', body, mailSubject, remoteHandle: 'a@example.com' }],
  });
  return inbox.rows[0].preview;
}

test('«<!DOCTYPE html>» and other declarations never reach a preview', () => {
  const doctype = '<!DOCTYPE html><html><head><title>Report</title></head><body><p>Il tuo report settimanale è pronto.</p></body></html>';
  const xhtml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n'
    + '<html xmlns="http://www.w3.org/1999/xhtml"><body><!-- preheader --><div>Il tuo report settimanale è pronto.</div></body></html>';
  for (const body of [doctype, xhtml]) {
    assert.equal(previewLastContactText(body), 'Il tuo report settimanale è pronto.', 'Clienti');
    assert.equal(oggiPreview(body), 'Il tuo report settimanale è pronto.', 'Oggi');
    assert.equal(card.passagePreview({ body, subject: null }), 'Il tuo report settimanale è pronto.', 'cronologia');
    assert.doesNotMatch(card.passageFullText({ body }), /DOCTYPE|<\?xml|CDATA|</, 'the full text of the scheda too');
  }
});

test('Muse P2: a CDATA section keeps its text; CDATA and processing instructions are markup for the scheda too', () => {
  const body = '<html><body><![CDATA[Confermo appuntamento domani alle 10.]]></body></html>';
  assert.equal(previewLastContactText(body), 'Confermo appuntamento domani alle 10.', 'Clienti');
  assert.equal(oggiPreview(body), 'Confermo appuntamento domani alle 10.', 'Oggi');
  assert.equal(card.passagePreview({ body, subject: null }), 'Confermo appuntamento domani alle 10.', 'cronologia');
  const full = card.passageFullText({ body });
  assert.match(full, /Confermo appuntamento domani alle 10\./);
  assert.doesNotMatch(full, /CDATA|<\/|\]\]>/);
  for (const bare of ['<![CDATA[Ciao]]>', '<?php echo 1; ?>Ciao']) {
    assert.equal(card.passageFullText({ body: bare }), 'Ciao', `no delimiter leaks in «Mostra tutto»: ${bare}`);
  }
});

test('«&zwnj;» and the other padding entities decode and vanish', () => {
  const body = 'Pagamento confermato &zwnj;&zwnj;&zwnj;&lrm;&rlm;&shy;&ensp;&thinsp; per il tuo ordine';
  assert.equal(previewLastContactText(body), 'Pagamento confermato per il tuo ordine', 'Clienti');
  assert.equal(oggiPreview(body), 'Pagamento confermato per il tuo ordine', 'Oggi');
  assert.equal(card.passageFullText({ body }), 'Pagamento confermato per il tuo ordine', 'the scheda full text decodes the same table');
  assert.equal(card.readableText('Ciao &zwnj;Mario&lrm;'), 'Ciao Mario');
});

test('«4,99 € EUR» reads once with NBSP, narrow NBSP and a leading code', () => {
  for (const [body, expected] of [
    [`Totale 4,99${NBSP}€${NBSP}EUR`, 'Totale 4,99 €'],
    [`Totale 4,99 €${NBSP}EUR`, 'Totale 4,99 €'],
    [`Totale 4,99${NNBSP}€${NNBSP}EUR`, 'Totale 4,99 €'],
    ['Totale 4,99&nbsp;€&nbsp;EUR', 'Totale 4,99 €'],
    ['Totale EUR 4,99 €', 'Totale 4,99 €'],
    [`Total €${NBSP}4.99 EUR`, 'Total €4.99'],
  ]) {
    assert.equal(previewLastContactText(body), expected, `Clienti: ${JSON.stringify(body)}`);
    assert.equal(oggiPreview(body), expected, `Oggi: ${JSON.stringify(body)}`);
  }
  assert.equal(previewLastContactText('Cambio EUR 5 $'), 'Cambio EUR 5 $', 'two different currencies both stay');
});

test('a stored Ahrefs body (pilot import, 2000 chars) reads clean: no «&zwnj;» run, no style residue', () => {
  // The shape read from Presti on 12/11 (GET only): text, 180 literal
  // «&zwnj;» each followed by an NBSP, then attribute residue over several
  // lines, cut at 2000 characters by the import.
  let body = 'New crawl for Danielepelleri 400 internal URLs were analyzed. Health Score 72 · Errors 129 '
    + `&zwnj;${NBSP}`.repeat(180)
    + '\n style="box-sizing: border-box; margin: 0;\n padding: 0; font-family: Arial">\n Unsubscribe from this project'
    + '\n style="box-sizing: border-box; color: #333">10 November\n width="100%" cellpadding="0">New crawl for Danielepelleri'
    + ' style="box-sizing: border-box; font-size: 14px; line-height: 20px; colo';
  body = body.slice(0, 2000);
  assert.equal(previewLastContactText(body),
    'New crawl for Danielepelleri 400 internal URLs were analyzed. Health Score 72 · Errors 129 Unsubscribe from this project 10 November New cr…');
  for (const shown of [previewLastContactText(body), oggiPreview(body), card.passagePreview({ body, subject: null })]) {
    assert.doesNotMatch(shown, /&zwnj;|style=|box-sizing|cellpadding|>/, shown);
    assert.ok(shown.startsWith('New crawl for Danielepelleri 400 internal URLs were analyzed.'), shown);
  }
  const full = card.passageFullText({ body });
  assert.doesNotMatch(full, /&zwnj;|style=|box-sizing|cellpadding|"/, 'the scheda full text is clean too');
  assert.match(full, /Unsubscribe from this project/);
});
