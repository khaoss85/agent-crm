import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHttpServer,
} from '../apps/server/src/http-server.js';
import { NotFoundError } from '../packages/core/src/errors.js';
import { bounds, safeText } from '../packages/work/src/follow-up.js';

/**
 * Nuovo cliente «Salva con nota» (backlog:aaa36cd07cd4).
 *
 * Production 07/11: POST /customer-hub/notes answered 400
 * BO_CRM_BODY_REFUSED and the screen showed no error. The framework fix
 * (text -> body, plus the Italian refusal warning beside the form) rides
 * main since PR 654; the verifier reopened the item on 09/11.
 *
 * What this must prove against the real route: the request body the Nuovo
 * cliente writer posts ({ resource, id, body }) is accepted by the server
 * (201) and reaches recordSubjectNote with the session actor; the old
 * `text` shape refuses 400 and writes nothing; a note on a ghost record
 * refuses with the record's own 404; without the work package composed the
 * honest 404 names the operation.
 *
 * A stub app keeps this instant and deterministic: no sqlite, no provider.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-type': 'user',
  'x-actor-id': 'nota-route',
};

function stubApp({ notes = [], withRecordNote = true, withEditNote = true, withDeleteNote = true } = {}) {
  return {
    services: {
      contacts: { get: async (id) => { if (id !== 'c1') throw new NotFoundError('contact', String(id)); return { id: 'c1' }; } },
      companies: { get: async (id) => { throw new NotFoundError('company', String(id)); } },
    },
    ...(withRecordNote ? {
      async recordSubjectNote(params) {
        // The framework's own validation, not a re-implementation: the
        // route test proves the wire, safeText proves the body contract.
        const body = safeText(params?.body, 'body', bounds.noteBody);
        notes.push({ ...params, body });
        return { id: 'n1', kind: 'note', body };
      },
    } : {}),
    ...(withEditNote ? {
      async editSubjectNote(params) {
        const body = safeText(params?.body, 'body', bounds.noteBody);
        if (params?.noteId !== 'n1') throw new NotFoundError('subject note', String(params?.noteId ?? ''));
        notes.push({ ...params, body });
        return { id: 'n1', kind: 'note', body };
      },
    } : {}),
    ...(withDeleteNote ? {
      async deleteSubjectNote(params) {
        if (params?.noteId !== 'n1') throw new NotFoundError('subject note', String(params?.noteId ?? ''));
        notes.push({ ...params });
        return { id: 'n1', kind: 'note', body: null };
      },
    } : {}),
  };
}

async function request(t, app, method, path, body) {
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

const NOTE_BASE = { resource: 'contact', id: 'c1', body: 'Ci ha conosciuti in palestra.' };

test('aaa36cd07cd4: POST notes accepts the writer body and answers 201', async (t) => {
  const notes = [];
  const { status, payload } = await request(t, stubApp({ notes }), 'POST', '/api/customer-hub/notes', NOTE_BASE);
  assert.equal(status, 201);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].resource, 'contact');
  assert.equal(notes[0].id, 'c1');
  assert.equal(notes[0].body, 'Ci ha conosciuti in palestra.');
  assert.equal(notes[0].actor?.type, 'user', 'the human actor travels to the operation');
  assert.equal(notes[0].actor?.id, 'nota-route');
  assert.equal(payload?.id, 'n1');
});

test('aaa36cd07cd4: a body actor is stripped, the session actor records', async (t) => {
  const notes = [];
  const { status } = await request(t, stubApp({ notes }), 'POST', '/api/customer-hub/notes', {
    ...NOTE_BASE, actor: { type: 'user', id: 'someone-else' },
  });
  assert.equal(status, 201);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].actor?.id, 'nota-route',
    'authorship is server-derived from the session, never a caller claim');
});

test('aaa36cd07cd4: the old `text` shape refuses 400 and writes nothing', async (t) => {
  const notes = [];
  const { status, payload } = await request(t, stubApp({ notes }), 'POST', '/api/customer-hub/notes', {
    resource: 'contact', id: 'c1', text: 'Ci ha conosciuti in palestra.',
  });
  assert.equal(status, 400, 'a body without `body` is not a note');
  assert.equal(notes.length, 0, 'a refused note writes nothing');
  assert.match(String(payload?.error?.message ?? ''), /body/i);
});

test('aaa36cd07cd4: a note on a ghost record refuses 404 and never reaches the operation', async (t) => {
  const notes = [];
  const { status } = await request(t, stubApp({ notes }), 'POST', '/api/customer-hub/notes', {
    ...NOTE_BASE, id: 'c-ghost',
  });
  assert.equal(status, 404);
  assert.equal(notes.length, 0, 'no row is written for a record that does not exist');
});

test('aaa36cd07cd4: without the operation composed the honest 404 names it', async (t) => {
  const { status, payload } = await request(t, stubApp({ withRecordNote: false }), 'POST', '/api/customer-hub/notes', NOTE_BASE);
  assert.equal(status, 404);
  assert.match(String(payload?.error?.message ?? ''), /subject note/);
});

test('aaa36cd07cd4: a non contact/company resource refuses 400', async (t) => {
  const notes = [];
  const { status } = await request(t, stubApp({ notes }), 'POST', '/api/customer-hub/notes', {
    ...NOTE_BASE, resource: 'lead',
  });
  assert.equal(status, 400);
  assert.equal(notes.length, 0);
});

/**
 * Voce 82235e46e3e9 (giro 2, VERIFIER_BACK on #793): the scheda's
 * Modifica and Elimina reach the composed operations with the session
 * actor; without them the honest 404 names the operation. A stub app
 * keeps this instant: no sqlite, no provider.
 */

test('82235e46e3e9: PATCH edits the note and answers 200', async (t) => {
  const notes = [];
  const { status, payload } = await request(t, stubApp({ notes }), 'PATCH', '/api/customer-hub/notes/n1', {
    resource: 'contact', id: 'c1', body: 'Richiamare martedì.',
  });
  assert.equal(status, 200);
  assert.equal(payload?.body, 'Richiamare martedì.');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].noteId, 'n1', 'the note id travels in the path, not the body');
  assert.equal(notes[0].actor?.id, 'nota-route', 'authorship is server-derived, never a caller claim');
});

test('82235e46e3e9: PATCH without a body refuses 400 and writes nothing', async (t) => {
  const notes = [];
  const { status } = await request(t, stubApp({ notes }), 'PATCH', '/api/customer-hub/notes/n1', {
    resource: 'contact', id: 'c1',
  });
  assert.equal(status, 400);
  assert.equal(notes.length, 0);
});

test('82235e46e3e9: PATCH on a ghost note or ghost record refuses 404', async (t) => {
  const notes = [];
  const ghostNote = await request(t, stubApp({ notes }), 'PATCH', '/api/customer-hub/notes/n9', {
    resource: 'contact', id: 'c1', body: 'x',
  });
  assert.equal(ghostNote.status, 404);
  const ghostRecord = await request(t, stubApp({ notes }), 'PATCH', '/api/customer-hub/notes/n1', {
    resource: 'contact', id: 'c-ghost', body: 'x',
  });
  assert.equal(ghostRecord.status, 404);
  assert.equal(notes.length, 0);
});

test('82235e46e3e9: PATCH without the operation composed names it in the 404', async (t) => {
  const { status, payload } = await request(t, stubApp({ withEditNote: false }), 'PATCH', '/api/customer-hub/notes/n1', {
    resource: 'contact', id: 'c1', body: 'x',
  });
  assert.equal(status, 404);
  assert.match(String(payload?.error?.message ?? ''), /subject note edit/);
});

test('82235e46e3e9: DELETE eliminates the note and answers 200', async (t) => {
  const notes = [];
  const { status, payload } = await request(
    t, stubApp({ notes }), 'DELETE', '/api/customer-hub/notes/n1?resource=contact&id=c1',
  );
  assert.equal(status, 200);
  assert.equal(payload?.body, null, 'the tombstone, not a removed row');
  assert.equal(notes.length, 1);
  assert.deepEqual([notes[0].resource, notes[0].id, notes[0].noteId], ['contact', 'c1', 'n1']);
  assert.equal(notes[0].actor?.id, 'nota-route');
});

test('82235e46e3e9: DELETE without a subject or on a ghost refuses and writes nothing', async (t) => {
  const notes = [];
  const noSubject = await request(t, stubApp({ notes }), 'DELETE', '/api/customer-hub/notes/n1');
  assert.equal(noSubject.status, 400);
  const ghost = await request(
    t, stubApp({ notes }), 'DELETE', '/api/customer-hub/notes/n1?resource=contact&id=c-ghost',
  );
  assert.equal(ghost.status, 404);
  const ghostNote = await request(
    t, stubApp({ notes }), 'DELETE', '/api/customer-hub/notes/n9?resource=contact&id=c1',
  );
  assert.equal(ghostNote.status, 404);
  assert.equal(notes.length, 0);
});

test('82235e46e3e9: DELETE without the operation composed names it in the 404', async (t) => {
  const { status, payload } = await request(
    t, stubApp({ withDeleteNote: false }), 'DELETE', '/api/customer-hub/notes/n1?resource=contact&id=c1',
  );
  assert.equal(status, 404);
  assert.match(String(payload?.error?.message ?? ''), /subject note delete/);
});
