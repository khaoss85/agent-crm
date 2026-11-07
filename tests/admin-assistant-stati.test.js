import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantPanel, runSuggestion } from '../apps/admin/public/admin-assistant.js';
import {
  SYNC_LABELS, callOutcomeLabel, italianLabel, romeClock,
} from '../apps/admin/public/admin-labels.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// Voce 52854fd292a3: the supervisor saw «completed: 2», «missed: 1», sources
// «completed +39 333 000 0001» and history «— 05:25:28 UTC» in the panel.
// States read in Italian, sources name the customer, times read in Rome.

const RAW = /\b(completed|missed|no-answer|failed|received|sent|delivered|unknown)\b|UTC/;

const CONVS = {
  items: [
    { id: 'conv-1', status: 'open', channel: 'phone', remoteHandle: '+39 333 000 0001', subjectLabel: 'Mario Rossi' },
  ],
};

const CALLS = {
  items: [
    {
      id: 'call-1', outcome: 'completed', teamAuthorId: 'guido', remoteHandle: '+39 333 000 0001',
      conversationId: 'conv-1', updatedAt: '2026-11-06T09:00:00.000Z',
    },
    {
      id: 'call-2', outcome: 'missed', teamAuthorId: 'maria', remoteHandle: '+39 333 000 0002',
      conversationId: 'conv-unknown', updatedAt: '2026-11-06T08:00:00.000Z',
    },
    {
      id: 'call-3', outcome: 'completed', teamAuthorId: 'guido', remoteHandle: '+39 333 000 0003',
      updatedAt: '2026-11-06T07:00:00.000Z',
    },
    { id: 'call-4', outcome: 'mystery', teamAuthorId: 'guido', updatedAt: '2026-11-06T06:00:00.000Z' },
  ],
};

function stubClient(routes) {
  return {
    async request(path) {
      if (Object.hasOwn(routes, path)) return routes[path];
      const error = new Error(`no such module (${path})`);
      Object.assign(error, { status: 404, code: 'MODULE_NOT_FOUND' });
      throw error;
    },
  };
}

const ROUTES = {
  '/api/modules/interaction-call/records?limit=100': CALLS,
  '/api/modules/conversation/records?limit=50': CONVS,
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function visibleStrings(answer) {
  return [
    ...answer.lines,
    ...answer.sources.map((source) => source.label),
    ...answer.actions.map((action) => action.label),
  ];
}

test('telefono: esiti in italiano, mai il valore grezzo', async () => {
  const answer = await runSuggestion(stubClient(ROUTES), 'bo04:oggi:chiamate');
  assert.ok(answer.lines.includes('• riuscita: 2'), JSON.stringify(answer.lines));
  assert.ok(answer.lines.includes('• persa: 1'), JSON.stringify(answer.lines));
  assert.ok(answer.lines.includes('• senza esito: 1'), JSON.stringify(answer.lines));
  for (const text of visibleStrings(answer)) assert.doesNotMatch(text, RAW, text);
});

test('telefono: fonti e azioni nominano il cliente, numero mascherato solo senza nome', async () => {
  const answer = await runSuggestion(stubClient(ROUTES), 'bo04:oggi:chiamate');
  const labels = answer.sources.map((source) => source.label);
  assert.deepEqual(labels, [
    'Mario Rossi · chiamata riuscita',
    '+39 …0002 · chiamata persa',
    '+39 …0003 · chiamata riuscita',
    'Chiamata senza esito',
  ]);
  assert.equal(answer.actions[0].label, 'Apri: Mario Rossi · chiamata riuscita');
  for (const text of visibleStrings(answer)) {
    assert.ok(!text.includes('000 0001') && !text.includes('000 0002'), `full number leaked: ${text}`);
    assert.ok(!/call-\d/.test(text), `record id leaked: ${text}`);
  }
});

test('telefono: senza conversationId nessuna lettura in più, nessun nome inventato', async () => {
  const reads = [];
  const client = {
    async request(path) {
      reads.push(path);
      return { items: [{ id: 'call-9', outcome: 'no-answer', remoteHandle: '+39 333 000 0009' }] };
    },
  };
  const answer = await runSuggestion(client, 'bo04:oggi:chiamate');
  assert.deepEqual(reads, ['/api/modules/interaction-call/records?limit=100']);
  assert.deepEqual(answer.sources.map((source) => source.label), ['+39 …0009 · chiamata senza risposta']);
});

test('reporting call: riuscite in italiano, fonti con il cliente', async () => {
  const answer = await runSuggestion(stubClient(ROUTES), 'bo04:reporting:call');
  assert.ok(answer.lines.some((line) => line.includes('(2 riuscite)')), JSON.stringify(answer.lines));
  assert.equal(answer.sources[0].label, 'Mario Rossi · chiamata riuscita');
  for (const text of visibleStrings(answer)) assert.doesNotMatch(text, RAW, text);
});

test('vocabolario condiviso: stati dei messaggi e delle chiamate in italiano', () => {
  assert.equal(italianLabel(SYNC_LABELS, 'received', 'stato'), 'ricevuto');
  assert.equal(italianLabel(SYNC_LABELS, 'SENT', 'stato'), 'inviato');
  assert.equal(italianLabel(SYNC_LABELS, 'toString', 'stato'), 'stato');
  assert.equal(callOutcomeLabel('completed'), 'riuscita');
  assert.equal(callOutcomeLabel('missed'), 'persa');
  assert.equal(callOutcomeLabel(undefined), 'senza esito');
});

test('orario: ora locale di Roma, mai UTC', () => {
  // 05:25:28 UTC on 07/11 is 06:25:28 in Rome (CET), 07:25:28 in summer (CEST).
  assert.equal(romeClock('2026-11-07T05:25:28.000Z'), '06:25:28');
  assert.equal(romeClock('2026-07-07T05:25:28.000Z'), '07:25:28');
  assert.equal(romeClock('non una data'), '');
});

test('pannello: stati, fonti e cronologia senza valori inglesi né UTC', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const panel = createAssistantPanel({ doc, mount, client: stubClient(ROUTES), navigate: () => {}, notify: () => {} });
  await panel.open('oggi');
  mount.findByText('button', 'Com’è andato il telefono?').dispatch('click', {});
  await tick();
  await tick();
  mount.findByText('button', 'Cosa è più urgente oggi?').dispatch('click', {});
  await tick();
  await tick();
  mount.findAll('button').filter(
    (node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-assistant-history-open'),
  )[0].dispatch('click', {});
  await tick();
  const text = mount.textContent;
  assert.ok(text.includes('riuscita: 2'), text);
  assert.ok(text.includes('Mario Rossi · chiamata riuscita'), text);
  assert.doesNotMatch(text, RAW);
  const history = mount.findAll('button')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-assistant-history-open'))
    .map((node) => node.textContent);
  assert.equal(history.length, 2);
  for (const label of history) assert.match(label, / — \d{2}:\d{2}:\d{2}$/, label);
});
