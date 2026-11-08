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

/**
 * @param {{readyAfter?: number, readFailures?: Array<any>, postError?: any}} options reads that stay
 *   pending before the draft is ready; errors the first reads throw instead; the POST's own refusal
 */
function phraseClient({ readyAfter = 1, readFailures = [], postError = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') throw postError ?? pending();
      if (path.startsWith('/api/appointments/phrase?requestId=')) {
        const reads = calls.filter((call) => call.path.startsWith('/api/appointments/phrase?requestId=')).length;
        if (reads <= readFailures.length) throw readFailures[reads - 1];
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

test('pendingRequestId reads only the route own queued code with a requestId (review #664)', () => {
  assert.equal(pendingRequestId(pending(), 'BO_PHRASE_PENDING'), 'req-1');
  assert.equal(pendingRequestId({ code: 'BO_DRAFT_PENDING', requestId: 'r2' }, 'BO_DRAFT_PENDING'), 'r2');
  assert.equal(pendingRequestId({ code: 'BO_DRAFT_PENDING', requestId: 'r2' }, 'BO_PHRASE_PENDING'), null, 'another route code is not ours');
  assert.equal(pendingRequestId({ code: 'BO_CLAIM_PENDING', requestId: 'r4' }, 'BO_PHRASE_PENDING'), null, 'an unrelated *_PENDING stays a refusal');
  assert.equal(pendingRequestId({ code: 'BO_PHRASE_PENDING' }, 'BO_PHRASE_PENDING'), null, 'no id, nothing to read back');
  assert.equal(pendingRequestId({ code: 'BO_PHRASE_STATUS_FAILED', requestId: 'r3' }, 'BO_PHRASE_PENDING'), null);
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

// Review #664 P1: one transient read failure ended the resume with «Ricerca
// non riuscita» and lost the requestId.
test('a transient read-back failure keeps reading the same request', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    readyAfter: 3,
    readFailures: [
      Object.assign(new Error('Gateway Timeout'), { status: 504, code: 'UNKNOWN' }),
      new TypeError('Failed to fetch'),
    ],
  });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush(40);
  assert.equal(posts(client).length, 1, 'never a second POST');
  assert.equal(reads(client).length, 3, 'read again after the hiccups');
  assert.ok(reads(client).every((call) => call.path.endsWith('requestId=req-1')));
  assert.ok(mount.querySelector('.cal-draft'), 'the ready draft paints');
  assert.ok(!mount.textContent.includes('Ricerca non riuscita'));
});

test('a final refusal during the read-back ends it in Italian (AI off)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    readyAfter: 5,
    readFailures: [Object.assign(new Error('Calendar phrase refused'), { status: 502, code: 'LLM_SPACE_DISABLED' })],
  });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush(30);
  assert.equal(reads(client).length, 1, 'AI off is final, not read again');
  assert.ok(mount.textContent.includes('L’AI è spenta in questo spazio'), mount.textContent);
  assert.ok(!mount.textContent.includes('Calendar phrase refused'));
});

// Review #664 P2: Riprova resumed the old request under the live, edited phrase.
test('Riprova resumes the request with the phrase that asked it, not a later edit', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ readyAfter: PHRASE_RESUME_ROUNDS + 1 });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush(120);
  const field = mount.querySelector('textarea[name="phrase"]');
  field.value = 'trova 60 minuti con sara venerdì';
  field.dispatch('input');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'phrase-resume').dispatch('click');
  await flush(30);
  assert.equal(posts(client).length, 1, 'the edit is not POSTed by Riprova');
  assert.equal(mount.querySelector('textarea[name="phrase"]').value, 'trova 30 minuti con marco giovedì',
    'the draft paints under the phrase that asked it');
});

// Review #664 P2: only the route's queued code is a queue.
test('an unrelated *_PENDING refusal on the POST is never read back', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    postError: Object.assign(new Error('Claim pending elsewhere'), { status: 409, code: 'BO_CLAIM_PENDING', requestId: 'trace-1' }),
  });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush(20);
  assert.equal(reads(client).length, 0, 'no read-back loop on a refusal');
  assert.ok(!mount.textContent.includes('Sto cercando'), 'the card does not pretend to wait');
  assert.ok(!mount.textContent.includes('Claim pending elsewhere'), 'never the English message');
});

// Review #664 round 2 P1: a route away during the POST, then a 504 pending,
// repainted the calendar over the new screen.
test('a route away during the POST never repaints the waiting card over the new screen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let rejectPost = () => {};
  const base = phraseClient();
  const client = {
    calls: base.calls,
    request(path, options = {}) {
      if (path === '/api/appointments/phrase' && (options.method ?? 'GET') === 'POST') {
        base.calls.push({ path, method: 'POST' });
        return new Promise((resolve, reject) => { rejectPost = reject; });
      }
      return base.request(path, options);
    },
  };
  const view = createCalendarioView({ doc, mount, client, wait: () => new Promise(() => {}), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush();
  // The shell routes away: it drops the calendar and paints another screen.
  view.invalidate();
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const other = doc.createElement('div');
  other.setAttribute('data-screen', 'clienti');
  mount.appendChild(other);
  rejectPost(pending());
  await flush();
  assert.equal(mount.querySelector('.cal-wrap'), null, 'the calendar never repaints');
  assert.ok(mount.findAll('div').some((node) => node.getAttribute('data-screen') === 'clienti'), 'the new screen stays');
  assert.equal(reads(client).length, 0, 'and nothing is read back for a screen that is gone');
});

// Review #664 round 2 P2: a status-less exception that is not a network
// fault is final — never retried for a minute and called «still queued».
test('a status-less read-back bug is final, never passed off as a slow request', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ readyAfter: 5, readFailures: [new Error('Unexpected token < in JSON')] });
  const view = createCalendarioView({ doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => { warned.push(args); };
  try {
    await search(view, mount);
    await flush(30);
  } finally {
    console.warn = original;
  }
  assert.equal(reads(client).length, 1, 'read once, not for a minute');
  assert.ok(!mount.textContent.includes('sta impiegando più del previsto'), 'not called slow');
  assert.ok(mount.textContent.includes('Ricerca non riuscita'), 'the honest failure');
  assert.ok(!mount.textContent.includes('Unexpected token'), 'never the raw message');
  assert.ok(warned.some(([label]) => label === '[bo] rilettura in coda rifiutata'), 'the cause is logged');
});

// Review #664 round 2 P2: a final read-back refusal logs its cause with the
// request and the space.
test('a final 5xx read-back refusal is logged with code, request and space', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const kept = new Map();
  const storage = {
    getItem: (key) => (key === 'accordo.activeSpace' ? 'space-9' : kept.get(key) ?? null),
    setItem: (key, value) => { kept.set(key, String(value)); },
    removeItem: (key) => { kept.delete(key); },
  };
  const client = phraseClient({
    readyAfter: 5,
    readFailures: [Object.assign(new Error('Calendar phrase refused'), { status: 502, code: 'BO_PHRASE_OUTCOME_UNKNOWN' })],
  });
  const view = createCalendarioView({ doc, mount, client, storage, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => { warned.push(args); };
  try {
    await search(view, mount);
    await flush(30);
  } finally {
    console.warn = original;
  }
  const line = warned.find(([label]) => label === '[bo] rilettura in coda rifiutata');
  assert.ok(line, 'the final refusal is logged');
  assert.deepEqual(line[1], { code: 'BO_PHRASE_OUTCOME_UNKNOWN', status: 502, requestId: 'req-1', spaceId: 'space-9' });
  assert.ok(!mount.textContent.includes('Calendar phrase refused'), 'never the English message');
});

// Review #664 round 2 P3: an edit while the answer is on its way never
// relabels the draft.
test('an edit during the read-back never paints the draft under other words', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseWait = () => {};
  let first = true;
  const client = phraseClient({ readyAfter: 1 });
  const wait = () => {
    if (!first) return Promise.resolve();
    first = false;
    return new Promise((resolve) => { releaseWait = resolve; });
  };
  const view = createCalendarioView({ doc, mount, client, wait, now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush();
  const field = mount.querySelector('textarea[name="phrase"]');
  field.value = 'trova 60 minuti con sara venerdì';
  field.dispatch('input');
  releaseWait();
  await flush(30);
  assert.ok(mount.querySelector('.cal-draft'), 'the asked draft paints');
  assert.equal(mount.querySelector('textarea[name="phrase"]').value, 'trova 30 minuti con marco giovedì');
});

// Review #664 round 3 P1: an edit during the read-back went into the queued
// request, so Riprova resumed it under the edited words.
test('an edit during the read-back never becomes the phrase Riprova resumes with', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseWait = () => {};
  let first = true;
  const client = phraseClient({ readyAfter: PHRASE_RESUME_ROUNDS + 1 });
  const wait = () => {
    if (!first) return Promise.resolve();
    first = false;
    return new Promise((resolve) => { releaseWait = resolve; });
  };
  const view = createCalendarioView({ doc, mount, client, wait, now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush();
  const field = mount.querySelector('textarea[name="phrase"]');
  field.value = 'trova 60 minuti con sara venerdì';
  field.dispatch('input');
  releaseWait();
  await flush(120);
  assert.ok(mount.textContent.includes('La ricerca sta impiegando più del previsto.'));
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'phrase-resume').dispatch('click');
  await flush(30);
  assert.equal(posts(client).length, 1, 'Riprova never POSTs');
  assert.equal(mount.querySelector('textarea[name="phrase"]').value, 'trova 30 minuti con marco giovedì',
    'the queued request rides with the phrase that asked it');
});

// Review #664 round 3 P1: a route away during the search left the card
// wedged on «Sto cercando…» with the button off.
test('a route away during the read-back brings the card back idle', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ readyAfter: 99 });
  const view = createCalendarioView({ doc, mount, client, wait: () => new Promise(() => {}), now: () => new Date('2026-10-21T06:00:00Z') });
  await search(view, mount);
  await flush();
  assert.ok(mount.textContent.includes('Sto cercando'), 'waiting before the route away');
  view.invalidate();
  await view.render();
  await flush();
  assert.ok(!mount.textContent.includes('Sto cercando'), 'no stuck waiting line');
  assert.ok(!mount.textContent.includes('Cerco gli slot liberi'), 'no stuck loading line');
  const find = mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi');
  assert.equal(find.getAttribute('disabled'), null, 'the search button works again');
});
