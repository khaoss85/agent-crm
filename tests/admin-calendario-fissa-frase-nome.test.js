import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, resolveDraftMemberIds } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:a16726b5ea76 (follow-up, live 18/11): «daniele pelleri»,
 * «Daniele Pelleri» and «daniele pelleri (2)» all answered «… non è nel
 * team» while «khaoss85» worked. The person holds several identities the
 * roster does not join into one row (same cause as the
 * persona-identificativi family: different keys and mailboxes, same
 * visible name), so the Team paints «Daniele Pelleri (1)» and
 * «Daniele Pelleri (2)». The match is by visible name, without case and
 * without the painted « (N)» suffix, and the rows sharing the name are
 * searched together. A name the team does not hold is not «not in the
 * team»: the phrase did not name a known person.
 *
 * The AI seam is stubbed with the draft the model gave; the suggest stub
 * answers like the server with an empty calendar.
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
// Same human, two identities the roster never joins (keys and mailboxes
// differ, like the live space): the Team paints (1) and (2).
const SPLIT_ROSTER = [
  { subject: 'google|daniele', displayName: 'Daniele Pelleri', email: 'daniele@gmail.com', role: 'member' },
  { subject: 'khaoss85', displayName: 'Daniele Pelleri', email: 'daniele@azienda.it', role: 'member' },
];
const BOTH_IDS = ['google|daniele', 'khaoss85'];
const draftFor = (teamMemberId) => ({ teamMemberId, startsAt: '2026-11-12T14:00:00.000Z' });

function phraseClient({ roster = SPLIT_ROSTER, draft = draftFor('daniele pelleri') } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/appointments/phrase' && method === 'POST') return { draft: { ...draft }, dryRun: false, spaceId: 'test' };
      if (path === '/api/spine/memberships') return { items: roster };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        const query = new URL(path, 'http://stub.test').searchParams;
        const ids = query.get('teamMemberIds')?.split(',') ?? [];
        const from = Date.parse(query.get('from') ?? '');
        const step = Number(query.get('slotMinutes')) * 60000;
        const slots = [];
        for (let at = from; at + step <= from + step * 4; at += step) {
          slots.push({ startsAt: new Date(at).toISOString(), endsAt: new Date(at + step).toISOString() });
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
const button = (mount, label) => mount.findAll('button').find((node) => node.textContent === label);
const suggestCalls = (client) => client.calls.filter((call) => call.path.startsWith('/api/appointments/suggest-slots'));
const suggestIds = (client) => suggestCalls(client).map((call) => new URL(call.path, 'http://stub.test').searchParams.get('teamMemberIds'));
const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);

async function askPhrase(view, mount, phrase) {
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = phrase;
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
}

test('resolveDraftMemberIds matches a split person by visible name (backlog:a16726b5ea76)', () => {
  assert.deepEqual(resolveDraftMemberIds('daniele pelleri', [], SPLIT_ROSTER), BOTH_IDS, 'lowercase finds both identities');
  assert.deepEqual(resolveDraftMemberIds('Daniele Pelleri', [], SPLIT_ROSTER), BOTH_IDS, 'capitals find both identities');
  assert.deepEqual(resolveDraftMemberIds('daniele pelleri (2)', [], SPLIT_ROSTER), BOTH_IDS, 'the painted ordinal is not the name');
  assert.deepEqual(resolveDraftMemberIds('khaoss85', [], SPLIT_ROSTER), ['khaoss85'], 'an exact identity still wins');
  assert.deepEqual(resolveDraftMemberIds('sconosciuto', [], SPLIT_ROSTER), [], 'strangers resolve to nothing');
});

for (const words of ['daniele pelleri', 'Daniele Pelleri', 'daniele pelleri (2)']) {
  test(`«con ${words}» searches the split person instead of refusing them (backlog:a16726b5ea76)`, async () => {
    const doc = createFakeDocument();
    const mount = createMount();
    const client = phraseClient({ draft: draftFor(words) });
    const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
    await askPhrase(view, mount, `fissa 45 minuti con ${words}`);
    assert.deepEqual(suggestIds(client), [BOTH_IDS.join(',')], `both identities searched for «${words}»`);
    assert.ok(!mount.textContent.includes('non è nel team'), `no refusal for «${words}»`);
    assert.ok(mount.textContent.includes('Bozza pronta'), 'the draft is ready');
    assert.ok(slotRows(mount).length > 0, 'free steps are proposed');
  });
}

test('a name the team does not hold says so, never «non è nel team» (backlog:a16726b5ea76)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = phraseClient({ draft: draftFor('Genoveffa') });
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await askPhrase(view, mount, 'fissa 45 minuti con Genoveffa');
  assert.deepEqual(suggestCalls(client), [], 'a stranger never filters the slots');
  assert.ok(mount.textContent.includes('Dalla frase non capisco la persona'), 'the card says the person is unknown');
  assert.ok(!mount.textContent.includes('non è nel team'), 'never refused as outside the team');
});
