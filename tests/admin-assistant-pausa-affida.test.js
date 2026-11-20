// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createAssistantPanel, ASSISTANT_STATUS_PATH } from '../apps/admin/public/admin-assistant.js';

/**
 * Backlog 02d29866d395: un agente in pausa non mostra «Affida».
 * La pagina Agenti lo fa già (agent-crm#1072); restava la menzione «@Agente …»
 * dell'assistente/⌘K: risolveva l'agente in pausa e proponeva «Affida a <nome>»,
 * un POST che nasceva per restare fermo (il giro esegue solo gli attivi).
 * In pausa niente «Affida», al suo posto «Riprendi».
 */

const PAUSATO = { id: 7, sourceKey: 'agent:presti:pausato', spaceId: 'presti', name: 'Pausato', role: 'Ricontatta i clienti', status: 'paused' };

function stubClient() {
  const calls = [];
  const agents = [{ ...PAUSATO }];
  const assignments = [];
  return {
    calls,
    agents,
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      const body = typeof options.body === 'string' && options.body !== '' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method, body, key: options.idempotencyKey });
      if (path === ASSISTANT_STATUS_PATH) return { freeQuestions: 'disabled' };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: agents.map((row) => ({ ...row })) };
      if (path === '/api/agents/set-status' && method === 'POST') {
        const row = agents.find((entry) => entry.sourceKey === body.agentSourceKey);
        if (!row) throw Object.assign(new Error('Unknown agent in this space'), { code: 'AGENT_UNKNOWN', status: 404 });
        row.status = body.status;
        return { duplicate: false, agent: { ...row } };
      }
      if (path === '/api/agents/assign' && method === 'POST') {
        const assignment = {
          sourceKey: body.sourceKey, agentSourceKey: body.agentSourceKey, phrase: body.phrase,
          cadence: 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', decidedAt: '2026-11-20T10:00:00.000Z',
        };
        assignments.push(assignment);
        return { duplicate: false, assignment };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function textOf(node) {
  return node.textContent;
}

function findButton(mount, action) {
  return mount.querySelector(`button[data-action="${action}"]`);
}

test('02d29866d395: la menzione di un agente in pausa non offre «Affida», offre «Riprendi»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Pausato ogni lunedì ricontrolla i lead');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'paused');
  const text = textOf(mount);
  assert.ok(!text.includes('Affida'), 'nessun «Affida» per un agente in pausa');
  assert.ok(text.includes('in pausa'), 'la card dice perché non si può affidare');
  assert.ok(findButton(mount, 'agent-resume'), 'al suo posto «Riprendi»');
  assert.equal(findButton(mount, 'agent-assign'), null);
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'niente scritto prima della scelta');
});

test('02d29866d395: «Riprendi» riattiva e riporta la menzione su «Affida»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Pausato ogni lunedì ricontrolla i lead');
  await flush();
  findButton(mount, 'agent-resume').dispatch('click', {});
  await flush();
  const resumes = client.calls.filter((call) => call.path === '/api/agents/set-status');
  assert.equal(resumes.length, 1, 'una sola riattivazione');
  assert.deepEqual(resumes[0].body, { spaceId: 'presti', agentSourceKey: PAUSATO.sourceKey, status: 'active' });
  assert.equal(typeof resumes[0].key, 'string', 'la riattivazione ha la sua chiave');
  assert.equal(panel.getState().mentionStatus, 'confirm', 'riattivato: la menzione torna confermabile');
  assert.ok(textOf(mount).includes('Affida a Pausato'), 'ora «Affida» c’è, a ragion veduta');
  assert.equal(client.calls.filter((call) => call.path === '/api/agents/assign').length, 0, '«Riprendi» non affida da solo');
  findButton(mount, 'agent-assign').dispatch('click', {});
  await flush();
  assert.equal(client.calls.filter((call) => call.path === '/api/agents/assign').length, 1, 'l’incarico parte dopo la conferma');
  assert.equal(panel.getState().mentionStatus, 'done');
});

test('02d29866d395: una «Riprendi» fallita resta in pausa e lo dice', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient();
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Pausato ogni lunedì ricontrolla i lead');
  await flush();
  client.request = async (path, options = {}) => {
    enforceAdminWriteGate(path, options);
    if (path === '/api/agents/set-status') throw Object.assign(new Error('boom'), { code: 'NETWORK', status: 0 });
    throw new Error(`unexpected request ${path}`);
  };
  findButton(mount, 'agent-resume').dispatch('click', {});
  await flush();
  assert.equal(panel.getState().mentionStatus, 'paused', 'resta in pausa');
  assert.ok(!textOf(mount).includes('Affida'), 'ancora nessun «Affida»');
  assert.ok(findButton(mount, 'agent-resume'), '«Riprendi» resta disponibile');
});
