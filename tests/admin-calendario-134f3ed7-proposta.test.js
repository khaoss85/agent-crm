// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:134f3ed73f86 (seguito 18/11 17:0xZ, prova del Mac sul live ebb43ac
 * + VERIFIER_BACK 18/11: OBSERVATION_FAILED AC-3) — da «Fissa con una frase»
 * il pannello «Nuovo appuntamento» si apre con Giorno, Inizio e Fine VUOTI
 * mentre la lista accanto propone già un orario, e il clic su un blocco
 * «Proposta» non riempie giorno e ora. Cura: la prima proposta (o quella
 * cliccata) riempie giorno, inizio e fine del pannello. Rossi sul codice di
 * prima, verdi dopo.
 */

const NOW = () => new Date('2026-11-17T08:00:00Z'); // Tuesday; Thursday 19/11 is the searched day.
const ROSTER = [
  { subject: 'google|marco', displayName: 'Marco', email: 'marco@example.com', role: 'member' },
];

/** @param {{draft?: any, held?: Array<{startsAt: string, endsAt: string}>}} [options] */
function phraseClient({ draft = { teamMemberId: 'Marco', durationMinutes: 45 }, held = [] } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') return { draft: { ...draft }, dryRun: false, spaceId: 'presti' };
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
          if (held.some((row) => Date.parse(row.startsAt) < at + step && Date.parse(row.endsAt) > at)) continue;
          slots.push({ teamMemberId: ids[0] ?? 'google|marco', startsAt: new Date(at).toISOString(), endsAt: new Date(at + step).toISOString() });
        }
        return { members: ids.map((id) => ({ teamMemberId: id, slots })) };
      }
      if (path === '/api/appointments/propose') {
        return { decision: 'confirm-required', draft: options.body ?? null, spaceId: 'presti', permission: 'book-appointments' };
      }
      if (path === '/api/appointments/confirm') {
        return { decision: 'booked', replayed: false, spaceId: 'presti' };
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 24) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const field = (mount, name) => mount.findAll('input').find((node) => node.getAttribute('name') === name);
const button = (mount, label) => mount.findAll('button').find((node) => node.textContent === label);
const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);
const ghosts = (mount) => mount.findAll('button').filter((node) => String(node.textContent ?? '').startsWith('✦ Proposta'));
const bookingCalls = (client) => client.calls.filter((call) => call.path === '/api/appointments/propose' || call.path === '/api/appointments/confirm');
const manualPop = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'manual-pop');
const popOpen = (mount) => {
  const pop = manualPop(mount);
  return Boolean(pop) && pop.getAttribute('hidden') === null && !(String(pop.getAttribute('class') ?? '').includes('hidden'));
};

async function askPhrase(view, mount, phrase) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = phrase;
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
}

const MONTHS = { gen: '01', feb: '02', mar: '03', apr: '04', mag: '05', giu: '06', lug: '07', ago: '08', set: '09', ott: '10', nov: '11', dic: '12' };

/** 'gio 19 nov · 09:30–10:15' → { date: '2026-11-19', start: '09:30', end: '10:15' }. */
function parseSlotRow(label) {
  const match = /(\d{1,2}) ([a-z]{3}) · (\d\d:\d\d)–(\d\d:\d\d)/.exec(String(label ?? ''));
  assert.ok(match, `a parseable slot row, got ${label ?? '(no rows)'}`);
  const [, day, mon, start, end] = match;
  return { date: `2026-${MONTHS[mon]}-${String(day).padStart(2, '0')}`, start, end };
}

test('frase senza giorno: la prima proposta riempie Giorno, Inizio e Fine (backlog:134f3ed7)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'trova 45 minuti con Marco');
  const rows = slotRows(mount);
  assert.ok(rows.length > 0, 'the card lists free slots');
  const first = parseSlotRow(rows[0]);
  assert.ok(popOpen(mount), 'the manual panel opens with the draft');
  assert.equal(field(mount, 'date')?.value, first.date, `Giorno follows the first proposal (${rows[0]})`);
  assert.equal(field(mount, 'start')?.value, first.start, `Inizio follows the first proposal (${rows[0]})`);
  assert.equal(field(mount, 'end')?.value, first.end, `Fine follows the first proposal (${rows[0]})`);
});

test('clic sulla Proposta: riempie il pannello e non prenota (backlog:134f3ed7)', async () => {
  // The draft hour is taken: the form carries the taken 15:00 while the card
  // proposes 15:30 next. Clicking the 15:30 ghost must fill the panel with
  // the clicked slot — never book it straight away.
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({
    draft: { teamMemberId: 'Marco', startsAt: '2026-11-19T14:00:00.000Z' },
    held: [{ startsAt: '2026-11-19T14:00:00.000Z', endsAt: '2026-11-19T14:30:00.000Z' }],
  });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'giovedì alle 15 con Marco');
  const rows = slotRows(mount);
  assert.ok(rows.length > 0, 'the card lists the next free steps');
  assert.equal(rows[0], 'gio 19 nov · 15:30–16:00', `the taken hour is skipped, got ${rows[0] ?? '(no rows)'}`);
  assert.equal(ghosts(mount).length, rows.length, 'one ghost per proposal');
  ghosts(mount)[0].dispatch('click');
  await flush();
  assert.equal(bookingCalls(client).length, 0, 'clicking a proposal books nothing');
  assert.ok(popOpen(mount), 'the manual panel opens on the clicked proposal');
  assert.equal(field(mount, 'date')?.value, '2026-11-19', 'Giorno follows the clicked proposal');
  assert.equal(field(mount, 'start')?.value, '15:30', 'Inizio follows the clicked proposal');
  assert.equal(field(mount, 'end')?.value, '16:00', 'Fine follows the clicked proposal');
});
