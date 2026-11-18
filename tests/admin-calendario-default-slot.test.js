// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultManualSlot } from '../apps/admin/public/admin-calendario.js';

// backlog:8f10bea47ac8 — «Nuovo appuntamento» proponeva sempre domani
// 09:30 anche a giornata libera: la proposta è il primo slot di oggi dopo
// l'ora attuale, domani 09:30 solo quando oggi non ha più slot. Rosso sul
// codice di prima (domani 09:30), verde dopo la cura.

test('defaultManualSlot: alle 10:17 di Roma propone oggi 10:30–11:00, mai domani', () => {
  // Prova del Mac del 17/11: alle 10:17 di Roma, giornata libera.
  assert.deepEqual(
    defaultManualSlot(Date.parse('2026-11-17T09:17:00.000Z')),
    { date: '2026-11-17', start: '10:30', end: '11:00' },
  );
});

test('defaultManualSlot: prima dell’apertura propone oggi 09:00–09:30', () => {
  // 2026-10-21T06:00Z sono le 08:00 di Roma: la griglia apre ancora oggi.
  assert.deepEqual(
    defaultManualSlot(Date.parse('2026-10-21T06:00:00.000Z')),
    { date: '2026-10-21', start: '09:00', end: '09:30' },
  );
});

test('defaultManualSlot: l’ultimo slot utile è oggi 17:30–18:00', () => {
  // 15:20Z sono le 17:20 di Roma (ora legale): ci sta ancora uno slot.
  assert.deepEqual(
    defaultManualSlot(Date.parse('2026-10-21T15:20:00.000Z')),
    { date: '2026-10-21', start: '17:30', end: '18:00' },
  );
});

test('defaultManualSlot: a ora tarda propone domani 09:30–10:00', () => {
  // 17:00Z sono le 19:00 di Roma: oggi non ha più slot interi.
  assert.deepEqual(
    defaultManualSlot(Date.parse('2026-10-21T17:00:00.000Z')),
    { date: '2026-10-22', start: '09:30', end: '10:00' },
  );
});

test('defaultManualSlot: sullo scoccare salta lo slot appena iniziato', () => {
  // 09:30Z sono le 10:30 di Roma: lo slot delle 10:30 è già iniziato.
  assert.deepEqual(
    defaultManualSlot(Date.parse('2026-11-17T09:30:00.000Z')),
    { date: '2026-11-17', start: '11:00', end: '11:30' },
  );
});
