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

function stubApp({ notes = [], withRecordNote = true } = {}) {
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
