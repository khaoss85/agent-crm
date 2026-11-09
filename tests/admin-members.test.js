import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyRoster,
  fetchTeamRoster,
  isTechnicalHandle,
  paintOwnerName,
  resolveTeamName,
  teamRoster,
} from '../apps/admin/public/admin-members.js';

/**
 * Voce ddf7f416: referente e autore con nome e cognome, mai id o «utente».
 * Pure unit tests for the shared roster helpers the offer screens use.
 */

const ROSTER = teamRoster([
  { subject: 'coach-guido', displayName: 'Guido Conti', email: 'guido@palestra.it', role: 'owner', status: 'active' },
  { subject: '00000000-0000-4000-8000-000000000000', displayName: 'Elena Rossi', role: 'member', status: 'active' },
  { subject: 'suspended-sam', displayName: 'Sam Verde', role: 'member', status: 'suspended' },
  { subject: 'mail-only', email: 'solo@palestra.it', role: 'member', status: 'active' },
  { subject: 'nameless', role: 'member', status: 'active' },
]);

test('the roster maps subjects to display names and lists sorted labels', () => {
  assert.equal(ROSTER.bySubject.get('coach-guido'), 'Guido Conti');
  assert.equal(ROSTER.bySubject.get('00000000-0000-4000-8000-000000000000'), 'Elena Rossi');
  assert.ok(!ROSTER.bySubject.has('nameless'), 'a nameless entry never paints');
  assert.deepEqual(ROSTER.labels, ['Elena Rossi', 'Guido Conti', 'Sam Verde', 'solo@palestra.it']);
});

test('a member handle resolves to nome e cognome, never the id', () => {
  assert.equal(resolveTeamName('coach-guido', ROSTER), 'Guido Conti');
  assert.equal(resolveTeamName('00000000-0000-4000-8000-000000000000', ROSTER), 'Elena Rossi');
  assert.equal(resolveTeamName('Guido Conti', ROSTER), 'Guido Conti', 'an already-human value reads as-is');
  assert.equal(resolveTeamName('stranger-handle', ROSTER), null, 'an unknown handle misses');
  assert.equal(resolveTeamName('', ROSTER), null, 'empty misses');
  assert.equal(resolveTeamName('coach-guido', null), null, 'no roster always misses');
});

test('technical handles are detected by shape', () => {
  assert.equal(isTechnicalHandle('00000000-0000-4000-8000-000000000000'), true);
  assert.equal(isTechnicalHandle('github|12345'), true, 'a pipe subject never paints');
  assert.equal(isTechnicalHandle('admin-ui'), true);
  assert.equal(isTechnicalHandle('system'), true);
  assert.equal(isTechnicalHandle('coach-guido'), false, 'a plain handle needs the roster, not the shape');
  assert.equal(isTechnicalHandle('Guido Conti'), false);
  assert.equal(isTechnicalHandle(''), false);
});

test('the painted referente is a name or a dash, never an id', () => {
  assert.equal(paintOwnerName('coach-guido', ROSTER), 'Guido Conti');
  assert.equal(paintOwnerName('maria', ROSTER), 'maria', 'an operator-typed name paints as-is');
  assert.equal(paintOwnerName('00000000-0000-4000-8000-000000000000', ROSTER), 'Elena Rossi');
  assert.equal(paintOwnerName('00000000-0000-4000-8000-000000000000', emptyRoster()), '—', 'an unresolvable UUID degrades to a dash');
  assert.equal(paintOwnerName('github|99', ROSTER), '—');
  assert.equal(paintOwnerName('', ROSTER), '—');
  assert.equal(paintOwnerName(null, ROSTER), '—');
});

test('an unreadable roster degrades to empty, never throws', async () => {
  const roster = await fetchTeamRoster({ async request() { throw Object.assign(new Error('forbidden'), { status: 403 }); } });
  assert.deepEqual(roster.labels, []);
  assert.equal(resolveTeamName('coach-guido', roster), null);
});

test('a readable roster lists its members', async () => {
  const roster = await fetchTeamRoster({
    async request(path) {
      assert.equal(path, '/api/spine/memberships');
      return { items: [{ subject: 'coach-guido', displayName: 'Guido Conti' }] };
    },
  });
  assert.deepEqual(roster.labels, ['Guido Conti']);
});
