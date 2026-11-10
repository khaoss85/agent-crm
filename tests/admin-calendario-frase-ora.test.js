import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, draftWithEnd } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:913c61ec — production 10/11 09:40Z (pilota 33a8e89, agent-crm
 * d238fd7, spazio Presti): «giovedì alle 15 con Guido» drafted «Guido ·
 * 12 nov 15:00» (startsAt only, no endsAt). The panel then left Fine empty,
 * searched the whole Thursday plus margins (from 11/11 22:00Z to 13/11
 * 02:00Z), listed 24 steps down to 00:00–03:00, named «✦ Proposta gio 12 nov
 * 00:00: è fuori dall'orario mostrato…» below the grid, and the draft card
 * had no way out but a page reload.
 *
 * The AI seam is stubbed with the draft the model gave; the suggest stub
 * answers like the server with an empty calendar: every step of the asked
 * window, minus the held ones.
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
const DRAFT = { teamMemberId: 'Guido', startsAt: '2026-11-12T14:00:00.000Z' }; // giovedì 15:00 Europe/Rome (CET).
const ROSTER = [
  { subject: 'google|guido', displayName: 'Guido', email: 'guido@example.com', role: 'member' },
  { subject: 'google|sara', displayName: 'Sara', email: 'sara@example.com', role: 'member' },
];

/**
 * @param {{roster?: Array<any>, held?: Array<{startsAt: string, endsAt: string}>, holdSuggest?: Promise<void>|null}} [options]
 */
function phraseClient({ roster = ROSTER, held = [], holdSuggest = null, draft = DRAFT } = {}) {
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
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        if (holdSuggest) await holdSuggest;
        const query = new URL(path, 'http://stub.test').searchParams;
        const ids = query.get('teamMemberIds')?.split(',') ?? [];
        const from = Date.parse(query.get('from') ?? '');
        const to = Date.parse(query.get('to') ?? '');
        const step = Number(query.get('slotMinutes')) * 60000;
        const slots = [];
        for (let at = from; at + step <= to; at += step) {
          const slot = { startsAt: new Date(at).toISOString(), endsAt: new Date(at + step).toISOString() };
          if (held.some((row) => Date.parse(row.startsAt) < at + step && Date.parse(row.endsAt) > at)) continue;
          slots.push(slot);
        }
        return { members: ids.map((id) => ({ teamMemberId: id, slots })) };
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
const suggestCalls = (client) => client.calls.filter((call) => call.path.startsWith('/api/appointments/suggest-slots'));
const bookingCalls = (client) => client.calls.filter((call) => call.path === '/api/appointments/propose' || call.path === '/api/appointments/confirm');
const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);
const ghosts = (mount) => mount.findAll('button').filter((node) => node.textContent.startsWith('✦ Proposta'));

async function askPhrase(view, mount) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = 'giovedì alle 15 con Guido';
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
}

test('draftWithEnd closes a timed draft with its minutes, never a day-only one (backlog:913c61ec)', () => {
  assert.deepEqual(draftWithEnd(DRAFT), { ...DRAFT, endsAt: '2026-11-12T14:30:00.000Z' }, 'no stated duration: 30 minutes');
  assert.equal(draftWithEnd({ ...DRAFT, durationMinutes: 45 }).endsAt, '2026-11-12T14:45:00.000Z', 'the stated minutes');
  assert.equal(draftWithEnd({ ...DRAFT, durationMinutes: 20 }).endsAt, '2026-11-12T14:20:00.000Z', 'any stated minutes, never the search size');
  const closed = { ...DRAFT, endsAt: '2026-11-12T15:00:00.000Z' };
  assert.equal(draftWithEnd(closed), closed, 'an end the model gave is kept');
  const dayOnly = { teamMemberId: 'Guido', day: '2026-11-12' };
  assert.equal(draftWithEnd(dayOnly), dayOnly, 'a day without a time stays without hours');
  const midnight = { teamMemberId: 'Guido', startsAt: '2026-11-11T23:00:00.000Z' };
  assert.equal(draftWithEnd(midnight), midnight, 'a Rome-midnight day stays a day');
  assert.equal(draftWithEnd(null), null);
});

test('«giovedì alle 15 con Guido»: Fine 15:30, search from 15:00, the proposal is the draft, Annulla closes it (backlog:913c61ec)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);

  // Fine = startsAt + the service minutes (30 when the sentence states none).
  assert.equal(field(mount, 'date').value, '2026-11-12', 'Giorno 12/11');
  assert.equal(field(mount, 'start').value, '15:00', 'Inizio 15:00');
  assert.equal(field(mount, 'end').value, '15:30', 'Fine 15:30, never empty');
  assert.ok(mount.querySelector('.cal-draft').textContent.includes('12 nov 15:00–15:30'), mount.querySelector('.cal-draft').textContent);

  // The search starts at the draft hour: never the whole day, never 00:00–03:00.
  const [suggest] = suggestCalls(client);
  assert.ok(suggest, 'the slots are searched');
  const query = new URL(suggest.path, 'http://stub.test').searchParams;
  assert.equal(query.get('teamMemberIds'), 'google|guido', 'Guido resolves to his booking identity');
  assert.equal(Date.parse(query.get('from')), Date.parse('2026-11-12T14:00:00.000Z'), `from the draft hour, got ${query.get('from')}`);
  assert.ok(Date.parse(query.get('to')) <= Date.parse('2026-11-12T17:00:00.000Z'), `never past the painted hours, got ${query.get('to')}`);
  assert.equal(query.get('slotMinutes'), '30');

  // The proposal is the draft: one row, one ghost at 15:00, nothing at midnight.
  assert.deepEqual(slotRows(mount), ['gio 12 nov · 15:00–15:30']);
  assert.deepEqual(ghosts(mount).map((node) => node.textContent), ['✦ Proposta 15:00']);
  assert.ok(!mount.textContent.includes('00:00'), 'no midnight anywhere');
  assert.ok(!mount.textContent.includes('fuori dall\'orario mostrato'), 'no out-of-hours proposal below the grid');

  // Annulla closes the draft in place: no reload, no booking call.
  const cancel = button(mount, 'Annulla');
  assert.ok(cancel, 'the draft card has «Annulla»');
  const before = client.calls.length;
  cancel.dispatch('click');
  await flush();
  assert.equal(mount.querySelector('.cal-draft'), null, 'the draft is gone');
  assert.equal(mount.querySelector('.cal-slots'), null, 'its proposals too');
  assert.equal(ghosts(mount).length, 0, 'and its ghosts');
  assert.equal(bookingCalls(client).length, 0, 'nothing booked or proposed');
  assert.deepEqual(client.calls.slice(before).filter((call) => call.method !== 'GET'), [], 'no write at all');
  assert.equal(field(mount, 'start').value, '', 'the draft hour leaves the form');
  assert.equal(field(mount, 'end').value, '', 'and its end');
  assert.equal(mount.querySelector('textarea[name="phrase"]').value, 'giovedì alle 15 con Guido', 'the phrase stays, to fix and search again');
});

test('a stated 20 minutes keeps Fine 15:20 and the proposal books 15:00–15:20 (review #735)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ draft: { ...DRAFT, durationMinutes: 20 } });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);
  assert.equal(field(mount, 'end').value, '15:20');
  assert.deepEqual(slotRows(mount), ['gio 12 nov · 15:00–15:20']);
});

test('a taken draft hour proposes the next free steps of that afternoon, never the night (backlog:913c61ec)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ held: [{ startsAt: '2026-11-12T14:00:00.000Z', endsAt: '2026-11-12T14:30:00.000Z' }] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);
  const rows = slotRows(mount);
  assert.equal(rows[0], 'gio 12 nov · 15:30–16:00', rows.join(' | '));
  assert.ok(rows.every((row) => /· 1[5-7]:/.test(row)), `only that afternoon: ${rows.join(' | ')}`);
  assert.ok(mount.textContent.includes('Alle 15:00 Guido è già occupato'), 'says why the draft hour is missing');
  assert.ok(!mount.textContent.includes('00:00'));
});

test('a name outside the team never filters the slots (backlog:913c61ec)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ roster: [ROSTER[1]] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);
  assert.deepEqual(suggestCalls(client), [], '«Guido» never travels as teamMemberIds');
  assert.equal(mount.querySelector('.cal-slots'), null, 'no invented free slots');
  assert.equal(ghosts(mount).length, 0);
  assert.ok(mount.textContent.includes('Guido non è nel team'), mount.textContent);
  assert.equal(field(mount, 'end').value, '15:30', 'the form still carries the draft hours');
  assert.ok(button(mount, 'Annulla'), 'and the draft can be closed');
});

test('Annulla while the slots are still searched: the late answer never paints (backlog:913c61ec)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let release = () => {};
  const holdSuggest = new Promise((resolve) => { release = resolve; });
  const client = phraseClient({ holdSuggest });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await view.render();
  await flush();
  // Review #735: what the operator typed before the phrase is never theirs to lose.
  for (const [name, value] of [['date', '2026-11-13'], ['start', '10:00'], ['end', '11:00']]) {
    field(mount, name).value = value;
    field(mount, name).dispatch('input');
  }
  await askPhrase(view, mount);
  assert.equal(suggestCalls(client).length, 1, 'the search is in flight');
  const cancel = button(mount, 'Annulla');
  assert.ok(cancel, 'Annulla is offered while the slots are searched');
  cancel.dispatch('click');
  await flush();
  release();
  await flush();
  assert.equal(mount.querySelector('.cal-draft'), null);
  assert.equal(mount.querySelector('.cal-slots'), null, 'the late answer stays unpainted');
  assert.equal(ghosts(mount).length, 0);
  assert.ok(!mount.textContent.includes('Cerco gli slot liberi…'), 'the card is idle again');
  assert.deepEqual(['date', 'start', 'end'].map((name) => field(mount, name).value), ['2026-11-13', '10:00', '11:00'], 'the form keeps the operator values');
  assert.equal(bookingCalls(client).length, 0);
});

test('a begun draft hour says «già passate», never «già occupato» (review #735)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  // Thursday 10:00 Rome; the draft asks 09:00 the same day, the afternoon is free.
  const client = phraseClient({ draft: { teamMemberId: 'Guido', startsAt: '2026-11-12T08:00:00.000Z' } });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => new Date('2026-11-12T09:00:00Z') });
  await askPhrase(view, mount);
  assert.ok(mount.textContent.includes('Le 09:00 sono già passate: ecco gli orari liberi dopo.'), mount.textContent);
  assert.ok(!mount.textContent.includes('già occupato'), 'a free hour that has begun is not «occupato»');
  assert.equal(slotRows(mount)[0], 'gio 12 nov · 10:00–10:30');
});

test('Annulla restores the operator values even when the draft wrote the same ones (review #735)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await view.render();
  await flush();
  const typed = [['date', '2026-11-12'], ['start', '15:00'], ['end', '15:30']];
  for (const [name, value] of typed) {
    field(mount, name).value = value;
    field(mount, name).dispatch('input');
  }
  await askPhrase(view, mount);
  assert.equal(field(mount, 'end').value, '15:30', 'the draft filled the same values');
  button(mount, 'Annulla').dispatch('click');
  await flush();
  assert.equal(mount.querySelector('.cal-draft'), null);
  assert.deepEqual(typed.map(([name]) => field(mount, name).value), typed.map(([, value]) => value), 'the operator values come back, never blanked');
});

// Production after #735: «giovedì alle 15 con Guido» with Guido outside the
// team still prefilled «Persona del team = Guido». A name the team does not
// hold never lands in the person field: it stays empty, or keeps the person
// the operator had already chosen; the note says why.
const personValue = (mount) => (mount.querySelector('select[name="teamMemberId"]') ?? field(mount, 'teamMemberId'))?.value;

test('a name outside the team leaves «Persona del team» empty', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ roster: [ROSTER[1]] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount);
  assert.ok(mount.textContent.includes('Guido non è nel team'), mount.textContent);
  assert.ok(mount.querySelector('select[name="teamMemberId"]'), 'the person stays a choice among the team');
  assert.equal(personValue(mount), '', 'never prefilled with the outsider name');
  assert.equal(field(mount, 'end').value, '15:30', 'the draft hours still fill the form');
});

test('a name outside the team keeps the person the operator had chosen', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ roster: [ROSTER[1]] });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await view.render();
  await flush();
  const person = mount.querySelector('select[name="teamMemberId"]');
  assert.ok(person, 'the known team starts as a choice');
  person.value = 'google|sara';
  person.dispatch('change');
  await askPhrase(view, mount);
  assert.ok(mount.textContent.includes('Guido non è nel team'), mount.textContent);
  assert.equal(personValue(mount), 'google|sara', 'the operator choice stays');
});
