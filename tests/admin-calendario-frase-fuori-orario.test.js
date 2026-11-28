import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:0a57d7b520ef (review accordo-muse-review Bondarenko#1164 P1): a timed
 * draft outside 09:00–18:00 that is free must not silently become day-time
 * alternatives with no note while the form prefills the out-of-grid hour.
 * It proposes zero slots with a dedicated out-of-hours note and leaves the
 * form hours empty. Red on head cb12f166eb20 (proposals were the day list,
 * aiNote empty, form prefilled 19:00), green after the cure.
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
const DRAFT_19 = { teamMemberId: 'Guido', startsAt: '2026-11-12T18:00:00.000Z' }; // giovedì 19:00 Europe/Rome (CET).
const ROSTER = [
  { subject: 'google|guido', displayName: 'Guido', email: 'guido@example.com', role: 'member' },
  { subject: 'google|sara', displayName: 'Sara', email: 'sara@example.com', role: 'member' },
];
// Same Thursday: one free step inside the grid, one free step at 19:00 Rome.
const SLOTS_MIXED = [
  { startsAt: '2026-11-12T14:00:00.000Z', endsAt: '2026-11-12T14:30:00.000Z' },
  { startsAt: '2026-11-12T18:00:00.000Z', endsAt: '2026-11-12T18:30:00.000Z' },
];

function phraseClient({ roster = ROSTER, held = [], draft = DRAFT_19, slots = SLOTS_MIXED } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') return { draft: { ...draft }, dryRun: false, spaceId: 'presti' };
      if (path === '/api/spine/memberships') return { items: roster };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: held })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, slots: slots.map((slot) => ({ ...slot })) })) };
      }
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        throw new Error(`no booking call expected: ${path}`);
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const field = (mount, name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
const button = (mount, label) => mount.findAll('button').find((node) => node.textContent === label);
const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);

async function askPhrase(view, mount, phrase = 'giovedì alle 19 con Guido') {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = phrase;
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
}

test('a free timed 19:00 proposes zero slots with an out-of-hours note, never day alternatives (backlog:0a57d7b520ef)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);

  // Zero proposals: neither the 19:00 step nor the free 15:00 step is offered.
  // (The draft card still names the asked 19:00 hour — only rows count here.)
  assert.deepEqual(slotRows(mount), [], 'no silent day-time alternatives for a free 19:00 draft');
  assert.deepEqual(
    mount.findAll('button').filter((node) => (node.textContent ?? '').startsWith('✦ Proposta')).map((node) => node.textContent),
    [],
    'no ghost lands on a grid row for the out-of-grid step',
  );
  assert.ok(!mount.textContent.includes('15:00–15:30'), 'the free afternoon step is not substituted in');
  // The dedicated note names the out-of-grid hour, never the generic empty-day line.
  assert.ok(mount.textContent.includes("fuori dall'orario mostrato (09:00–18:00)"), mount.textContent);
  assert.ok(!mount.textContent.includes('ecco gli orari liberi dopo'), 'no silent substitution note');
  // The form keeps the drafted day but never the out-of-grid hours.
  assert.equal(field(mount, 'date').value, '2026-11-12', 'the drafted day stays');
  assert.equal(field(mount, 'start').value, '', 'Inizio never prefills 19:00');
  assert.equal(field(mount, 'end').value, '', 'Fine never prefills 19:30');
  assert.ok(button(mount, 'Annulla'), 'the draft can still be closed');
});

test('a held timed 19:00 still proposes the free afternoon with «già occupato» (backlog:913c61ec)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    held: [{ startsAt: '2026-11-12T18:00:00.000Z', endsAt: '2026-11-12T18:30:00.000Z' }],
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);

  assert.deepEqual(slotRows(mount), ['gio 12 nov · 15:00–15:30'], 'the free afternoon step is still offered');
  assert.ok(mount.textContent.includes('già occupato'), 'the reason for the missing 19:00 is said');
});
