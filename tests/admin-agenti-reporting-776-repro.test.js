// @ts-check
/**
 * backlog:776cf3469e64 — repro for the VERIFIER_BACK verdict («must write
 * reproTest red-before green-after for empty-name error and weeks ending
 * today»): «Nuovo agente» kept showing the stale live «name taken» line
 * after the Nome was emptied, so Crea never said the name was missing; and
 * in the running month the channel chart bars kept a future week nobody
 * could have filled yet.
 *
 * Every test below is RED on the code before the cure (632998b8^: the live
 * line stays «already taken» on an empty Nome and Crea repeats it; the
 * running month opens with the month's first-Monday weeks including the
 * future one, and the breakdown counts it) and GREEN after it: 2/2 fail on
 * 632998b8^, 2/2 pass with the cure. This file is the observable proof and
 * regression lock; the cure itself lives in apps/admin/public/admin-agenti.js
 * (stale live name line cleared) and packages/analytics/src/dashboard.js
 * (channelWeeksOf/buildChannelBreakdown end at today in the running month).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_NAME_TAKEN_NOTE,
  createAgentiView,
} from '../apps/admin/public/admin-agenti.js';
import {
  buildChannelBreakdown,
  channelWeeksOf,
} from '../packages/analytics/src/dashboard.js';

const NOW = '2026-11-12T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };
const CATALOG = [
  { slug: 'riaggancio', name: 'Riaggancio', role: 'Ricontatta i clienti', instructions: 'Trova…', examplePhrase: 'occupati dei lead', agentSourceKey: 'agent:presti:riaggancio' },
];

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A server like apps/server for the agents routes. */
function driveClient({ agents = [RIAGGANCIO] } = {}) {
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
      if (path.startsWith('/api/agents/catalog')) return { agents: CATALOG };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: assignments.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/create' && method === 'POST') {
        const sourceKey = `custom-agent:${body.spaceId}:${body.key}`;
        const known = rows.find((row) => row.sourceKey === sourceKey);
        if (known) return { duplicate: true, agent: known };
        if (rows.some((row) => fold(row.name) === fold(body.name))) {
          throw Object.assign(new Error('name taken'), { code: 'AGENT_NAME_TAKEN', status: 409 });
        }
        const agent = { id: rows.length + 1, sourceKey, spaceId: body.spaceId, name: body.name, role: body.role, instructions: body.instructions, status: 'active' };
        rows.push(agent);
        return { duplicate: false, agent };
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

test('776cf3469e64 repro: Nome svuotato dopo la riga live — Crea dice che il nome manca, non scrive', async () => {
  const { mount, client } = await paintedView();
  button(mount, 'new-agent').dispatch('click', {});
  fillPanel(mount, { name: 'Riaggancio' });
  assert.equal(mount.querySelector('.bo-seq-create-error').textContent, AGENT_NAME_TAKEN_NOTE, 'la riga live del nome preso');
  type(mount, 'agent-name', '');
  button(mount, 'create-agent').dispatch('click', {});
  await flush();
  assert.equal(posts(client).length, 0, 'niente POST con il Nome vuoto');
  assert.match(mount.querySelector('.bo-seq-create-error').textContent, /Dagli un nome/, 'Crea dice che il nome manca');
  assert.ok(!mount.textContent.includes(AGENT_NAME_TAKEN_NOTE), 'la riga live vecchia non copre il nome mancante');
  assert.equal(mount.querySelector('input[name="agent-name"]').getAttribute('aria-invalid'), 'true', 'il campo Nome resta segnato');
});

test('776cf3469e64 repro: nel mese in corso le settimane finiscono a oggi, la ripartizione ignora le future', () => {
  // Sabato 14 novembre 2026: niente settimana futura 16–22 nov in coda.
  assert.deepEqual(
    channelWeeksOf('2026-11', '2026-11-14T10:00:00.000Z').map((slot) => slot.week),
    ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'],
  );
  const breakdown = buildChannelBreakdown(
    [
      { system: 'instagram', week: '2026-11-16', count: 5 },
      { system: 'whatsapp', week: '2026-11-09', count: 3 },
    ],
    { period: '2026-11' },
    '2026-11-14T10:00:00.000Z',
  );
  assert.deepEqual(breakdown.weeks.map((slot) => slot.week), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
  assert.equal(breakdown.total, 3, 'la settimana futura non si conta');
  assert.deepEqual(breakdown.channels.map((entry) => entry.channel), ['whatsapp']);
});
