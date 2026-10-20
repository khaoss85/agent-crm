import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOK_APPOINTMENTS_PERMISSION,
  PROPOSE_ACTION_KIND,
  SUGGEST_SLOT_MINUTES,
  bookFromLink,
  confirmBooking,
  createAppointmentBookCapability,
  parseBookingPhrase,
  proposeBooking,
  suggestSlots,
  validateBookingLinkToken,
} from '../packages/appointments/src/index.js';
import { ConflictError, NotFoundError } from '../packages/core/index.js';
import { createSpacePermissionGateCapability } from '../packages/space-permissions/src/index.js';

/**
 * Appointments BO-F3-02 booking flow ("07 Calendario"), with fakes and no
 * application boot: every claim here is about the flow functions and the
 * capability that exposes them, so a database would prove nothing and only
 * slow the answer — except the no-double-booking race, which rides the
 * booking path's own member serialization and source-key replay, proven by
 * the two-connection worker test in tests/appointments-model.test.js.
 */

const NOW = '2026-10-17T09:00:00.000Z';
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };
const ACTOR = { type: 'user', id: 'flow-probe' };
const SPACE = 'spazio-1';
const TOKEN = 'AbC123-def456_GH7890';

const booking = (overrides = {}) => ({
  sourceKey: 'gym:flow:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
  source: SOURCE,
  ...overrides,
});

function fakeAppointments(seed = []) {
  const rows = seed.map((row, index) => ({ id: `a-${index + 1}`, ...row }));
  return {
    rows,
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async createManaged(row) {
      const stored = { id: `a-${rows.length + 1}`, ...row };
      rows.push(stored);
      return stored;
    },
    async applyManaged(id, patch) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`appointment ${id} not found`);
      Object.assign(row, patch);
      return row;
    },
    async get(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new NotFoundError(`appointment ${id} not found`);
      return row;
    },
  };
}

const modulesFor = (service) => ({
  get: (name) => {
    if (name === 'appointment') return { service };
    throw new NotFoundError(`module ${name} not found`);
  },
});

/** The space-permissions gate over two in-memory record fakes. */
function fakeGate({ overrides = [] } = {}) {
  const overrideRows = overrides.map((row, index) => ({ id: `o-${index + 1}`, ...row }));
  const proposalRows = [];
  const modules = {
    get: (name) => {
      if (name === 'space-permission-override') {
        return {
          service: {
            async listWhere(where) {
              return overrideRows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
            },
          },
        };
      }
      if (name === 'space-ai-proposal') {
        return {
          service: {
            async listWhere(where) {
              return proposalRows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
            },
            async createManaged(row, { actor } = {}) {
              void actor;
              if (proposalRows.some((candidate) => candidate.sourceKey === row.sourceKey)) {
                throw new ConflictError('duplicate proposal', { details: { transient: false } });
              }
              const stored = { id: `p-${proposalRows.length + 1}`, ...row };
              proposalRows.push(stored);
              return stored;
            },
          },
        };
      }
      throw new NotFoundError(`module ${name} not found`);
    },
  };
  const gate = createSpacePermissionGateCapability().create({ modules, consumer: 'flow-probe' });
  return { gate, overrideRows, proposalRows };
}

const allowGate = () => fakeGate({ overrides: [{ spaceId: SPACE, permission: 'book-appointments', enabled: true }] }).gate;

const capabilityFor = ({ service, gate = null, phraseLlm = null, calendarSync = null } = {}) => createAppointmentBookCapability({
  permissionGate: gate,
  phraseLlm,
  calendarSync,
}).create({
  modules: modulesFor(service),
  actor: ACTOR,
  now: () => NOW,
  consumer: 'host',
});

test('suggested slots come from real availability: held rows carve the window', async () => {
  const service = fakeAppointments([{
    sourceKey: 'gym:held:1',
    subjectResource: 'contact',
    subjectId: 'c-presti',
    teamMemberId: 'coach-guido',
    startsAt: '2026-10-20T17:00:00.000Z',
    endsAt: '2026-10-20T18:00:00.000Z',
    status: 'booked',
  }]);
  const week = await suggestSlots({ modules: modulesFor(service) }, {
    teamMemberIds: ['coach-guido'],
    from: '2026-10-20T16:00:00.000Z',
    to: '2026-10-20T19:00:00.000Z',
    slotMinutes: 60,
  });
  assert.equal(week.slotMinutes, 60);
  assert.equal(week.members.length, 1);
  assert.deepEqual(
    week.members[0].slots.map((slot) => slot.startsAt),
    ['2026-10-20T16:00:00.000Z', '2026-10-20T18:00:00.000Z'],
  );
});

test('back-to-back slots share the endpoint and a cancelled booking frees its slot', async () => {
  const service = fakeAppointments([{
    sourceKey: 'gym:cancelled:1',
    subjectResource: 'contact',
    subjectId: 'c-presti',
    teamMemberId: 'coach-guido',
    startsAt: '2026-10-20T17:00:00.000Z',
    endsAt: '2026-10-20T18:00:00.000Z',
    status: 'cancelled',
  }]);
  const week = await suggestSlots({ modules: modulesFor(service) }, {
    teamMemberIds: ['coach-guido'],
    from: '2026-10-20T17:00:00.000Z',
    to: '2026-10-20T19:00:00.000Z',
    slotMinutes: 60,
  });
  assert.deepEqual(
    week.members[0].slots.map((slot) => slot.startsAt),
    ['2026-10-20T17:00:00.000Z', '2026-10-20T18:00:00.000Z'],
  );
});

test('suggesting over an unprovable held row fails closed, never a silent free slot', async () => {
  const service = fakeAppointments([{
    sourceKey: 'gym:corrupt:1',
    subjectResource: 'contact',
    subjectId: 'c-presti',
    teamMemberId: 'coach-guido',
    startsAt: 'not-a-date',
    endsAt: '2026-10-20T18:00:00.000Z',
    status: 'booked',
  }]);
  await assert.rejects(
    suggestSlots({ modules: modulesFor(service) }, {
      teamMemberIds: ['coach-guido'],
      from: '2026-10-20T16:00:00.000Z',
      to: '2026-10-20T19:00:00.000Z',
      slotMinutes: 60,
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_STORAGE_INVALID');
      return true;
    },
  );
});

test('the suggestion filter is bounded: members, window, steps', async () => {
  const service = fakeAppointments();
  const storage = { modules: modulesFor(service) };
  await assert.rejects(suggestSlots(storage, { teamMemberIds: [] }), /at least one team member/);
  await assert.rejects(
    suggestSlots(storage, { teamMemberIds: ['a'], from: '2026-10-20T19:00:00.000Z', to: '2026-10-20T16:00:00.000Z' }),
    /after from/,
  );
  await assert.rejects(
    suggestSlots(storage, { teamMemberIds: ['a'], from: '2026-10-20T16:00:00.000Z', to: '2026-11-25T16:00:00.000Z' }),
    /at most 31 days/,
  );
  await assert.rejects(
    suggestSlots(storage, {
      teamMemberIds: ['a'], from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', slotMinutes: 15,
    }),
    /narrow the window/,
  );
  await assert.rejects(
    suggestSlots(storage, {
      teamMemberIds: ['a'], from: '2026-10-20T16:00:00.000Z', to: '2026-10-20T19:00:00.000Z', slotMinutes: 7,
    }),
    /must be one of/,
  );
  assert.ok(SUGGEST_SLOT_MINUTES.includes(30));
});

test('propose with the switch on answers a draft and writes nothing', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service, gate: allowGate() });
  const proposed = await cap.proposeBooking({ ...booking(), spaceId: SPACE });
  assert.equal(proposed.decision, 'confirm-required');
  assert.equal(proposed.spaceId, SPACE);
  assert.equal(proposed.permission, BOOK_APPOINTMENTS_PERMISSION);
  assert.equal(proposed.draft.teamMemberId, 'coach-guido');
  assert.equal(proposed.draft.serviceKey, 'pt-single');
  assert.equal(proposed.draft.startsAt, '2026-10-20T17:00:00.000Z');
  assert.equal(service.rows.length, 0, 'the proposal writes no appointment row');
});

test('propose fails fast on a held slot, before reading the switch', async () => {
  const service = fakeAppointments([{
    sourceKey: 'gym:held:1',
    subjectResource: 'contact',
    subjectId: 'c-presti',
    teamMemberId: 'coach-guido',
    startsAt: '2026-10-20T17:00:00.000Z',
    endsAt: '2026-10-20T18:00:00.000Z',
    status: 'booked',
  }]);
  const cap = capabilityFor({ service, gate: allowGate() });
  await assert.rejects(
    cap.proposeBooking({ ...booking(), spaceId: SPACE }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test('propose with the switch off records a space-ai-proposal and writes no appointment', async () => {
  const service = fakeAppointments();
  const { gate, proposalRows } = fakeGate({
    overrides: [{ spaceId: SPACE, permission: 'book-appointments', enabled: false }],
  });
  const cap = capabilityFor({ service, gate });
  const proposed = await cap.proposeBooking({ ...booking(), spaceId: SPACE });
  assert.equal(proposed.decision, 'proposal');
  assert.ok(proposed.proposalId, 'the proposal row is named');
  assert.equal(proposed.replayed, false);
  assert.equal(service.rows.length, 0, 'no appointment row on the proposal path');
  assert.equal(proposalRows.length, 1);
  assert.equal(proposalRows[0].permission, 'book-appointments');
  assert.equal(proposalRows[0].status, 'proposed');
  const again = await cap.proposeBooking({ ...booking(), spaceId: SPACE });
  assert.equal(again.decision, 'proposal');
  assert.equal(again.proposalId, proposed.proposalId);
  assert.equal(again.replayed, true, 'the same action replays its open proposal');
  assert.equal(proposalRows.length, 1, 'no second proposal row');
});

test('confirm without confirmed:true creates nothing', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service, gate: allowGate() });
  await assert.rejects(
    cap.confirmBooking({ ...booking(), spaceId: SPACE }),
    (error) => {
      assert.match(error.message, /confirmed must be true/);
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'no row without the explicit confirmation');
});

test('confirm with the switch on books and advances booked -> confirmed', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service, gate: allowGate() });
  const confirmed = await cap.confirmBooking({ ...booking(), spaceId: SPACE, confirmed: true });
  assert.equal(confirmed.decision, 'booked');
  assert.equal(confirmed.replayed, false);
  assert.equal(confirmed.appointment.status, 'confirmed');
  assert.equal(confirmed.push, null, 'no calendar named, no push');
  assert.equal(service.rows.length, 1);
});

test('confirm names the calendar push: the event is created once, a failed push retries idempotently', async () => {
  const service = fakeAppointments();
  const pushes = [];
  let failOnce = true;
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey, options) {
      pushes.push({ calendarId, sourceKey, spaceId: options?.spaceId });
      if (failOnce) {
        failOnce = false;
        const error = new Error('provider unavailable');
        error.code = 'CALENDAR_PROVIDER_UNAVAILABLE';
        throw error;
      }
      return { status: 'exported', eventId: 'evt-1', sourceKey };
    },
  };
  const cap = capabilityFor({ service, gate: allowGate(), calendarSync });
  const request = {
    ...booking(), spaceId: SPACE, confirmed: true, calendar: { calendarId: 'cal-1' },
  };
  await assert.rejects(
    cap.confirmBooking(request),
    (error) => {
      assert.equal(error.code, 'CALENDAR_PROVIDER_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(service.rows.length, 1, 'the local commit stays confirmed past the push failure');
  assert.equal(service.rows[0].status, 'confirmed');
  const retried = await cap.confirmBooking(request);
  assert.equal(retried.decision, 'booked');
  assert.equal(retried.replayed, true, 'the retry replays the winner row');
  assert.equal(retried.appointment.status, 'confirmed');
  assert.deepEqual(retried.push, { status: 'exported', eventId: 'evt-1', sourceKey: 'gym:flow:1' });
  assert.equal(pushes.length, 2, 'the push ran again, exactly once per confirm');
  assert.equal(pushes[1].calendarId, 'cal-1');
  assert.equal(pushes[1].spaceId, SPACE);
});

test('confirm with the switch off stays a proposal: still no appointment row', async () => {
  const service = fakeAppointments();
  const { gate, proposalRows } = fakeGate({
    overrides: [{ spaceId: SPACE, permission: 'book-appointments', enabled: false }],
  });
  const cap = capabilityFor({ service, gate });
  const confirmed = await cap.confirmBooking({ ...booking(), spaceId: SPACE, confirmed: true });
  assert.equal(confirmed.decision, 'proposal');
  assert.ok(confirmed.proposalId);
  assert.equal(service.rows.length, 0);
  assert.equal(proposalRows.length, 1);
});

test('confirm names the permission edge when no gate is composed', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  await assert.rejects(
    cap.confirmBooking({ ...booking(), spaceId: SPACE, confirmed: true }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_PERMISSION_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(service.rows.length, 0);
});

test('confirm names the calendar edge when a calendar is named but none is composed', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service, gate: allowGate() });
  await assert.rejects(
    cap.confirmBooking({ ...booking(), spaceId: SPACE, confirmed: true, calendar: { calendarId: 'cal-1' } }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_CALENDAR_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(service.rows[0].status, 'confirmed', 'the booking stands; only the push is missing');
});

test('a booking link books once: the resubmission replays the winner', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  const link = { ...booking(), linkToken: TOKEN };
  const first = await cap.bookFromLink(link);
  assert.equal(first.replayed, false);
  assert.equal(first.linkToken, TOKEN);
  assert.equal(first.appointment.status, 'booked');
  assert.equal(first.appointment.sourceKey, `booking-link:${TOKEN}:2026-10-20T17:00:00.000Z`);
  const second = await cap.bookFromLink(link);
  assert.equal(second.replayed, true);
  assert.equal(second.appointment.id, first.appointment.id);
  assert.equal(service.rows.length, 1, 'one link, one slot, one row');
});

test('a link booking naming a reminder keeps the pair promise: no transaction, no row', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  await assert.rejects(
    cap.bookFromLink({ ...booking(), linkToken: TOKEN, remindAt: '2026-10-20T16:00:00.000Z' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_TRANSACTION_REQUIRED');
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'the reminder is never silently dropped');
});

test('two different slots behind one link stay two bookings', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  await cap.bookFromLink({ ...booking(), linkToken: TOKEN });
  await cap.bookFromLink({
    ...booking(),
    linkToken: TOKEN,
    startsAt: '2026-10-20T18:00:00.000Z',
    endsAt: '2026-10-20T19:00:00.000Z',
  });
  assert.equal(service.rows.length, 2);
});

test('a divergent claim behind the same link and slot is refused, never adopted', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  await cap.bookFromLink({ ...booking(), linkToken: TOKEN });
  await assert.rejects(
    cap.bookFromLink({ ...booking(), linkToken: TOKEN, teamMemberId: 'coach-maria' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_LOG_CONFLICT');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.equal(service.rows.length, 1);
});

test('a malformed link token books nothing', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  for (const linkToken of [undefined, '', 'short', 'has spaces in it 123456', 'punctuation!*-token-1234']) {
    await assert.rejects(
      cap.bookFromLink({ ...booking(), linkToken }),
      (error) => {
        assert.match(error.message, /linkToken/);
        return true;
      },
    );
  }
  assert.equal(validateBookingLinkToken(` ${TOKEN} `), TOKEN, 'surrounding whitespace is trimmed');
  assert.equal(service.rows.length, 0);
});

test('ten racers on one link leave one row: the losers replay the winner', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  const link = { ...booking(), linkToken: TOKEN };
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => cap.bookFromLink(link)));
  assert.equal(service.rows.length, 1, 'exactly one row survives the race');
  assert.equal(outcomes.filter((outcome) => outcome.replayed === false).length, 1, 'exactly one fresh writer');
  for (const outcome of outcomes) {
    assert.equal(outcome.appointment.id, service.rows[0].id);
  }
});

test('two racers on one slot with different keys: one books, the other names the overlap', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  const race = (key) => cap.bookFromLink({ ...booking(), sourceKey: key, linkToken: `${TOKEN}-x${key}` });
  const [a, b] = await Promise.allSettled([race('k1'), race('k2')]);
  const fulfilled = [a, b].filter((outcome) => outcome.status === 'fulfilled');
  const rejected = [a, b].filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'APPOINTMENTS_OVERLAP');
  assert.equal(service.rows.length, 1);
});

test('the phrase drafts parameters from one sentence through the composed LLM', async () => {
  const service = fakeAppointments();
  const phraseLlm = {
    async complete(request) {
      assert.equal(request.purpose, 'suggest');
      assert.ok(Array.isArray(request.messages) && request.messages.length === 2);
      return {
        text: '{"teamMemberId": "coach-guido", "serviceKey": "pt-single", "startsAt": "2026-10-21T17:00:00.000Z", "endsAt": "2026-10-21T18:00:00.000Z", "unknown": "dropped"}',
        dryRun: false,
      };
    },
  };
  const cap = capabilityFor({ service, phraseLlm });
  const parsed = await cap.parseBookingPhrase({ spaceId: 'spazio-prova', phrase: 'Giovedì alle 17 con Guido, scheda singola' });
  assert.deepEqual(parsed.draft, {
    teamMemberId: 'coach-guido',
    serviceKey: 'pt-single',
    startsAt: '2026-10-21T17:00:00.000Z',
    endsAt: '2026-10-21T18:00:00.000Z',
  });
  assert.equal(parsed.dryRun, false);
});

test('the phrase refuses without a handle and on an unusable draft', async () => {
  const service = fakeAppointments();
  const cap = capabilityFor({ service });
  await assert.rejects(
    cap.parseBookingPhrase({ spaceId: 'spazio-prova', phrase: 'Giovedì alle 17 con Guido' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_AI_UNAVAILABLE');
      return true;
    },
  );
  for (const text of ['not json at all', '{"serviceKey": "PT Single!"}', '{"startsAt": "tomorrow"}']) {
    const phraseLlm = { async complete() { return { text, dryRun: true }; } };
    const draftCap = capabilityFor({ service, phraseLlm });
    await assert.rejects(
      draftCap.parseBookingPhrase({ spaceId: 'spazio-prova', phrase: 'qualcosa' }),
      (error) => {
        assert.equal(error.code, 'APPOINTMENTS_AI_DRAFT_UNUSABLE');
        return true;
      },
      `text must be refused: ${text}`,
    );
  }
  assert.equal(service.rows.length, 0, 'a draft never writes');
});

test('the flow is exposed on appointment-book@1 with the direct path unchanged', async () => {
  const service = fakeAppointments();
  const { gate } = fakeGate();
  const cap = createAppointmentBookCapability({ permissionGate: gate }).create({
    modules: modulesFor(service),
    actor: ACTOR,
    now: () => NOW,
    consumer: 'host',
  });
  for (const method of ['suggestSlots', 'proposeBooking', 'confirmBooking', 'bookFromLink', 'parseBookingPhrase']) {
    assert.equal(typeof cap[method], 'function', `${method} is exposed`);
  }
  assert.equal(cap.capabilityContract, 1);
  assert.equal(typeof cap.bookAppointment, 'function');
  assert.equal(typeof cap.advanceAppointment, 'function');
  assert.equal(PROPOSE_ACTION_KIND, 'book-appointment');
});
