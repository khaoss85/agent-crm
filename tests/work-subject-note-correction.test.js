import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { shapeCustomerTimeline } from '../packages/customer-hub/src/timeline.js';

/**
 * backlog:82235e46e3e9: «Modifica» and «Elimina» on a scheda note, without
 * ever rewriting a row. A correction is a later `note` row whose `revisesId`
 * names the original note; a withdrawal is one with `withdrawn: true` and no
 * body. The timeline shows the latest wording at the note's place and hides
 * a withdrawn note; every version stays on record.
 */

const OPERATOR = { type: 'user', id: 'scheda-op' };
const OTHER = { type: 'user', id: 'altra-op' };

async function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Palestra Esempio' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  });
  const other = await app.services.contacts.create({
    companyId: company.id, firstName: 'Ada', lastName: 'Rossi', email: 'ada@palestra-esempio.it',
  });
  const activities = app.modules.get('work-activity').service;
  const note = await app.recordSubjectNote({ resource: 'contact', id: contact.id, body: 'Richiamare lunedì', actor: OPERATOR });
  const rows = () => activities.listWhere({ subjectResource: 'contact', subjectId: contact.id });
  return { app, contact, other, activities, note, rows };
}

test('82235e46e3e9: a correction appends a note row naming the original; nothing is rewritten', async (t) => {
  const { app, contact, note, rows } = await scene(t);
  const revised = await app.reviseSubjectNote({
    resource: 'contact', id: contact.id, noteId: note.id, body: 'Richiamare martedì', actor: OTHER, actorRole: 'owner',
  });
  assert.equal(revised.kind, 'note');
  assert.equal(revised.revisesId, note.id);
  assert.equal(revised.body, 'Richiamare martedì');
  assert.equal(revised.actorId, 'altra-op', 'the correction carries who made it (here the space owner)');
  const all = await rows();
  assert.equal(all.length, 2, 'the original and the correction');
  assert.equal(all.find((row) => row.id === note.id).body, 'Richiamare lunedì', 'the original wording stays on record');
});

test('82235e46e3e9: a withdrawal appends one row, and a second withdrawal replays it', async (t) => {
  const { app, contact, note, rows } = await scene(t);
  const first = await app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, actor: OPERATOR });
  assert.equal(first.revisesId, note.id);
  assert.equal(first.withdrawn, true);
  assert.equal(first.body, null);
  const again = await app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, actor: OPERATOR });
  assert.equal(again.id, first.id, 'a double click withdraws once');
  assert.equal((await rows()).length, 2, 'the note and one withdrawal');
  await assert.rejects(
    () => app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: 'troppo tardi', actor: OPERATOR }),
    (error) => error?.code === 'WORK_NOTE_WITHDRAWN',
    'a withdrawn note no longer changes',
  );
});

test('82235e46e3e9: refusals — agent actor, another customer\'s note, a correction as target, empty body', async (t) => {
  const { app, contact, other, note, rows } = await scene(t);
  await assert.rejects(
    () => app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: 'x', actor: { type: 'agent', id: 'bot' } }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  await assert.rejects(
    () => app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, actor: { type: 'agent', id: 'bot' } }),
    (error) => error?.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  await assert.rejects(
    () => app.withdrawSubjectNote({ resource: 'contact', id: other.id, noteId: note.id, actor: OPERATOR }),
    (error) => error?.code === 'WORK_NOTE_NOT_FOUND',
    'a note is changed only on its own customer',
  );
  const correction = await app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: 'v2', actor: OPERATOR });
  await assert.rejects(
    () => app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: correction.id, body: 'v3', actor: OPERATOR }),
    (error) => error?.code === 'WORK_NOTE_NOT_FOUND',
    'corrections always point at the original note',
  );
  await assert.rejects(
    () => app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: '   ', actor: OPERATOR }),
    'an empty correction refuses',
  );
  await assert.rejects(
    () => app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: '', actor: OPERATOR }),
    (error) => error?.status === 400 || error?.code === 'VALIDATION_ERROR' || error?.name === 'ValidationError',
  );
  assert.equal((await rows()).length, 2, 'only the one accepted correction was written');
});

const shape = (entries) => shapeCustomerTimeline({
  profile: { identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null }, externalIdentities: [] },
  threads: [], history: { entries }, schedule: [], subject: { resource: 'contact', id: 'c1' },
});
const workNote = (fields) => ({ entry: 'work-note', kind: 'note', taskId: null, actorType: 'user', createdAt: null, revisesId: null, withdrawn: false, ...fields });

test('82235e46e3e9: the timeline shows the latest wording at the note\'s place and hides a withdrawn note', () => {
  const timeline = shape([
    workNote({ id: 'n1', body: 'Richiamare lunedì', actorId: 'elena', occurredAt: '2026-11-01T09:00:00.000Z', seq: 1 }),
    workNote({ id: 'n2', body: 'Vuole il pacchetto', actorId: 'dan', occurredAt: '2026-11-02T09:00:00.000Z', seq: 2 }),
    workNote({ id: 'r1', body: 'Richiamare martedì', actorId: 'dan', occurredAt: '2026-11-03T09:00:00.000Z', seq: 3, revisesId: 'n1' }),
    workNote({ id: 'r2', body: 'Richiamare mercoledì', actorId: 'marco', occurredAt: '2026-11-04T09:00:00.000Z', seq: 4, revisesId: 'n1' }),
    workNote({ id: 'w1', body: null, actorId: 'dan', occurredAt: '2026-11-05T09:00:00.000Z', seq: 5, revisesId: 'n2', withdrawn: true }),
  ]);
  assert.deepEqual(timeline.entries.items.map((item) => item.id), ['n1'], 'corrections are never rows; the withdrawn note is gone');
  const [note] = timeline.entries.items;
  assert.equal(note.body, 'Richiamare mercoledì', 'the latest correction wins');
  assert.equal(note.occurredAt, '2026-11-01T09:00:00.000Z', 'the note stays where it was');
  assert.equal(note.teamAuthorId, 'elena', 'signed by who wrote it');
  assert.equal(note.revisedAt, '2026-11-04T09:00:00.000Z');
  assert.equal(note.revisedBy, 'marco');
  assert.equal(timeline.entries.count, 1);
});

test('82235e46e3e9: a correction far from its note still folds when the cronologia is paged', () => {
  const mails = Array.from({ length: 30 }, (_, index) => ({
    entry: 'message', id: `m${index}`, conversationId: 't1', channel: 'email', direction: 'inbound', status: 'received',
    body: `mail ${index}`, teamAuthorId: null, remoteHandle: 'x@esempio.invalid', errorCode: null,
    occurredAt: new Date(Date.UTC(2026, 10, 2, 6, index)).toISOString(),
  }));
  const entries = [
    workNote({ id: 'n1', body: 'vecchia', actorId: 'elena', occurredAt: '2026-11-01T09:00:00.000Z', seq: 1 }),
    ...mails,
    workNote({ id: 'r1', body: 'nuova', actorId: 'elena', occurredAt: '2026-11-03T09:00:00.000Z', seq: 2, revisesId: 'n1' }),
  ];
  const paged = shapeCustomerTimeline({
    profile: { identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null }, externalIdentities: [] },
    threads: [], history: { entries }, schedule: [], subject: { resource: 'contact', id: 'c1' },
    page: { before: '2026-11-02T06:05:00.000Z|m5', limit: 10 },
  });
  const note = paged.entries.items.find((item) => item.id === 'n1');
  assert.ok(note, 'the older page holds the note');
  assert.equal(note.body, 'nuova', 'with the correction written on a later day');
  assert.ok(!paged.entries.items.some((item) => item.id === 'r1'));
});

test('82235e46e3e9: the real app shows the correction and hides the withdrawal end to end', async (t) => {
  const { app, contact, note } = await scene(t);
  const second = await app.recordSubjectNote({ resource: 'contact', id: contact.id, body: 'Da togliere', actor: OPERATOR });
  await app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: 'Richiamare martedì', actor: OPERATOR });
  await app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: second.id, actor: OPERATOR });
  // The interactions read the hub shapes, over the real work-activity rows
  // (no channel passages in this scene): the stored rows carry what the
  // fold needs, through the very mapping production reads them with.
  const { readTimeline } = await import('../packages/interactions/src/interactions.js');
  const empty = { service: { listWhere: async () => [] } };
  const modules = {
    get: (name) => (name === 'work-activity' ? app.modules.get('work-activity') : empty),
  };
  const history = await readTimeline({ modules, moduleNames: {} }, { resource: 'contact', id: contact.id, owner: 'host' });
  const timeline = shape(history.entries);
  assert.deepEqual(timeline.entries.items.filter((item) => item.entry === 'note').map((item) => [item.id, item.body]),
    [[note.id, 'Richiamare martedì']], 'the corrected note reads its new wording, the withdrawn one is gone');
});

// Owner decision 11/11: a note is corrected or withdrawn by who wrote it or
// by the space owner; any other member who may write records gets a clear 403.
test('82235e46e3e9: the writer can change the note, the owner can, another member gets WORK_NOTE_NOT_AUTHOR', async (t) => {
  const { app, contact, note, rows } = await scene(t);
  const notAuthor = (error) => error?.code === 'WORK_NOTE_NOT_AUTHOR' && error?.status === 403;
  for (const role of [null, 'member', 'manager', 'administrator']) {
    await assert.rejects(
      () => app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: 'no', actor: OTHER, actorRole: role }),
      notAuthor, `a ${role ?? 'roleless'} member who did not write the note cannot correct it`,
    );
    await assert.rejects(
      () => app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, actor: OTHER, actorRole: role }),
      notAuthor, `nor withdraw it (${role ?? 'roleless'})`,
    );
  }
  assert.equal((await rows()).length, 1, 'the refusals wrote nothing');
  const byWriter = await app.reviseSubjectNote({ resource: 'contact', id: contact.id, noteId: note.id, body: 'dal suo autore', actor: OPERATOR, actorRole: 'member' });
  assert.equal(byWriter.revisesId, note.id, 'the writer can, whatever the role');
  const second = await app.recordSubjectNote({ resource: 'contact', id: contact.id, body: 'di scheda-op', actor: OPERATOR });
  const byOwner = await app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: second.id, actor: OTHER, actorRole: 'owner' });
  assert.equal(byOwner.withdrawn, true, 'the space owner can withdraw anyone\'s note');
  await assert.rejects(
    () => app.withdrawSubjectNote({ resource: 'contact', id: contact.id, noteId: second.id, actor: OTHER, actorRole: 'member' }),
    notAuthor, 'the replay of a withdrawal answers only who could have made it',
  );
});

// ---- review Muse #839 (giro 1) ---------------------------------------------

test('review Muse #839 (P2): two corrections in the same millisecond — the later seq wins, whatever the row order', () => {
  const at = '2026-11-03T09:00:00.000Z';
  const rows = [
    workNote({ id: 'n1', body: 'originale', actorId: 'elena', occurredAt: '2026-11-01T09:00:00.000Z', seq: 1 }),
    workNote({ id: 'r2', body: 'seconda', actorId: 'dan', occurredAt: at, seq: 1_000_002, revisesId: 'n1' }),
    workNote({ id: 'r1', body: 'prima', actorId: 'dan', occurredAt: at, seq: 1_000_001, revisesId: 'n1' }),
  ];
  for (const order of [rows, [rows[0], rows[2], rows[1]]]) {
    const [note] = shape(order).entries.items;
    assert.equal(note.body, 'seconda', 'the higher seq of the same instant wins, in either row order');
  }
  const unsequenced = shape([
    rows[0],
    workNote({ id: 'r3', body: 'con seq', actorId: 'dan', occurredAt: at, seq: 3, revisesId: 'n1' }),
    workNote({ id: 'r4', body: 'senza seq', actorId: 'dan', occurredAt: at, seq: null, revisesId: 'n1' }),
  ]);
  assert.equal(unsequenced.entries.items[0].body, 'con seq', 'a row without seq orders first');
});

/**
 * The note operations over an in-memory activity store whose reads can be
 * scripted, so an interleaving is a test step, never a timing accident.
 */
async function scriptedNotes({ onListSourceKey = null, onGet = null } = {}) {
  const { buildReviseSubjectNoteOperation, buildWithdrawSubjectNoteOperation } = await import('../packages/work/src/index.js');
  const rows = [{
    id: 'n1', kind: 'note', subjectResource: 'contact', subjectId: 'c1', taskId: null, body: 'Richiamare',
    actorType: 'user', actorId: OPERATOR.id, occurredAt: '2026-11-01T09:00:00.000Z', seq: 1, revisesId: null, withdrawn: null, sourceKey: null,
  }];
  const activities = {
    rows,
    async get(id) {
      if (onGet) return onGet(id, rows);
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw Object.assign(new Error('missing'), { status: 404, name: 'NotFoundError' });
      return row;
    },
    async listWhere(where) {
      if (typeof where.sourceKey === 'string' && onListSourceKey) {
        const scripted = await onListSourceKey(where.sourceKey, rows);
        if (scripted !== undefined) return scripted;
      }
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async createManaged(row) {
      if (row.sourceKey && rows.some((candidate) => candidate.sourceKey === row.sourceKey)) {
        throw Object.assign(new Error('duplicate'), { code: 'UNIQUE_CONSTRAINT', status: 409, name: 'ConflictError' });
      }
      const stored = { id: `a${rows.length + 1}`, ...row };
      rows.push(stored);
      return stored;
    },
  };
  const runtime = { modules: { get: (name) => (name === 'work-activity' ? { service: activities } : null) } };
  return {
    rows,
    revise: buildReviseSubjectNoteOperation().create(runtime),
    withdraw: buildWithdrawSubjectNoteOperation().create(runtime),
  };
}

test('review Muse #839 (P2): a withdrawal that lands between the replay read and the note read replays the winner, never 409', async () => {
  let reads = 0;
  const winner = { id: 'w-a', kind: 'note', subjectResource: 'contact', subjectId: 'c1', sourceKey: 'note-withdrawal:n1', revisesId: 'n1', withdrawn: true, body: null };
  const scripted = await scriptedNotes({
    // B's first replay read sees nothing; A's withdrawal lands right after.
    onListSourceKey: (key, rows) => {
      reads += 1;
      if (reads === 1) {
        rows.push(winner);
        return [];
      }
      return undefined;
    },
  });
  const answer = await scripted.withdraw({ resource: 'contact', id: 'c1', noteId: 'n1', actor: OPERATOR });
  assert.equal(answer.id, 'w-a', 'B answers the winner\'s withdrawal');
  assert.equal(scripted.rows.filter((row) => row.withdrawn === true).length, 1, 'one withdrawal on record');
});

test('review Muse #839 (P2): the withdrawal replay never masks a store failure, and a missing original is NOT_FOUND for the owner too', async () => {
  const withdrawal = { id: 'w-a', kind: 'note', subjectResource: 'contact', subjectId: 'c1', sourceKey: 'note-withdrawal:n1', revisesId: 'n1', withdrawn: true, body: null };
  const failing = await scriptedNotes({ onGet: () => { throw Object.assign(new Error('connection reset'), { code: 'STORAGE_DOWN', status: 503 }); } });
  failing.rows.push(withdrawal);
  await assert.rejects(
    () => failing.withdraw({ resource: 'contact', id: 'c1', noteId: 'n1', actor: OTHER }),
    (error) => error?.code === 'STORAGE_DOWN',
    'a store failure stays the store\'s error, never WORK_NOTE_NOT_AUTHOR',
  );
  const missing = await scriptedNotes({ onGet: () => { throw Object.assign(new Error('missing'), { status: 404, name: 'NotFoundError' }); } });
  missing.rows.push(withdrawal);
  for (const [actor, actorRole] of [[OTHER, undefined], [OTHER, 'owner'], [OPERATOR, undefined]]) {
    await assert.rejects(
      () => missing.withdraw({ resource: 'contact', id: 'c1', noteId: 'n1', actor, actorRole }),
      (error) => error?.code === 'WORK_NOTE_NOT_FOUND' && error?.status === 404,
      'an unverified original answers NOT_FOUND, never NOT_AUTHOR, never an owner bypass',
    );
  }
});

test('review Muse #839 (P2): a withdrawal that lands while a correction is on its way wins — no correction after it', async () => {
  let reads = 0;
  const scripted = await scriptedNotes({
    // The correction's first withdrawn check sees nothing; the withdrawal
    // lands before its insert.
    onListSourceKey: (key, rows) => {
      reads += 1;
      if (reads === 1) {
        rows.push({ id: 'w-a', kind: 'note', subjectResource: 'contact', subjectId: 'c1', sourceKey: 'note-withdrawal:n1', revisesId: 'n1', withdrawn: true, body: null });
        return [];
      }
      return undefined;
    },
  });
  await assert.rejects(
    () => scripted.revise({ resource: 'contact', id: 'c1', noteId: 'n1', body: 'troppo tardi', actor: OPERATOR }),
    (error) => error?.code === 'WORK_NOTE_WITHDRAWN' && error?.status === 409,
  );
  assert.equal(scripted.rows.filter((row) => row.body === 'troppo tardi').length, 0, 'no correction written after the withdrawal');
});
