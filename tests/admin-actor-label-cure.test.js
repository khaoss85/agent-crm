import test from 'node:test';
import assert from 'node:assert/strict';
import { auditActorLabel, offerCreatorLabel, personOf } from '../apps/admin/public/admin-labels.js';

/**
 * backlog:3f3c143b (seguito di #918, verifier back 17/11 + review Muse
 * rev-agent-crm-918-ab0cfaef6fef): nomi mancanti in cronologia e offerta.
 * - P2 review: un id tecnico confermato dal record veniva dipinto verbale
 *   (il controllo known correva prima del filtro tecnico);
 * - P2 review: il fallback mailbox accettava ogni stringa con '@';
 * - un audit registrato con un altro identificativo della stessa persona
 *   (mailbox, nome) non risolveva la riga del team e restava «—».
 */

const ROSTER = [
  { subject: 'google|601', displayName: 'Operatrice Uno', email: 'uno@esempio.invalid' },
];

const peopleOf = (roster) => roster;

test('3f3c143b seguito P2-1: a corroborated technical id stays hidden, never verbatim', () => {
  // Il record porta come nome contatto un id provider: l'audit con lo
  // stesso actorId non deve dipingerlo.
  assert.equal(auditActorLabel({ actorId: 'google|118' }, ['google|118'], []), '—');
  assert.equal(auditActorLabel({ actorId: 'admin-ui' }, ['admin-ui'], []), '—');
  assert.equal(
    auditActorLabel({ actorId: '123e4567-e89b-12d3-a456-426614174000' }, ['123e4567-e89b-12d3-a456-426614174000'], []),
    '—',
  );
  // Un id non tecnico confermato continua a leggersi (parola o nome).
  assert.equal(auditActorLabel({ actorId: 'coach-guido' }, ['coach-guido'], []), 'Coach Guido');
  assert.equal(auditActorLabel({ actorId: 'Guido Bianchi' }, ['Guido Bianchi'], []), 'Guido Bianchi');
});

test('3f3c143b seguito P2-2: the mailbox fallback needs a real mailbox', () => {
  assert.equal(auditActorLabel({ actorId: '@' }, [], []), '—');
  assert.equal(auditActorLabel({ actorId: 'foo@bar' }, [], []), '—');
  assert.equal(auditActorLabel({ actorId: 'a@b@c' }, [], []), '—');
  assert.equal(auditActorLabel({ actorId: 'mario.rossi@esempio.it' }, [], []), 'mario.rossi@esempio.it');
});

test('3f3c143b seguito: an audit actor recorded as mailbox or name names the roster person', () => {
  const people = peopleOf(ROSTER);
  assert.equal(personOf('uno@esempio.invalid', people)?.label, 'Operatrice Uno');
  assert.equal(personOf('Uno Esempio', people), null, 'an unknown name stays unknown');
  assert.equal(auditActorLabel({ actorId: 'uno@esempio.invalid' }, [], people), 'Operatrice Uno');
  assert.equal(auditActorLabel({ actorId: 'operatrice uno' }, [], people), 'Operatrice Uno');
  const offer = { id: 'o1', name: 'Prova', owner: 'google|601' };
  const created = { action: 'opportunity.created', actorType: 'user', actorId: 'uno@esempio.invalid' };
  assert.equal(offerCreatorLabel([created], offer, people), 'Operatrice Uno');
});

test('3f3c143b seguito: a shared mailbox or a homonym name never picks a person', () => {
  const shared = [
    { subject: 'a', displayName: 'Sara Neri', email: 'info@example.com' },
    { subject: 'b', displayName: 'Luca Blu', email: 'info@example.com' },
  ];
  assert.equal(personOf('info@example.com', shared), null, 'no misattribution on a shared mailbox');
  assert.equal(
    auditActorLabel({ actorId: 'info@example.com' }, [], shared),
    'info@example.com',
    'the honest mailbox form stays',
  );
  const homonyms = [
    { subject: 'rossi-a', displayName: 'Marco Rossi' },
    { subject: 'rossi-b', displayName: 'Marco Rossi' },
  ];
  assert.equal(personOf('Marco Rossi', homonyms), null, 'no misattribution on a homonym name');
});

test('3f3c143b seguito (review Codex su #999 P2): uniqueness across all member identities', () => {
  // Alice holds two mailboxes, Bruno shares one of them: the shared
  // mailbox is ambiguous even though no single row shows both.
  const roster = [
    { subject: 'alice-a', displayName: 'Alice', email: 'alice@example.com', operatorAccountId: 'op-alice' },
    { subject: 'alice-b', displayName: 'Alice', email: 'info@example.com', operatorAccountId: 'op-alice' },
    { subject: 'bruno', displayName: 'Bruno', email: 'info@example.com' },
  ];
  assert.equal(personOf('info@example.com', roster), null, 'shared across two people: nobody');
  assert.equal(
    auditActorLabel({ actorId: 'info@example.com' }, [], roster),
    'info@example.com',
    'the honest mailbox form stays',
  );
  // Alice's own mailbox still names her.
  assert.equal(personOf('alice@example.com', roster)?.name, 'Alice');
});
