// @ts-check
/**
 * backlog:0f2ae629e09b — appuntamento ricorrente come Google Calendar.
 *
 * La regola descrive la serie, l'espansione la apre in occorrenze una per
 * una (ognuna controllata sui conflitti con il suo 409 che nomina la
 * data), e recurrenceToRRule è la riga RRULE che descrive la regola.
 * Modifica e annullo con scope (backlog:6acf0a73bfc3: «solo questo / questo
 * e i successivi / tutti»): su una serie collegata a Google «solo questo»
 * aggiunge EXDATE e «questo e i successivi» chiude con UNTIL (più la nuova
 * serie quando la coda si sposta), sempre su Google prima che sulla griglia;
 * un rifiuto di Google lascia la griglia intatta con un 502 che nomina il
 * motivo. Il 409 APPOINTMENTS_SERIES_SCOPE_NOT_SYNCED non esiste più.
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
  bookFromLink,
  cancelAppointment,
  confirmBooking,
  proposeBooking,
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

test('i feriali hanno intervallo 1: un intervallo diverso viene rifiutato, mai espanso a metà', () => {
  // P1 review giro 6 (backlog:0f2ae629e09b): l'intervallo dei feriali era
  // validato e salvato ma ignorato dall'espansione — griglia e RRULE
  // divergevano. Ora la validazione lo rifiuta: solo intervallo 1.
  assert.deepEqual(validateRecurrence({ kind: 'weekdays', count: 3 }), {
    kind: 'weekdays', interval: 1, days: null, unit: 'week', count: 3, until: null,
  });
  for (const interval of [2, 3, 99]) {
    assert.throws(() => validateRecurrence({ kind: 'weekdays', interval, count: 3 }), (error) => (
      error instanceof ValidationError && error.details?.field === 'recurrence'
    ), `i feriali con intervallo ${interval} sono 400`);
    assert.throws(() => recurrenceToRRule({ kind: 'weekdays', interval, count: 3 }), (error) => (
      error instanceof ValidationError
    ), `la riga RRULE non indovina i feriali con intervallo ${interval}`);
  }
});

test('prenotare i feriali con intervallo rifiuta prima di ogni scrittura', async () => {
  const service = fakeAppointments();
  await assert.rejects(
    bookAppointment(contextFor(service), booking({ recurrence: { kind: 'weekdays', interval: 2, count: 3 } })),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'nessuna occorrenza scritta con la regola rifiutata');
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




test('la serie rifiuta un «owner hold» su un’occorrenza dopo la prima, come la singola (backlog:0f2ae629e09b)', async () => {
  // Seconda occorrenza (mar 24 nov, 16:00Z) coperta da un impegno del
  // titolare: la serie non si prenota, la proposta non passa.
  const hold = [{
    teamMemberId: 'coach-guido',
    startsAt: '2026-11-24T16:30:00.000Z',
    endsAt: '2026-11-24T17:30:00.000Z',
    title: 'visita medica privata',
  }];
  const calendarSync = { async listOwnerBlocks() { return hold; } };
  const recurrence = { kind: 'weekly', count: 3 };
  for (const via of ['book', 'propose']) {
    const service = fakeAppointments();
    const context = { ...contextFor(service), calendarSync };
    const request = { ...booking({ sourceKey: `gym:series:hold:${via}` }), recurrence };
    const failed = via === 'book'
      ? bookAppointment(context, request)
      : proposeBooking(context, { ...request, spaceId: 'spazio-1' });
    await assert.rejects(
      failed,
      (error) => {
        assert.equal(error.code, 'APPOINTMENTS_OVERLAP');
        assert.equal(error.status, 409);
        assert.match(error.message, /2 di 3/);
        assert.match(error.message, /titolare/);
        assert.doesNotMatch(error.message, /visita medica privata/, 'il titolo del titolare non esce a chi prenota');
        assert.equal(error.details?.occurrenceIndex, 1);
        return true;
      },
      `la serie cade sull’hold con via ${via}`,
    );
    assert.equal(service.rows.length, 0, `nessuna riga scritta con via ${via}`);
  }
});




test('la conferma di una serie è atomica: una conferma a metà fallita lascia tutto prenotato', async () => {
  const service = fakeAppointments();
  // Transazione finta con rollback, come nel test dell’annullo.
  const snapshot = () => service.rows.map((row) => ({ ...row }));
  service.database = {
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
  const context = { ...contextFor(service), permissionGate: allowGate() };
  const request = {
    ...booking({ recurrence: { kind: 'weekly', count: 3 } }),
    spaceId: 'spazio-1',
    confirmed: true,
  };
  // La prenota fallisce dentro la conferma, alla seconda occorrenza.
  let advances = 0;
  const realApply = service.applyManaged;
  service.applyManaged = async (id, patch, options) => {
    if (patch?.status === 'confirmed') {
      advances += 1;
      if (advances === 2) throw new Error('injected confirm failure');
    }
    return realApply(id, patch, options);
  };
  await assert.rejects(confirmBooking(context, request), /injected confirm failure/);
  assert.deepEqual(
    service.rows.map((row) => row.status),
    ['booked', 'booked', 'booked'],
    'la serie resta intera quando una conferma fallisce a metà giro',
  );
});


test('il link pubblico non apre serie: una richiesta con ricorrenza è 400 senza scrivere', async () => {
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: allowGate() };
  await assert.rejects(
    bookFromLink(context, {
      ...booking(),
      spaceId: 'spazio-1',
      linkToken: 'booking-link-pubblica-serie-01',
      recurrence: { kind: 'weekly', count: 3 },
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      return true;
    },
  );
  assert.equal(service.rows.length, 0, 'nessuna occorrenza scritta dal link pubblico');
});

test('il link pubblico accetta «Non si ripete» esplicito come un singolo (backlog:0f2ae629e09b)', async () => {
  // P1 review giro 9: la guardia leggeva la ricorrenza GREZZA della richiesta
  // e rifiutava anche { kind: 'none' } — ora legge quella normalizzata e
  // rifiuta solo una serie vera.
  const service = fakeAppointments();
  const context = { ...contextFor(service), permissionGate: allowGate() };
  const result = await bookFromLink(context, {
    ...booking(),
    spaceId: 'spazio-1',
    linkToken: 'booking-link-singolo-none-01',
    recurrence: { kind: 'none' },
  });
  assert.equal(result.decision, 'booked');
  assert.equal(service.rows.length, 1, 'un solo appuntamento, come senza ricorrenza');
});

test('una regola con sia count sia until è 400: griglia e RRULE non divergono (backlog:0f2ae629e09b)', () => {
  // P1 review giro 9: la validazione accettava count e until insieme ma la
  // riga RRULE ne scriveva uno solo — un solo cancello in validazione li
  // rifiuta su tutti i percorsi (valida, espandi, RRULE).
  const both = { kind: 'weekly', count: 3, until: '2026-12-31' };
  assert.throws(() => validateRecurrence(both), (error) => (
    error instanceof ValidationError && error.details?.field === 'recurrence'
  ));
  assert.throws(() => recurrenceToRRule(both), (error) => (
    error instanceof ValidationError && error.details?.field === 'recurrence'
  ));
  assert.throws(() => expandRecurrence({
    startsAtMs: TUE_MS, endsAtMs: TUE_MS + HOUR_MS, recurrence: both,
  }), (error) => (
    error instanceof ValidationError && error.details?.field === 'recurrence'
  ));
});

test('una serie vuota è 400 in proposta e in conferma, senza scrivere (backlog:0f2ae629e09b)', async () => {
  // P1 review giro 8: regola e finestra che non si incontrano (until prima
  // dell'inizio) espandono a zero occorrenze: la conferma rispondeva 500 e
  // la proposta abbozzava una serie vuota ma non prenotabile.
  const recurrence = { kind: 'weekly', until: '2026-11-01' };
  const confirming = fakeAppointments();
  await assert.rejects(
    confirmBooking(
      { ...contextFor(confirming), permissionGate: allowGate() },
      { ...booking({ sourceKey: 'gym:series:vuota:1', recurrence }), spaceId: 'spazio-1', confirmed: true },
    ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      assert.match(String(error.message), /non produce nessun appuntamento/);
      return true;
    },
  );
  assert.equal(confirming.rows.length, 0, 'nessuna riga scritta dalla conferma di una serie vuota');
  const proposing = fakeAppointments();
  await assert.rejects(
    proposeBooking(
      { ...contextFor(proposing), permissionGate: allowGate() },
      { ...booking({ sourceKey: 'gym:series:vuota:2', recurrence }), spaceId: 'spazio-1' },
    ),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.field, 'recurrence');
      assert.match(String(error.message), /non produce nessun appuntamento/);
      return true;
    },
  );
  assert.equal(proposing.rows.length, 0, 'nessuna riga scritta dalla proposta di una serie vuota');
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

test('serie collegata a Google: «solo questo» converge Google prima di scrivere (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const scoped = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      pushes.push(sourceKey);
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      return { status: 'pushed', sourceKey: headSourceKey, eventId: 'evt-1', change: 'series-test' };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const headKey = booked.occurrences[0].sourceKey;
  const before = service.rows.map((row) => row.startsAt);
  // «Solo questo» con calendario: Google converge prima della scrittura, poi la griglia si muove.
  const moved = await rescheduleAppointment(context, {
    id: booked.occurrences[2].id,
    startsAt: '2026-12-03T16:00:00.000Z',
    endsAt: '2026-12-03T17:00:00.000Z',
    scope: 'single',
    calendar: { calendarId: 'cal-1' },
    spaceId: 'spazio-1',
  });
  assert.equal(moved.moved, true);
  assert.equal(service.rows[2].startsAt, '2026-12-03T16:00:00.000Z');
  assert.equal(service.rows[0].startsAt, before[0], 'le altre occorrenze restano ferme');
  assert.equal(service.rows[1].startsAt, before[1], 'le altre occorrenze restano ferme');
  assert.equal(scoped.length, 1, 'la converge corre una volta sola, prima della scrittura');
  assert.equal(scoped[0].headSourceKey, headKey, 'la converge nomina la testa che porta la RRULE');
  assert.equal(scoped[0].plan.scope, 'single');
  assert.equal(scoped[0].plan.occurrenceStartsAt, before[2], 'EXDATE sull’istante originale');
  assert.equal(scoped[0].plan.movedStartsAt, '2026-12-03T16:00:00.000Z');
  assert.equal(scoped[0].plan.movedEndsAt, '2026-12-03T17:00:00.000Z');
  assert.equal(scoped[0].plan.movedSourceKey, booked.occurrences[2].sourceKey);
  assert.equal(pushes.length, 0, 'una sola strada verso Google: la converge prima del commit, mai la spinta della testa dopo');
  // «Questo e i successivi» con calendario: UNTIL più la nuova serie, poi la griglia.
  const tail = await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-25T16:00:00.000Z',
    endsAt: '2026-11-25T17:00:00.000Z',
    scope: 'following',
    calendar: { calendarId: 'cal-1' },
    spaceId: 'spazio-1',
  });
  assert.equal(tail.scope, 'following');
  assert.equal(scoped.length, 2);
  assert.equal(scoped[1].plan.scope, 'following');
  assert.equal(scoped[1].plan.scopeStartsAt, before[1]);
  assert.deepEqual(scoped[1].plan.tailRuleLines, ['RRULE:FREQ=WEEKLY;COUNT=2'], 'la coda tiene le due occorrenze');
  assert.equal(scoped[1].plan.tailSourceKey, booked.occurrences[1].sourceKey);
  assert.equal(pushes.length, 0, 'una sola strada verso Google anche per «questo e i successivi»');
  // «Tutti» con calendario resta com'era: la serie si muove e la push nomina
  // la testa, senza converge parziale.
  await rescheduleAppointment(context, {
    id: booked.occurrences[0].id,
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    scope: 'all',
    calendar: { calendarId: 'cal-1' },
    spaceId: 'spazio-1',
  });
  assert.equal(scoped.length, 2, '«tutti» non apre EXDATE né UNTIL');
  assert.ok(pushes.includes(headKey), '«tutti» spinge la testa');
});

test('se Google rifiuta lo spostamento parziale la griglia non cambia e il motivo si legge (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const scoped = [];
  const refusal = new Error('google patchEvent refused');
  refusal.code = 'GOOGLE_CALL_MALFORMED';
  refusal.status = 422;
  const calendarSync = {
    async pushAppointment() {
      throw new Error('non deve spingere su un rifiuto');
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      throw refusal;
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const before = service.rows.map((row) => row.startsAt);
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
      assert.equal(error.code, 'APPOINTMENTS_SERIES_SYNC_FAILED');
      assert.equal(error.status, 502, 'mai più il 409 della serie');
      assert.notEqual(error.status, 409);
      assert.match(String(error.message), /griglia non è cambiata/);
      assert.match(String(error.message), /GOOGLE_CALL_MALFORMED/);
      assert.equal(error.details?.providerCode, 'GOOGLE_CALL_MALFORMED');
      return true;
    },
  );
  assert.deepEqual(service.rows.map((row) => row.startsAt), before, 'il rifiuto arriva prima della prima scrittura');
  assert.equal(scoped.length, 1);
});

test('serie collegata a Google: «solo questo» annulla con EXDATE, «questo e i successivi» con UNTIL (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const pushes = [];
  const scoped = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      pushes.push(sourceKey);
      return { status: 'ok', sourceKey };
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      return { status: 'pushed', sourceKey: headSourceKey, eventId: 'evt-1', change: 'series-test' };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const headKey = booked.occurrences[0].sourceKey;
  const cal = { calendar: { calendarId: 'cal-1' }, spaceId: 'spazio-1', reason: 'serie finita' };
  // «Solo questo»: un evento solo si annulla anche su Google.
  const single = await cancelAppointment(context, { id: booked.occurrences[1].id, scope: 'single', ...cal });
  assert.equal(single.scope, 'single');
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'booked']);
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].headSourceKey, headKey);
  assert.equal(scoped[0].plan.scope, 'single');
  assert.equal(scoped[0].plan.occurrenceStartsAt, '2026-11-24T16:00:00.000Z');
  assert.ok(!('movedStartsAt' in scoped[0].plan), 'un annullo non apre eventi nuovi');
  assert.equal(scoped[0].plan.movedSourceKey, booked.occurrences[1].sourceKey, 'l’annullo ritira l’evento creato dallo spostamento');
  assert.equal(pushes.length, 0, 'una sola strada verso Google: la converge prima del commit, mai la spinta della testa dopo');
  // «Questo e i successivi»: la serie vecchia si chiude, senza nuova serie.
  const following = await cancelAppointment(context, { id: booked.occurrences[2].id, scope: 'following', ...cal });
  assert.equal(following.scope, 'following');
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'cancelled']);
  assert.equal(scoped.length, 2);
  assert.equal(scoped[1].plan.scope, 'following');
  assert.equal(scoped[1].plan.scopeStartsAt, '2026-12-01T16:00:00.000Z');
  assert.ok(!('tailRuleLines' in scoped[1].plan), 'una coda annullata non rinasce');
  assert.equal(scoped[1].plan.tailSourceKey, booked.occurrences[2].sourceKey, 'l’annullo ritira la coda creata dallo spostamento');
  assert.equal(pushes.length, 0, 'una sola strada verso Google anche per «questo e i successivi»');
  // «Tutti» resta com'era: annulla tutto e spinge la testa, senza converge parziale.
  const out = await cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'all', ...cal });
  assert.ok(service.rows.every((row) => row.status === 'cancelled'));
  assert.ok(pushes.includes(headKey), 'la push nomina la testa che porta la RRULE');
  assert.equal(out.scope, 'all');
  assert.equal(scoped.length, 2, '«tutti» non apre EXDATE né UNTIL');
});

test('se Google rifiuta l’annullo parziale la griglia non cambia e il motivo si legge (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const refusal = new Error('google patchEvent refused');
  refusal.code = 'GOOGLE_SYNC_TOKEN_INVALID';
  refusal.status = 410;
  const calendarSync = {
    async pushAppointment() {
      throw new Error('non deve spingere su un rifiuto');
    },
    async pushSeriesScope() {
      throw refusal;
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await assert.rejects(
    cancelAppointment(context, {
      id: booked.occurrences[1].id, scope: 'single', reason: 'spostato',
      calendar: { calendarId: 'cal-1' }, spaceId: 'spazio-1',
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_SYNC_FAILED');
      assert.equal(error.status, 502, 'mai più il 409 della serie');
      assert.match(String(error.message), /griglia non è cambiata/);
      assert.match(String(error.message), /GOOGLE_SYNC_TOKEN_INVALID/);
      return true;
    },
  );
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'booked', 'booked']);
});

test('serie mai esportata su Google: single e following cambiano solo la griglia (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const scoped = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      return { status: 'local-only', sourceKey: headSourceKey, reason: 'finto' };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await cancelAppointment(context, { id: booked.occurrences[1].id, scope: 'single', reason: 'spostato' });
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'booked']);
  assert.equal(scoped.length, 1, 'la converge corre, ma senza link non tocca Google');
  await rescheduleAppointment(context, {
    id: booked.occurrences[2].id,
    startsAt: '2026-12-03T16:00:00.000Z',
    endsAt: '2026-12-03T17:00:00.000Z',
    scope: 'single',
  });
  assert.equal(service.rows[2].startsAt, '2026-12-03T16:00:00.000Z');
});

test('senza la spinta delle serie la modifica parziale resta solo in griglia, mai 409 (backlog:6acf0a73bfc3)', async () => {
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
  const moved = await rescheduleAppointment(context, {
    id: booked.occurrences[2].id,
    startsAt: '2026-12-03T16:00:00.000Z',
    endsAt: '2026-12-03T17:00:00.000Z',
    scope: 'single',
    calendar: { calendarId: 'cal-1' },
    spaceId: 'spazio-1',
  });
  assert.equal(moved.moved, true, 'la serie mai esportata si sposta in griglia');
  assert.equal(service.rows[2].startsAt, '2026-12-03T16:00:00.000Z');
  assert.equal(pushes.length, 1, 'solo la head-push post-commit della riga, nessuna converge di serie');
  const cancelled = await cancelAppointment(context, {
    id: booked.occurrences[1].id, scope: 'single', reason: 'spostato',
    calendar: { calendarId: 'cal-1' }, spaceId: 'spazio-1',
  });
  assert.equal(cancelled.cancelled, true, 'la serie mai esportata si annulla in griglia');
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'booked']);
  assert.equal(pushes.length, 2, 'solo head-push post-commit, nessuna converge di serie');
});

test('la conferma di una serie con calendario esporta un solo evento ricorrente (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const pushed = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey, opts) {
      pushed.push({ calendarId, sourceKey, recurrence: opts?.recurrence ?? null });
      return { status: 'exported', sourceKey, eventId: 'evt-1' };
    },
  };
  const context = { ...contextFor(service), permissionGate: allowGate(), calendarSync };
  const result = await confirmBooking(context, {
    ...booking({ sourceKey: 'gym:series:export:1', recurrence: { kind: 'weekly', count: 3 } }),
    spaceId: 'spazio-1',
    confirmed: true,
    calendar: { calendarId: 'cal-1' },
  });
  assert.equal(result.decision, 'booked');
  assert.equal(result.occurrences.length, 3);
  assert.equal(pushed.length, 1, 'una sola esportazione per tutta la serie');
  assert.equal(pushed[0].sourceKey, result.appointment.sourceKey, 'la testa porta la serie');
  assert.deepEqual(pushed[0].recurrence, ['RRULE:FREQ=WEEKLY;COUNT=3'], 'la testa porta la RRULE su Google');
});

test('la conferma singola con calendario non porta righe di ricorrenza (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const pushed = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey, opts) {
      pushed.push({ calendarId, sourceKey, recurrence: opts?.recurrence ?? null });
      return { status: 'exported', sourceKey, eventId: 'evt-1' };
    },
  };
  const context = { ...contextFor(service), permissionGate: allowGate(), calendarSync };
  await confirmBooking(context, {
    ...booking({ sourceKey: 'gym:single:export:1' }),
    spaceId: 'spazio-1',
    confirmed: true,
    calendar: { calendarId: 'cal-1' },
  });
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].recurrence, null, 'il singolo resta un evento singolo');
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

test('la converge serie-Google non dipende dalla richiesta: con il bordo composto corre anche senza «calendar» (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const scoped = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      return { status: 'pushed', sourceKey: headSourceKey, eventId: 'evt-1', change: 'series-test' };
    },
    async readAppointmentDetail() {
      return { appointment: null, origin: 'locale', sync: null };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const before = service.rows.map((row) => row.startsAt);
  // Il link lo risolve la spinta dalla testa: la richiesta non nomina nessun calendario.
  const moved = await rescheduleAppointment(context, {
    id: booked.occurrences[2].id,
    startsAt: '2026-12-03T16:00:00.000Z',
    endsAt: '2026-12-03T17:00:00.000Z',
    scope: 'single',
  });
  assert.equal(moved.moved, true);
  assert.equal(service.rows[2].startsAt, '2026-12-03T16:00:00.000Z');
  assert.equal(scoped.length, 1, 'la converge corre anche senza «calendar» nella richiesta');
  assert.equal(scoped[0].plan.scope, 'single');
  assert.equal(scoped[0].plan.occurrenceStartsAt, before[2]);
  const tail = await rescheduleAppointment(context, {
    id: booked.occurrences[1].id,
    startsAt: '2026-11-25T16:00:00.000Z',
    endsAt: '2026-11-25T17:00:00.000Z',
    scope: 'following',
  });
  assert.equal(tail.scope, 'following');
  assert.equal(scoped.length, 2);
  assert.deepEqual(scoped[1].plan.tailRuleLines, ['RRULE:FREQ=WEEKLY;COUNT=2']);
  // «Tutti» senza «calendar» resta com'era: la serie si sposta, senza push.
  await rescheduleAppointment(context, {
    id: booked.occurrences[0].id,
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    scope: 'all',
  });
  assert.equal(scoped.length, 2, '«tutti» non apre EXDATE né UNTIL');
});

test('la converge serie-Google vale anche per l’annullo senza «calendar» nella richiesta (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const scoped = [];
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      return { status: 'pushed', sourceKey: headSourceKey, eventId: 'evt-1', change: 'series-test' };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await cancelAppointment(context, { id: booked.occurrences[1].id, scope: 'single', reason: 'spostato' });
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'booked']);
  assert.equal(scoped.length, 1, 'la converge corre anche senza «calendar» nella richiesta');
  assert.equal(scoped[0].plan.scope, 'single');
  await cancelAppointment(context, { id: booked.occurrences[2].id, scope: 'following', reason: 'serie finita' });
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'cancelled', 'cancelled']);
  assert.equal(scoped.length, 2);
  assert.equal(scoped[1].plan.scope, 'following');
});

test('«tutti» su una serie collegata a Google senza «calendar» viene rifiutato prima di scrivere (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const scoped = [];
  const calendarSync = {
    async pushAppointment() {
      throw new Error('la spinta della testa non deve partire: la griglia non si è mossa');
    },
    async pushSeriesScope(headSourceKey, plan) {
      scoped.push({ headSourceKey, plan });
      return { status: 'pushed', sourceKey: headSourceKey, eventId: 'evt-1', change: 'series-test' };
    },
    async readAppointmentDetail({ sourceKey }) {
      return { appointment: null, origin: 'google-calendar', sync: { googleEventId: 'cal-1:evt-1', sourceKey } };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  const before = service.rows.map((row) => ({ ...row }));
  await assert.rejects(
    rescheduleAppointment(context, {
      id: booked.occurrences[0].id,
      startsAt: '2026-11-18T16:00:00.000Z',
      endsAt: '2026-11-18T17:00:00.000Z',
      scope: 'all',
    }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_ALL_GOOGLE');
      assert.equal(error.status, 409);
      assert.match(String(error.message), /griglia non è cambiata/);
      return true;
    },
  );
  assert.deepEqual(service.rows, before, 'il rifiuto arriva prima della prima scrittura');
  assert.equal(scoped.length, 0, 'nessuna converge parziale per «tutti»');
  await assert.rejects(
    cancelAppointment(context, { id: booked.occurrences[0].id, scope: 'all', reason: 'serie finita' }),
    (error) => {
      assert.equal(error.code, 'APPOINTMENTS_SERIES_ALL_GOOGLE');
      assert.equal(error.status, 409);
      return true;
    },
  );
  assert.deepEqual(service.rows.map((row) => row.status), ['booked', 'booked', 'booked']);
});

test('«tutti» senza link resta solo griglia anche con il bordo composto (backlog:6acf0a73bfc3)', async () => {
  const service = fakeAppointments();
  const calendarSync = {
    async pushAppointment(calendarId, sourceKey) {
      return { status: 'noop', sourceKey, reason: 'finto' };
    },
    async pushSeriesScope(headSourceKey, plan) {
      return { status: 'local-only', sourceKey: headSourceKey, reason: 'finto' };
    },
    async readAppointmentDetail() {
      return { appointment: null, origin: 'locale', sync: null };
    },
  };
  const context = { ...contextFor(service), calendarSync };
  const booked = await bookAppointment(context, booking({ recurrence: { kind: 'weekly', count: 3 } }));
  await rescheduleAppointment(context, {
    id: booked.occurrences[0].id,
    startsAt: '2026-11-18T16:00:00.000Z',
    endsAt: '2026-11-18T17:00:00.000Z',
    scope: 'all',
  });
  assert.equal(service.rows[0].startsAt, '2026-11-18T16:00:00.000Z', 'la serie mai esportata si sposta in griglia');
});

test('permesso revocato e master mancante tengono il loro codice, mai 502 (backlog:6acf0a73bfc3)', async () => {
  const failures = [
    new AppError('grant revocato', { code: 'CALENDAR_GRANT_REVOKED', status: 409 }),
    new AppError('spazio sbagliato', { code: 'CALENDAR_GRANT_UNKNOWN', status: 404 }),
    new AppError('master mancante', { code: 'CALENDAR_SYNC_EVENT_UNKNOWN', status: 404 }),
    new AppError('non una serie', { code: 'CALENDAR_SYNC_SERIES_NOT_RECURRING', status: 422 }),
  ];
  for (const failure of failures) {
    const service = fakeAppointments();
    const calendarSync = {
      async pushAppointment() {
        throw new Error('non deve spingere su un rifiuto');
      },
      async pushSeriesScope() {
        throw failure;
      },
    };
    const context = { ...contextFor(service), calendarSync };
    const booked = await bookAppointment(context, booking({ sourceKey: `gym:serie:err:${failure.code}`, recurrence: { kind: 'weekly', count: 3 } }));
    const ids = new Set(booked.occurrences.map((entry) => entry.id));
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
        assert.equal(error.code, failure.code, 'il codice del contratto resta, non diventa 502');
        assert.equal(error.status, failure.status);
        return true;
      },
      `il rifiuto ${failure.code} non diventa 502`,
    );
    assert.deepEqual(
      service.rows.filter((row) => ids.has(row.id)).map((row) => row.startsAt),
      ['2026-11-17T16:00:00.000Z', '2026-11-24T16:00:00.000Z', '2026-12-01T16:00:00.000Z'],
      'la griglia non è cambiata',
    );
  }
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

test('i days sulle regole non settimanali vengono rifiutati, mai ignorati (backlog:573a1e85942f)', () => {
  for (const rule of [
    { kind: 'daily', interval: 1, count: 3, days: [1] },
    { kind: 'monthly', interval: 1, count: 3, days: [2] },
    { kind: 'yearly', interval: 1, count: 2, days: [3] },
    { kind: 'custom', unit: 'month', interval: 1, count: 3, days: [2] },
  ]) {
    assert.throws(
      () => validateRecurrence(rule),
      (error) => error.details?.field === 'recurrence',
      `days su ${rule.kind} rifiutato`,
    );
  }
  // La settimanale personalizzata resta l'unica che legge i days.
  assert.deepEqual(
    validateRecurrence({ kind: 'custom', unit: 'week', interval: 1, days: [2], count: 3 }),
    { kind: 'custom', interval: 1, days: [2], unit: 'week', count: 3, until: null },
  );
});


