import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  NOTE_WITHDRAW_GRACE_MS,
  NOTE_WITHDRAWALS_STORAGE_KEY,
  createCustomerCardView,
  noteChangeRefusalText,
  withRevisedNote,
  withoutNote,
} from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:cb348c9fcaeb — «Modifica» and «Elimina» on the operator's own note
 * in the scheda cronologia. agent-crm#797 shipped the routes
 * (POST /api/customer-hub/notes/revise and /withdraw); production 13/11 had
 * no command on a note. Only the note's writer sees the commands (the actor
 * the host names in /api/spine/context); Modifica edits in place (Invio
 * saves, Maiusc+Invio new line, Esc cancels); Elimina hides the note at once
 * and sends the withdrawal when the «Annulla» window of the toast ends —
 * never a native confirm.
 */

const ME = 'google|501';
const OTHER = 'google|502';

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Cliente Prova',
  company: { id: 'co1', name: 'Azienda Esempio' },
  phone: { available: false, value: null },
  email: 'cliente@esempio.invalid',
  socials: [],
  status: { value: 'contatto' },
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: {
    company: { id: 'co1', name: 'Azienda Esempio' },
    contact: { id: 'c1', firstName: 'Cliente', lastName: 'Prova', email: 'cliente@esempio.invalid', companyId: 'co1' },
  },
  externalIdentities: [],
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

const MINE = { entry: 'note', id: 'n-mia', body: 'Richiamare lunedì', teamAuthorId: ME, occurredAt: '2026-11-12T10:00:00.000Z' };
const THEIRS = { entry: 'note', id: 'n-altra', body: 'Preventivo inviato', teamAuthorId: OTHER, occurredAt: '2026-11-12T09:00:00.000Z' };

const timelineOf = (items) => ({
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: items.length, truncated: false, items },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});

const ROSTER = {
  items: [
    { subject: ME, displayName: 'Operatrice Uno', email: 'uno@esempio.invalid' },
    { subject: OTHER, displayName: 'Operatore Due', email: 'due@esempio.invalid' },
  ],
};

/**
 * The server double: notes live in `state.items`; a correction changes the
 * note's wording in place and a withdrawal removes it, like the cronologia
 * the hub folds. `refuse` throws the given error on the named write path.
 */
function fakeClient({ items = [MINE, THEIRS], context = { actor: { type: 'user', id: ME } }, refuse = {} } = {}) {
  const state = { items: [...items] };
  const writes = [];
  const reads = [];
  return {
    state,
    writes,
    reads,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        writes.push({ path, method, body, keepalive: options.keepalive === true, key: options.headers?.['Idempotency-Key'] ?? null });
        if (Object.hasOwn(refuse, path)) throw refuse[path];
        if (path === '/api/customer-hub/notes/revise') {
          state.items = state.items.map((item) => (item.id === body.noteId ? { ...item, body: body.body } : item));
          return { id: 'n-correzione', revisesId: body.noteId, body: body.body, actorId: ME };
        }
        if (path === '/api/customer-hub/notes/withdraw') {
          state.items = state.items.filter((item) => item.id !== body.noteId);
          return { id: 'n-ritiro', revisesId: body.noteId, withdrawn: true, actorId: ME };
        }
        return { ok: true };
      }
      reads.push(path);
      if (path.startsWith('/api/customer-hub/card/')) return { ...CARD, subject: { resource: 'contact', id: path.split('/').pop() } };
      if (path.startsWith('/api/customer-hub/timeline/')) return timelineOf(state.items);
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path === '/api/spine/memberships') return ROSTER;
      if (path === '/api/spine/context') {
        const answer = typeof context === 'function' ? context() : context;
        if (answer instanceof Error) throw answer;
        return answer;
      }
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/schema') return { pipelines: [] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A wait the test ends by hand: the «Annulla» window of Elimina. */
function manualWait() {
  const waits = [];
  return {
    waits,
    wait: (ms) => new Promise((resolve) => { waits.push({ ms, resolve }); }),
    endAll() { for (const entry of waits.splice(0)) entry.resolve(); },
  };
}

async function open(client = fakeClient(), spaceId = 'spazio-prova', extra = {}) {
  const doc = extra.doc ?? createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const hidden = [];
  const timer = manualWait();
  const view = createCustomerCardView({
    doc, mount, client, spaceId, wait: timer.wait, ...(extra.pageWindow ? { pageWindow: extra.pageWindow } : {}),
    ...(extra.sessionStorage ? { sessionStorage: extra.sessionStorage } : {}),
    ...(extra.storage ? { storage: extra.storage } : {}),
    toast: (text, error = false, options = {}) => toasts.push({ text, error, options }),
    hideToast: (scope) => hidden.push(scope),
  });
  await view.renderCard('contact', 'c1');
  await flush();
  return { mount, view, client, toasts, timer, hidden, doc };
}

/** The note row in the cronologia that shows `text`, or undefined. */
const noteRow = (mount, text) => mount.findAll('div')
  .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-scheda-entry-note'))
  .find((node) => node.textContent.includes(text));
const commandsIn = (row) => (row ? row.findAll('button') : [])
  .map((node) => node.getAttribute('data-action'))
  .filter((action) => action === 'edit-note' || action === 'withdraw-note');
const byAction = (root, action) => root.findAll('button').find((node) => node.getAttribute('data-action') === action);
const editField = (mount) => mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteEditBody');
const key = (name, extra = {}) => ({ key: name, preventDefault() { this.prevented = true; }, ...extra });

test('cb348c9fcaeb: only the operator’s own note offers Modifica and Elimina', async () => {
  const { mount } = await open();
  assert.deepEqual(commandsIn(noteRow(mount, 'Richiamare lunedì')), ['edit-note', 'withdraw-note']);
  assert.deepEqual(commandsIn(noteRow(mount, 'Preventivo inviato')), [], 'another member’s note has no command');
});

test('cb348c9fcaeb: without the actor of the session no note offers a command', async () => {
  for (const context of [{}, { actor: null }, Object.assign(new Error('Not Found'), { status: 404 })]) {
    const { mount } = await open(fakeClient({ context }));
    assert.ok(noteRow(mount, 'Richiamare lunedì'), 'the note is shown');
    assert.deepEqual(commandsIn(noteRow(mount, 'Richiamare lunedì')), [], JSON.stringify(context));
  }
});

test('cb348c9fcaeb: the operator is read per space — another space names another actor (review Muse #867)', async () => {
  let space = 'spazio-a';
  const actors = { 'spazio-a': ME, 'spazio-b': OTHER };
  const client = fakeClient({ context: () => ({ actor: { type: 'user', id: actors[space] } }) });
  const { mount, view } = await open(client, () => space);
  assert.deepEqual(commandsIn(noteRow(mount, 'Richiamare lunedì')), ['edit-note', 'withdraw-note']);
  assert.deepEqual(commandsIn(noteRow(mount, 'Preventivo inviato')), []);
  space = 'spazio-b';
  await view.renderCard('contact', 'c1');
  await flush();
  assert.deepEqual(commandsIn(noteRow(mount, 'Richiamare lunedì')), [], 'the note of space A\u2019s actor has no command in space B');
  assert.deepEqual(commandsIn(noteRow(mount, 'Preventivo inviato')), ['edit-note', 'withdraw-note'], 'the operator\u2019s own note in space B has them');
  assert.equal(client.reads.filter((path) => path === '/api/spine/context').length, 2, 'one read per full read, never per repaint');
});

test('cb348c9fcaeb: Modifica edits in place — Maiusc+Invio goes to a new line, Invio saves and the cronologia is read again', async () => {
  const { mount, client, toasts } = await open();
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  const field = editField(mount);
  assert.ok(field, 'the note turns into a field');
  assert.equal(field.value, 'Richiamare lunedì', 'with its wording');
  assert.ok(mount.textContent.includes('Invio salva, Maiusc+Invio va a capo, Esc annulla.'));
  field.value = 'Richiamare martedì';
  const shift = key('Enter', { shiftKey: true });
  field.dispatch('keydown', shift);
  assert.equal(shift.prevented, undefined, 'Maiusc+Invio keeps the new line');
  assert.equal(client.writes.length, 0);
  field.value = 'Richiamare martedì\ndopo le 15';
  client.reads.length = 0;
  const enter = key('Enter');
  editField(mount).dispatch('keydown', enter);
  await flush();
  assert.equal(enter.prevented, true);
  assert.deepEqual(client.writes.map((write) => [write.path, write.body]), [[
    '/api/customer-hub/notes/revise',
    { resource: 'contact', id: 'c1', noteId: 'n-mia', body: 'Richiamare martedì\ndopo le 15' },
  ]]);
  assert.deepEqual(toasts.map((entry) => entry.text), ['Nota modificata']);
  assert.ok(client.reads.some((path) => path.startsWith('/api/customer-hub/timeline/')), 'the cronologia is read again');
  assert.equal(editField(mount), undefined, 'the editor is closed');
  assert.ok(noteRow(mount, 'Richiamare martedì'), 'the new wording is on screen');
  assert.ok(!mount.textContent.includes('Richiamare lunedì'));
});

test('cb348c9fcaeb: Esc and Annulla put the note back as it was, with no write', async () => {
  const { mount, client } = await open();
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  editField(mount).value = 'testo che non resta';
  const esc = key('Escape');
  editField(mount).dispatch('keydown', esc);
  assert.equal(esc.prevented, true);
  assert.equal(editField(mount), undefined);
  assert.ok(noteRow(mount, 'Richiamare lunedì'));
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  byAction(mount, 'cancel-note-edit').dispatch('click');
  assert.equal(editField(mount), undefined);
  await flush();
  assert.equal(client.writes.length, 0);
});

test('cb348c9fcaeb: what is typed in Modifica survives a repaint of the scheda', async () => {
  const { mount, view } = await open();
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  editField(mount).value = 'Richiamare mercoledì';
  await view.renderCard('contact', 'c1');
  await flush();
  assert.ok(editField(mount), 'the editor is still open');
  assert.equal(editField(mount).value, 'Richiamare mercoledì');
});

test('cb348c9fcaeb: Salva shows its wait and an empty note is refused on the spot', async () => {
  const { mount, client } = await open();
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  editField(mount).value = '   ';
  await byAction(mount, 'save-note-edit').listeners.click[0]();
  assert.ok(mount.textContent.includes('Scrivi la nota prima di salvarla. Per toglierla usa «Elimina».'));
  assert.equal(client.writes.length, 0);
  editField(mount).value = 'Richiamare giovedì';
  const save = byAction(mount, 'save-note-edit');
  const saving = save.listeners.click[0]();
  assert.equal(save.getAttribute('aria-busy'), 'true', 'the button says it is saving');
  assert.equal(save.textContent, 'Salvo…');
  await saving;
});

test('cb348c9fcaeb: a refused correction keeps the editor and says what happened, never «Riprova più tardi»', async () => {
  const refusal = Object.assign(new Error('Only who wrote the note, or the space owner, can change it'), {
    status: 403, code: 'WORK_NOTE_NOT_AUTHOR',
  });
  const { mount, client, toasts } = await open(fakeClient({ refuse: { '/api/customer-hub/notes/revise': refusal } }));
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  editField(mount).value = 'Richiamare venerdì';
  editField(mount).dispatch('keydown', key('Enter'));
  await flush();
  assert.equal(client.writes.length, 1);
  assert.ok(editField(mount), 'the editor stays open');
  assert.equal(editField(mount).value, 'Richiamare venerdì', 'with what was typed');
  const said = 'Solo chi ha scritto la nota può modificarla o eliminarla.';
  assert.ok(mount.textContent.includes(said), mount.textContent.slice(0, 600));
  assert.deepEqual(toasts.map((entry) => [entry.text, entry.error]), [[said, true]]);
  assert.ok(!mount.textContent.includes('Riprova più tardi'));
});

test('cb348c9fcaeb: Elimina hides the note at once, offers Annulla, and withdraws when the window ends', async () => {
  const previous = globalThis.confirm;
  globalThis.confirm = () => { throw new Error('no native confirm'); };
  try {
    const { mount, client, toasts, timer } = await open();
    const press = byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
    await press;
    await flush();
    assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined, 'the note leaves the screen at once');
    assert.ok(noteRow(mount, 'Preventivo inviato'), 'the other notes stay');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].text, 'Nota eliminata');
    assert.equal(toasts[0].options.action.label, 'Annulla');
    assert.equal(toasts[0].options.duration, NOTE_WITHDRAW_GRACE_MS);
    assert.deepEqual(timer.waits.map((entry) => entry.ms), [NOTE_WITHDRAW_GRACE_MS]);
    assert.equal(client.writes.length, 0, 'nothing is sent while Annulla is offered');
    client.reads.length = 0;
    timer.endAll();
    await flush();
    assert.deepEqual(client.writes.map((write) => [write.path, write.body]), [[
      '/api/customer-hub/notes/withdraw', { resource: 'contact', id: 'c1', noteId: 'n-mia' },
    ]]);
    assert.ok(client.reads.some((path) => path.startsWith('/api/customer-hub/timeline/')), 'the cronologia is read again');
    assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined);
    toasts[0].options.action.run();
    await flush();
    assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined, 'a late Annulla changes nothing');
    assert.deepEqual([toasts.at(-1).text, toasts.at(-1).error], ['La nota è già stata eliminata: non si può più annullare.', true],
      'and says so');
  } finally {
    globalThis.confirm = previous;
  }
});

test('cb348c9fcaeb: Annulla in the toast brings the note back and nothing is ever sent', async () => {
  const { mount, client, toasts, timer } = await open();
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  await flush();
  assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined);
  toasts[0].options.action.run();
  await flush();
  assert.ok(noteRow(mount, 'Richiamare lunedì'), 'the note is back');
  assert.deepEqual(commandsIn(noteRow(mount, 'Richiamare lunedì')), ['edit-note', 'withdraw-note']);
  assert.equal(toasts.at(-1).text, 'Nota ripristinata');
  timer.endAll();
  await flush();
  assert.equal(client.writes.length, 0, 'the window ended after Annulla: no withdrawal');
});

test('cb348c9fcaeb: a refused withdrawal brings the note back with a readable reason', async () => {
  const refusal = Object.assign(new Error('No note with this id on this customer'), { status: 404, code: 'WORK_NOTE_NOT_FOUND' });
  const { mount, client, toasts, timer } = await open(fakeClient({ refuse: { '/api/customer-hub/notes/withdraw': refusal } }));
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  timer.endAll();
  await flush();
  assert.equal(client.writes.length, 1);
  assert.deepEqual(toasts.at(-1), { text: 'Questa nota non c’è più: ricarica la scheda.', error: true, options: {} });
  assert.ok(noteRow(mount, 'Richiamare lunedì'), 'the server still lists it: it is shown again');
});

test('cb348c9fcaeb: opening another customer sends a waiting withdrawal at once', async () => {
  const { mount, view, client } = await open();
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  assert.equal(client.writes.length, 0);
  await view.renderCard('contact', 'c2');
  await flush();
  assert.deepEqual(client.writes.map((write) => [write.path, write.body.noteId]), [['/api/customer-hub/notes/withdraw', 'n-mia']]);
});

// backlog:947260f9f036 (review Muse #871 giro 1): leaving the scheda and
// coming back to the same customer (scheda → offerta → «← cliente») paints
// the skeleton at once, but a note in its «Annulla» window stays waiting:
// Annulla keeps working until the window ends. Only another customer sends
// it at once (#867), and then the toast with its Annulla leaves.
test('947260f9f036: back on the same customer after another screen, a waiting withdrawal keeps its Annulla', async () => {
  const { mount, view, client, toasts, timer, hidden } = await open();
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  await flush();
  view.invalidate();
  await view.renderCard('contact', 'c1');
  await flush();
  assert.equal(client.writes.length, 0, 'nothing is sent on the way back');
  assert.deepEqual(hidden, [], 'the Annulla toast stays');
  assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined, 'the note stays hidden while the window is open');
  toasts[0].options.action.run();
  await flush();
  assert.ok(noteRow(mount, 'Richiamare lunedì'), 'Annulla still brings it back');
  timer.endAll();
  await flush();
  assert.equal(client.writes.length, 0, 'and nothing is ever sent');
});

test('947260f9f036: back on the same customer, a withdrawal not undone leaves when its window ends', async () => {
  const { mount, view, client, timer } = await open();
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  await flush();
  view.invalidate();
  await view.renderCard('contact', 'c1');
  await flush();
  timer.endAll();
  await flush();
  assert.deepEqual(client.writes.map((write) => [write.path, write.body.noteId]), [['/api/customer-hub/notes/withdraw', 'n-mia']]);
  assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined);
});

test('947260f9f036: opening another customer sends the waiting withdrawal and takes its Annulla away', async () => {
  const { mount, view, client, toasts, hidden } = await open();
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  await flush();
  const scope = toasts[0].options.scope;
  assert.ok(typeof scope === 'string' && scope !== '', 'the Annulla toast has an owner the shell can hide');
  view.invalidate();
  await view.renderCard('contact', 'c2');
  await flush();
  assert.deepEqual(client.writes.map((write) => [write.path, write.body.noteId]), [['/api/customer-hub/notes/withdraw', 'n-mia']]);
  assert.deepEqual(hidden, [scope], 'the Annulla toast leaves when the withdrawal is sent');
});

test('947260f9f036: the shell hides the scheda toast by its owner', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const wiring = /const customerCardView = createCustomerCardView\(\{([\s\S]*?)\n\}\);/.exec(app);
  assert.ok(wiring && /hideToast: \(scope\) => \{ if \(toaster !== null\) toaster\.hideScope\(scope\); \}/.test(wiring[1]));
});

test('cb348c9fcaeb: the cronologia helpers and the refusal sentences', () => {
  const loaded = { timeline: timelineOf([MINE, THEIRS]) };
  const revised = withRevisedNote(loaded, 'n-mia', 'Nuovo testo');
  assert.equal(revised.timeline.entries.items[0].body, 'Nuovo testo');
  assert.equal(revised.timeline.entries.items[0].teamAuthorId, ME, 'the writer stays');
  assert.equal(revised.timeline.entries.items[0].occurredAt, MINE.occurredAt, 'the place stays');
  assert.equal(loaded.timeline.entries.items[0].body, 'Richiamare lunedì', 'the read copy is untouched');
  const without = withoutNote(loaded, 'n-mia');
  assert.deepEqual(without.timeline.entries.items.map((item) => item.id), ['n-altra']);
  assert.equal(without.timeline.entries.count, 1);
  // Review Muse #867 (P2): a shape without count starts from the list before the filter.
  const uncounted = { timeline: { entries: { available: true, items: [MINE, THEIRS] } } };
  assert.equal(withoutNote(uncounted, 'n-mia').timeline.entries.count, 1);
  assert.equal(noteChangeRefusalText({ status: 409, code: 'WORK_NOTE_WITHDRAWN' }, 'x', 'withdraw'), 'Questa nota è già stata eliminata.');
  for (const [error, sentence] of [
    [{ status: 403, code: 'WORK_NOTE_NOT_AUTHOR' }, 'Solo chi ha scritto la nota può modificarla o eliminarla.'],
    [{ status: 404, code: 'WORK_NOTE_NOT_FOUND' }, 'Questa nota non c’è più: ricarica la scheda.'],
    [{ status: 409, code: 'WORK_NOTE_WITHDRAWN' }, 'Questa nota è stata eliminata: non si può più modificare.'],
    [{ status: 400, code: 'VALIDATION_ERROR', message: 'body must be at most 1000 characters' }, 'La nota è troppo lunga: al massimo 1000 caratteri.'],
  ]) {
    assert.equal(noteChangeRefusalText(error, 'Nota non modificata. Riprova più tardi.'), sentence);
  }
});

// ---------------------------------------------------------------------------
// backlog:fe9be5f0af4a — production verification 13/11 after #867
// ---------------------------------------------------------------------------

/** An event target the page fires `pagehide` on. */
function fakeWindow() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
    fire(type) { for (const handler of listeners[type] ?? []) handler({ type }); },
  };
}

/** A fake document that knows which node has the focus and where the caret is. */
function focusDocument() {
  const doc = createFakeDocument();
  const listeners = {};
  doc.activeElement = null;
  doc.visibilityState = 'visible';
  doc.addEventListener = (type, handler) => { (listeners[type] ??= []).push(handler); };
  doc.fire = (type) => { for (const handler of listeners[type] ?? []) handler({ type }); };
  const proto = Object.getPrototypeOf(doc.createElement('div'));
  const restore = { focus: proto.focus, setSelectionRange: proto.setSelectionRange };
  proto.focus = function focus() { this.__focused = true; doc.activeElement = this; };
  proto.setSelectionRange = function setSelectionRange(start, end) { this.__selection = [start, end]; };
  doc.restore = () => { proto.focus = restore.focus; if (restore.setSelectionRange) proto.setSelectionRange = restore.setSelectionRange; else delete proto.setSelectionRange; };
  return doc;
}

const settle = async () => {
  await flush();
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await flush();
};

test('fe9be5f0af4a: leaving the page inside the Annulla window sends the withdrawal at once, with keepalive and its key', async () => {
  const pageWindow = fakeWindow();
  const { mount, client, hidden, toasts } = await open(fakeClient(), 'spazio-prova', { pageWindow });
  await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  assert.equal(client.writes.length, 0, 'nothing leaves while Annulla is offered');
  pageWindow.fire('pagehide');
  await flush();
  assert.equal(client.writes.length, 1);
  const [write] = client.writes;
  assert.deepEqual([write.path, write.body], ['/api/customer-hub/notes/withdraw', { resource: 'contact', id: 'c1', noteId: 'n-mia' }]);
  assert.equal(write.keepalive, true, 'the request outlives the page');
  assert.match(String(write.key), /^v1\./, 'through the /bo write client: same submission key as any write');
  assert.deepEqual(hidden, [toasts[0].options.scope], 'the Annulla toast leaves with the withdrawal');
  pageWindow.fire('pagehide');
  await flush();
  assert.equal(client.writes.length, 1, 'sent once');
});

test('fe9be5f0af4a: another browser tab sends nothing and Annulla still works (review Muse #878, P2)', async () => {
  const doc = focusDocument();
  try {
    const { mount, client, toasts, timer, hidden } = await open(fakeClient(), 'spazio-prova', { doc, pageWindow: fakeWindow() });
    await byAction(noteRow(mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
    doc.visibilityState = 'hidden';
    doc.fire('visibilitychange');
    await flush();
    assert.equal(client.writes.length, 0, 'a hidden page is not a page that left');
    assert.deepEqual(hidden, [], 'the Annulla toast stays');
    doc.visibilityState = 'visible';
    doc.fire('visibilitychange');
    toasts[0].options.action.run();
    await flush();
    assert.ok(noteRow(mount, 'Richiamare lunedì'), 'Annulla brought the note back');
    timer.endAll();
    await flush();
    assert.equal(client.writes.length, 0, 'and nothing is ever sent');
  } finally {
    doc.restore();
  }
});

test('fe9be5f0af4a: Modifica puts the cursor in the note, at the end of its text, and keeps it through a repaint', async () => {
  const doc = focusDocument();
  try {
    const { mount, view } = await open(fakeClient(), 'spazio-prova', { doc });
    byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
    await settle();
    const field = editField(mount);
    assert.equal(doc.activeElement, field, 'the cursor is in the field, never on the page body');
    assert.deepEqual(field.__selection, ['Richiamare lunedì'.length, 'Richiamare lunedì'.length], 'at the end of the text');
    field.value = 'Richiamare lunedì mattina';
    await view.renderCard('contact', 'c1');
    await settle();
    assert.notEqual(editField(mount), field, 'the scheda was repainted');
    assert.equal(doc.activeElement, editField(mount), 'the new field has the cursor again');
    assert.deepEqual(editField(mount).__selection, ['Richiamare lunedì mattina'.length, 'Richiamare lunedì mattina'.length]);
  } finally {
    doc.restore();
  }
});

test('fe9be5f0af4a: the later focus attempt never takes the focus back from where the operator moved (review Muse #878)', async () => {
  const doc = focusDocument();
  try {
    const { mount } = await open(fakeClient(), 'spazio-prova', { doc });
    byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
    const elsewhere = doc.createElement('input');
    elsewhere.focus();
    await settle();
    assert.equal(doc.activeElement, elsewhere, 'the operator keeps the field they moved to');
  } finally {
    doc.restore();
  }
});

test('fe9be5f0af4a: Dettagli › Modifica puts the cursor in the first field, at the end', async () => {
  const doc = focusDocument();
  try {
    const { mount } = await open(fakeClient(), 'spazio-prova', { doc });
    byAction(mount, 'edit-details').dispatch('click');
    await settle();
    const first = mount.findAll('input').find((node) => node.getAttribute('name') === 'firstName');
    assert.ok(first, 'the form is open');
    assert.equal(doc.activeElement, first);
    assert.deepEqual(first.__selection, [String(first.value).length, String(first.value).length]);
  } finally {
    doc.restore();
  }
});

test('fe9be5f0af4a: a corrected note says «modificata» with the hour of the correction', async () => {
  const hour = (iso) => new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }).format(new Date(iso));
  const corrected = { ...MINE, revisedAt: '2026-11-12T14:05:00.000Z', revisedBy: ME };
  const { mount } = await open(fakeClient({ items: [corrected, THEIRS] }));
  const head = noteRow(mount, 'Richiamare lunedì').findAll('p')[0].textContent;
  assert.ok(head.endsWith(`· ${hour(MINE.occurredAt)} · modificata ${hour(corrected.revisedAt)}`), head);
  assert.ok(!noteRow(mount, 'Preventivo inviato').textContent.includes('modificata'), 'an untouched note does not say it');
});

test('fe9be5f0af4a: right after Salva the corrected note already says «modificata»', async () => {
  const client = fakeClient();
  const { mount } = await open(client);
  byAction(noteRow(mount, 'Richiamare lunedì'), 'edit-note').dispatch('click');
  editField(mount).value = 'Richiamare martedì';
  // The server's cronologia carries revisedAt once the correction is on record.
  const original = client.request.bind(client);
  client.request = async (path, options = {}) => {
    const answer = await original(path, options);
    if (String(options.method ?? 'GET') === 'GET' && path.startsWith('/api/customer-hub/timeline/')) {
      return { ...answer, entries: { ...answer.entries, items: answer.entries.items.map((item) => (item.id === 'n-mia' ? { ...item, revisedAt: '2026-11-13T18:00:00.000Z' } : item)) } };
    }
    return answer;
  };
  editField(mount).dispatch('keydown', key('Enter'));
  await flush();
  assert.ok(noteRow(mount, 'Richiamare martedì').textContent.includes('modificata'));
});

// ---------------------------------------------------------------------------
// backlog:4eceae80a5ca — production verification 14/11 after #878
// ---------------------------------------------------------------------------

/** A Storage-shaped map (sessionStorage / localStorage). */
function memoryStore() {
  const map = new Map();
  return {
    map,
    getItem: (name) => (map.has(name) ? map.get(name) : null),
    setItem: (name, value) => { map.set(name, String(value)); },
    removeItem: (name) => { map.delete(name); },
  };
}

/** The first page: its keepalive withdrawal leaves but the server has not applied it yet. */
function slowWithdrawClient() {
  const client = fakeClient();
  const original = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if (path === '/api/customer-hub/notes/withdraw') {
      client.writes.push({ path, body: JSON.parse(String(options.body)), keepalive: options.keepalive === true, key: options.headers?.['Idempotency-Key'] ?? null });
      return new Promise(() => {});
    }
    return original(path, options);
  };
  return client;
}

test('4eceae80a5ca: a reload right after Elimina keeps the note hidden and sends the withdrawal again with the same key', async () => {
  const session = memoryStore();
  const local = memoryStore();
  const pageWindow = fakeWindow();
  const first = await open(slowWithdrawClient(), 'spazio-prova', { pageWindow, sessionStorage: session, storage: local });
  await byAction(noteRow(first.mount, 'Richiamare lunedì'), 'withdraw-note').listeners.click[0]();
  pageWindow.fire('pagehide');
  await flush();
  assert.equal(first.client.writes.length, 1, 'the keepalive withdrawal left with the page');
  const firstKey = first.client.writes[0].key;
  const [stored] = JSON.parse(session.getItem(NOTE_WITHDRAWALS_STORAGE_KEY));
  assert.deepEqual({ ...stored, expiresAt: typeof stored.expiresAt },
    { spaceId: 'spazio-prova', resource: 'contact', id: 'c1', noteId: 'n-mia', idempotencyKey: firstKey, expiresAt: 'number' },
    'written down before the page went away');

  // The new page reads the cronologia before the server applied the first POST.
  const client = fakeClient();
  const second = await open(client, 'spazio-prova', { sessionStorage: session, storage: local });
  assert.equal(noteRow(second.mount, 'Richiamare lunedì'), undefined, 'the note never comes back');
  assert.ok(noteRow(second.mount, 'Preventivo inviato'));
  assert.deepEqual(client.writes.map((write) => [write.path, write.body.noteId, write.key]),
    [['/api/customer-hub/notes/withdraw', 'n-mia', firstKey]], 'sent again under the SAME key: the server replays, never a second write');
  await flush();
  assert.equal(session.getItem(NOTE_WITHDRAWALS_STORAGE_KEY), null, 'the entry leaves once the cronologia no longer lists the note');
});

test('4eceae80a5ca: a withdrawal the server already applied is not sent again; another space or customer is left alone', async () => {
  const session = memoryStore();
  const later = Date.now() + 60_000;
  session.setItem(NOTE_WITHDRAWALS_STORAGE_KEY, JSON.stringify([
    { spaceId: 'spazio-prova', resource: 'contact', id: 'c1', noteId: 'n-gia-ritirata', idempotencyKey: 'v1.20261114.00000000000000000000000000000001', expiresAt: later },
    { spaceId: 'altro-spazio', resource: 'contact', id: 'c1', noteId: 'n-mia', idempotencyKey: 'v1.20261114.00000000000000000000000000000002', expiresAt: later },
    { spaceId: 'spazio-prova', resource: 'contact', id: 'c9', noteId: 'n-mia', idempotencyKey: 'v1.20261114.00000000000000000000000000000003', expiresAt: later },
    { spaceId: 'spazio-prova', resource: 'contact', id: 'c1', noteId: 'n-altra', idempotencyKey: 'v1.20261114.00000000000000000000000000000004', expiresAt: Date.now() - 1 },
  ]));
  const { mount, client } = await open(fakeClient(), 'spazio-prova', { sessionStorage: session });
  await flush();
  assert.equal(client.writes.length, 0, 'nothing to send again');
  assert.ok(noteRow(mount, 'Richiamare lunedì'), 'a withdrawal stored for another space hides nothing here');
  assert.ok(noteRow(mount, 'Preventivo inviato'), 'an expired entry hides nothing');
  const left = JSON.parse(session.getItem(NOTE_WITHDRAWALS_STORAGE_KEY)).map((entry) => `${entry.spaceId}/${entry.id}/${entry.noteId}`);
  assert.deepEqual(left, ['altro-spazio/c1/n-mia', 'spazio-prova/c9/n-mia'], 'done and expired entries leave, the others wait for their scheda');
});

test('4eceae80a5ca: after Aggiungi nota with Invio the cursor stays in the empty field', async () => {
  const doc = focusDocument();
  try {
    const { mount, client } = await open(fakeClient(), 'spazio-prova', { doc });
    const field = () => mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody');
    field().focus();
    field().value = 'Prima nota';
    field().dispatch('keydown', key('Enter'));
    await settle();
    assert.equal(client.writes.filter((write) => write.path === '/api/customer-hub/notes').length, 1);
    assert.equal(doc.activeElement, field(), 'the cursor is in the note field, never on the page body');
    assert.equal(field().value, '', 'and the field is empty for the next note');
  } finally {
    doc.restore();
  }
});

for (const [label, failure] of [
  ['the pilot refusing the same key (502)', Object.assign(new Error('Scrittura del pannello rifiutata'), { status: 502, code: 'BO_CRM_CLAIM_MISMATCH' })],
  ['a network failure', Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' })],
]) {
  test(`4eceae80a5ca: a failed send again after a reload (${label}) shows the note again, says so and forgets the entry`, async () => {
    const session = memoryStore();
    session.setItem(NOTE_WITHDRAWALS_STORAGE_KEY, JSON.stringify([
      { spaceId: 'spazio-prova', resource: 'contact', id: 'c1', noteId: 'n-mia', idempotencyKey: 'v1.20261114.0000000000000000000000000000000a', expiresAt: Date.now() + 60_000 },
    ]));
    const client = fakeClient({ refuse: { '/api/customer-hub/notes/withdraw': failure } });
    const { mount, toasts } = await open(client, 'spazio-prova', { sessionStorage: session });
    await flush();
    assert.equal(client.writes.length, 1, 'sent again once');
    assert.ok(noteRow(mount, 'Richiamare lunedì'), 'the note is back, never hidden in silence');
    assert.deepEqual([toasts.at(-1).text, toasts.at(-1).error], ['Non sono riuscito a eliminare la nota: riprova.', true]);
    assert.equal(session.getItem(NOTE_WITHDRAWALS_STORAGE_KEY), null, 'the entry is forgotten');
  });
}

test('4eceae80a5ca: a send again answered «already withdrawn» is done, quietly', async () => {
  const session = memoryStore();
  session.setItem(NOTE_WITHDRAWALS_STORAGE_KEY, JSON.stringify([
    { spaceId: 'spazio-prova', resource: 'contact', id: 'c1', noteId: 'n-mia', idempotencyKey: 'v1.20261114.0000000000000000000000000000000b', expiresAt: Date.now() + 60_000 },
  ]));
  const refused = Object.assign(new Error('withdrawn'), { status: 409, code: 'WORK_NOTE_WITHDRAWN' });
  // The first page's withdrawal landed between the cronologia read and the send again.
  const client = fakeClient();
  const original = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if (path === '/api/customer-hub/notes/withdraw') {
      client.writes.push({ path });
      client.state.items = client.state.items.filter((item) => item.id !== 'n-mia');
      throw refused;
    }
    return original(path, options);
  };
  const { mount, toasts } = await open(client, 'spazio-prova', { sessionStorage: session });
  await flush();
  assert.equal(noteRow(mount, 'Richiamare lunedì'), undefined, 'the note stays out');
  assert.ok(!toasts.some((entry) => entry.error), 'no error toast');
  assert.equal(session.getItem(NOTE_WITHDRAWALS_STORAGE_KEY), null);
});
