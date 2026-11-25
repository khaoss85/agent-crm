// @ts-check
/**
 * backlog:0f2ae629e09b — appuntamento ricorrente come Google Calendar,
 * ambito piccolo: «Non si ripete / Ogni giorno / Ogni settimana di
 * <giorno> / Ogni mese il <n>», solo senza calendario collegato.
 *
 * La regola descrive la serie, l'espansione la apre in occorrenze una per
 * data), la griglia mostra ogni occorrenza. Con il calendario collegato la
 * serie non si conferma (400 prima di ogni scrittura); il link pubblico
 * prenota solo appuntamenti singoli. Yearly, feriali e «Personalizza…»
 * sono seguiti: il validatore li rifiuta nominando `recurrence`. Modifica
 * e annullo con scope (backlog:573a1e85942f: «solo questo / questo e i
 * successivi / tutti»): su una serie locale tutti e tre gli scope spostano
 * o annullano le righe giuste; su una serie collegata a Google solo
 * «tutti» passa, gli altri sono 409 prima di ogni scrittura (le eccezioni
 * EXDATE/UNTIL sono la voce 6acf0a73bfc3, non questa). A decidere se la
 * serie è collegata è il suo link di sync letto dal server, mai la sola
 * presenza del bordo calendario: con il bordo composto una serie locale
 * tiene tutti gli scope, e «tutti» su una serie collegata spinge la testa
 * su Google anche quando la richiesta non nomina nessun calendario.
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
  cancelAppointment,
  confirmBooking,
  proposeBooking,
  readTeamWeek,
  rescheduleAppointment,
  validateAppointmentRequest,
} from '../packages/appointments/src/appointments.js';
import { AppError, NotFoundError, ValidationError } from '../packages/core/index.js';

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

test('una serie senza fine (né count né until) viene rifiutata 400 su ogni percorso, senza scrivere', async () => {
  for (const kind of ['daily', 'weekly', 'monthly']) {
    assert.throws(() => validateRecurrence({ kind }), (error) => (
      error instanceof ValidationError && error.details?.field === 'recurrence'
    ), `kind ${kind} senza fine rifiutato con 400`);
  }
  const open = { recurrence: { kind: 'weekly' } };
  const bookService = fakeAppointments();
  await assert.rejects(bookAppointment(contextFor(bookService), booking(open)), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.details?.field, 'recurrence');
    return true;
  });
  assert.equal(bookService.rows.length, 0, 'nessuna riga scritta dalla serie senza fine');
  const proposeService = fakeAppointments();
  await assert.rejects(
    proposeBooking({ ...contextFor(proposeService), permissionGate: allowGate() }, { ...booking(open), spaceId: SPACE }),
    (error) => error instanceof ValidationError && error.details?.field === 'recurrence',
  );
  assert.equal(proposeService.rows.length, 0, 'la proposta non scrive niente');
  const confirmService = fakeAppointments();
  await assert.rejects(
    confirmBooking(
      { ...contextFor(confirmService), permissionGate: allowGate() },
      { ...booking(open), spaceId: SPACE, confirmed: true },
    ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      return true;
    },
  );
  assert.equal(confirmService.rows.length, 0, 'la conferma non scrive niente');
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

test('annullare chiede solo questo / successivi / tutti e fa esattamente quello (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const second = booked.occurrences[1];

  // «Solo questo»: le altre restano prenotate.
  await cancelAppointment(context, { id: second.id, scope: 'single', reason: 'spostato dal cliente' });
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'booked']);

  // «Questo e i successivi»: dal secondo in poi.
  await cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'following', reason: 'serie finita' });
  assert.deepEqual(service.rows.map((row) => row.status), ['cancelled', 'cancelled', 'cancelled']);
});

test('annullare «tutti» chiude la serie intera (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const cancelled = await cancelAppointment(context, { id: booked.occurrences[2].id, scope: 'all', reason: 'serie finita' });
  assert.equal(cancelled.occurrences.length, 3);
  assert.equal(cancelled.scope, 'all');
  assert.ok(service.rows.every((row) => row.status === 'cancelled'));
});

test('spostare «questo e i successivi» tiene il ritmo della serie (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const moved = await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-25T16:00:00.000Z',
    endsAt: '2026-11-25T17:00:00.000Z',
    scope: 'following',
  });
  assert.equal(moved.scope, 'following');
  assert.deepEqual(moved.occurrences.map((row) => row.startsAt), [
    '2026-11-25T16:00:00.000Z',
    '2026-12-02T16:00:00.000Z',
  ]);
  assert.deepEqual(service.rows.map((row) => row.startsAt), [
    '2026-11-17T16:00:00.000Z',
    '2026-11-25T16:00:00.000Z',
    '2026-12-02T16:00:00.000Z',
  ]);
});

test('spostare «solo questo» muove una sola occorrenza (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const moved = await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-25T16:00:00.000Z',
    endsAt: '2026-11-25T17:00:00.000Z',
    scope: 'single',
  });
  assert.equal(moved.scope, 'single');
  assert.deepEqual(moved.occurrences, []);
  assert.deepEqual(service.rows.map((row) => row.startsAt), [
    '2026-11-17T16:00:00.000Z',
    '2026-11-25T16:00:00.000Z',
    '2026-12-01T16:00:00.000Z',
  ]);
});

test('uno scope largo su una riga fuori serie viene rifiutato (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const single = await bookAppointment(context, booking());
  await assert.rejects(
    cancelAppointment(context, { id: single.appointment.id, scope: 'all', reason: 'serie finita' }),
    (error) => error.details?.field === 'scope',
  );
  await assert.rejects(
    rescheduleAppointment(context, {
      id: single.appointment.id,
      startsAt: '2026-11-18T16:00:00.000Z',
      endsAt: '2026-11-18T17:00:00.000Z',
      scope: 'following',
    }),
    (error) => error.details?.field === 'scope',
  );
});

test('uno scope ignoto viene rifiutato nominando scope (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 2 } }));
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'head', reason: 'x' }),
    (error) => error.details?.field === 'scope',
  );
});

test('annullare con una riga terminale nello scope rifiuta tutto senza scrivere niente (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  service.rows[0].status = 'done';
  const before = service.rows.map((row) => ({ ...row }));
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[1].id, scope: 'all', reason: 'serie finita' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(service.rows, before, 'il rifiuto arriva prima della prima scrittura');
});

test('il 409 di uno spostamento con scope nomina posizione e totale scoped (backlog:573a1e85942f)', async () => {
  // Serie 17, 24/11 e 1/12; sposto «questo e i successivi» dal secondo di un
  // giorno: il terzo (posizione 2 di 2) cade su una fascia occupata.
  const busy = {
    teamMemberId: 'coach-guido',
    startsAt: '2026-12-02T16:00:00.000Z',
    endsAt: '2026-12-02T17:00:00.000Z',
    status: 'booked',
  };
  const service = fakeAppointments([busy]);
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ sourceKey: 'gym:series:idx:1', recurrence: { kind: 'weekly', count: 3 } }));
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[1].id,
      startsAt: '2026-11-25T16:00:00.000Z',
      endsAt: '2026-11-25T17:00:00.000Z',
      scope: 'following',
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.match(String(error.message), /ccorrenza 2 di 2/);
      assert.equal(error.details?.occurrenceIndex, 1, 'posizione nello scope, non indice globale');
      assert.equal(error.details?.occurrenceCount, 2, 'totale scoped, non della serie');
      return true;
    },
  );
  assert.deepEqual(
    service.rows.slice(1).map((row) => row.startsAt),
    ['2026-11-17T16:00:00.000Z', '2026-11-24T16:00:00.000Z', '2026-12-01T16:00:00.000Z'],
    'il rifiuto arriva prima della prima scrittura',
  );
});

test('la proposta di serie con la testa occupata nomina l’occorrenza come la prenotazione (backlog:573a1e85942f)', async () => {
  const busy = {
    teamMemberId: 'coach-guido',
    startsAt: '2026-11-17T16:00:00.000Z',
    endsAt: '2026-11-17T17:00:00.000Z',
    status: 'booked',
  };
  const service = fakeAppointments([busy]);
  await assert.rejects(
    proposeBooking(
      { ...contextFor(service), permissionGate: allowGate() },
      { ...booking({ sourceKey: 'gym:series:prop:1', recurrence: { kind: 'weekly', count: 3 } }), spaceId: 'spazio-1' },
    ),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
      assert.match(String(error.message), /ccorrenza 1 di 3/);
      assert.equal(error.details?.occurrenceIndex, 0);
      assert.equal(error.details?.occurrenceCount, 3);
      return true;
    },
  );
});

test('serie collegata a Google: solo «tutti» si sposta, single e following sono 409 prima di ogni scrittura (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      pushes.push(sourceKey);
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const headKey = booked.occurrences[0].sourceKey;
  const before = service.rows.map((row) => row.startsAt);
  // «Solo questo» con calendario: 409, niente scritto, niente spinto.
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[2].id,
      startsAt: '2026-12-03T16:00:00.000Z',
      endsAt: '2026-12-03T17:00:00.000Z',
      scope: 'single',
      calendar: { calendarId: 'cal-1' },
      spaceId: 'spazio-1',
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED');
      assert.equal(error.status, 409);
      assert.match(String(error.message), /tutta la serie/);
      return true;
    },
  );
  assert.deepEqual(service.rows.map((row) => row.startsAt), before, 'il rifiuto arriva prima della prima scrittura');
  assert.deepEqual(pushes, [], 'nessuna push su un rifiuto');
  // «Questo e i successivi» con calendario: stesso 409, stessa quiete.
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[1].id,
      startsAt: '2026-11-25T16:00:00.000Z',
      endsAt: '2026-11-25T17:00:00.000Z',
      scope: 'following',
      calendar: { calendarId: 'cal-1' },
      spaceId: 'spazio-1',
    }),
    (error) => error.code === 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED' && error.status === 409,
  );
  assert.deepEqual(service.rows.map((row) => row.startsAt), before, 'il rifiuto arriva prima della prima scrittura');
  assert.deepEqual(pushes, [], 'nessuna push su un rifiuto');
  // «Tutti» con calendario resta com'era: la serie si muove e la push nomina
  // la testa, che porta la RRULE su Google.
  await rescheduleAppointment(context, {
    id: booked.occurrences[0].id,
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    scope: 'all',
    calendar: { calendarId: 'cal-1' },
    spaceId: 'spazio-1',
  });
  assert.deepEqual(pushes, [headKey]);
});

test('serie collegata a Google: single e following non annullano, «tutti» annulla e spinge la testa (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      pushes.push(sourceKey);
      return { status: 'ok', sourceKey };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const headKey = booked.occurrences[0].sourceKey;
  const cal = { calendar: { calendarId: 'cal-1' }, spaceId: 'spazio-1', reason: 'serie finita' };
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[1].id, scope: 'single', ...cal }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'booked', 'booked']);
  assert.deepEqual(pushes, [], 'nessuna push su un rifiuto');
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'following', ...cal }),
    (error) => error.code === 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED' && error.status === 409,
  );
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'booked', 'booked']);
  assert.deepEqual(pushes, [], 'nessuna push su un rifiuto');
  const out = await cancelAppointment(context, { id: booked.occurrences[2].id, scope: 'all', ...cal });
  assert.ok(service.rows.every((row) => row.status === 'cancelled'));
  assert.ok(pushes.includes(headKey), 'la push nomina la testa che porta la RRULE');
  assert.equal(out.scope, 'all');
});

test('senza bordo calendario single e following funzionano come ora (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  // Senza calendarSync nel contesto il bordo non esiste: gli scope parziali
  // restano permessi su una serie locale.
  await cancelAppointment(context, { id: booked.occurrences[1].id, scope: 'single', reason: 'spostato' });
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'booked']);
  await rescheduleAppointment(context, {
    id: booked.occurrences[2].id,
    startsAt: '2026-12-03T16:00:00.000Z',
    endsAt: '2026-12-03T17:00:00.000Z',
    scope: 'single',
  });
  assert.equal(service.rows[2].startsAt, '2026-12-03T16:00:00.000Z');
});

test('serie locale con il bordo composto: single e following passano, decide il link non il bordo (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      pushes.push(sourceKey);
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
    // Serie mai sincronizzata: Google non ha niente per lei.
    async readAppointmentDetail() {
      return {};
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await rescheduleAppointment(context, {
    id: booked.occurrences[2].id,
    startsAt: '2026-12-03T16:00:00.000Z',
    endsAt: '2026-12-03T17:00:00.000Z',
    scope: 'single',
  });
  assert.equal(service.rows[2].startsAt, '2026-12-03T16:00:00.000Z', '«solo questo» muove la riga locale');
  await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-25T16:00:00.000Z',
    endsAt: '2026-11-25T17:00:00.000Z',
    scope: 'following',
  });
  assert.equal(service.rows[1].startsAt, '2026-11-25T16:00:00.000Z', '«questo e i successivi» muove la serie locale');
  assert.deepEqual(pushes, [], 'serie locale: niente da spingere su Google');
});

test('serie collegata a Google senza «calendar» nella richiesta: single e following sono 409, «tutti» spinge la testa (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      pushes.push([calendarId, sourceKey]);
      return { status: 'ok', sourceKey };
    },
    // Serie davvero collegata: il link di sync nomina il calendario.
    async readAppointmentDetail() {
      return { sync: { calendarId: 'cal-1' } };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const headKey = booked.occurrences[0].sourceKey;
  const before = service.rows.map((row) => row.startsAt);
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[2].id,
      startsAt: '2026-12-03T16:00:00.000Z',
      endsAt: '2026-12-03T17:00:00.000Z',
      scope: 'single',
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(service.rows.map((row) => row.startsAt), before, 'il rifiuto arriva prima della prima scrittura');
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[1].id,
      startsAt: '2026-11-25T16:00:00.000Z',
      endsAt: '2026-11-25T17:00:00.000Z',
      scope: 'following',
    }),
    (error) => error.code === 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED' && error.status === 409,
  );
  assert.deepEqual(service.rows.map((row) => row.startsAt), before, 'il rifiuto arriva prima della prima scrittura');
  assert.deepEqual(pushes, [], 'nessuna push su un rifiuto');
  // «Tutti» senza «calendar» converge Google da solo: la serie si sposta e
  // la push nomina la testa, che porta la RRULE.
  await rescheduleAppointment(context, {
    id: booked.occurrences[0].id,
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    scope: 'all',
  });
  assert.notDeepEqual(service.rows.map((row) => row.startsAt), before, '«tutti» sposta la serie');
  assert.deepEqual(pushes, [['cal-1', headKey]], '«tutti» spinge la testa sul calendario del link');
});

test('annullo senza «calendar»: la serie locale passa, quella collegata rifiuta single e following (backlog:573a1e85942f)', async () => {
  const local = fakeAppointments();
  const localPushes = [];
  const localSync = {
    async pushAppointment(calendarId, sourceKey) {
      localPushes.push(sourceKey);
      return { status: 'ok', sourceKey };
    },
    // Serie mai sincronizzata: Google non ha niente per lei.
    async readAppointmentDetail() {
      return {};
    },
  };
  const bookedLocal = await bookAppointment(
    { ...contextFor(local), calendarSync: localSync },
    booking({ recurrence: { kind: 'weekly', count: 3 } }),
  );
  await cancelAppointment(
    { ...contextFor(local), calendarSync: localSync },
    { id: bookedLocal.occurrences[1].id, scope: 'single', reason: 'spostato' },
  );
  assert.deepEqual(local.rows.map((row) => row.status), ['booked', 'cancelled', 'booked'], '«solo questo» annulla la riga locale');
  assert.deepEqual(localPushes, [], 'serie locale: niente da spingere su Google');

  const linked = fakeAppointments();
  const linkedPushes = [];
  const linkedSync = {
    async pushAppointment(calendarId, sourceKey) {
      linkedPushes.push(sourceKey);
      return { status: 'ok', sourceKey };
    },
    // Serie davvero collegata: il link di sync nomina il calendario.
    async readAppointmentDetail() {
      return { sync: { calendarId: 'cal-1' } };
    },
  };
  const linkedContext = { ...contextFor(linked), calendarSync: linkedSync };
  const bookedLinked = await bookAppointment(linkedContext, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await assert.rejects(
    cancelAppointment(linkedContext, { id: bookedLinked.occurrences[1].id, scope: 'single', reason: 'spostato' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(linked.rows.map((row) => row.status), ['booked', 'booked', 'booked']);
  await assert.rejects(
    cancelAppointment(linkedContext, { id: bookedLinked.occurrences[0].id, scope: 'following', reason: 'serie finita' }),
    (error) => error.code === 'APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED' && error.status === 409,
  );
  assert.deepEqual(linked.rows.map((row) => row.status), ['booked', 'booked', 'booked']);
  assert.deepEqual(linkedPushes, [], 'nessuna push su un rifiuto');
});

test('la corsa di annullo con scope rilegge la riga bersaglio, non quella nominata (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const [first, raced, third] = booked.occurrences;
  // La seconda occorrenza la cancella un altro operatore tra la lettura
  // dello scope e la sua scrittura: lo storage rifiuta la scrittura
  // perdente con il 409 di transizione, come fa Postgres sulla seconda
  // connessione.
  let racedOnce = false;
  const realApply = service.applyManaged;
  service.applyManaged = async (id, patch, options) => {
    if (id === raced.id && !racedOnce) {
      racedOnce = true;
      const winner = service.rows.find((row) => row.id === raced.id);
      winner.status = 'cancelled';
      winner.cancelReason = 'altro operatore';
      throw new AppError(
        'An appointment in state "cancelled" cannot advance to "cancelled"; it is terminal and advances nowhere',
        { code: 'APPOINTMENTS_INVALID_STATE', status: 409, details: { from: 'cancelled', to: 'cancelled' } },
      );
    }
    return realApply(id, patch, options);
  };
  const out = await cancelAppointment(context, { id: first.id, scope: 'all', reason: 'serie finita' });
  assert.equal(out.appointment.id, first.id, 'la risposta nomina la riga richiesta');
  assert.equal(out.cancelled, true);
  const byId = Object.fromEntries(out.occurrences.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.keys(byId).sort(), [first.id, raced.id, third.id].sort());
  assert.equal(byId[raced.id].cancelled, false, 'il perdente non scrive ma risponde con la riga del vincitore');
  assert.equal(
    service.rows.find((row) => row.id === raced.id).startsAt,
    raced.startsAt,
    'la riga del vincitore è il bersaglio, non la nominata',
  );
  assert.ok(service.rows.every((row) => row.status === 'cancelled'));
});

test('spostare «tutti» con una durata diversa è 400 field endsAt e niente si muove (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const before = service.rows.map((row) => ({ startsAt: row.startsAt, endsAt: row.endsAt }));
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[0].id,
      startsAt: '2026-11-17T16:00:00.000Z',
      endsAt: '2026-11-17T17:30:00.000Z',
      scope: 'all',
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'endsAt');
      return true;
    },
  );
  assert.deepEqual(
    service.rows.map((row) => ({ startsAt: row.startsAt, endsAt: row.endsAt })),
    before,
    'il rifiuto arriva prima della prima scrittura',
  );
});

test('«questo e i successivi» tiene la durata di ogni riga, mai quella della nominata (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 2 } }));
  // Allungo solo la seconda con «solo questo»: da qui in poi le durate
  // divergono (60 min la prima, 90 la seconda).
  await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-24T16:00:00.000Z',
    endsAt: '2026-11-24T17:30:00.000Z',
    scope: 'single',
  });
  assert.equal(service.rows[1].endsAt, '2026-11-24T17:30:00.000Z');
  // Sposto «tutti» di un giorno con la durata della testa: la seconda resta
  // da 90 minuti, non viene normalizzata a 60.
  await rescheduleAppointment(context, {
    id: booked.occurrences[0].id,
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    scope: 'all',
  });
  assert.equal(service.rows[0].endsAt, '2026-11-18T17:00:00.000Z');
  assert.equal(service.rows[1].startsAt, '2026-11-25T16:00:00.000Z');
  assert.equal(service.rows[1].endsAt, '2026-11-25T17:30:00.000Z', 'ogni riga tiene la sua durata');
});

test('annullare «tutti» con la seconda scrittura che fallisce non lascia niente annullato (backlog:573a1e85942f)', async () => {
  const service = fakeAppointments();
  // Transazione finta con rollback: fotografa le righe e le ripristina se il
  // giro fallisce, come fa lo storage vero.
  const snapshot = () => service.rows.map((row) => ({ ...row }));
  const database = {
    storage: { activeTransaction: () => null },
    async transactionAsync(critical) {
      const before = snapshot();
      try {
        return await critical();
      } catch (error) {
        service.rows.length = 0;
        for (const row of before) service.rows.push(row);
        throw error;
      }
    },
  };
  service.database = database;
  let writes = 0;
  const realApply = service.applyManaged;
  service.applyManaged = async (id, patch) => {
    writes += 1;
    if (writes === 2) throw new Error('injected storage failure');
    return realApply(id, patch);
  };
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'all', reason: 'serie finita' }),
    /injected storage failure/,
  );
  assert.deepEqual(
    service.rows.map((row) => row.status),
    ['booked', 'booked', 'booked'],
    'la serie resta intera quando una scrittura fallisce a metà giro',
  );
});

test('i days vengono rifiutati su ogni regola, mai ignorati (backlog:573a1e85942f)', () => {
  // La main ha stretto lo scope (solo daily/weekly/monthly) e rifiuta i
  // days su tutte le regole modellate: niente viene validato e poi
  // ignorato dall'espansione.
  for (const rule of [
    { kind: 'daily', interval: 1, count: 3, days: [1] },
    { kind: 'weekly', interval: 1, count: 3, days: [2] },
    { kind: 'monthly', interval: 1, count: 3, days: [2] },
  ]) {
    assert.throws(
      () => validateRecurrence(rule),
      (error) => error.details?.field === 'recurrence',
      `days su ${rule.kind} rifiutato`,
    );
  }
});
