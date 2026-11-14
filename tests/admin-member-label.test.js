import test from 'node:test';
import assert from 'node:assert/strict';
import { isTechnicalMemberText, memberLabel, memberText } from '../apps/admin/public/admin-labels.js';
import { buildTodayAgenda, loadOggiData } from '../apps/admin/public/admin-oggi.js';
import { buildTeamRows } from '../apps/admin/public/admin-spazi-accessi.js';
import { personRows, resolveMemberName } from '../apps/admin/public/admin-calendario.js';
import { teamName } from '../apps/admin/public/admin-customer-card.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Team members by name, never a technical id (production 10/11): Oggi ›
 * Agenda printed «broker+adopted-…@accordo.invalid» under the customer
 * (and «google|1049…» in the test space), Spazi e accessi listed the team
 * as broker mailboxes. One filter (`memberText`) and one label
 * (`memberLabel`) in admin-labels.js serve every team screen.
 * The ids below have the production shape; the digits are invented.
 */

const BROKER = 'broker+adopted-0a1b2c3d4e5f@accordo.invalid';
const GOOGLE = 'google|100000000000000000001';
const NOW = new Date('2026-10-19T07:00:00.000Z'); // 09:00 in Rome
const APPT = {
  id: 'appt-1', status: 'booked', subjectResource: 'contact', subjectId: 'c1', subjectOwner: 'host',
  subjectLabel: 'Giulia Romano', startsAt: '2026-10-19T08:00:00.000Z',
};

test('the shared filter: a provider id or a broker mailbox is never a member name', () => {
  for (const value of [BROKER, GOOGLE, 'github|42', 'BROKER+x@accordo.invalid', 'adopted-1@accordo.invalid', '', '  ', null]) {
    assert.equal(isTechnicalMemberText(value), true, String(value));
    assert.equal(memberText(value), null, String(value));
  }
  assert.equal(memberText(' Daniele Pelleri '), 'Daniele Pelleri');
  assert.equal(memberText('dan@esempio.it'), 'dan@esempio.it', 'a real mailbox is readable');
});

test('memberLabel names the subject from the roster, or nothing', () => {
  const roster = [
    { subject: GOOGLE, displayName: 'Daniele Pelleri', email: 'dan@esempio.it', operatorAccountId: 'op-1' },
    { subject: BROKER, displayName: null, email: BROKER, operatorAccountId: 'op-1' },
    { subject: 'google|100000000000000000002', displayName: BROKER, email: BROKER },
  ];
  assert.equal(memberLabel(GOOGLE, roster), 'Daniele Pelleri');
  assert.equal(memberLabel(BROKER, roster), 'Daniele Pelleri', 'the same person lends its name to the broker subject');
  assert.equal(memberLabel('google|100000000000000000002', roster), null, 'a technical display name is no name');
  assert.equal(memberLabel(BROKER, []), null, 'no roster: never the broker mailbox');
  assert.equal(memberLabel(GOOGLE, []), null, 'no roster: never the provider id');
  assert.equal(memberLabel('Marco', []), 'Marco', 'a plain word an operator typed still reads');
  assert.equal(memberLabel('marco@esempio.it', []), 'marco@esempio.it', 'a real address outside the roster reads as itself, like personLabel (backlog:e52c5e0dd49f)');
});

test('Oggi › Agenda: the chi line is the member name, never the raw id', () => {
  const roster = [{ subject: BROKER, displayName: 'Giulia Verdi', email: BROKER }];
  const named = buildTodayAgenda([{ ...APPT, teamMemberId: BROKER }], NOW, {}, roster);
  assert.equal(named[0].who, 'Giulia Verdi');
  const unnamed = buildTodayAgenda([
    { ...APPT, id: 'a', teamMemberId: BROKER },
    { ...APPT, id: 'b', teamMemberId: GOOGLE, notes: 'Vuole il listino.' },
  ], NOW);
  assert.equal(unnamed[0].who, null, 'no name: nothing, never the broker mailbox');
  assert.equal(unnamed[1].who, 'Vuole il listino.', 'no name: the notes cue, never the provider id');
  for (const row of unnamed) {
    assert.ok(!String(row.who ?? '').includes('accordo.invalid') && !String(row.who ?? '').includes('|'));
  }
});

test('loadOggiData reads the roster with the profile, even when no slot names a member (785aeb28bd18)', async () => {
  const seen = [];
  const client = (appointments) => ({
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      seen.push(path);
      if (path === '/api/schema') return { domains: { appointments: {} } };
      if (path === '/api/profile') return null;
      if (path.startsWith('/api/modules/appointment/records')) return { items: appointments };
      if (path === '/api/spine/memberships') return { items: [{ subject: BROKER, displayName: 'Giulia Verdi' }] };
      if (path.startsWith('/api/customer-data/profile/')) return { identity: { displayName: 'Giulia Romano' } };
      throw new Error(`unexpected read: ${path}`);
    },
  });
  const data = await loadOggiData(client([{ ...APPT, teamMemberId: BROKER }]), NOW);
  assert.deepEqual(data.members, [{ subject: BROKER, displayName: 'Giulia Verdi' }]);
  assert.equal(buildTodayAgenda(data.appointments, NOW, data.appointmentNames, data.members)[0].who, 'Giulia Verdi');
  seen.length = 0;
  const none = await loadOggiData(client([APPT]), NOW);
  // 785aeb28bd18: the roster rides the first wave beside the profile, so the
  // member step settles with the wave (under 1 s on a warm server) instead of
  // waiting for the module reads; no slot still gets an empty agenda line.
  assert.deepEqual(none.members, [{ subject: BROKER, displayName: 'Giulia Verdi' }]);
  assert.ok(seen.includes('/api/spine/memberships'), 'the roster launches with the profile, even with no named member');
});

test('Spazi e accessi lists members by name, never by broker mailbox', () => {
  const rows = buildTeamRows([
    { subject: BROKER, role: 'owner', status: 'active', displayName: null, email: BROKER },
    { subject: 'broker+adopted-ffffffffffff@accordo.invalid', role: 'operator', status: 'active' },
    { subject: GOOGLE, role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'dan@esempio.it' },
  ]);
  const shown = rows.map((row) => `${row.name} ${row.email ?? ''} ${row.initials}`).join(' | ');
  assert.ok(!shown.includes('accordo.invalid') && !shown.includes('broker') && !shown.includes('|1'), shown);
  assert.deepEqual(rows.map((row) => row.name), ['Daniele Pelleri', 'Membro del team', 'Membro del team']);
  assert.equal(rows[1].email, null);
  assert.ok(rows.every((row) => row.subjects.length === 1), 'removal still targets each subject');
});

test('Calendario and the scheda apply the same filter', () => {
  const rows = personRows([BROKER], [], [{ subject: BROKER, displayName: null, email: BROKER }]);
  assert.equal(rows[0].label, 'Membro del team');
  assert.equal(resolveMemberName(BROKER, [BROKER], []), null);
  assert.equal(teamName(BROKER), null, 'the scheda never reads «Broker»');
  assert.equal(teamName('marco.rossi'), 'Marco Rossi');
});
