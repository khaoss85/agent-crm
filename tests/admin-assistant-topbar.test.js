// Dan 05/11: the words typed in the top bar are never dropped. With free
// questions off they run the closest suggestion, and channels read in Italian.
import test from 'node:test';
import assert from 'node:assert/strict';
import { closestSuggestion, channelName, suggestionsFor } from '../apps/admin/public/admin-assistant.js';

test('a typed question runs the closest suggestion of the screen', () => {
  const titles = suggestionsFor('clienti').map((s) => s.title);
  assert.ok(titles.includes('Chi devo ricontattare?'));
  assert.equal(closestSuggestion('clienti', 'chi devo ricontattare oggi?')?.title, 'Chi devo ricontattare?');
  assert.equal(closestSuggestion('clienti', 'quali lead sono più caldi')?.title, 'Quali lead mostrano segnali caldi?');
});

test('no overlap, empty or non-string questions match nothing', () => {
  assert.equal(closestSuggestion('clienti', 'meteo a Milano'), null);
  assert.equal(closestSuggestion('clienti', '   '), null);
  assert.equal(closestSuggestion('clienti', undefined), null);
});

test('channel ids read in Italian, unknown ids stay short and as they are', () => {
  assert.equal(channelName('phone'), 'Telefono');
  assert.equal(channelName('facebook'), 'Facebook');
  assert.equal(channelName('WhatsApp'), 'WhatsApp');
  assert.equal(channelName('carrier-pigeon'), 'carrier-pigeon');
});

import { createAssistantPanel } from '../apps/admin/public/admin-assistant.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const CONVS = { items: [
  { id: 'conv-1', status: 'open', channel: 'phone', subjectResource: 'contact', subjectId: 'contact-1', subjectLabel: 'Gia Brezzi', updatedAt: '2026-11-04T10:00:00.000Z' },
  { id: 'conv-2', status: 'open', channel: 'facebook', subjectResource: 'contact', subjectId: 'contact-2', subjectLabel: 'Ida Rosa', updatedAt: '2026-11-04T09:00:00.000Z' },
] };

function panelWith() {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/modules/conversation/records')) return CONVS;
      const error = new Error(`no such module (${path})`);
      Object.assign(error, { status: 404, code: 'MODULE_NOT_FOUND' });
      throw error;
    },
  };
  return { mount, panel: createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {} }) };
}

test('open(question): the top-bar words run «Chi devo ricontattare?» and its channels read in Italian', async () => {
  const { mount, panel } = panelWith();
  await panel.open('clienti', undefined, undefined, 'chi devo ricontattare oggi?');
  const text = mount.textContent;
  assert.ok(text.includes('«chi devo ricontattare oggi?»'), 'the typed words are echoed');
  assert.ok(text.includes('rispondo con «Chi devo ricontattare?»'), 'the panel names the suggestion it ran');
  assert.ok(text.includes('(Telefono)') && text.includes('(Facebook)'), 'channels read in Italian on the real path');
  assert.ok(!text.includes('(phone)') && !text.includes('(facebook)'));
});

test('open(question) with no match clears the previous answer instead of showing it', async () => {
  const { mount, panel } = panelWith();
  await panel.open('clienti', undefined, undefined, 'chi devo ricontattare oggi?');
  assert.ok(mount.textContent.includes('Gia Brezzi'));
  await panel.open('clienti', undefined, undefined, 'meteo a Milano');
  const text = mount.textContent;
  assert.ok(text.includes('scegli una delle domande qui sotto'));
  assert.ok(!text.includes('Gia Brezzi'), 'the old answer is gone');
});

test('a tie on the best overlap runs nothing (ambiguous)', () => {
  assert.equal(closestSuggestion('cliente', 'cosa'), null, '«cosa» opens two suggestions on the scheda');
});

test('review #596 P2: a second top-bar question while the first runs waits, then runs; no mismatched pair', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.startsWith('/api/modules/conversation/records')) {
        calls += 1;
        if (calls === 1) await gate;
        return CONVS;
      }
      const error = new Error(`no such module (${path})`);
      Object.assign(error, { status: 404, code: 'MODULE_NOT_FOUND' });
      throw error;
    },
  };
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {} });
  const first = panel.open('clienti', undefined, undefined, 'chi devo ricontattare oggi?');
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  await panel.open('clienti', undefined, undefined, 'meteo a Milano');
  assert.ok(mount.textContent.includes('«meteo a Milano»'), 'the waiting question is on screen');
  assert.ok(mount.textContent.includes('Finisco la risposta in corso'), 'the panel says it waits');
  release();
  await first;
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  const text = mount.textContent;
  assert.ok(text.includes('«meteo a Milano»'), 'the newest question is the one shown');
  assert.ok(text.includes('scegli una delle domande qui sotto'), 'and it ran (no match → the honest line)');
  assert.ok(!text.includes('Gia Brezzi'), 'the first answer never sits under the second question');
  assert.ok(!text.includes('Finisco la risposta in corso'), 'the queue drained');
});
