import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { logMessage, validateMessageRequest } from '../packages/interactions/src/index.js';
import { isNotificationMessage } from '../packages/core/sender-kind.js';
import { awaitingReplyFor } from '../packages/customer-data/src/customers.js';

/**
 * backlog:bab63e32acdb, verification 12/11 on the pilot (NON PASSA): two
 * mass mails stayed in «Da rispondere». Raw rows (read-only GET on the
 * pilot space, anonymized beyond the sender): «Namecheap Support» from
 * `pesupport@namecheap.com`, a newsletter with U+2007 preheader padding and
 * «View in browser»; «Ahrefs Site Audit» from `sa@ahrefs.com`, a crawl report
 * with «Unsubscribe from this project». No address rule names them without
 * hurting real people: the import now keeps the header signal (`mailBulk`),
 * and the footer words are the defence for rows stored before it.
 */

const SUBJECT = { resource: 'contact', id: 'c-pilot', owner: 'host' };
const SOURCE = { package: 'host', action: 'google-sync-import' };
const BASE = {
  sourceKey: 'gmail:bulk:1', conversationId: 'email:thread-bulk-1', direction: 'inbound', channel: 'email',
  body: 'Ciao', subject: SUBJECT, occurredAt: '2026-11-12T09:00:00.000Z', source: SOURCE,
};

const NAMECHEAP = {
  channel: 'email', direction: 'inbound', remoteHandle: 'pesupport@namecheap.com', mailSubject: null,
  body: `Download the new Private Email mobile app${' '.repeat(40)}\nView in browser`,
};
const AHREFS = {
  channel: 'email', direction: 'inbound', remoteHandle: 'sa@ahrefs.com', mailSubject: null,
  body: 'New crawl for Danielepelleri: 400 internal URLs were analyzed. Health Score 87. Unsubscribe from this project',
};

test('bab63e32acdb: interaction-message keeps the mass-mail flag, email only, boolean only', () => {
  assert.equal(validateMessageRequest({ ...BASE, mailBulk: true }).mailBulk, true);
  assert.equal(validateMessageRequest({ ...BASE, mailBulk: false }).mailBulk, false);
  assert.equal(validateMessageRequest(BASE).mailBulk, null, 'absent reads unknown, never false');
  assert.throws(() => validateMessageRequest({ ...BASE, mailBulk: 'yes' }), /mailBulk must be a boolean/);
  assert.throws(() => validateMessageRequest({ ...BASE, channel: 'whatsapp', mailBulk: true }), /email-only/);
  const manifest = JSON.parse(readFileSync(new URL('../packages/interactions/modules/interaction-message.module.json', import.meta.url), 'utf8'));
  assert.equal(manifest.revision, 4);
  assert.deepEqual(manifest.fields.find((field) => field.name === 'mailBulk'), { name: 'mailBulk', type: 'boolean', writable: 'managed' });
  const history = JSON.parse(readFileSync(new URL('../packages/interactions/modules/interaction-message.history.json', import.meta.url), 'utf8'));
  assert.ok(history.previousManifests.some((entry) => entry.revision === 3 && !entry.fields.some((field) => field.name === 'mailBulk')),
    'revision 3 stays in the history: the change is additive');
});

test('bab63e32acdb: the host stores the flag the import read', async () => {
  let stored = null;
  const service = { listWhere: async () => [], createManaged: async (row) => { stored = row; return { id: 'm1', ...row }; } };
  await logMessage({ modules: { get: () => ({ service }) }, actor: { type: 'system', id: 'google-sync' } }, { ...BASE, mailBulk: true });
  assert.equal(stored.mailBulk, true);
});

test('bab63e32acdb: the real pilot rows — the header flag first, the footer words for older rows from a sender never answered', () => {
  // Rows stored before the flag: the footer words decide, only for a stranger.
  assert.equal(isNotificationMessage(NAMECHEAP, { weWrote: false }), true, 'Namecheap «View in browser»');
  assert.equal(isNotificationMessage(AHREFS, { weWrote: false }), true, 'Ahrefs «Unsubscribe»');
  assert.equal(isNotificationMessage(NAMECHEAP, { weWrote: true }), false, 'a correspondent the team answered stays a person');
  assert.equal(isNotificationMessage({ ...AHREFS, body: 'Ciao, volevo un preventivo per la palestra.' }, { weWrote: false }), false,
    'the same mailbox without mass-mail words is a person');
  // Rows with the flag: the header decides, whatever the address.
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'mario@studio-esempio.it', body: 'Novità', mailBulk: true }), true);
  assert.equal(isNotificationMessage({ channel: 'email', remoteHandle: 'mario@studio-esempio.it', body: 'Ciao', mailBulk: false }), false);
  // A contact form is a person writing, even sent as bulk.
  assert.equal(isNotificationMessage({
    channel: 'email', remoteHandle: 'noreply@arvo.app', body: 'NEW CONTACT FORM SUBMISSION Name: Julian Ross', mailBulk: true,
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
