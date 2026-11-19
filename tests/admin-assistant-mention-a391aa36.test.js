// @ts-check
/**
 * Voce a391aa36 — barra AI (@nome agente) con admin-agenti.js:
 * - agente con tetto: propone l'incarico con costo stimato, conferma in un clic;
 * - «Apri Agenti →» porta alla card con la frase già scritta (AGENT_PREFILL_KEY);
 * - senza motore l'esito dice «In attesa del motore», mai «Fatto»;
 * - card in pausa: azione principale «Riattiva», non «Affida».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_PREFILL_KEY,
  createAssistantPanel,
  ASSISTANT_STATUS_PATH,
} from '../apps/admin/public/admin-assistant.js';

const NOW = '2026-11-12T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };
const AUGURI = { id: 2, sourceKey: 'custom-agent:presti:v1.aaa', spaceId: 'presti', name: 'Auguri', role: 'Fa gli auguri', status: 'active', spendingCapCents: 1000 };
const CATALOG = [
  { slug: 'riaggancio', name: 'Riaggancio', role: 'Ricontatta', instructions: 'Trova…', examplePhrase: 'occupati', agentSourceKey: 'agent:presti:riaggancio' },
];

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function driveClient({ agents = [RIAGGANCIO] } = {}) {
  const calls = [];
  const rows = agents.map((row) => ({ ...row }));
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      const raw = options.body;
      const body = typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : raw;
      calls.push({ path, method, body });
      if (path === ASSISTANT_STATUS_PATH) return { freeQuestions: 'disabled' };
      if (path.startsWith('/api/agents/catalog')) return { agents: CATALOG };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: [] };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/assign' && method === 'POST') {
        const agent = rows.find((row) => row.sourceKey === body.agentSourceKey);
        if (Number.isInteger(agent?.spendingCapCents) && !(body.costPerRunCents > 0)) {
          throw Object.assign(new Error('cost'), { code: 'AGENT_COST_ESTIMATE_REQUIRED', status: 422 });
        }
        return { duplicate: false, assignment: { sourceKey: body.sourceKey, phrase: body.phrase, cadence: 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', decidedAt: NOW } };
      }
      if (path === '/api/agents/set-status' && method === 'POST') {
        const agent = rows.find((row) => row.sourceKey === body.agentSourceKey);
        if (!agent) throw Object.assign(new Error('gone'), { status: 404 });
        agent.status = body.status;
        return { ok: true, agent: { ...agent } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

function openPanel(client, extra = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const store = {};
  const win = {
    addEventListener() {},
    removeEventListener() {},
    sessionStorage: {
      setItem(key, value) { store[key] = String(value); },
      getItem(key) { return store[key] ?? null; },
    },
  };
  const panel = createAssistantPanel({
    doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti', win, ...extra,
  });
  return { doc, mount, panel, store, win };
}

const posts = (client, path) => client.calls.filter((call) => call.method === 'POST' && call.path === path);

test('tetto: propone incarico con costo, un clic con la stima lo affida', async () => {
  const client = driveClient({ agents: [RIAGGANCIO, AUGURI] });
  const { mount, panel } = openPanel(client);
  await panel.open('oggi', null, null, '@Auguri ogni lunedì fai gli auguri');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'capped');
  assert.ok(mount.textContent.includes('Incarico per Auguri'));
  assert.ok(mount.textContent.includes('ogni lunedì fai gli auguri'));
  const cost = mount.querySelector('input[placeholder="€ a giro"]');
  assert.ok(cost, 'il campo della stima');
  const form = mount.findAll('FORM').find((node) => node.textContent.includes('Affida a Auguri'));
  assert.ok(form, 'un clic: Affida nel form del costo');
  form.dispatch('submit', { preventDefault() {} });
  await flush();
  assert.equal(posts(client, '/api/agents/assign').length, 0, 'senza stima non parte');
  assert.ok(mount.textContent.includes('quanto costa più o meno un giro'));
  const cost2 = mount.querySelector('input[placeholder="€ a giro"]');
  cost2.value = '0,20';
  cost2.dispatch('input', {});
  mount.findAll('FORM').find((node) => node.textContent.includes('Affida a Auguri')).dispatch('submit', { preventDefault() {} });
  await flush();
  const sent = posts(client, '/api/agents/assign');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.costPerRunCents, 20);
  assert.equal(sent[0].body.phrase, 'ogni lunedì fai gli auguri');
});

test('tetto senza motore: esito «In attesa del motore», mai «Fatto»', async () => {
  const client = driveClient({ agents: [RIAGGANCIO, AUGURI] });
  const { mount, panel } = openPanel(client);
  await panel.open('oggi', null, null, '@Auguri ogni lunedì fai gli auguri');
  await flush();
  const cost = mount.querySelector('input[placeholder="€ a giro"]');
  cost.value = '1';
  cost.dispatch('input', {});
  mount.findAll('FORM').find((node) => node.textContent.includes('Affida a Auguri')).dispatch('submit', { preventDefault() {} });
  await flush();
  assert.equal(posts(client, '/api/agents/assign').length, 1);
  assert.ok(mount.textContent.includes('In attesa del motore'));
  assert.ok(!mount.textContent.includes('Fatto:'), 'mai Fatto senza motore');
});

test('con motore: esito «Fatto» come prima', async () => {
  const client = driveClient({ agents: [RIAGGANCIO] });
  const { mount, panel } = openPanel(client);
  await panel.open('oggi', null, null, '@Riaggancio occupati dei lead');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'confirm');
  mount.findByText('BUTTON', 'Affida a Riaggancio').dispatch('click', {});
  await flush();
  await flush();
  const sent = posts(client, '/api/agents/assign');
  assert.equal(sent.length, 1);
  assert.ok(mount.textContent.includes('Fatto: Riaggancio ha l’incarico'));
});

test('pausa: azione principale «Riattiva», non «Affida»', async () => {
  const client = driveClient({ agents: [{ ...RIAGGANCIO, status: 'paused' }] });
  const { mount, panel } = openPanel(client);
  await panel.open('oggi', null, null, '@Riaggancio occupati dei lead');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'paused');
  assert.ok(mount.findByText('BUTTON', 'Riattiva Riaggancio'), 'il principale è Riattiva');
  assert.equal(mount.findByText('BUTTON', 'Affida a Riaggancio'), undefined, 'niente Affida in pausa');
  mount.findByText('BUTTON', 'Riattiva Riaggancio').dispatch('click', {});
  await flush();
  const sent = posts(client, '/api/agents/set-status');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.status, 'active');
  assert.ok(mount.textContent.includes('Riaggancio riattivato'));
});

test('«Apri Agenti →» lascia frase e chiave per la card', async () => {
  const client = driveClient({ agents: [RIAGGANCIO, AUGURI] });
  const navigated = [];
  const { mount, panel, store } = openPanel(client, { navigate: (href) => navigated.push(href) });
  await panel.open('oggi', null, null, '@Auguri ogni lunedì fai gli auguri');
  await flush();
  const link = mount.findByText('A', 'Apri Agenti →');
  assert.ok(link, 'il link con la freccia');
  assert.equal(link.getAttribute('href'), '#/agenti');
  link.dispatch('click', { preventDefault() {} });
  assert.deepEqual(navigated, ['#/agenti']);
  const prefill = JSON.parse(store[AGENT_PREFILL_KEY]);
  assert.equal(prefill.sourceKey, AUGURI.sourceKey);
  assert.equal(prefill.phrase, 'ogni lunedì fai gli auguri');
});
