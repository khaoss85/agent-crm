import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_WITHDRAW_GRACE_MS,
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
        writes.push({ path, method, body });
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
        if (context instanceof Error) throw context;
        return context;
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

async function open(client = fakeClient()) {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const timer = manualWait();
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'spazio-prova', wait: timer.wait,
    toast: (text, error = false, options = {}) => toasts.push({ text, error, options }),
  });
  await view.renderCard('contact', 'c1');
  await flush();
  return { mount, view, client, toasts, timer };
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
  for (const [error, sentence] of [
    [{ status: 403, code: 'WORK_NOTE_NOT_AUTHOR' }, 'Solo chi ha scritto la nota può modificarla o eliminarla.'],
    [{ status: 404, code: 'WORK_NOTE_NOT_FOUND' }, 'Questa nota non c’è più: ricarica la scheda.'],
    [{ status: 409, code: 'WORK_NOTE_WITHDRAWN' }, 'Questa nota è stata eliminata: non si può più modificare.'],
    [{ status: 400, code: 'VALIDATION_ERROR', message: 'body must be at most 1000 characters' }, 'La nota è troppo lunga: al massimo 1000 caratteri.'],
  ]) {
    assert.equal(noteChangeRefusalText(error, 'Nota non modificata. Riprova più tardi.'), sentence);
  }
});
