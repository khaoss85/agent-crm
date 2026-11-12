import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Voce 714433c2: the scheda cliente's "Aggiungi nota".
 *
 * What it must prove: an operator note lands as a `work-activity` row of
 * kind `note` on the customer subject — the same row, kind and human-actor
 * boundary as the task `add-note` action, but with no task (taskId null),
 * because a customer note is a statement about the subject, not about a
 * follow-up. It carries no idempotency key: two identical notes are two
 * statements. An agent actor and a bad subject refuse.
 */

const OPERATOR = { type: 'user', id: 'scheda-op' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  assert.equal(typeof app.recordSubjectNote, 'function', 'the work package offers the note operation');
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti',
    email: 'guido@palestra-esempio.it',
  });
  const activities = app.modules.get('work-activity').service;
  return { app, contact, activities };
}

test('a note records kind, subject and body, readable beside the subject', async (t) => {
  const { app, contact, activities } = await scene(t);
  const recorded = await app.recordSubjectNote({
    resource: 'contact', id: contact.id, body: 'Preferisce allenarsi la sera.', actor: OPERATOR,
  });
  assert.equal(recorded.kind, 'note');
  assert.equal(recorded.taskId, null, 'a customer note belongs to no task');
  assert.equal(recorded.subjectResource, 'contact');
  assert.equal(recorded.subjectId, contact.id);
  assert.equal(recorded.body, 'Preferisce allenarsi la sera.');
  const rows = await activities.listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.equal(rows.length, 1, 'exactly one timeline row');
  assert.equal(rows[0].body, 'Preferisce allenarsi la sera.');

  const again = await app.recordSubjectNote({
    resource: 'contact', id: contact.id, body: 'Preferisce allenarsi la sera.', actor: OPERATOR,
  });
  assert.notEqual(again.id, recorded.id, 'two identical notes are two statements, no dedup key');
  const both = await activities.listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.equal(both.length, 2, 'both statements persist');
});

test('an agent actor, a bad subject and an empty body refuse', async (t) => {
  const { app, contact, activities } = await scene(t);
  await assert.rejects(
    () => app.recordSubjectNote({
      resource: 'contact', id: contact.id, body: 'nota', actor: { type: 'agent', id: 'bot' },
    }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
    'a note is a human decision, like the task add-note action',
  );
  await assert.rejects(
    () => app.recordSubjectNote({ resource: 'lead', id: contact.id, body: 'nota', actor: OPERATOR }),
    (error) => error?.code === 'WORK_NOTE_SUBJECT_INVALID',
    'only contact and company subjects take notes',
  );
  await assert.rejects(
    () => app.recordSubjectNote({ resource: 'contact', id: contact.id, body: '   ', actor: OPERATOR }),
    'an empty note refuses',
  );
  const rows = await activities.listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.equal(rows.length, 0, 'a refused note writes nothing');
});

/**
 * Voce 82235e46e3e9 (giro 2, VERIFIER_BACK on #793): the scheda's
 * Modifica and Elimina on a note. An edit corrects the row in place
 * through the managed write — one statement per note, writer unchanged —
 * and a delete clears the text leaving the tombstone the scheda reads as
 * «Nota eliminata». Ghost, foreign and lifecycle rows refuse.
 */

test('an edit corrects the note in place, keeping its writer', async (t) => {
  const { app, contact, activities } = await scene(t);
  assert.equal(typeof app.editSubjectNote, 'function', 'the work package offers the edit operation');
  assert.equal(typeof app.deleteSubjectNote, 'function', 'the work package offers the delete operation');
  const recorded = await app.recordSubjectNote({
    resource: 'contact', id: contact.id, body: 'Richiamare lunedì.', actor: OPERATOR,
  });
  const edited = await app.editSubjectNote({
    resource: 'contact', id: contact.id, noteId: recorded.id, body: 'Richiamare martedì.', actor: OPERATOR,
  });
  assert.equal(edited.id, recorded.id, 'no second row');
  assert.equal(edited.body, 'Richiamare martedì.');
  assert.equal(edited.actorId, 'scheda-op', 'an edit fixes the text, it does not re-sign it');
  const rows = await activities.listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.equal(rows.length, 1, 'the cronologia keeps one statement per note');
});

test('a delete clears the text and repeats as a no-op', async (t) => {
  const { app, contact, activities } = await scene(t);
  const recorded = await app.recordSubjectNote({
    resource: 'contact', id: contact.id, body: 'Da togliere.', actor: OPERATOR,
  });
  const deleted = await app.deleteSubjectNote({
    resource: 'contact', id: contact.id, noteId: recorded.id, actor: OPERATOR,
  });
  assert.equal(deleted.id, recorded.id, 'the row stays, only its text goes');
  assert.equal(deleted.body, null, 'the tombstone the scheda reads as eliminated');
  const rows = await activities.listWhere({ subjectResource: 'contact', subjectId: contact.id });
  assert.equal(rows.length, 1, 'elimination removes no row: the framework has no storage delete');
  const again = await app.deleteSubjectNote({
    resource: 'contact', id: contact.id, noteId: recorded.id, actor: OPERATOR,
  });
  assert.equal(again.body, null, 'repeating the delete changes nothing');
  await assert.rejects(
    () => app.editSubjectNote({
      resource: 'contact', id: contact.id, noteId: recorded.id, body: 'Torna.', actor: OPERATOR,
    }),
    (error) => error?.code === 'WORK_NOTE_DELETED',
    'an eliminated note is history, not a draft',
  );
});

test('ghost, foreign and lifecycle rows refuse the note change', async (t) => {
  const { app, contact, activities } = await scene(t);
  await assert.rejects(
    () => app.editSubjectNote({
      resource: 'contact', id: contact.id, noteId: 'nota-fantasma', body: 'x', actor: OPERATOR,
    }),
    (error) => error?.status === 404,
    'a ghost note id refuses with the record 404',
  );
  const other = await app.services.contacts.create({
    companyId: contact.companyId, firstName: 'Altro', lastName: 'Cliente', email: 'altro@esempio.it',
  });
  const recorded = await app.recordSubjectNote({
    resource: 'contact', id: contact.id, body: 'Solo di Guido.', actor: OPERATOR,
  });
  await assert.rejects(
    () => app.editSubjectNote({
      resource: 'contact', id: other.id, noteId: recorded.id, body: 'Rubata.', actor: OPERATOR,
    }),
    (error) => error?.status === 404,
    'a note of another customer is not found from this subject',
  );
  const lifecycle = await activities.createManaged({
    sourceKey: `giro2-lifecycle:${contact.id}`,
    kind: 'task_created',
    subjectResource: 'contact',
    subjectId: contact.id,
    taskId: 't-giro2',
    body: null,
    occurredAt: '2026-11-10T09:00:00.000Z',
    actorType: 'user',
    actorId: 'scheda-op',
    sourcePackage: 'work',
    sourceAction: 'test',
    seq: 1,
  }, { actor: OPERATOR });
  await assert.rejects(
    () => app.deleteSubjectNote({
      resource: 'contact', id: contact.id, noteId: lifecycle.id, actor: OPERATOR,
    }),
    (error) => error?.code === 'WORK_NOTE_NOT_EDITABLE',
    'task lifecycle rows stay as written',
  );
  const intact = await activities.get(recorded.id);
  assert.equal(intact.body, 'Solo di Guido.', 'refused changes write nothing');
});
