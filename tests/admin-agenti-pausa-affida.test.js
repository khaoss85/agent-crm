// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createAgentiView } from '../apps/admin/public/admin-agenti.js';

/**
 * backlog:02d29866d395 — un agente in pausa (ritirato con «Ritira»,
 * POST /api/agents/set-status 200) mostra ancora il campo «Affida» sulla
 * sua card, schermata Agenti. In pausa niente «Affida»: al suo posto
 * «Riprendi», che riattiva con lo stesso passo Conferma di «Riattiva».
 */

const NOW = '2026-11-19T10:00:00.000Z';
const agent = (status) => ({
  id: 7, sourceKey: 'agent:presti:accoglienza', spaceId: 'presti',
  name: 'Accoglienza', role: 'Accoglie i clienti', status,
});

function clientFor(status) {
  const rows = [agent(status)];
  return {
    rows,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path.startsWith('/api/agents/catalog')) return { agents: [] };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: [] };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/set-status' && method === 'POST') {
        const body = JSON.parse(String(options.body));
        rows[0].status = body.status;
        return { agent: { ...rows[0] }, duplicate: false };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function painted(status) {
  const mount = createMount();
  const client = clientFor(status);
  const view = createAgentiView({
    doc: createFakeDocument(), mount, client, spaceId: () => 'presti',
    now: () => NOW, setTimer: () => null, clearTimer: () => {},
  });
  await view.render();
  await flush();
  return { mount, client };
}

/** @param {any} node @param {string} tag @param {string} cls */
function byClass(node, tag, cls) {
  return node.findAll(tag).filter((child) => child.classList.contains(cls));
}

test('02d29866d395: la card in pausa non mostra «Affida», mostra «Riprendi»', async () => {
  const { mount } = await painted('paused');
  const card = byClass(mount, 'article', 'bo-agent-card')[0];
  assert.ok(card, 'la card c’è');
  assert.equal(card.querySelector('button[data-action="talk"]'), null, 'niente bottone Affida in pausa');
  assert.ok(!card.textContent.includes('Affida'), 'la parola «Affida» non compare nella card in pausa');
  const resume = card.querySelector('button[data-action="resume-agent"]');
  assert.ok(resume, 'c’è «Riprendi» al posto di «Affida»');
  assert.equal(resume.textContent, 'Riprendi');
});

test('02d29866d395: la card attiva mostra «Affida» e non «Riprendi»', async () => {
  const { mount } = await painted('active');
  const card = byClass(mount, 'article', 'bo-agent-card')[0];
  assert.ok(card, 'la card c’è');
  const talk = card.querySelector('button[data-action="talk"]');
  assert.ok(talk, 'c’è il bottone Affida');
  assert.equal(talk.textContent, 'Affida');
  assert.equal(card.querySelector('button[data-action="resume-agent"]'), null, 'niente «Riprendi» sulla card attiva');
});

test('02d29866d395: «Riprendi» apre Conferma e riattiva l’agente', async () => {
  const { mount } = await painted('paused');
  const card = () => byClass(mount, 'article', 'bo-agent-card')[0];
  card().querySelector('button[data-action="resume-agent"]').dispatch('click', {});
  await flush();
  const confirm = card().querySelector('button[data-action="confirm-retire-agent"]');
  assert.ok(confirm, '«Riprendi» apre il passo Conferma');
  confirm.dispatch('click', {});
  await flush();
  await flush();
  const fresh = byClass(mount, 'article', 'bo-agent-card')[0];
  assert.ok(fresh.querySelector('button[data-action="talk"]'), 'riattivato: torna «Affida»');
  assert.equal(fresh.querySelector('button[data-action="resume-agent"]'), null, 'riattivato: «Riprendi» sparisce');
});
