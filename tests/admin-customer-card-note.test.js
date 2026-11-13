import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:82235e46e3e9 (giro UX 11/11), note e Dettagli della scheda:
 * Invio aggiunge la nota e Maiusc+Invio va a capo; la nota è firmata con il
 * nome di chi l'ha scritta; lo stato vuoto non promette un messaggio dove
 * c'è il campo nota; «Tutti i contatti» mostra le offerte e i cambi di
 * stato; in Dettagli Invio salva ed Esc annulla.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: false, value: null },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto' },
};

const entries = (items) => ({
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: items.length, truncated: false, items },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});

const MESSAGE = {
  entry: 'message', id: 'm1', conversationId: 't1', channel: 'whatsapp', direction: 'inbound',
  sync: 'received', body: 'Ciao', teamAuthorId: null, remoteHandle: '+393331234567', errorCode: null,
  occurredAt: '2026-11-10T09:00:00.000Z',
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
  opportunities: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
  quotes: { available: true, count: 0, countIsComplete: true, truncated: false, items: [] },
};

const ROSTER = { items: [{ subject: 'google|118', displayName: 'Elena Rinaldi', email: 'elena@studio.it' }] };

function fakeClient({ timeline = entries([MESSAGE]), profile = PROFILE, audit = [], roster = ROSTER, noteRefusal = null } = {}) {
  const writes = [];
  const reads = [];
  return {
    writes,
    reads,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        writes.push({ path, method, body });
        if (path === '/api/customer-hub/notes' && noteRefusal !== null) throw noteRefusal;
        if (path === '/api/customer-hub/notes') return { id: `n${writes.length}`, body: body.body, actorId: 'google|118', occurredAt: '2026-11-11T10:00:00.000Z' };
        return { ok: true };
      }
      reads.push(path);
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return timeline;
      if (path.startsWith('/api/customer-data/profile/')) return profile;
      if (path === '/api/spine/memberships') return roster;
      if (path.startsWith('/api/audit')) return { items: audit };
      if (path === '/api/schema') return { pipelines: [] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(client = fakeClient()) {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({ doc, mount, client, spaceId: 'presti', toast: (text) => toasts.push(text) });
  await view.renderCard('contact', 'c1');
  await flush();
  return { mount, view, client, toasts };
}

const noteField = (mount) => mount.findAll('textarea').find((node) => node.getAttribute('name') === 'noteBody');
const byAction = (mount, action) => mount.findAll('button').find((node) => node.getAttribute('data-action') === action);
const key = (name, extra = {}) => ({ key: name, preventDefault() { this.prevented = true; }, ...extra });

test('82235e46e3e9: Invio adds the note, Maiusc+Invio goes to a new line', async () => {
  const { mount, client, toasts } = await open();
  const field = noteField(mount);
  assert.ok(field, 'the note field is a multi-line field');
  field.value = 'Prima riga';
  const shift = key('Enter', { shiftKey: true });
  field.dispatch('keydown', shift);
  assert.equal(shift.prevented, undefined, 'Maiusc+Invio keeps the new line');
  assert.equal(client.writes.length, 0, 'and adds nothing');
  field.value = 'Prima riga\nSeconda riga';
  const enter = key('Enter');
  field.dispatch('keydown', enter);
  await flush();
  assert.equal(enter.prevented, true);
  assert.deepEqual(client.writes.map((write) => [write.path, write.body.body]), [['/api/customer-hub/notes', 'Prima riga\nSeconda riga']]);
  assert.deepEqual(toasts, ['Nota aggiunta']);
  assert.equal(noteField(mount).value, '', 'the field is empty again');
  assert.ok(mount.textContent.includes('Invio aggiunge la nota, Maiusc+Invio va a capo.'), 'the help says how');
});

test('82235e46e3e9: Invio on an empty note or while composing a character sends nothing', async () => {
  const { mount, client } = await open();
  noteField(mount).dispatch('keydown', key('Enter'));
  assert.ok(mount.textContent.includes('Scrivi la nota prima di aggiungerla.'));
  noteField(mount).value = 'nota';
  noteField(mount).dispatch('keydown', key('Enter', { isComposing: true }));
  await flush();
  assert.equal(client.writes.length, 0);
});

test('82235e46e3e9: a note is signed with the name of who wrote it, never «dal team»', async () => {
  const note = { entry: 'note', id: 'n0', body: 'Richiamare lunedì', teamAuthorId: 'google|118', occurredAt: '2026-11-10T10:00:00.000Z' };
  const { mount } = await open(fakeClient({ timeline: entries([MESSAGE, note]) }));
  assert.ok(mount.textContent.includes('Nota · da Elena Rinaldi'), mount.textContent.slice(0, 400));
  assert.ok(!mount.textContent.includes('dal team'));
});

test('82235e46e3e9: without a roster a provider id still never shows, and the note reads «dal team»', async () => {
  const note = { entry: 'note', id: 'n0', body: 'Richiamare', teamAuthorId: 'google|118', occurredAt: '2026-11-10T10:00:00.000Z' };
  const failing = fakeClient({ timeline: entries([note]) });
  const base = failing.request.bind(failing);
  failing.request = async (path, options) => {
    if (path === '/api/spine/memberships') throw Object.assign(new Error('x'), { status: 403 });
    return base(path, options);
  };
  const { mount } = await open(failing);
  assert.ok(mount.textContent.includes('Nota · dal team'));
  assert.ok(!mount.textContent.includes('google|118'));
});

test('82235e46e3e9: the empty state names «Scrivi» for messages and the note field below', async () => {
  const { mount } = await open(fakeClient({ timeline: entries([]) }));
  assert.ok(mount.textContent.includes('Ancora nessun contatto'));
  assert.ok(mount.textContent.includes('Scrivi al cliente con «Scrivi», oppure aggiungi una nota qui sotto.'));
  assert.ok(!mount.textContent.includes('primo messaggio qui sotto'));
});

test('82235e46e3e9: «Tutti i contatti» shows the offer created and its stage moves, signed by name', async () => {
  const profile = {
    ...PROFILE,
    opportunities: {
      available: true, count: 1, countIsComplete: true, truncated: false,
      items: [{ id: 'o1', name: 'Pacchetto 10 ingressi', stage: 'proposal', status: 'proposal', createdAt: '2026-11-09T08:00:00.000Z' }],
    },
  };
  const audit = [{
    id: 'a1', action: 'opportunity.stage_changed', actorType: 'user', actorId: 'google|118',
    data: { from: 'qualification', to: 'proposal' }, createdAt: '2026-11-10T15:00:00.000Z',
  }];
  const { mount } = await open(fakeClient({ profile, audit }));
  const list = mount.findAll('section').find((node) => String(node.getAttribute('class')).includes('bo-scheda-card-timeline'));
  const text = list.textContent;
  assert.ok(text.includes('Offerta creata'), text);
  assert.ok(text.includes('Pacchetto 10 ingressi'));
  assert.ok(/Cambio di stato · da Elena Rinaldi/.test(text), 'the move is signed by name, never «da utente»');
  assert.ok(text.includes('Pacchetto 10 ingressi: da '), 'the move names the offer and its stages');
  assert.ok(!text.includes('da utente'));
  // A channel filter shows that channel only.
  const chip = mount.findAll('button').find((node) => node.getAttribute('data-channel') === 'whatsapp');
  assert.ok(chip, 'the WhatsApp chip exists');
  chip.dispatch('click');
  const filtered = mount.findAll('section').find((node) => String(node.getAttribute('class')).includes('bo-scheda-card-timeline')).textContent;
  assert.ok(!filtered.includes('Offerta creata'), 'a channel filter leaves the offer out');
  assert.ok(filtered.includes('Ciao'), 'and keeps the channel passages');
});

test('82235e46e3e9: in Dettagli Invio saves and Esc cancels', async () => {
  const { mount, client } = await open();
  byAction(mount, 'edit-details').listeners.click[0]();
  const first = mount.findAll('input').find((node) => node.getAttribute('name') === 'firstName');
  first.value = 'Guido Maria';
  first.dispatch('keydown', key('Enter'));
  await flush();
  assert.deepEqual(client.writes.map((write) => write.path), ['/api/contacts/c1']);
  assert.equal(client.writes[0].body.firstName, 'Guido Maria');
  assert.equal(byAction(mount, 'save-details'), undefined, 'the form closed after the save');

  byAction(mount, 'edit-details').listeners.click[0]();
  const email = mount.findAll('input').find((node) => node.getAttribute('name') === 'email');
  email.value = 'cambiata@esempio.it';
  email.dispatch('keydown', key('Escape'));
  await flush();
  assert.equal(byAction(mount, 'save-details'), undefined, 'Esc closes the form');
  assert.equal(client.writes.length, 1, 'Esc writes nothing');
  assert.ok(!mount.textContent.includes('cambiata@esempio.it'), 'the edit is gone');
});

// Review Muse #793 (P2): the roster arriving while a note is saving
// repaints the scheda; the rebuilt field's Invio must not post it again.
test('82235e46e3e9: a repaint while the note is saving never posts it twice', async () => {
  let releaseRoster;
  const rosterGate = new Promise((resolve) => { releaseRoster = resolve; });
  let releasePost;
  const postGate = new Promise((resolve) => { releasePost = resolve; });
  const note = { entry: 'note', id: 'n0', body: 'Vecchia', teamAuthorId: 'google|118', occurredAt: '2026-11-10T10:00:00.000Z' };
  const base = fakeClient({ timeline: entries([MESSAGE, note]) });
  const client = {
    writes: base.writes,
    reads: base.reads,
    async request(path, options = {}) {
      if (path === '/api/spine/memberships') {
        await rosterGate;
        return ROSTER;
      }
      if (options.method === 'POST' && path === '/api/customer-hub/notes') {
        const answer = base.request(path, options);
        await postGate;
        return answer;
      }
      return base.request(path, options);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  await createCustomerCardView({ doc, mount, client, spaceId: 'presti', toast: () => {} }).renderCard('contact', 'c1');
  noteField(mount).value = 'Richiamare domani';
  noteField(mount).dispatch('keydown', key('Enter'));
  await flush();
  assert.equal(client.writes.length, 1, 'the note is saving');
  releaseRoster();
  await flush();
  assert.ok(mount.textContent.includes('Nota · da Elena Rinaldi'), 'the roster repaint happened');
  noteField(mount).value = 'Richiamare domani';
  noteField(mount).dispatch('keydown', key('Enter'));
  await flush();
  assert.equal(client.writes.length, 1, 'the rebuilt field does not post the same note again');
  releasePost();
  await flush();
});

// Production 12/11 (pilota 21ade52): a note on two lines answered 400
// VALIDATION_ERROR and the scheda said «Nota non salvata. Riprova più
// tardi.» — retrying the same text is refused again. A validation refusal
// says what to correct.
test('82235e46e3e9 seguito: a refused note says what to correct, never «Riprova più tardi»', async () => {
  const refusal = Object.assign(new Error('body must not contain control characters'), { status: 400, code: 'VALIDATION_ERROR' });
  const { mount, toasts } = await open(fakeClient({ noteRefusal: refusal }));
  noteField(mount).value = 'Una nota';
  byAction(mount, 'add-note').dispatch('click');
  await flush();
  assert.ok(!mount.textContent.includes('Riprova più tardi'), 'never «Riprova più tardi» for a refused text');
  assert.ok(mount.textContent.includes('La nota contiene caratteri non ammessi'), 'it names what to correct');
  assert.equal(noteField(mount).value, 'Una nota', 'the text stays to be corrected');
  assert.ok(toasts.some((text) => text.includes('caratteri non ammessi')));
});

test('82235e46e3e9 seguito: a note over 1000 characters is stopped before sending, with the limit', async () => {
  const { mount, client } = await open();
  noteField(mount).value = 'a'.repeat(1001);
  byAction(mount, 'add-note').dispatch('click');
  await flush();
  assert.equal(client.writes.length, 0, 'nothing posted');
  assert.ok(mount.textContent.includes('La nota è troppo lunga: al massimo 1000 caratteri.'));
});
