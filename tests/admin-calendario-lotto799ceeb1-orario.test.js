// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * lot lot-apps-admin-public-799ceeb1, item 0a57d7b520ef (b): gli slot
 * proposti stanno solo nelle 09:00–18:00 di Roma, mai 00:00–02:30. La notte è
 * sempre libera: a giornata piena le righe si riempirebbero di passi
 * notturni. Solo l'orario chiesto esplicitamente tiene la sua riga onesta.
 */

const MEMBERSHIPS = [
  { subject: 'marco', role: 'operator', displayName: 'Marco' },
];

// 2026-10-21/22: CEST (UTC+2). Rome 00:00–00:30 and 01:30–02:00 on the 22nd,
// plus one 10:00 step inside the painted hours.
const NIGHT_EARLY = { startsAt: '2026-10-21T22:00:00.000Z', endsAt: '2026-10-21T22:30:00.000Z' };
const NIGHT_LATE = { startsAt: '2026-10-21T23:30:00.000Z', endsAt: '2026-10-22T00:00:00.000Z' };
const DAY_STEP = { startsAt: '2026-10-22T08:00:00.000Z', endsAt: '2026-10-22T08:30:00.000Z' };

function stubClient({ draft, slots }) {
  const calls = [];
  const notFound = () => {
    const error = new Error('not composed');
    error.code = 'NOT_FOUND';
    error.status = 404;
    return error;
  };
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/spine/memberships') return { items: MEMBERSHIPS };
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        return { from: '', to: '', slotMinutes: 30, members: [{ teamMemberId: 'marco', slots }] };
      }
      if (path === '/api/appointments/phrase' && (options.method ?? 'GET') === 'POST') {
        return { draft: { ...draft }, dryRun: false, spaceId: 'locale' };
      }
      throw notFound();
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);
const field = (mount, name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);

async function askPhrase(view, mount, words) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = words;
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await flush();
}

test('a giornata piena di giorno: le righe propongono solo 09:00–18:00, mai 00:00–02:30', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    draft: { teamMemberId: 'marco', day: '2026-10-22' },
    slots: [NIGHT_EARLY, NIGHT_LATE, DAY_STEP],
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount, 'trova 30 minuti con marco giovedì');
  assert.deepEqual(slotRows(mount), ['gio 22 ott · 10:00–10:30']);
  assert.ok(!mount.textContent.includes('00:00'), 'no midnight anywhere');
  assert.ok(!mount.textContent.includes('01:30'), 'no 01:30 anywhere');
  assert.equal(field(mount, 'start').value, '10:00', 'the first free in-hours step fills Inizio');
  assert.equal(field(mount, 'end').value, '10:30', 'and its end fills Fine');
});

test('solo passi notturni liberi: nessuna proposta, il modulo resta senza orari', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({
    draft: { teamMemberId: 'marco', day: '2026-10-22' },
    slots: [NIGHT_EARLY, NIGHT_LATE],
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-10-21T06:00:00Z') });
  await askPhrase(view, mount, 'trova 30 minuti con marco giovedì');
  assert.equal(mount.querySelector('.cal-slots'), null, 'no proposal rows at night');
  assert.ok(
    mount.textContent.includes('Nessuno slot libero quel giorno, prova con un altro giorno.'),
    'says the day is full instead of proposing the night',
  );
  assert.equal(field(mount, 'start').value, '', 'no midnight hour fills Inizio');
  assert.equal(field(mount, 'end').value, '', 'no night end fills Fine');
  assert.ok(!mount.textContent.includes('00:00'), 'no midnight anywhere');
});
