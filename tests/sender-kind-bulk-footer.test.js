import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotificationMessage } from '../packages/core/sender-kind.js';
import { awaitingReplyFor } from '../packages/customer-data/src/customers.js';

/**
 * backlog:bab63e32acdb, verification 12/11 on the pilot (NON PASSA): two
 * mass mails stayed in «Da rispondere». Raw rows (read-only GET on the
 * pilot space, anonymized beyond the sender): «Namecheap Support» from
 * `pesupport@namecheap.com`, a newsletter with U+2007 preheader padding and
 * «View in browser»; «Ahrefs Site Audit» from `sa@ahrefs.com`, a crawl report
 * with «Unsubscribe from this project». No address rule names them without
 * hurting real people. Both Gmail readers already quarantine mass mail by
 * its headers, so such rows are history from before that door: the footer
 * words of mass mail, from a sender the team never wrote to, cure them.
 */

const NAMECHEAP = {
  channel: 'email', direction: 'inbound', remoteHandle: 'pesupport@namecheap.com', mailSubject: null,
  body: `Download the new Private Email mobile app${' '.repeat(40)}\nView in browser`,
};
const AHREFS = {
  channel: 'email', direction: 'inbound', remoteHandle: 'sa@ahrefs.com', mailSubject: null,
  body: 'New crawl for Danielepelleri: 400 internal URLs were analyzed. Health Score 87. Unsubscribe from this project',
};

test('bab63e32acdb: the real pilot rows — the footer words decide, only for a sender never answered', () => {
  assert.equal(isNotificationMessage(NAMECHEAP, { weWrote: false }), true, 'Namecheap «View in browser»');
  assert.equal(isNotificationMessage(AHREFS, { weWrote: false }), true, 'Ahrefs «Unsubscribe»');
  assert.equal(isNotificationMessage(NAMECHEAP, { weWrote: true }), false, 'a correspondent the team answered stays a person');
  assert.equal(isNotificationMessage({ ...AHREFS, body: 'Ciao, volevo un preventivo per la palestra.' }, { weWrote: false }), false,
    'the same mailbox without mass-mail words is a person');
  // A contact form is a person writing, even with a footer.
  assert.equal(isNotificationMessage({
    channel: 'email', remoteHandle: 'noreply@arvo.app', body: 'NEW CONTACT FORM SUBMISSION Name: Julian Ross. Unsubscribe',
  }, { weWrote: false }), false);
  // Italian footers too.
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'info@negozio.it', body: 'Saldi! Per non ricevere più email annulla l’iscrizione' }, { weWrote: false }), true,
    'the typographic apostrophe too');
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'info@negozio.it', body: 'Saldi! Disiscriviti qui' }, { weWrote: false }), true);
});

test('bab63e32acdb: the server view no longer counts them as waiting, unless the team answered them', () => {
  const row = (over) => ({ subjectResource: 'contact', subjectId: 'c1', occurredAt: '2026-11-12T09:00:00.000Z', ...over });
  assert.equal(awaitingReplyFor([row({ ...NAMECHEAP, conversationId: 'n1' })], [{ id: 'n1', subjectLabel: 'Namecheap Support' }]).count, 0);
  assert.equal(awaitingReplyFor([row({ ...AHREFS, conversationId: 'a1' })], [{ id: 'a1', subjectLabel: 'Ahrefs Site Audit' }]).count, 0);
  const answered = [
    row({ ...NAMECHEAP, conversationId: 'n1', occurredAt: '2026-11-10T09:00:00.000Z' }),
    row({ conversationId: 'n1', channel: 'email', direction: 'outbound', body: 'Grazie', occurredAt: '2026-11-11T09:00:00.000Z' }),
    row({ ...NAMECHEAP, conversationId: 'n1', occurredAt: '2026-11-12T09:00:00.000Z' }),
  ];
  assert.equal(awaitingReplyFor(answered).count, 1, 'a correspondent the team wrote to keeps waiting');
});

