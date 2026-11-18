// @ts-check
/**
 * backlog:0f2ae629e09b — appuntamento ricorrente come Google Calendar,
 * ambito piccolo: «Non si ripete / Ogni giorno / Ogni settimana di
 * <giorno> / Ogni mese il <n>», solo senza calendario collegato.
 *
 * La regola descrive la serie, l'espansione la apre in occorrenze una per
 * una (ognuna controllata sui conflitti con il suo 409 che nomina la
 * data), la griglia mostra ogni occorrenza. Con il calendario collegato la
 * serie non si conferma (400 prima di ogni scrittura); il link pubblico
 * prenota solo appuntamenti singoli. Yearly, feriali e «Personalizza…»
 * sono seguiti: il validatore li rifiuta nominando `recurrence`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECURRENCE_KINDS,
  expandRecurrence,
  recurrenceOptions,
  validateRecurrence,
} from '../packages/appointments/src/recurrence.js';
import {
  bookAppointment,
  bookFromLink,
  confirmBooking,
  proposeBooking,
  readTeamWeek,
  validateAppointmentRequest,
} from '../packages/appointments/src/appointments.js';
import { NotFoundError, ValidationError } from '../packages/core/index.js';

// Martedì 17 novembre 2026, 17:00 ora di Roma.
const TUE = '2026-11-17T17:00:00+01:00';
const TUE_MS = Date.parse(TUE);
const HOUR_MS = 60 * 60 * 1000;

const ACTOR = { type: 'user', id: 'e2e' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'book' };
const SPACE = 'spazio-1';

const booking = (overrides = {}) => ({
  sourceKey: 'gym:series:1',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-11-17T16:00:00.000Z',
  endsAt: '2026-11-17T17:00:00.000Z',
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

const contextFor = (service) => ({
  modules: {
    get: (name) => {
      if (name === 'appointment') return { service };
      throw new NotFoundError(`module ${name} not found`);
    },
  },
  actor: ACTOR,
  now: () => '2026-11-10T09:00:00.000Z',
  consumer: 'host',
  followUps: null,
});

/** Il gate dei permessi per i percorsi di proposta e conferma. */
const allowGate = () => ({
  async gate() { return { decision: 'allow' }; },
  async propose(input) {
    return { proposalId: `p-${String(input?.actionKey ?? 'x').slice(0, 8)}`, replayed: false };
  },
});

test('null, undefined e «none» sono «Non si ripete»; un kind ignoto viene rifiutato', () => {
  assert.equal(validateRecurrence(null), null);
  assert.equal(validateRecurrence(undefined), null);
  assert.equal(validateRecurrence({ kind: 'none' }), null);
  for (const kind of ['bogus', 'yearly', 'weekdays', 'custom']) {
    assert.throws(() => validateRecurrence({ kind, count: 3 }), (error) => (
      error instanceof ValidationError && error.details?.field === 'recurrence'
    ), `kind ${kind} rifiutato con 400`);
  }
  assert.deepEqual([...RECURRENCE_KINDS], ['none', 'daily', 'weekly', 'monthly']);
});

test('count e until insieme vengono rifiutati: o un numero di volte o una data di fine', () => {
  assert.throws(() => validateRecurrence({ kind: 'weekly', count: 3, until: '2026-12-31' }), (error) => (
    error instanceof ValidationError && error.details?.field === 'recurrence'
  ));
});

test('le etichette si calcolano dalla data scelta', () => {
  const labels = Object.fromEntries(recurrenceOptions(TUE).map((entry) => [entry.value, entry.label]));
  assert.equal(labels.none, 'Non si ripete');
  assert.equal(labels.daily, 'Ogni giorno');
  assert.equal(labels.weekly, 'Ogni settimana di martedì');
  assert.equal(labels.monthly, 'Ogni mese il 3° martedì');
});

test('la serie settimanale tiene la stessa ora di Roma', () => {
  const slots = expandRecurrence({
    startsAtMs: TUE_MS, endsAtMs: TUE_MS + HOUR_MS, recurrence: { kind: 'weekly', count: 3 },
  });
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((slot) => slot.startsAt), [
    '2026-11-17T16:00:00.000Z',
    '2026-11-24T16:00:00.000Z',
    '2026-12-01T16:00:00.000Z',
  ]);
  for (const slot of slots) assert.equal(slot.endsAt, new Date(Date.parse(slot.startsAt) + HOUR_MS).toISOString());
});

test('la serie giornaliera avanza di un giorno alla stessa ora', () => {
  const slots = expandRecurrence({
    startsAtMs: TUE_MS, endsAtMs: TUE_MS + HOUR_MS, recurrence: { kind: 'daily', count: 3 },
  });
  assert.deepEqual(slots.map((slot) => slot.startsAt), [
    '2026-11-17T16:00:00.000Z',
    '2026-11-18T16:00:00.000Z',
    '2026-11-19T16:00:00.000Z',
  ]);
});

test('i mesi senza il giorno nominato si saltano, mai trascinati', () => {
  // Venerdì 30 gennaio 2026 è il 5° venerdì: i mesi con quattro venerdì
  // (febbraio, marzo, aprile) non ne hanno, maggio sì (29 maggio).
  const jan30 = Date.parse('2026-01-30T17:00:00+01:00');
  const slots = expandRecurrence({
    startsAtMs: jan30, endsAtMs: jan30 + HOUR_MS, recurrence: { kind: 'monthly', count: 2 },
  });
  assert.deepEqual(slots.map((slot) => slot.startsAt.slice(0, 10)), ['2026-01-30', '2026-05-29']);
});

test('la richiesta di prenotazione porta la ricorrenza normalizzata', () => {
  const input = validateAppointmentRequest(booking({ recurrence: { kind: 'weekly', count: 2 } }));
  assert.deepEqual(input.recurrence, { kind: 'weekly', interval: 1, days: null, unit: 'week', count: 2, until: null });
  assert.equal(validateAppointmentRequest(booking()).recurrence, null);
});

test('una serie vuota (regola e finestra che non si incontrano) viene rifiutata 400, mai 500', async () => {
  const service = fakeAppointments();
  const request = booking({ recurrence: { kind: 'monthly', until: '2026-11-10' } });
  await assert.rejects(bookAppointment(contextFor(service), request), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.details?.field, 'recurrence');
    return true;
  });
  assert.equal(service.rows.length, 0, 'nessuna riga scritta con la regola rifiutata');
  const context = { ...contextFor(service), permissionGate: allowGate() };
  await assert.rejects(
    proposeBooking(context, { ...request, spaceId: SPACE }),
    (error) => error instanceof ValidationError && error.details?.field === 'recurrence',
  );
});

test('una serie settimanale crea le occorrenze, ognuna con la sua chiave di serie', async () => {
  const service = fakeAppointments();
  const result = await bookAppointment(contextFor(service), booking({ recurrence: { kind: 'weekly', count: 3 } }));
  assert.equal(result.occurrenceCount, 3);
  assert.equal(result.seriesKey, 'gym:series:1');
  assert.equal(service.rows.length, 3);
  assert.deepEqual(result.occurrences.map((row) => row.occurrenceIndex), [0, 1, 2]);
  for (const row of result.occurrences) {
    assert.equal(row.seriesKey, 'gym:series:1');
    assert.ok(typeof row.recurrenceRule === 'string' && row.recurrenceRule.includes('"weekly"'));
  }
  assert.deepEqual(service.rows.map((row) => row.startsAt), [
    '2026-11-17T16:00:00.000Z',
    '2026-11-24T16:00:00.000Z',
    '2026-12-01T16:00:00.000Z',
  ]);
});

test('le occorrenze della serie si vedono in griglia, ognuna con serie e indice', async () => {
  const service = fakeAppointments();
  await bookAppointment(contextFor(service), booking({ recurrence: { kind: 'weekly', count: 2 } }));
  const week = await readTeamWeek({ appointments: service }, {
    teamMemberIds: ['coach-guido'],
    from: '2026-11-16T00:00:00.000Z',
    to: '2026-11-23T00:00:00.000Z',
  });
  assert.equal(week.members.length, 1);
  assert.equal(week.members[0].appointments.length, 1, 'solo la prima occorrenza cade nella settimana');
  const painted = week.members[0].appointments[0];
  assert.equal(painted.seriesKey, 'gym:series:1');
  assert.equal(painted.occurrenceIndex, 0);
  assert.ok(String(painted.recurrenceRule).includes('"weekly"'));
  const wide = await readTeamWeek({ appointments: service }, {
    teamMemberIds: ['coach-guido'],
    from: '2026-11-16T00:00:00.000Z',
    to: '2026-12-06T00:00:00.000Z',
  });
  assert.equal(wide.members[0].appointments.length, 2, 'tutte le occorrenze si vedono in griglia');
  assert.deepEqual(wide.members[0].appointments.map((row) => row.occurrenceIndex), [0, 1]);
});

test('se una occorrenza è occupata il 409 nomina quale, e niente viene scritto', async () => {
  const busy = {
    teamMemberId: 'coach-guido',
    startsAt: '2026-11-24T16:00:00.000Z',
    endsAt: '2026-11-24T17:00:00.000Z',
    status: 'booked',
  };
  const service = fakeAppointments([busy]);
  await assert.rejects(
    bookAppointment(contextFor(service), booking({ recurrence: { kind: 'weekly', count: 3 } })),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.equal(error.status, 409);
      assert.equal(error.details?.occurrenceIndex, 1);
      assert.equal(error.details?.occurrenceCount, 3);
      assert.match(String(error.message), /ccorrenza 2 di 3/);
      return true;
    },
  );
  assert.equal(service.rows.length, 1, 'nessuna occorrenza scritta quando una è occupata');
});

test('un impegno del titolare su una occorrenza ferma tutta la serie', async () => {
  const service = fakeAppointments();
  const context = {
    ...contextFor(service),
    calendarSync: {
      async listOwnerBlocks() {
        return [{
          teamMemberId: 'coach-guido',
          startsAt: '2026-11-24T16:00:00.000Z',
          endsAt: '2026-11-24T17:00:00.000Z',
          title: 'Palestra chiusa',
        }];
      },
    },
  };
  await assert.rejects(
    bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } })),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.equal(error.details?.occurrenceIndex, 1);
      assert.match(String(error.message), /titolare/);
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'nessuna riga scritta quando un impegno ferma la serie');
});

test('la proposta controlla ogni occorrenza: un conflitto dopo la testa ferma tutto prima di scrivere', async () => {
  const busy = {
    teamMemberId: 'coach-guido',
    startsAt: '2026-11-24T16:00:00.000Z',
    endsAt: '2026-11-24T17:00:00.000Z',
    status: 'booked',
  };
  const service = fakeAppointments([busy]);
  const context = { ...contextFor(service), permissionGate: allowGate() };
  await assert.rejects(
    proposeBooking(context, { ...booking({ recurrence: { kind: 'weekly', count: 3 } }), spaceId: SPACE }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.equal(error.details?.occurrenceIndex, 1);
      return true;
    },
  );
  assert.equal(service.rows.length, 1, 'la proposta non scrive niente');
});

test('Conferma di una serie conferma tutte le occorrenze, non solo la testa', async () => {
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: allowGate() };
  const result = await confirmBooking(context, {
    ...booking({ recurrence: { kind: 'weekly', count: 3 } }),
    spaceId: SPACE,
    confirmed: true,
  });
  assert.equal(result.decision, 'booked');
  assert.equal(result.occurrences.length, 3);
  assert.ok(result.occurrences.every((row) => row.status === 'confirmed'), 'ogni occorrenza è confermata');
  assert.deepEqual(service.rows.map((row) => row.status), ['confirmed', 'confirmed', 'confirmed']);
});

test('con il calendario collegato la serie non si conferma: 400 prima di ogni scrittura', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const context = {
    ...contextFor(service),
    permissionGate: allowGate(),
    calendarSync: {
      async pushAppointment(calendarId, sourceKey, options) {
        pushes.push({ calendarId, sourceKey, options });
        return { id: 'g1' };
      },
    },
  };
  await assert.rejects(
    confirmBooking(context, {
      ...booking({ recurrence: { kind: 'weekly', count: 3 } }),
      spaceId: SPACE,
      confirmed: true,
      calendar: { calendarId: 'cal-1' },
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_CALENDAR_PENDING');
      assert.equal(error.status, 400);
      assert.match(String(error.message), /ricorrenze arrivano presto/);
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'nessuna riga scritta quando la serie è collegata');
  assert.equal(pushes.length, 0, 'nessuna spinta parziale su Google');
  // Senza calendario la stessa serie si conferma come prima.
  const plain = await confirmBooking(
    { ...contextFor(service), permissionGate: allowGate() },
    { ...booking({ recurrence: { kind: 'weekly', count: 2 } }), spaceId: SPACE, confirmed: true },
  );
  assert.equal(plain.decision, 'booked');
  assert.equal(plain.occurrences.length, 2);
});

test('il link pubblico prenota un solo appuntamento: una serie dal link viene rifiutata', async () => {
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: allowGate() };
  const link = {
    spaceId: SPACE,
    linkToken: 'link-token-probe-0001',
    subject: SUBJECT,
    teamMemberId: 'coach-guido',
    serviceKey: 'pt-single',
    priceCents: 4000,
    currency: 'EUR',
    startsAt: '2026-11-17T16:00:00.000Z',
    endsAt: '2026-11-17T17:00:00.000Z',
    source: SOURCE,
  };
  const single = await bookFromLink(context, { ...link, recurrence: { kind: 'none' } });
  assert.equal(single.decision, 'booked');
  assert.equal(service.rows.length, 1);
  await assert.rejects(
    bookFromLink(context, { ...link, linkToken: 'link-token-probe-0002', recurrence: { kind: 'weekly', count: 3 } }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      return true;
    },
  );
  assert.equal(service.rows.length, 1, 'la serie dal link non scrive niente');
});
