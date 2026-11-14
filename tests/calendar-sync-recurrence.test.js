// @ts-check
/**
 * backlog:0f2ae629e09b — una serie collegata a Google arriva come evento
 * ricorrente: solo la testa porta la riga RRULE, le altre occorrenze non
 * spingono niente di loro, e una regola illeggibile non spinge una
 * ricorrenza indovinata.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { seriesRecurrence } from '../packages/calendar-sync/src/sync.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

const HEAD = {
  id: 'a-1',
  sourceKey: 'gym:series:1:r1',
  seriesKey: 'gym:series:1',
  occurrenceIndex: 0,
  startsAt: '2026-11-17T16:00:00.000Z',
  endsAt: '2026-11-17T17:00:00.000Z',
  recurrenceRule: JSON.stringify({ kind: 'weekly', unit: 'week', interval: 1, days: null, count: 4, until: null }),
};

test('la testa della serie spinge una sola riga RRULE', () => {
  assert.deepEqual(seriesRecurrence(HEAD), ['RRULE:FREQ=WEEKLY;COUNT=4']);
});

test('le altre occorrenze non spingono ricorrenza di loro', () => {
  assert.equal(seriesRecurrence({ ...HEAD, occurrenceIndex: 1 }), null);
  assert.equal(seriesRecurrence({ ...HEAD, occurrenceIndex: 2 }), null);
});

test('senza regola o con regola illeggibile: nessuna ricorrenza, mai indovinata', () => {
  assert.equal(seriesRecurrence({ ...HEAD, recurrenceRule: null }), null);
  assert.equal(seriesRecurrence({ ...HEAD, recurrenceRule: '' }), null);
  assert.equal(seriesRecurrence({ ...HEAD, recurrenceRule: 'not-json' }), null);
  assert.equal(seriesRecurrence({ ...HEAD, recurrenceRule: JSON.stringify({ kind: 'none' }) }), null);
  assert.equal(seriesRecurrence(null), null);
});

test('la riga segue la regola: giorni feriali e fine in una data', () => {
  assert.deepEqual(
    seriesRecurrence({
      ...HEAD,
      recurrenceRule: JSON.stringify({ kind: 'weekdays', unit: 'week', interval: 1, days: null, count: null, until: null }),
    }),
    ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
  );
  assert.deepEqual(
    seriesRecurrence({
      ...HEAD,
      recurrenceRule: JSON.stringify({
        kind: 'custom', unit: 'week', interval: 2, days: [2, 4], count: null, until: '2026-12-31',
      }),
    }),
    ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;UNTIL=20261231T235959Z'],
  );
});

test('mensile personalizzato: BYDAY del giorno della settimana, come la griglia', () => {
  // Martedì 17 novembre 2026 è il 3° martedì: la griglia locale apre i 3°
  // martedì (nth-weekday), quindi la riga spinta deve portare BYDAY=3TU —
  // una MONTHLY nuda ripeterebbe il giorno del mese su Google.
  assert.deepEqual(
    seriesRecurrence({
      ...HEAD,
      recurrenceRule: JSON.stringify({
        kind: 'custom', unit: 'month', interval: 2, days: null, count: 4, until: null,
      }),
    }),
    ['RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=3TU;COUNT=4'],
  );
});

test('il finto Google tiene la ricorrenza sulla riga come il vero', async () => {
  const calendar = createFakeGoogleCalendar();
  const created = await calendar.insertEvent({
    calendarId: 'primary',
    summary: 'Lezione PT',
    start: { dateTime: HEAD.startsAt },
    end: { dateTime: HEAD.endsAt },
    recurrence: seriesRecurrence(HEAD),
  });
  assert.deepEqual(created.recurrence, ['RRULE:FREQ=WEEKLY;COUNT=4']);
});
