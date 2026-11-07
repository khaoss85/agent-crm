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
  assert.equal(captureDrafts({ root: before, hash: HASH, storage, now: 1000 }), 1, 'only the typed text field is kept');
  const kept = JSON.parse(storage.getItem(DRAFT_KEEP_KEY));
  assert.deepEqual(kept.fields.map((field) => field.name), ['noteBody']);
  assert.ok(!JSON.stringify(kept).includes('not-kept'), 'never a password or hidden value');

  const after = view(doc, [['input', { name: 'noteBody' }, '']]);
  assert.equal(restoreDrafts({ root: after, hash: HASH, storage, now: 2000 }), 1);
  assert.equal(after.childNodes[0].childNodes[0].value, NOTE, 'the note is back, whole');
  assert.equal(storage.getItem(DRAFT_KEEP_KEY), null, 'used once, then dropped');
});

test('B4: kept text never overwrites what the operator typed, waits for its own route, and expires', () => {
  const doc = createFakeDocument();
  const storage = memoryStorage();
  captureDrafts({ root: view(doc, [['textarea', { name: 'body' }, 'testo vecchio']]), hash: HASH, storage, now: 0 });

  const otherRoute = view(doc, [['textarea', { name: 'body' }, '']]);
  assert.equal(restoreDrafts({ root: otherRoute, hash: '#/customer-data', storage, now: 10 }), 0, 'another route fills nothing');
  assert.notEqual(storage.getItem(DRAFT_KEEP_KEY), null, 'and the copy waits for its route');
  assert.equal(pendingDraftRoute({ storage, now: 10 }), HASH, 'the home can send the operator back there');

  const typed = view(doc, [['textarea', { name: 'body' }, 'testo nuovo']]);
  assert.equal(restoreDrafts({ root: typed, hash: HASH, storage, now: 20 }), 0);
  assert.equal(typed.childNodes[0].childNodes[0].value, 'testo nuovo', 'what the operator typed stays');

  captureDrafts({ root: view(doc, [['textarea', { name: 'body' }, 'vecchio']]), hash: HASH, storage, now: 0 });
  const late = view(doc, [['textarea', { name: 'body' }, '']]);
  assert.equal(restoreDrafts({ root: late, hash: HASH, storage, now: 3 * 60 * 60 * 1000 }), 0, 'after two hours the copy is stale');
  assert.equal(late.childNodes[0].childNodes[0].value, '');
  assert.equal(storage.getItem(DRAFT_KEEP_KEY), null, 'and dropped');
  assert.equal(pendingDraftRoute({ storage, now: 3 * 60 * 60 * 1000 }), null);
});

test('B4: no storage, a broken storage or a hostile copy never crash the shell', () => {
  const doc = createFakeDocument();
  const root = view(doc, [['input', { name: 'noteBody' }, 'x']]);
  assert.equal(captureDrafts({ root, hash: HASH, storage: null }), 0);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(captureDrafts({ root, hash: HASH, storage: throwing }), 0);
  assert.equal(restoreDrafts({ root, hash: HASH, storage: throwing }), 0);
  assert.equal(pendingDraftRoute({ storage: throwing }), null);
  const storage = memoryStorage();
  storage.setItem(DRAFT_KEEP_KEY, '{not json');
  assert.equal(restoreDrafts({ root, hash: HASH, storage }), 0);
  storage.setItem(DRAFT_KEEP_KEY, JSON.stringify({ hash: 'javascript:alert(1)', at: Date.now(), fields: [] }));
  assert.equal(pendingDraftRoute({ storage }), null, 'only an in-app #/ route is ever navigated to');
});
