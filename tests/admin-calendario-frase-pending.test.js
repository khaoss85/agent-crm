import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, PHRASE_RESUME_ROUNDS } from '../apps/admin/public/admin-calendario.js';
import { pendingRequestId } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Production 07/11 (release 3c3059e, 21:42Z): the first «Trova slot liberi»
 * POST answered 504 BO_PHRASE_PENDING after 51.9 s with an English message,
 * and the card said «Ricerca non riuscita» without retrying — while a GET
 * with the returned requestId answered the ready draft in 0.3 s. The card
 * now keeps «Sto cercando…», reads the same request back every 3 s for
 * about a minute, and past that says it is slow with a Riprova that reads
 * the same request again — never a second POST, never the English text.
 */

const ENGLISH = 'Calendar phrase pending: poll ?requestId, do not resubmit';
const DRAFT = { teamMemberId: 'marco', startsAt: '2026-10-22T12:00:00.000Z', endsAt: '2026-10-22T12:30:00.000Z' };
const pending = () => Object.assign(new Error(ENGLISH), { status: 504, code: 'BO_PHRASE_PENDING', requestId: 'req-1' });

/** @param {{readyAfter?: number}} options reads that stay pending before the draft is ready */
function phraseClient({ readyAfter = 1 } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') throw pending();
      if (path.startsWith('/api/appointments/phrase?requestId=')) {
        const reads = calls.filter((call) => call.path.startsWith('/api/appointments/phrase?requestId=')).length;
        if (reads < readyAfter) throw pending();
        return { draft: DRAFT, dryRun: false, spaceId: 'locale' };
      }
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) return { members: [{ teamMemberId: 'marco', appointments: [] }] };
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { members: [{ teamMemberId: 'marco', slots: [{ startsAt: '2026-10-22T13:00:00.000Z', endsAt: '2026-10-22T13:30:00.000Z' }] }] };
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 12) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const posts = (client) => client.calls.filter((call) => call.path === '/api/appointments/phrase' && call.method === 'POST');
const reads = (client) => client.calls.filter((call) => call.path.startsWith('/api/appointments/phrase?requestId='));

async function search(view, mount) {
  await view.render();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con marco giovedì';
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
}

test('pendingRequestId reads any *_PENDING code carrying a requestId', () => {
  assert.equal(pendingRequestId(pending()), 'req-1');
  assert.equal(pendingRequestId({ code: 'BO_DRAFT_PENDING', requestId: 'r2' }), 'r2');
  assert.equal(pendingRequestId({ code: 'BO_PHRASE_PENDING' }), null, 'no id, nothing to read back');
  assert.equal(pendingRequestId({ code: 'BO_PHRASE_STATUS_FAILED', requestId: 'r3' }), null);
});

test('a queued phrase says «Sto cercando…» while it is read back', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient();
  const view = createCalendarioView({ doc, mount, client, wait: () => new Promise(() => {}), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush();
  assert.ok(mount.textContent.includes('Sto cercando… la risposta arriva tra poco.'), 'the card keeps searching');
  assert.ok(!mount.textContent.includes('Ricerca non riuscita'));
  assert.ok(!mount.textContent.includes(ENGLISH), 'never the English server message');
});

test('a queued phrase is read back with its requestId and shows the draft and the slots', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ readyAfter: 3 });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush(30);
  assert.equal(posts(client).length, 1, 'one POST only');
  assert.equal(reads(client).length, 3, 'read back until ready');
  assert.ok(reads(client).every((call) => call.path.endsWith('requestId=req-1')));
  assert.ok(mount.querySelector('.cal-draft'), 'the ready draft paints');
  assert.ok(mount.querySelector('.cal-slots'), 'and its slots');
  assert.ok(!mount.textContent.includes('Ricerca non riuscita'));
  assert.ok(!mount.textContent.includes(ENGLISH));
});

test('a phrase still queued after a minute says so in Italian, and Riprova reads the same request again', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ readyAfter: PHRASE_RESUME_ROUNDS + 1 });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush(120);
  assert.equal(reads(client).length, PHRASE_RESUME_ROUNDS, 'every 3 s for about a minute');
  assert.ok(mount.textContent.includes('La ricerca sta impiegando più del previsto.'), mount.textContent);
  assert.ok(!mount.textContent.includes('Ricerca non riuscita'), 'never «non riuscita» on an answer that may be ready');
  assert.ok(!mount.textContent.includes(ENGLISH), 'never the English server message');
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'phrase-resume');
  assert.ok(retry, 'Riprova is offered');
  assert.equal(retry.textContent, 'Riprova');
  retry.dispatch('click');
  await flush(30);
  assert.equal(posts(client).length, 1, 'Riprova never POSTs the phrase again');
  assert.equal(reads(client).length, PHRASE_RESUME_ROUNDS + 1);
  assert.ok(reads(client).at(-1).path.endsWith('requestId=req-1'), 'the same request id');
  assert.ok(mount.querySelector('.cal-draft'), 'the draft paints once ready');
});
