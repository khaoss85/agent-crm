// @ts-check
/**
 * backlog:1f7cb20d3c30 — «Nuovo agente»: in Agenti si crea un agente scritto
 * a mano (nome, di cosa si occupa, come lavora, tetto facoltativo) con la
 * stessa create-agent del catalogo. Compare in «I tuoi agenti», si incarica
 * dalla card e con «@nome», e senza un motore nello spazio la card dice
 * «Pronto, in attesa del motore», mai «Attivo».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_CAP_USE_CARD_NOTE,
  AGENT_COST_NEEDED_NOTE,
  AGENT_NAME_TAKEN_NOTE,
  AGENT_NO_ENGINE_LABEL,
  AGENT_NO_ENGINE_NOTE,
  ASSIGNMENT_NO_ENGINE_LABEL,
  buildAgentCards,
  checkNewAgent,
  createAgentiView,
  findMentionedAgent,
} from '../apps/admin/public/admin-agenti.js';
import { createAssistantPanel, ASSISTANT_STATUS_PATH } from '../apps/admin/public/admin-assistant.js';

const NOW = '2026-11-12T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };
const CATALOG = [
  { slug: 'riaggancio', name: 'Riaggancio', role: 'Ricontatta i clienti', instructions: 'Trova…', examplePhrase: 'occupati dei lead', agentSourceKey: 'agent:presti:riaggancio' },
];
const AUGURI = { id: 2, sourceKey: 'custom-agent:presti:v1.20261112.aaaa', spaceId: 'presti', name: 'Auguri', role: 'Fa gli auguri', status: 'active', spendingCapCents: 1000 };

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A server like apps/server for the agents routes, with switches for failures. */
function driveClient({ agents = [RIAGGANCIO], failCreate = [] } = {}) {
  const calls = [];
  const rows = agents.map((row) => ({ ...row }));
  const assignments = [];
  const fold = (value) => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '');
  return {
    calls,
    rows,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      const body = typeof options.body === 'string' && options.body !== '' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method, body, key: options.idempotencyKey });
      if (path === ASSISTANT_STATUS_PATH) return { freeQuestions: 'disabled' };
      if (path.startsWith('/api/agents/catalog')) return { agents: CATALOG };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: assignments.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/create' && method === 'POST') {
        const failure = failCreate.shift();
        if (failure) throw failure;
        const sourceKey = `custom-agent:${body.spaceId}:${body.key}`;
        const known = rows.find((row) => row.sourceKey === sourceKey);
        if (known) return { duplicate: true, agent: known };
        if (rows.some((row) => fold(row.name) === fold(body.name))) {
          throw Object.assign(new Error('name taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
        }
        const agent = { id: rows.length + 1, sourceKey, spaceId: body.spaceId, name: body.name, role: body.role, instructions: body.instructions, status: 'active', ...(body.spendingCapCents ? { spendingCapCents: body.spendingCapCents } : {}) };
        rows.push(agent);
        return { duplicate: false, agent };
      }
      if (path === '/api/agents/assign' && method === 'POST') {
        const agent = rows.find((row) => row.sourceKey === body.agentSourceKey);
        if (Number.isInteger(agent?.spendingCapCents) && !(body.costPerRunCents > 0)) {
          throw Object.assign(new Error('cost'), { code: 'AGENT_COST_ESTIMATE_REQUIRED', status: 422 });
        }
        const assignment = { sourceKey: body.sourceKey, agentSourceKey: body.agentSourceKey, phrase: body.phrase, cadence: 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', decidedAt: NOW, ...(body.costPerRunCents ? { costPerRunCents: body.costPerRunCents } : {}) };
        assignments.push(assignment);
        return { duplicate: false, assignment };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

async function paintedView(options) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient(options);
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW, setTimer: () => null, clearTimer: () => {} });
  await view.render();
  await flush();
  return { mount, client, view };
}

const button = (mount, action) => mount.querySelector(`button[data-action="${action}"]`);
const posts = (client, path = '/api/agents/create') => client.calls.filter((call) => call.method === 'POST' && call.path === path);

function type(mount, name, value) {
  const node = mount.querySelector(`input[name="${name}"]`) ?? mount.querySelector(`textarea[name="${name}"]`);
  assert.ok(node, `the field ${name}`);
  node.value = value;
  node.dispatch('input', {});
}

function fillPanel(mount, { name = 'Auguri', role = 'Fa gli auguri ai clienti', instructions = 'Ogni mattina prepara gli auguri.', cap = '' } = {}) {
  type(mount, 'agent-name', name);
  type(mount, 'agent-role', role);
  type(mount, 'agent-instructions', instructions);
  type(mount, 'agent-cap', cap);
}

test('checkNewAgent: ogni campo mancante si spiega in italiano; il nome perde la @; il tetto si legge in euro', () => {
  assert.match(checkNewAgent({ name: '', role: 'r', instructions: 'i' }).error ?? '', /Dagli un nome/);
  assert.match(checkNewAgent({ name: 'A', role: ' ', instructions: 'i' }).error ?? '', /di cosa si occupa/);
  assert.match(checkNewAgent({ name: 'A', role: 'r', instructions: '' }).error ?? '', /come lavora/);
  assert.deepEqual(checkNewAgent({ name: ' @Auguri ', role: 'r', instructions: 'i', cap: '' }), { body: { name: 'Auguri', role: 'r', instructions: 'i' } });
  assert.equal(checkNewAgent({ name: 'A', role: 'r', instructions: 'i', cap: '7,50' }).body?.spendingCapCents, 750);
  assert.equal(checkNewAgent({ name: 'A', role: 'r', instructions: 'i', cap: '10 €' }).body?.spendingCapCents, 1000);
  assert.match(checkNewAgent({ name: 'A', role: 'r', instructions: 'i', cap: 'dieci' }).error ?? '', /in euro/);
  assert.match(checkNewAgent({ name: 'A', role: 'r', instructions: 'i', cap: '0' }).error ?? '', /più di 0/);
  assert.equal(checkNewAgent({ name: 'riaggàncio', role: 'r', instructions: 'i' }, [RIAGGANCIO]).error, AGENT_NAME_TAKEN_NOTE, 'un altro agente risponde già a quel @nome');
  assert.match(checkNewAgent({ name: 'x'.repeat(121), role: 'r', instructions: 'i' }).error ?? '', /troppo lungo/);
});

test('«Nuovo agente» apre il pannello sul nome; Esc e Annulla lo chiudono e il fuoco torna al pulsante', async () => {
  const { mount, client } = await paintedView();
  const open = button(mount, 'new-agent');
  assert.ok(open, 'il pulsante sta in «I tuoi agenti»');
  assert.equal(open.getAttribute('aria-expanded'), 'false');
  open.dispatch('click', {});
  assert.ok(mount.querySelector('input[name="agent-name"]').__focused, 'il fuoco va sul nome');
  assert.equal(button(mount, 'new-agent').getAttribute('aria-expanded'), 'true');
  assert.ok(mount.querySelector('textarea[name="agent-instructions"]').getAttribute('placeholder').startsWith('Es. '), 'un esempio di istruzioni');
  const panel = mount.querySelector('.bo-agent-new');
  panel.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  assert.ok(mount.querySelector('.bo-agent-new'), 'Invio non chiude e non crea');
  panel.dispatch('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(mount.querySelector('.bo-agent-new'), null, 'Esc chiude');
  assert.ok(button(mount, 'new-agent').__focused, 'il fuoco torna su «Nuovo agente»');
  button(mount, 'new-agent').dispatch('click', {});
  button(mount, 'cancel-agent').dispatch('click', {});
  assert.equal(mount.querySelector('.bo-agent-new'), null, 'Annulla chiude');
  assert.equal(posts(client).length, 0, 'aprire e chiudere non scrive niente');
});

test('un campo mancante non scrive niente, dice cosa manca e lascia quello che hai scritto', async () => {
  const { mount, client } = await paintedView();
  button(mount, 'new-agent').dispatch('click', {});
  fillPanel(mount, { role: '' });
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.equal(posts(client).length, 0);
  assert.match(mount.querySelector('.bo-seq-create-error').textContent, /di cosa si occupa/);
  assert.equal(mount.querySelector('input[name="agent-name"]').value, 'Auguri', 'il nome scritto resta');
  fillPanel(mount, { name: 'Riaggancio' });
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.equal(posts(client).length, 0, 'un @nome già preso non parte');
  assert.equal(mount.querySelector('.bo-seq-create-error').textContent, AGENT_NAME_TAKEN_NOTE);
});

test('Crea l’agente: una sola POST con la chiave del pannello anche col doppio clic; la card compare «in attesa del motore»', async () => {
  const { mount, client } = await paintedView();
  button(mount, 'new-agent').dispatch('click', {});
  fillPanel(mount, { cap: '10' });
  button(mount, 'create-agent').dispatch('click', {});
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  const sent = posts(client);
  assert.equal(sent.length, 1, 'un doppio clic, un agente');
  assert.deepEqual(Object.keys(sent[0].body).sort(), ['instructions', 'key', 'name', 'role', 'spaceId', 'spendingCapCents']);
  assert.equal(sent[0].body.spaceId, 'presti');
  assert.equal(sent[0].body.spendingCapCents, 1000);
  assert.equal(sent[0].key, sent[0].body.key, 'la chiave di idempotenza è la chiave dell’agente');
  assert.equal(sent[0].body.slug, undefined, 'mai uno slug del catalogo');
  assert.equal(mount.querySelector('.bo-agent-new'), null, 'il pannello si chiude');
  assert.ok(mount.textContent.includes('Auguri è entrato nel tuo team.'));
  const card = mount.querySelector(`article[data-agent="custom-agent:presti:${sent[0].body.key}"]`);
  assert.ok(card, 'la card del nuovo agente è in «I tuoi agenti» senza ricaricare');
  const status = card.querySelector('.bo-agent-status');
  assert.equal(status.textContent, AGENT_NO_ENGINE_LABEL);
  assert.ok(status.classList.contains('bo-agent-status-waiting'));
  assert.ok(card.textContent.includes(AGENT_NO_ENGINE_NOTE));
  assert.ok(card.textContent.includes('10,00 €') || card.textContent.includes('10 €'), 'il tetto si legge sulla card');
  const catalogCard = mount.querySelector(`article[data-agent="${RIAGGANCIO.sourceKey}"]`);
  assert.equal(catalogCard.querySelector('.bo-agent-status').textContent, 'Attivo', 'un agente del catalogo resta «Attivo»');
  assert.ok(button(mount, 'new-agent').__focused, 'il fuoco torna su «Nuovo agente»');
});

test('errori del server: nome preso, permesso negato, rete persa — testo in italiano, campi intatti, chiave giusta al nuovo tentativo', async () => {
  const lost = Object.assign(new TypeError('Failed to fetch'), { status: 0 });
  const forbidden = Object.assign(new Error('forbidden'), { code: 'FORBIDDEN', status: 403 });
  const taken = Object.assign(new Error('taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
  const { mount, client } = await paintedView({ failCreate: [lost, forbidden, taken] });
  button(mount, 'new-agent').dispatch('click', {});
  fillPanel(mount);
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.match(mount.querySelector('.bo-seq-create-error').textContent, /Connessione non riuscita/);
  assert.equal(mount.querySelector('textarea[name="agent-instructions"]').value, 'Ogni mattina prepara gli auguri.', 'le istruzioni restano');
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.match(mount.querySelector('.bo-seq-create-error').textContent, /Non hai il permesso di creare agenti/);
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.equal(mount.querySelector('.bo-seq-create-error').textContent, AGENT_NAME_TAKEN_NOTE, 'un nome preso nel frattempo');
  assert.equal(mount.querySelector('input[name="agent-name"]').value, 'Auguri');
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  const sent = posts(client);
  assert.equal(sent.length, 4);
  assert.equal(sent[1].body.key, sent[0].body.key, 'una risposta persa si riprova con la stessa chiave');
  assert.notEqual(sent[2].body.key, sent[1].body.key, 'dopo un rifiuto del server è un tentativo nuovo');
  assert.notEqual(sent[3].body.key, sent[2].body.key);
  assert.ok(mount.textContent.includes('Auguri è entrato nel tuo team.'));
});

test('un agente con tetto: la card chiede il costo di un giro prima di affidare, poi lo manda', async () => {
  const { mount, client } = await paintedView({ agents: [RIAGGANCIO, AUGURI] });
  const input = mount.querySelector(`input[name="talk-${AUGURI.sourceKey}"]`);
  input.value = 'ogni lunedì fai gli auguri';
  input.dispatch('input', {});
  assert.ok(mount.querySelector(`input[name="cost-${AUGURI.sourceKey}"]`), 'il campo del costo c’è solo per chi ha un tetto');
  assert.equal(mount.querySelector(`input[name="cost-${RIAGGANCIO.sourceKey}"]`), null);
  const form = mount.querySelector(`article[data-agent="${AUGURI.sourceKey}"]`).querySelector('form');
  form.dispatch('submit', {});
  await flush();
  assert.equal(posts(client, '/api/agents/assign').length, 0, 'senza costo non parte');
  assert.ok(mount.textContent.includes(AGENT_COST_NEEDED_NOTE));
  const cost = mount.querySelector(`input[name="cost-${AUGURI.sourceKey}"]`);
  cost.value = '0,20';
  cost.dispatch('input', {});
  mount.querySelector(`article[data-agent="${AUGURI.sourceKey}"]`).querySelector('form').dispatch('submit', {});
  await flush();
  const sent = posts(client, '/api/agents/assign');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.costPerRunCents, 20);
  assert.equal(sent[0].body.agentSourceKey, AUGURI.sourceKey);
  assert.ok(mount.textContent.includes('Incarico dato a Auguri'));
});

test('@nome trova anche un agente scritto a mano; con un tetto la barra ⌘K manda alla card invece di scrivere', async () => {
  const plain = { ...AUGURI, spendingCapCents: undefined };
  const found = findMentionedAgent('@auguri ogni lunedì fai gli auguri', [RIAGGANCIO, plain]);
  assert.equal(found?.agent?.sourceKey, AUGURI.sourceKey);
  assert.equal(found?.instruction, 'ogni lunedì fai gli auguri');
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({ agents: [RIAGGANCIO, AUGURI] });
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Auguri ogni lunedì fai gli auguri');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'capped');
  assert.ok(mount.textContent.includes(AGENT_CAP_USE_CARD_NOTE));
  assert.ok(mount.querySelector('a[href="#/agenti"]'));
  assert.equal(posts(client, '/api/agents/assign').length, 0, 'niente scrittura destinata al rifiuto');
});

test('senza lettura del catalogo la card non inventa niente: resta «Attivo»', () => {
  const [card] = buildAgentCards({ agents: [AUGURI], nowIso: NOW });
  assert.equal(card.statusLabel, 'Attivo');
  const [waiting] = buildAgentCards({ agents: [AUGURI], nowIso: NOW, catalog: CATALOG });
  assert.equal(waiting.statusLabel, AGENT_NO_ENGINE_LABEL);
  assert.equal(waiting.engine, false);
  const [paused] = buildAgentCards({ agents: [{ ...AUGURI, status: 'paused' }], nowIso: NOW, catalog: CATALOG });
  assert.equal(paused.statusLabel, 'In pausa', 'in pausa resta in pausa');
});

test('gli incarichi di un agente senza motore restano visibili «In attesa del motore», mai «Non riuscito»', () => {
  const assignments = [
    { sourceKey: 'a-1', agentSourceKey: AUGURI.sourceKey, phrase: 'ogni lunedì fai gli auguri', cadence: 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', nextRunAt: '2026-11-09T07:00:00.000Z', decidedAt: NOW },
    { sourceKey: 'a-2', agentSourceKey: AUGURI.sourceKey, phrase: 'fermo', cadence: 'weekly', status: 'paused', decidedAt: '2026-11-01T00:00:00.000Z' },
  ];
  const [card] = buildAgentCards({ agents: [AUGURI], assignments, runs: [], nowIso: NOW, catalog: CATALOG });
  assert.equal(card.assignments[0].status, ASSIGNMENT_NO_ENGINE_LABEL, 'il giro è passato ma l’incarico aspetta il motore');
  assert.equal(card.assignments[0].lastOutcome, null, 'nessun giro fallito');
  assert.equal(card.assignments[1].status, 'In pausa', 'in pausa resta in pausa');
  const [catalogCard] = buildAgentCards({ agents: [RIAGGANCIO], assignments: [{ ...assignments[0], agentSourceKey: RIAGGANCIO.sourceKey }], runs: [], nowIso: NOW, catalog: CATALOG });
  assert.notEqual(catalogCard.assignments[0].status, ASSIGNMENT_NO_ENGINE_LABEL, 'un agente del catalogo non aspetta il motore');
});
