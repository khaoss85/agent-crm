import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView, matchDraftMemberRows, resolveDraftMemberIds } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:a16726b5ea76 (review accordo-muse-review #1047, P1): the visible
 * name can span several distinct rows — one human over split identities,
 * or true homonyms the roster cannot tell apart. The phrase still
 * recognises them (draft ready, free steps proposed), but no slot books
 * directly as the first identity: the operator picks the person in the
 * «Nuovo appuntamento» form, and the form is never prefilled with the
 * wrong human. Red before the cure (union booked via slot Conferma), green
 * after (proposals without direct booking, choice forced in the form).
 *
 * The AI seam is stubbed with the draft the model gave; the suggest stub
 * answers like the server with an empty calendar.
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
// Two distinct humans sharing one visible name: different subjects and
// mailboxes, so the roster never joins them into one row.
const HOMONYM_ROSTER = [
  { subject: 'marco-rossi', displayName: 'Marco', email: 'marco.rossi@x.it', role: 'member' },
  { subject: 'marco-bianchi', displayName: 'Marco', email: 'marco.bianchi@y.it', role: 'member' },
];
const draftFor = (teamMemberId) => ({ teamMemberId, startsAt: '2026-11-12T14:00:00.000Z' });

function phraseClient({ roster = HOMONYM_ROSTER, draft = draftFor('Marco') } = {}) {
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
        throw new Error(`no direct booking expected: ${path}`);
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 20) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const button = (mount, label) => mount.findAll('button').find((node) => node.textContent === label);
const slotRows = (mount) => (mount.querySelector('.cal-slots')?.findAll('span') ?? []).map((node) => node.textContent);

async function askPhrase(mount, phrase, client) {
  const doc = createFakeDocument();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = phrase;
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
  return view;
}

test('matchDraftMemberRows counts one row per distinct human (backlog:a16726b5ea76)', () => {
  assert.equal(matchDraftMemberRows('Marco', [], HOMONYM_ROSTER).length, 2, 'two homonym rows stay two rows');
  assert.deepEqual(
    resolveDraftMemberIds('Marco', [], HOMONYM_ROSTER).sort(),
    ['marco-rossi', 'marco-bianchi'].sort(),
    'the search still covers both identities',
  );
  assert.equal(matchDraftMemberRows('marco-rossi', [], HOMONYM_ROSTER).length, 1, 'an exact identity is one row');
  assert.deepEqual(matchDraftMemberRows('sconosciuto', [], HOMONYM_ROSTER), [], 'strangers match nothing');
});

test('homonym phrase proposes free steps but no direct booking (backlog:a16726b5ea76)', async () => {
  const mount = createMount();
  const client = phraseClient({});
  await askPhrase(mount, 'fissa 45 minuti con Marco', client);
  // Recognised: the draft is ready, free steps are listed, nobody refused.
  assert.ok(mount.textContent.includes('Bozza pronta'), 'the draft is ready');
  assert.ok(mount.textContent.includes('più persone'), 'the card says a person must be picked');
  assert.ok(slotRows(mount).length > 0, 'free steps are proposed');
  assert.ok(!mount.textContent.includes('non è nel team'), 'never refused as outside the team');
  assert.ok(!mount.textContent.includes('non capisco'), 'a held name is recognised, not unknown');
  // Fail closed: no Conferma button beside any proposed slot, and no
  // clickable «✦ Proposta» ghost on the grid.
  const slotButtons = (mount.querySelector('.cal-slots')?.findAll('button') ?? []).map((node) => node.textContent);
  assert.deepEqual(slotButtons, [], 'no direct booking beside the proposed slots');
  const ghostButtons = mount.findAll('button')
    .map((node) => node.textContent)
    .filter((text) => text.startsWith('✦ Proposta'));
  assert.deepEqual(ghostButtons, [], 'no clickable proposal ghost on the grid');
  assert.ok(mount.textContent.includes('✦ Proposta'), 'the grid still marks the proposed steps');
  // The form forces the choice: the person menu is unpicked, listing both.
  const personSelect = mount.findAll('select').find((node) => node.getAttribute('name') === 'teamMemberId');
  assert.ok(personSelect, 'the person menu is a choice, not a text field');
  assert.ok(personSelect.textContent.includes('Scegli una persona'), 'nothing preselected');
  assert.ok(personSelect.textContent.includes('Marco (1)'), 'first homonym offered');
  assert.ok(personSelect.textContent.includes('Marco (2)'), 'second homonym offered');
  assert.equal(client.calls.filter((call) => call.path === '/api/appointments/confirm').length, 0, 'nothing booked');
});
