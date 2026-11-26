import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:0a57d7b520ef — production 18/11 (live pilota 0112c38, agent-crm
 * a74d152, spazio 2f07eeb9): «30 minuti con khaoss85 giovedì» → Trova slot
 * liberi: dopo le 17:30 compaiono proposte dalle 00:00 alle 02:30 marcate
 * «fuori dall'orario mostrato». Gli slot proposti devono stare nella
 * griglia di lavoro (09:00–18:00 Roma): un giorno cercato non propone mai
 * slot tra le 18:00 e le 09:00.
 *
 * Il server (suggestSlots) passa tutta la finestra del giorno, notte
 * compresa: la notte è sempre libera, quindi senza filtro riempie le
 * proposte. La cura è nel filtro frase, come già fa il pannello
 * prenotazioni con slotInGrid.
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
const DRAFT = { teamMemberId: 'Guido', day: '2026-11-12', durationMinutes: 30 };
const ROSTER = [
  { subject: 'google|guido', displayName: 'Guido', email: 'guido@example.com', role: 'member' },
  { subject: 'google|sara', displayName: 'Sara', email: 'sara@example.com', role: 'member' },
];

function dayClient() {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') return { draft: { ...DRAFT }, dryRun: false, spaceId: 'presti' };
      if (path === '/api/spine/memberships') return { items: ROSTER };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        const query = new URL(path, 'http://stub.test').searchParams;
        const ids = query.get('teamMemberIds')?.split(',') ?? [];
        const from = Date.parse(query.get('from') ?? '');
        const to = Date.parse(query.get('to') ?? '');
        const step = Number(query.get('slotMinutes')) * 60000;
        const slots = [];
        for (let at = from; at + step <= to; at += step) {
          slots.push({ startsAt: new Date(at).toISOString(), endsAt: new Date(at + step).toISOString() });
        }
        return { members: ids.map((id) => ({ teamMemberId: id, slots })) };
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);
const ghosts = (mount) => mount.findAll('button').filter((node) => node.textContent.startsWith('✦ Proposta'));

test('«30 minuti con Guido giovedì»: nessun slot tra 18:00 e 09:00 (backlog:0a57d7b520ef)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = dayClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = 'trova 30 minuti con Guido giovedì';
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await flush();

  const rows = slotRows(mount);
  assert.ok(rows.length > 0, 'il giorno libero propone slot');
  assert.ok(
    rows.every((row) => /· (09|10|11|12|13|14|15|16|17):/.test(row)),
    `solo ore 09:00–18:00 Roma: ${rows.join(' | ')}`,
  );
  assert.ok(!mount.textContent.includes('00:00'), 'nessuna proposta di mezzanotte');
  assert.ok(!mount.textContent.includes("fuori dall'orario mostrato"), 'nessuna riga fuori orario sotto la griglia');
  assert.ok(
    ghosts(mount).every((node) => /✦ Proposta (09|10|11|12|13|14|15|16|17):/.test(node.textContent)),
    'i fantasmi stanno nella griglia',
  );
});
