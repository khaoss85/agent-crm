// @ts-check
/**
 * backlog:0f2ae629e09b — appuntamento ricorrente come Google Calendar.
 *
 * La regola descrive la serie, l'espansione la apre in occorrenze una per
 * una (ognuna controllata sui conflitti con il suo 409 che nomina la
 * data), e recurrenceToRRule è la riga RRULE che calendar-sync spinge su
 * Google: la serie arriva lì come un evento ricorrente, non N singoli.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandRecurrence,
  recurrenceOptions,
  recurrenceToRRule,
  validateRecurrence,
} from '../packages/appointments/src/recurrence.js';
import {
  bookAppointment,
  cancelAppointment,
  confirmBooking,
  proposeBooking,
  rescheduleAppointment,
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

test('null, undefined e «none» sono «Non si ripete»; un kind ignoto viene rifiutato', () => {
  assert.equal(validateRecurrence(null), null);
  assert.equal(validateRecurrence(undefined), null);
  assert.equal(validateRecurrence({ kind: 'none' }), null);
  assert.throws(() => validateRecurrence({ kind: 'bogus' }), (error) => (
    error instanceof ValidationError && error.details?.field === 'recurrence'
  ));
});

test('le regole personalizzate falliscono chiuse, mai indovinate', () => {
  assert.throws(() => validateRecurrence({ kind: 'custom', unit: 'week' }), /names its days/);
  assert.throws(() => validateRecurrence({ kind: 'custom', unit: 'week', days: [2], interval: 0 }), /interval/);
  assert.throws(() => validateRecurrence({ kind: 'custom', unit: 'week', days: [2], interval: 1, count: 0 }), /from 1 to 365/);
  assert.throws(() => validateRecurrence({ kind: 'custom', unit: 'year' }), /one of day, week, month/);
  const rule = validateRecurrence({ kind: 'custom', unit: 'week', interval: 2, days: [2, 4], count: 6 });
  assert.deepEqual(rule, { kind: 'custom', unit: 'week', interval: 2, days: [2, 4], count: 6, until: null });
});

test('le etichette si calcolano dalla data scelta', () => {
  const labels = Object.fromEntries(recurrenceOptions(TUE).map((entry) => [entry.value, entry.label]));
  assert.equal(labels.none, 'Non si ripete');
  assert.equal(labels.daily, 'Ogni giorno');
  assert.equal(labels.weekly, 'Ogni settimana di martedì');
  assert.equal(labels.monthly, 'Ogni mese il 3° martedì');
  assert.equal(labels.yearly, 'Ogni anno il 17 novembre');
  assert.equal(labels.weekdays, 'Tutti i giorni feriali (lun–ven)');
  assert.equal(labels.custom, 'Personalizza…');
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

test('i feriali saltano il weekend', () => {
  // Venerdì 20 novembre 2026: ven, lun, mar.
  const fri = Date.parse('2026-11-20T17:00:00+01:00');
  const slots = expandRecurrence({
    startsAtMs: fri, endsAtMs: fri + HOUR_MS, recurrence: { kind: 'weekdays', count: 3 },
  });
  assert.deepEqual(slots.map((slot) => slot.startsAt.slice(0, 10)), [
    '2026-11-20', '2026-11-23', '2026-11-24',
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

test('la regola diventa una sola riga RRULE', () => {
  assert.equal(recurrenceToRRule({ kind: 'daily' }), 'RRULE:FREQ=DAILY');
  assert.equal(recurrenceToRRule({ kind: 'weekdays' }), 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(
    recurrenceToRRule({ kind: 'custom', unit: 'week', interval: 2, days: [2, 4], count: 6 }),
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=6',
  );
  assert.match(recurrenceToRRule({ kind: 'weekly', until: '2026-12-31' }), /^RRULE:FREQ=WEEKLY;UNTIL=20261231T235959Z$/);
  assert.equal(recurrenceToRRule(null), null);
});

test('Conferma crea le occorrenze visibili in griglia, ognuna con la sua chiave di serie', async () => {
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

test('annullare chiede solo questo / successivi / tutti e fa esattamente quello', async () => {
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

test('annullare «tutti» chiude la serie intera', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const cancelled = await cancelAppointment(context, { id: booked.occurrences[2].id, scope: 'all', reason: 'serie finita' });
  assert.equal(cancelled.occurrences.length, 3);
  assert.ok(service.rows.every((row) => row.status === 'cancelled'));
});

test('spostare «questo e i successivi» tiene il ritmo della serie', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const moved = await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-25T16:00:00.000Z',
    endsAt: '2026-11-25T17:00:00.000Z',
    scope: 'following',
  });
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

test('uno scope largo su una riga fuori serie viene rifiutato', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const single = await bookAppointment(context, booking());
  await assert.rejects(
    cancelAppointment(context, { id: single.appointment.id, scope: 'all', reason: 'serie finita' }),
    (error) => error.details?.field === 'scope',
  );
});

test('la richiesta di prenotazione porta la ricorrenza alla proposta: un conflitto dopo la testa ferma tutto', async () => {
  // validateAppointmentRequest legge e normalizza la ricorrenza della claim.
  const input = validateAppointmentRequest(booking({ recurrence: { kind: 'weekly', count: 2 } }));
  assert.deepEqual(input.recurrence, { kind: 'weekly', unit: 'week', interval: 1, days: null, count: 2, until: null });
  assert.equal(validateAppointmentRequest(booking()).recurrence, null);
});

/** Il gate dei permessi per i percorsi di proposta e conferma. */
const allowGate = (seen = null) => ({
  async gate() { return { decision: 'allow' }; },
  async propose(input) {
    if (seen) seen.push(input);
    return { proposalId: `p-${(seen ?? []).length + 1}`, replayed: false };
  },
});

test('Conferma di una serie conferma tutte le occorrenze, non solo la testa', async () => {
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: allowGate() };
  const result = await confirmBooking(context, {
    ...booking({ recurrence: { kind: 'weekly', count: 3 } }),
    spaceId: 'spazio-1',
    confirmed: true,
  });
  assert.equal(result.decision, 'booked');
  assert.equal(result.occurrences.length, 3);
  assert.ok(result.occurrences.every((row) => row.status === 'confirmed'), 'ogni occorrenza è confermata');
  assert.deepEqual(service.rows.map((row) => row.status), ['confirmed', 'confirmed', 'confirmed']);
});

test('singolo e serie sulla stessa testa hanno identità e bozze diverse', async () => {
  const service = fakeAppointments();
  const seen = [];
  const agent = {
    ...contextFor(service),
    actor: { type: 'agent', id: 'agent-1' },
    permissionGate: { async gate() { return { decision: 'deny' }; }, async propose(input) { seen.push(input); return { proposalId: `p-${seen.length}`, replayed: false }; } },
  };
  const base = { ...booking(), spaceId: 'spazio-1' };
  await proposeBooking(agent, base);
  await proposeBooking(agent, { ...base, recurrence: { kind: 'weekly', count: 4 } });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].actionKey, seen[1].actionKey, 'la ricorrenza cambia la chiave della proposta');
  // La bozza umana porta la ricorrenza: la conferma sa cosa sta per creare.
  const human = { ...contextFor(service), permissionGate: allowGate() };
  const draftSingle = await proposeBooking(human, base);
  const draftSeries = await proposeBooking(human, { ...base, recurrence: { kind: 'weekly', count: 4 } });
  assert.equal(draftSingle.decision, 'confirm-required');
  assert.equal(draftSingle.draft.recurrence, null);
  assert.deepEqual(draftSeries.draft.recurrence, { kind: 'weekly', unit: 'week', interval: 1, days: null, count: 4, until: null });
});

test('mensile personalizzato: griglia ed RRULE dicono lo stesso giorno', () => {
  // Martedì 17 novembre 2026 è il 3° martedì: la griglia apre i 3° martedì,
  // quindi la riga RRULE deve portare BYDAY=3TU ogni due mesi.
  const rule = { kind: 'custom', unit: 'month', interval: 2, count: 4 };
  assert.equal(
    recurrenceToRRule(rule, '2026-11-17T16:00:00.000Z'),
    'RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=3TU;COUNT=4',
  );
  const slots = expandRecurrence({
    startsAtMs: Date.parse('2026-11-17T16:00:00.000Z'),
    endsAtMs: Date.parse('2026-11-17T17:00:00.000Z'),
    recurrence: rule,
  });
  assert.deepEqual(slots.map((slot) => slot.startsAt.slice(0, 10)), [
    '2026-11-17', '2027-01-19', '2027-03-16', '2027-05-18',
  ]);
});

test('annullare con una riga terminale nello scope rifiuta tutto senza scrivere niente', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  // Una visita già avvenuta: stato terminale dentro lo scope «tutti».
  await service.applyManaged(booked.occurrences[1].id, { status: 'done' });
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'all', reason: 'serie finita' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(
    service.rows.map((row) => row.status),
    ['booked', 'done', 'booked'],
    'nessuna cancellazione parziale: il rifiuto arriva prima della prima scrittura',
  );
});

test('la serie deve partire dalla data scelta: feriali dal sabato e custom senza il giorno di inizio sono 400', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  // Sabato 14 novembre 2026: i feriali partirebbero di lunedì, non di sabato.
  await assert.rejects(
    bookAppointment(context, booking({
      startsAt: '2026-11-14T16:00:00.000Z',
      endsAt: '2026-11-14T17:00:00.000Z',
      recurrence: { kind: 'weekdays', count: 3 },
    })),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      assert.match(String(error.message), /giorno di inizio/);
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'nessuna occorrenza scritta quando la testa è fuori regola');
  // Custom settimanale che parte martedì ma nomina solo giovedì (ISO 4).
  await assert.rejects(
    bookAppointment(context, booking({ recurrence: { kind: 'custom', unit: 'week', days: [4], count: 3 } })),
    (error) => error.status === 400 && error.details?.field === 'recurrence',
  );
  assert.equal(service.rows.length, 0, 'nessuna occorrenza scritta quando la testa è fuori regola');
});

test('la stessa regola vale in proposta: una testa fuori regola ferma tutto con lo stesso 400', async () => {
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: allowGate() };
  await assert.rejects(
    proposeBooking(context, {
      ...booking(),
      spaceId: 'spazio-1',
      recurrence: { kind: 'custom', unit: 'week', days: [4], count: 3 },
    }),
    (error) => error.status === 400 && error.details?.field === 'recurrence',
  );
});

test('serie collegata a Google: solo «tutti» si sposta, single e following sono 409 prima di ogni scrittura', async () => {
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

test('serie collegata a Google: single e following non annullano, «tutti» annulla e spinge la testa', async () => {
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

test('senza bordo calendario single e following funzionano come ora', async () => {
  const service = fakeAppointments();
  const context = contextFor(service);
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  // Senza calendarSync nel contesto il bordo non esiste: gli scope parziali
  // restano permessi.
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

test('annullare «tutti» con la seconda scrittura che fallisce non lascia niente annullato', async () => {
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
