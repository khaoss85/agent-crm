import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView, withContactDetails, withNote, withOfferStage, withOpportunity } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:2a214b66fe12 (giro UX 11/11): after a note, a Dettagli save, a new
 * offer or a «Cambia stato», the scheda used to re-read its eight sources
 * (2.5–4 s each) and repaint only at the end, while the toast had already
 * spoken — «Spostata in Proposta» with the pill still on «Richiesta info».
 * Now the write shows at once, in the same moment as the toast, and only
 * the touched part is read again.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto', reason: 'x' },
};

const TIMELINE = {
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: {
    available: true, count: 1, truncated: false,
    items: [{
      entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
      sync: 'received', body: 'Ciao, vorrei prenotare una prova', teamAuthorId: null,
      remoteHandle: '+393331234567', errorCode: null, occurredAt: '2026-10-20T09:00:00.000Z',
    }],
  },
  appointments: { available: true, count: 0, truncated: false, items: [] },
};

const PROFILE = {
  customerProfileContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  canonicalIdentity: { linked: false, members: [] },
  identity: {
    company: { id: 'co1', name: 'Palestra Esempio' },
    contact: { id: 'c1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it', companyId: 'co1' },
  },
  externalIdentities: [],
  opportunities: {
    available: true, count: 1, countIsComplete: true, truncated: false,
    items: [{ id: 'o1', status: 'qualification', stage: 'qualification', name: 'Pacchetto 10 ingressi' }],
  },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

/**
 * Serves the scheda; after the first full read, `hold()` makes every read
 * wait until `release()`, so a test sees the screen between the write and
 * the re-read.
 */
function fakeClient({ onWrite = null, server = {} } = {}) {
  const state = { card: CARD, timeline: TIMELINE, profile: PROFILE, ...server };
  const reads = [];
  const writes = [];
  let gate = null;
  let open = () => {};
  let failReads = false;
  return {
    state,
    reads,
    writes,
    hold() { gate = new Promise((resolve) => { open = resolve; }); },
    release() { open(); gate = null; },
    failReads(on) { failReads = on; },
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        writes.push({ path, method, body });
        return typeof onWrite === 'function' ? onWrite({ path, body, state }) : { ok: true };
      }
      reads.push(path);
      if (gate !== null) await gate;
      if (failReads) throw Object.assign(new Error('boom'), { status: 503 });
      if (path.startsWith('/api/customer-hub/card/')) return state.card;
      if (path.startsWith('/api/customer-hub/timeline/')) return state.timeline;
      if (path.startsWith('/api/customer-data/profile/')) return state.profile;
      if (path === '/api/schema') return { pipelines: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/catalog/products?active=true') return { products: [] };
      if (path === '/api/profile') return { member: { name: 'Elena Rinaldi' } };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(client) {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  // The screen as it is at each toast: toast and screen must agree.
  const atToast = [];
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti',
    toast: (text) => { toasts.push(text); atToast.push(mount.textContent); },
  });
  await view.renderCard('contact', 'c1');
  await flush();
  client.reads.length = 0;
  return { mount, view, toasts, atToast };
}

const byAction = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
const READ_KINDS = (reads) => reads.map((path) => path.replace(/^\/api\/([^/?]+\/[^/?]+).*$/, '$1'));

test('2a214b66fe12: a note shows in the cronologia with its toast, and only the cronologia is read again', async () => {
  const client = fakeClient({
    onWrite: ({ path, body, state }) => {
      if (path !== '/api/customer-hub/notes') return { ok: true };
      const row = { id: 'n1', body: body.body, actorId: 'elena', occurredAt: '2026-11-11T10:00:00.000Z' };
      state.timeline = {
        ...state.timeline,
        entries: { ...state.timeline.entries, items: [{ entry: 'note', ...row, teamAuthorId: 'elena', channel: null }, ...state.timeline.entries.items] },
      };
      return row;
    },
  });
  const { mount, toasts, atToast } = await open(client);
  mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value = 'Richiamare lunedì';
  client.hold();
  const saving = byAction(mount, 'add-note').listeners.click[0]();
  await flush();
  assert.deepEqual(toasts, ['Nota aggiunta']);
  assert.ok(atToast[0].includes('Richiamare lunedì'), 'the note is on screen when the toast speaks');
  assert.ok(mount.textContent.includes('Richiamare lunedì'), 'before the re-read answers');
  assert.equal(mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value, '', 'the field is empty');
  assert.deepEqual(READ_KINDS(client.reads), ['customer-hub/timeline'], 'only the cronologia is read again');
  client.release();
  await saving;
  await flush();
  assert.equal(mount.textContent.split('Richiamare lunedì').length - 1, 1, 'the server answer replaces the copy: one note, never two');
});

test('2a214b66fe12: a Dettagli save shows the new name at once and re-reads only card and profile', async () => {
  const client = fakeClient({
    onWrite: ({ path, body, state }) => {
      state.card = { ...state.card, name: `${body.firstName} ${body.lastName}`, email: body.email };
      state.profile = { ...state.profile, identity: { ...state.profile.identity, contact: { ...state.profile.identity.contact, ...body } } };
      return { id: 'c1', ...body, path };
    },
  });
  const { mount, toasts, atToast } = await open(client);
  byAction(mount, 'edit-details').listeners.click[0]();
  mount.findAll('input').find((node) => node.getAttribute('name') === 'firstName').value = 'Guido Maria';
  client.hold();
  const saving = byAction(mount, 'save-details').listeners.click[0]();
  await flush();
  assert.deepEqual(toasts, ['Dati salvati']);
  assert.ok(atToast[0].includes('Guido Maria Presti'), 'the header names the new name when the toast speaks');
  assert.equal(byAction(mount, 'save-details'), undefined, 'the form is closed');
  assert.deepEqual(READ_KINDS(client.reads).sort(), ['customer-data/profile', 'customer-hub/card']);
  client.release();
  await saving;
  await flush();
  assert.ok(mount.textContent.includes('Guido Maria Presti'));
});

test('2a214b66fe12: Annulla in Dettagli reads nothing', async () => {
  const client = fakeClient();
  const { mount } = await open(client);
  byAction(mount, 'edit-details').listeners.click[0]();
  await byAction(mount, 'cancel-details').listeners.click[0]();
  assert.equal(byAction(mount, 'save-details'), undefined, 'the form is closed');
  assert.deepEqual(client.reads, [], 'no read for a form that wrote nothing');
});

test('2a214b66fe12: «Cambia stato» moves the pill with its toast and re-reads only card and profile', async () => {
  const client = fakeClient({
    onWrite: ({ state }) => {
      state.profile = { ...state.profile, opportunities: { ...state.profile.opportunities, items: [{ ...state.profile.opportunities.items[0], stage: 'proposal', status: 'proposal' }] } };
      return { runId: 'r1', status: 'completed', output: { outcome: 'moved' } };
    },
  });
  const { mount, toasts, atToast } = await open(client);
  const stateBefore = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-offer-state').textContent;
  byAction(mount, 'change-offer-stage').listeners.click[0]();
  const voice = mount.findAll('button').find((node) => node.getAttribute('data-stage') === 'proposal')
    ?? mount.findAll('button').find((node) => (node.getAttribute('role') === 'menuitem') && /propost/i.test(node.textContent));
  assert.ok(voice, 'the menu offers the proposal stage');
  client.hold();
  const moving = voice.listeners.click[0]();
  await flush();
  assert.deepEqual(toasts, ['Stato aggiornato']);
  const stateAfterRead = READ_KINDS(client.reads).filter((kind) => !kind.startsWith('/api/audit') && kind !== 'spine/memberships');
  const stateAfter = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-offer-state').textContent;
  assert.notEqual(stateAfter, stateBefore, 'the pill moved before the re-read');
  assert.ok(atToast[0].includes(stateAfter), 'the screen says the new stage when the toast speaks');
  // Card and profile, plus «Storia stati» of that offer: the move is new history.
  assert.deepEqual(stateAfterRead.sort(), ['customer-data/profile', 'customer-hub/card']);
  client.release();
  await moving;
  await flush();
  assert.equal(client.reads.filter((path) => path.startsWith('/api/audit?entityType=opportunity&entityId=o1')).length, 1,
    'the history of the moved offer is read again, once for both paints');
  assert.equal(mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-offer-state').textContent, stateAfter);
});

test('2a214b66fe12: a new offer shows on the scheda with its toast and re-reads only the profile', async () => {
  const created = { id: 'o2', name: 'Pacchetto estate', stage: 'qualification', status: 'qualification', valueCents: 35000, currency: 'EUR' };
  const client = fakeClient({
    onWrite: ({ path, state }) => {
      if (path !== '/api/opportunities') return { ok: true };
      state.profile = { ...state.profile, opportunities: { ...state.profile.opportunities, items: [created, ...state.profile.opportunities.items] } };
      return created;
    },
  });
  const { mount, toasts, atToast } = await open(client);
  byAction(mount, 'new-offer').listeners.click[0]();
  // Voce 2c1c0e149cf9: Offerta is a menu — the manual voice opens the window.
  mount.findAll('button').find((node) => node.getAttribute('data-voice') === 'manual').listeners.click[0]();
  await flush();
  const panel = mount.findAll('div').find((node) => node.getAttribute('data-offer-panel') === 'open');
  panel.findAll('input').find((node) => node.getAttribute('name') === 'offer-title').value = 'Pacchetto estate';
  panel.findAll('input').find((node) => node.getAttribute('name') === 'offer-value').value = '350';
  client.reads.length = 0;
  client.hold();
  const creating = panel.__submit();
  await flush();
  assert.deepEqual(toasts, ['Offerta creata']);
  assert.ok(atToast[0].includes('Pacchetto estate'), 'the new offer is on the scheda when the toast speaks');
  assert.deepEqual(READ_KINDS(client.reads.filter((path) => !path.startsWith('/api/audit') && path !== '/api/spine/memberships')),
    ['customer-data/profile'], 'only the profile is read again');
  client.release();
  await creating;
  await flush();
  assert.ok(mount.textContent.includes('Pacchetto estate'));
});

test('2a214b66fe12: a move waiting for approval does not move the pill', async () => {
  const client = fakeClient({ onWrite: () => ({ runId: 'r1', status: 'waiting', output: { outcome: 'approval_required' } }) });
  const { mount, toasts } = await open(client);
  const stateBefore = mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-offer-state').textContent;
  byAction(mount, 'change-offer-stage').listeners.click[0]();
  const voice = mount.findAll('button').find((node) => (node.getAttribute('role') === 'menuitem') && /propost/i.test(node.textContent));
  client.hold();
  const moving = voice.listeners.click[0]();
  await flush();
  assert.equal(toasts[0], 'Stato aggiornato: serve un’approvazione');
  assert.equal(mount.findAll('span').find((node) => node.getAttribute('class') === 'bo-scheda-offer-state').textContent, stateBefore);
  client.release();
  await moving;
});

test('2a214b66fe12: a failed re-read keeps the written note on screen', async () => {
  const client = fakeClient({ onWrite: ({ body }) => ({ id: 'n1', body: body.body, actorId: 'elena' }) });
  const { mount } = await open(client);
  mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value = 'Nota importante';
  client.failReads(true);
  await byAction(mount, 'add-note').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('Nota importante'), 'the note stays');
  assert.ok(!mount.textContent.includes('non si è potuta leggere'), 'no error replaces the cronologia the write just changed');
});

test('2a214b66fe12: a full re-read started before the note never paints over it', async () => {
  const client = fakeClient({ onWrite: ({ body }) => ({ id: 'n1', body: body.body, actorId: 'elena' }) });
  const { mount, view } = await open(client);
  client.hold();
  const full = view.renderCard('contact', 'c1');
  await flush();
  mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value = 'Scritta durante la lettura';
  const saving = byAction(mount, 'add-note').listeners.click[0]();
  await flush();
  // The server now knows the note; the full read in flight was asked before it.
  client.state.timeline = {
    ...client.state.timeline,
    entries: { ...client.state.timeline.entries, items: [{ entry: 'note', id: 'n1', body: 'Scritta durante la lettura', teamAuthorId: 'elena', occurredAt: '2026-11-11T10:00:00.000Z' }, ...TIMELINE.entries.items] },
  };
  client.release();
  await Promise.all([full, saving]);
  await flush();
  assert.ok(mount.textContent.includes('Scritta durante la lettura'), 'the note is still there');
});

test('2a214b66fe12: the patch helpers never touch what they read', () => {
  const loaded = Object.freeze({
    card: Object.freeze({ ...CARD }),
    timeline: TIMELINE,
    profile: PROFILE,
  });
  const noted = withNote(loaded, { id: 'n1', actorId: 'elena', occurredAt: '2026-11-11T10:00:00.000Z' }, 'Ciao');
  assert.equal(noted.timeline.entries.items[0].body, 'Ciao');
  assert.equal(noted.timeline.entries.items[0].teamAuthorId, 'elena');
  assert.equal(loaded.timeline.entries.items.length, 1);
  const named = withContactDetails(loaded, { firstName: 'Ada', lastName: 'Rossi', email: '' });
  assert.equal(named.card.name, 'Ada Rossi');
  assert.equal(named.card.email, null);
  assert.equal(named.profile.identity.contact.firstName, 'Ada');
  assert.equal(loaded.card.name, 'Guido Presti');
  const offered = withOpportunity(loaded, { id: 'o2', name: 'Nuova', stage: 'qualification' });
  assert.deepEqual(offered.profile.opportunities.items.map((row) => row.id), ['o2', 'o1']);
  const moved = withOfferStage(loaded, 'o1', 'pipeline', 'proposta');
  assert.equal(moved.profile.opportunities.items[0].pipelineStage, 'proposta');
  assert.equal(loaded.profile.opportunities.items[0].pipelineStage, undefined);
});

// Review Muse giro 1 su #787.
test('review #787: what Aggiorna read survives the repaint after a note', async () => {
  let enriched = { customerEnrichmentContract: 1, subject: { resource: 'contact', id: 'c1' }, linked: true, optedOut: null, items: [] };
  const client = fakeClient({
    onWrite: ({ body, state }) => {
      const row = { id: 'n1', body: body.body, actorId: 'elena', occurredAt: '2026-11-11T10:00:00.000Z' };
      state.timeline = { ...state.timeline, entries: { ...state.timeline.entries, items: [{ entry: 'note', ...row, teamAuthorId: 'elena' }, ...state.timeline.entries.items] } };
      return row;
    },
  });
  const base = client.request.bind(client);
  client.request = async (path, options = {}) => {
    if (path.startsWith('/api/customer-data/enriched/')) return enriched;
    return base(path, options);
  };
  const { mount } = await open(client);
  enriched = { ...enriched, items: [{ field: 'role', value: 'Personal trainer', source: 'email-signature', observedAt: '2026-11-10T09:00:00.000Z' }] };
  await byAction(mount, 'refresh-enrichment').listeners.click[0]();
  assert.ok(mount.textContent.includes('Personal trainer'), 'Aggiorna paints the fresh row');
  mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value = 'Nota dopo Aggiorna';
  await byAction(mount, 'add-note').listeners.click[0]();
  await flush();
  assert.ok(mount.textContent.includes('Nota dopo Aggiorna'));
  assert.ok(mount.textContent.includes('Personal trainer'), 'the repaint keeps what Aggiorna read');
});

test('review #787: a cronologia re-read older than a full read never paints over it', async () => {
  const client = fakeClient({ onWrite: ({ body }) => ({ id: 'n1', body: body.body, actorId: 'elena' }) });
  const { mount, view } = await open(client);
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const base = client.request.bind(client);
  let held = 0;
  client.request = async (path, options = {}) => {
    // The first cronologia re-read (after the note) answers late, with the
    // server state of that moment.
    if (path.startsWith('/api/customer-hub/timeline/') && held === 0) {
      held += 1;
      const stale = client.state.timeline;
      await oldGate;
      return stale;
    }
    return base(path, options);
  };
  mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value = 'Prima nota';
  const saving = byAction(mount, 'add-note').listeners.click[0]();
  await flush();
  // Meanwhile the server gains a second write and a full read sees it.
  client.state.timeline = {
    ...client.state.timeline,
    entries: { ...client.state.timeline.entries, items: [
      { entry: 'note', id: 'n1', body: 'Prima nota', teamAuthorId: 'elena', occurredAt: '2026-11-11T10:00:00.000Z' },
      { entry: 'note', id: 'n2', body: 'Seconda nota', teamAuthorId: 'elena', occurredAt: '2026-11-11T10:01:00.000Z' },
      ...TIMELINE.entries.items,
    ] },
  };
  await view.renderCard('contact', 'c1');
  assert.ok(mount.textContent.includes('Seconda nota'), 'the full read shows the second write');
  releaseOld();
  await saving;
  await flush();
  assert.ok(mount.textContent.includes('Seconda nota'), 'the older re-read never hides it');
});

test('review #787: a failed re-read after a write is logged with its cause, never the note', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const client = fakeClient({ onWrite: ({ body }) => ({ id: 'n1', body: body.body, actorId: 'elena' }) });
    const { mount } = await open(client);
    mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody').value = 'Testo riservato';
    client.failReads(true);
    await byAction(mount, 'add-note').listeners.click[0]();
    await flush();
  } finally {
    console.error = original;
  }
  const entry = logged.find(([label]) => label === '[bo] scheda non riletta');
  assert.ok(entry, 'the failed re-read is logged');
  assert.deepEqual(entry[1], { area: 'scheda-timeline', code: null, name: 'Error', spaceId: 'presti', status: 503 });
  assert.ok(!JSON.stringify(logged).includes('Testo riservato'), 'never the note itself');
});
