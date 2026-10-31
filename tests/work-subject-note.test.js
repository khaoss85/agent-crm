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
