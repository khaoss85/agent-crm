import test from 'node:test';
import assert from 'node:assert/strict';

import { DRAFT_KEEP_KEY, captureDrafts, pendingDraftRoute, restoreDrafts } from '../apps/admin/public/admin-draft-keep.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// backlog:5a40c73e54aa (B4 of VALIDAZIONE-PRODOTTO.md): with the session gone,
// Salva on a long note used to throw the text away with the page. The shell
// now keeps it in sessionStorage before leaving for the login and fills it
// back in on the return.

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
}

function view(doc, fields) {
  const mount = createMount();
  const box = doc.createElement('div');
  for (const [tag, attrs, value] of fields) {
    const node = doc.createElement(tag);
    for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
    node.value = value;
    box.appendChild(node);
  }
  mount.appendChild(box);
  return mount;
}

const HASH = '#/customer-card/contact/c1';
const SPACE = 'spazio-a';
const NOTE = 'Richiamare lunedì: vuole dividere il pacchetto in due mesi. '.repeat(10);

test('B4: a long note typed before the session expires comes back after the login', () => {
  const doc = createFakeDocument();
  const storage = memoryStorage();
  const before = view(doc, [
    ['input', { name: 'noteBody' }, NOTE],
    ['input', { name: 'secret', type: 'password' }, 'not-kept'],
    ['input', { name: 'token', type: 'hidden' }, 'not-kept'],
    ['input', { name: 'empty' }, '   '],
  ]);
  assert.equal(captureDrafts({ root: before, hash: HASH, space: SPACE, storage, now: 1000 }), 1, 'only the typed text field is kept');
  const kept = JSON.parse(storage.getItem(DRAFT_KEEP_KEY));
  assert.deepEqual(kept.fields.map((field) => field.name), ['noteBody']);
  assert.ok(!JSON.stringify(kept).includes('not-kept'), 'never a password or hidden value');

  const after = view(doc, [['input', { name: 'noteBody' }, '']]);
  assert.equal(restoreDrafts({ root: after, hash: HASH, space: SPACE, storage, now: 2000 }), 1);
  assert.equal(after.childNodes[0].childNodes[0].value, NOTE, 'the note is back, whole');
  assert.equal(kept.space, SPACE, 'the copy names its space');
  assert.equal(storage.getItem(DRAFT_KEEP_KEY), null, 'used once, then dropped');
});

test('B4: kept text never overwrites what the operator typed, waits for its own route, and expires', () => {
  const doc = createFakeDocument();
  const storage = memoryStorage();
  captureDrafts({ root: view(doc, [['textarea', { name: 'body' }, 'testo vecchio']]), hash: HASH, space: SPACE, storage, now: 0 });

  const otherRoute = view(doc, [['textarea', { name: 'body' }, '']]);
  assert.equal(restoreDrafts({ root: otherRoute, hash: '#/customer-data', space: SPACE, storage, now: 10 }), 0, 'another route fills nothing');
  assert.notEqual(storage.getItem(DRAFT_KEEP_KEY), null, 'and the copy waits for its route');
  assert.equal(pendingDraftRoute({ space: SPACE, storage, now: 10 }), HASH, 'the home can send the operator back there');

  const typed = view(doc, [['textarea', { name: 'body' }, 'testo nuovo']]);
  assert.equal(restoreDrafts({ root: typed, hash: HASH, space: SPACE, storage, now: 20 }), 0);
  assert.equal(typed.childNodes[0].childNodes[0].value, 'testo nuovo', 'what the operator typed stays');

  captureDrafts({ root: view(doc, [['textarea', { name: 'body' }, 'vecchio']]), hash: HASH, space: SPACE, storage, now: 0 });
  const late = view(doc, [['textarea', { name: 'body' }, '']]);
  assert.equal(restoreDrafts({ root: late, hash: HASH, space: SPACE, storage, now: 3 * 60 * 60 * 1000 }), 0, 'after two hours the copy is stale');
  assert.equal(late.childNodes[0].childNodes[0].value, '');
  assert.equal(storage.getItem(DRAFT_KEEP_KEY), null, 'and dropped');
  assert.equal(pendingDraftRoute({ space: SPACE, storage, now: 3 * 60 * 60 * 1000 }), null);
});

test('B4: no storage, a broken storage or a hostile copy never crash the shell', () => {
  const doc = createFakeDocument();
  const root = view(doc, [['input', { name: 'noteBody' }, 'x']]);
  assert.equal(captureDrafts({ root, hash: HASH, space: SPACE, storage: null }), 0);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(captureDrafts({ root, hash: HASH, space: SPACE, storage: throwing }), 0);
  assert.equal(restoreDrafts({ root, hash: HASH, space: SPACE, storage: throwing }), 0);
  assert.equal(pendingDraftRoute({ space: SPACE, storage: throwing }), null);
  const storage = memoryStorage();
  storage.setItem(DRAFT_KEEP_KEY, '{not json');
  assert.equal(restoreDrafts({ root, hash: HASH, space: SPACE, storage }), 0);
  storage.setItem(DRAFT_KEEP_KEY, JSON.stringify({ hash: 'javascript:alert(1)', at: Date.now(), fields: [] }));
  assert.equal(pendingDraftRoute({ space: SPACE, storage }), null, 'only an in-app #/ route is ever navigated to');
});

// Review #634 P1: the copy is bound to its space. sessionStorage outlives a
// space change in the same tab, so a copy taken in space A never fills a
// view nor redirects in space B — A's text is never saved into B's tenant.
test('review #634: a draft kept in one space never fills or redirects in another', () => {
  const doc = createFakeDocument();
  const storage = memoryStorage();
  captureDrafts({ root: view(doc, [['textarea', { name: 'body' }, 'testo dello spazio A']]), hash: '#/sequenze', space: 'spazio-a', storage, now: 0 });
  assert.equal(pendingDraftRoute({ storage, space: 'spazio-b', now: 10 }), null, 'another space is never sent to A\'s route');
  const inB = view(doc, [['textarea', { name: 'body' }, '']]);
  assert.equal(restoreDrafts({ root: inB, hash: '#/sequenze', space: 'spazio-b', storage, now: 10 }), 0, 'another space fills nothing');
  assert.equal(inB.childNodes[0].childNodes[0].value, '');
  assert.equal(restoreDrafts({ root: inB, hash: '#/sequenze', space: null, storage, now: 10 }), 0, 'an unknown space fills nothing');
  assert.notEqual(storage.getItem(DRAFT_KEEP_KEY), null, 'the copy waits for its own space');
  const inA = view(doc, [['textarea', { name: 'body' }, '']]);
  assert.equal(restoreDrafts({ root: inA, hash: '#/sequenze', space: 'spazio-a', storage, now: 20 }), 1);
  assert.equal(inA.childNodes[0].childNodes[0].value, 'testo dello spazio A');
  // Without an active space there is nothing to bind the copy to.
  const empty = memoryStorage();
  assert.equal(captureDrafts({ root: view(doc, [['textarea', { name: 'body' }, 'x']]), hash: HASH, space: null, storage: empty }), 0);
  assert.equal(empty.getItem(DRAFT_KEEP_KEY), null);
  // A copy written before the binding (no space) never fills anything.
  empty.setItem(DRAFT_KEEP_KEY, JSON.stringify({ hash: HASH, at: 0, fields: [{ name: 'body', value: 'senza spazio' }] }));
  assert.equal(restoreDrafts({ root: view(doc, [['textarea', { name: 'body' }, '']]), hash: HASH, space: SPACE, storage: empty, now: 10 }), 0);
});

// Review #634 P2: a matching route that offers no empty field (the form did
// not render, or it came back pre-filled) consumes nothing — the copy stays
// for a later complete render, and the home bounce happens once only.
test('review #634: a matching restore that fills nothing keeps the copy, and the home bounce happens once', () => {
  const doc = createFakeDocument();
  const storage = memoryStorage();
  captureDrafts({ root: view(doc, [['input', { name: 'noteBody' }, NOTE]]), hash: HASH, space: SPACE, storage, now: 0 });
  assert.equal(pendingDraftRoute({ storage, space: SPACE, now: 5 }), HASH, 'the home sends the operator back once');
  const noForm = view(doc, [['input', { name: 'search' }, '']]);
  assert.equal(restoreDrafts({ root: noForm, hash: HASH, space: SPACE, storage, now: 10 }), 0, 'the note form did not render');
  assert.notEqual(storage.getItem(DRAFT_KEEP_KEY), null, 'the copy survives a restore that filled nothing');
  const prefilled = view(doc, [['input', { name: 'noteBody' }, 'dal server']]);
  assert.equal(restoreDrafts({ root: prefilled, hash: HASH, space: SPACE, storage, now: 15 }), 0);
  assert.notEqual(storage.getItem(DRAFT_KEEP_KEY), null, 'and a pre-filled field consumes nothing either');
  assert.equal(pendingDraftRoute({ storage, space: SPACE, now: 20 }), null, 'never a second bounce off the home');
  const complete = view(doc, [['input', { name: 'noteBody' }, '']]);
  assert.equal(restoreDrafts({ root: complete, hash: HASH, space: SPACE, storage, now: 30 }), 1, 'a later complete render restores it');
  assert.equal(complete.childNodes[0].childNodes[0].value, NOTE);
  assert.equal(storage.getItem(DRAFT_KEEP_KEY), null, 'consumed once offered back');
});
