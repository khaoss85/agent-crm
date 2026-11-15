import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView, defaultDeviceDictate } from '../apps/admin/public/admin-customer-card.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Voce 5036bc435465 (telefonate: nota vocale dopo la chiamata): «Detta
 * nota vocale» nella scheda cliente.
 *
 * What it must prove: the scheda offers «Detta nota vocale» beside the
 * note form; where the browser cannot dictate the Detta button stays
 * disabled and the field is typed; with a dictate seam the said words land
 * in the transcript; «Ordina con l'AI» fills the three editable fields
 * (riassunto, decisioni, prossimi passi) from POST
 * /api/call-intelligence/voice-note; «Salva in cronologia» writes the
 * composed note through the existing subject-note write, signed like every
 * note; with the AI off the option says why and the dictated text still
 * saves as-is; an empty dictation sends nothing.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  phone: { available: true, value: '+393331234567', system: 'phone', reason: null },
  email: 'guido@palestra-esempio.it',
  socials: [],
  status: { value: 'contatto' },
};

const timeline = (items = []) => ({
  customerTimelineContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  conversations: { available: true, count: 0, truncated: false, items: [] },
  entries: { available: true, count: items.length, truncated: false, items },
  appointments: { available: true, count: 0, truncated: false, items: [] },
});

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

const DRAFT = {
  riassunto: 'Chiamata andata bene: vuole provare prima di Natale.',
  decisioni: 'Prova gratuita di una settimana.',
  prossimiPassi: 'Elena richiama lunedì.',
};

function fakeClient({ voiceDraft = DRAFT, voiceRefusal = null } = {}) {
  const writes = [];
  return {
    writes,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        writes.push({ path, method, body });
        if (path === '/api/call-intelligence/voice-note') {
          const refusal = typeof voiceRefusal === 'function' ? voiceRefusal({ path, method, body }) : voiceRefusal;
          if (refusal !== null && refusal !== undefined) throw refusal;
          return { ...voiceDraft };
        }
        if (path === '/api/customer-hub/notes') {
          return { id: `n${writes.length}`, body: body.body, actorId: 'google|118', occurredAt: '2026-11-15T09:00:00.000Z' };
        }
        return { ok: true };
      }
      if (path.startsWith('/api/customer-hub/card/')) return CARD;
      if (path.startsWith('/api/customer-hub/timeline/')) return timeline();
      if (path.startsWith('/api/customer-data/profile/')) return PROFILE;
      if (path === '/api/spine/memberships') return ROSTER;
      if (path.startsWith('/api/audit')) return { items: [] };
      if (path === '/api/schema') return { pipelines: [] };
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

// The dictate seam: probe answers availability, start records its hooks so
// the test speaks without a microphone.
const stubDictate = (hooksLog) => (doc, hooks = {}) => {
  if (hooks.probe === true) return { stop() {} };
  hooksLog.push(hooks);
  return { stop() { hooksLog.push({ stopped: true }); } };
};

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

async function open(options = {}) {
  const { dictate, ...clientOptions } = options;
  const client = fakeClient(clientOptions);
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const view = createCustomerCardView({
    doc, mount, client, spaceId: 'presti',
    toast: (text) => toasts.push(text),
    ...(dictate === undefined ? {} : { dictate }),
  });
  await view.renderCard('contact', 'c1');
  await flush();
  return { mount, client, toasts };
}

const byAction = (mount, action) => mount.findAll('button')
  .find((node) => node.getAttribute('data-action') === action) ?? null;
const field = (mount, name) => mount.findAll('textarea')
  .find((node) => node.getAttribute('name') === name) ?? null;

const openPanel = async (mount) => {
  byAction(mount, 'dictate-note').listeners.click[0]();
  await flush();
};

test('5036bc435465: the scheda offers Detta nota vocale beside the note form', async () => {
  const { mount } = await open();
  assert.ok(byAction(mount, 'dictate-note'), 'the voice toggle is beside Aggiungi nota');
  assert.equal(byAction(mount, 'dictate-start'), null, 'the dictation panel stays closed until asked');
  await openPanel(mount);
  assert.ok(byAction(mount, 'dictate-start'), 'opening shows the dictation panel');
  assert.ok(field(mount, 'voiceNoteText'), 'the dictated text has its own field');
  assert.ok(field(mount, 'voiceRiassunto'), 'riassunto stays editable before saving');
  assert.ok(field(mount, 'voiceDecisioni'), 'decisioni stays editable before saving');
  assert.ok(field(mount, 'voiceProssimiPassi'), 'prossimi passi stays editable before saving');
});

test('5036bc435465: without device dictation the Detta button stays disabled and the field is typed', async () => {
  const { mount } = await open();
  await openPanel(mount);
  const detta = byAction(mount, 'dictate-start');
  assert.equal(detta.getAttribute('disabled'), '', 'no microphone promise where the browser cannot dictate');
  assert.ok(mount.textContent.includes('Questo browser non detta: scrivi qui sotto.'));
});

test('5036bc435465: said words land in the transcript, then the AI orders them and the note saves signed', async () => {
  const hooksLog = [];
  const { mount, client, toasts } = await open({ dictate: stubDictate(hooksLog) });
  await openPanel(mount);
  byAction(mount, 'dictate-start').listeners.click[0]();
  await flush();
  const hooks = hooksLog.find((entry) => typeof entry.onText === 'function');
  assert.ok(hooks, 'dictation starts with text and end hooks');
  hooks.onText('il cliente vuole provare prima di Natale');
  hooks.onText('richiamare lunedì');
  hooks.onEnd();
  await flush();
  assert.ok(
    field(mount, 'voiceNoteText').value.includes('il cliente vuole provare prima di Natale'),
    'the said words stay in the editable transcript',
  );

  byAction(mount, 'structure-voice-note').listeners.click[0]();
  await flush();
  assert.equal(field(mount, 'voiceRiassunto').value, DRAFT.riassunto, 'the AI draft fills riassunto');
  assert.equal(field(mount, 'voiceDecisioni').value, DRAFT.decisioni);
  assert.equal(field(mount, 'voiceProssimiPassi').value, DRAFT.prossimiPassi);
  const voiceCall = client.writes.find((write) => write.path === '/api/call-intelligence/voice-note');
  assert.ok(voiceCall, 'the draft comes from the voice-note endpoint');
  assert.equal(voiceCall.body.spaceId, 'presti', 'the space stays explicit, never inferred');

  field(mount, 'voiceProssimiPassi').value = 'Elena richiama martedì.';
  byAction(mount, 'save-voice-note').listeners.click[0]();
  await flush();
  const saved = client.writes.find((write) => write.path === '/api/customer-hub/notes');
  assert.ok(saved, 'the note saves through the existing subject-note write');
  assert.equal(
    saved.body.body,
    `Riassunto: ${DRAFT.riassunto}\nDecisioni: ${DRAFT.decisioni}\nProssimi passi: Elena richiama martedì.`,
    'the edited draft is what lands in the cronologia',
  );
  assert.deepEqual(toasts, ['Nota aggiunta in cima alla cronologia'], 'the saved note reads back signed');
});

test('5036bc435465: with the AI off the option says why and the dictated text still saves as-is', async () => {
  const hooksLog = [];
  const { mount, client } = await open({
    dictate: stubDictate(hooksLog),
    voiceRefusal: Object.assign(new Error('no model'), { status: 409, code: 'VOICE_NOTE_UNAVAILABLE' }),
  });
  await openPanel(mount);
  field(mount, 'voiceNoteText').value = 'chiamata breve, tutto ok';
  byAction(mount, 'structure-voice-note').listeners.click[0]();
  await flush();
  assert.ok(
    mount.textContent.includes('L’AI non è attiva in questo spazio'),
    'the option names the switched-off AI, never a fake draft',
  );
  byAction(mount, 'save-voice-note').listeners.click[0]();
  await flush();
  const saved = client.writes.find((write) => write.path === '/api/customer-hub/notes');
  assert.equal(saved.body.body, 'chiamata breve, tutto ok', 'the AI-off path still saves the dictated text');
});

test('5036bc435465: an empty dictation orders and saves nothing', async () => {
  const { mount, client } = await open({ dictate: stubDictate([]) });
  await openPanel(mount);
  byAction(mount, 'structure-voice-note').listeners.click[0]();
  await flush();
  byAction(mount, 'save-voice-note').listeners.click[0]();
  await flush();
  assert.equal(client.writes.length, 0, 'nothing leaves the phone without said words');
  assert.ok(mount.textContent.includes('Detta o scrivi prima com’è andata la chiamata.'));
});

test('5036bc435465: a draft structured from older words never saves as the new dictation', async () => {
  let voiceCalls = 0;
  const { mount, client } = await open({
    dictate: stubDictate([]),
    voiceRefusal: () => {
      voiceCalls += 1;
      return voiceCalls > 1 ? Object.assign(new Error('ai down'), { status: 502 }) : null;
    },
  });
  await openPanel(mount);
  field(mount, 'voiceNoteText').value = 'il cliente vuole provare prima di Natale';
  byAction(mount, 'structure-voice-note').listeners.click[0]();
  await flush();
  assert.equal(field(mount, 'voiceRiassunto').value, DRAFT.riassunto, 'the first reorder fills the draft');
  field(mount, 'voiceNoteText').value = 'il cliente vuole provare prima di Natale e chiede lo sconto';
  byAction(mount, 'structure-voice-note').listeners.click[0]();
  await flush();
  assert.ok(
    mount.textContent.includes('L’AI non ha risposto'),
    'the failed reorder says the AI did not answer, keeping the old draft on screen',
  );
  byAction(mount, 'save-voice-note').listeners.click[0]();
  await flush();
  assert.equal(
    client.writes.filter((write) => write.path === '/api/customer-hub/notes').length,
    0,
    'no stale draft lands in the cronologia as the new dictation',
  );
  assert.ok(
    mount.textContent.includes('La bozza è di un dettato diverso'),
    'the refused save names the stale draft and the reorder that fixes it',
  );
});

test('5036bc435465: device dictation reads array-like results without Symbol.iterator', () => {
  const said = [];
  const ended = [];
  let captured = null;
  class FakeRecognition {
    constructor() { captured = this; }
    start() {}
    stop() {}
  }
  const docNode = { defaultView: { SpeechRecognition: FakeRecognition, webkitSpeechRecognition: null } };
  const handle = defaultDeviceDictate(docNode, {
    onText: (text) => said.push(text),
    onEnd: () => ended.push(true),
  });
  assert.ok(handle && typeof handle.stop === 'function', 'recognition starts where the browser offers it');
  const interim = { isFinal: false, 0: { transcript: 'parziale' }, length: 1 };
  const fin = { isFinal: true, 0: { transcript: 'il cliente richiama lunedì' }, length: 1 };
  // Array-like on purpose: indexed with length, no Symbol.iterator — the
  // shape for...of cannot walk on some implementations (webkit).
  const results = { 0: interim, 1: fin, length: 2 };
  assert.equal(typeof results[Symbol.iterator], 'undefined', 'the fixture really is not iterable');
  captured.onresult({ results });
  assert.deepEqual(said, ['il cliente richiama lunedì'], 'only the final transcript reaches the field');
  captured.onend();
  handle.stop();
  assert.deepEqual(ended, [true], 'the end still closes the dictation');
});
