import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamRows, duplicateTeamHints } from '../apps/admin/public/admin-spazi-accessi.js';

/**
 * backlog:6563edf41aab (ritorno verifica 17/11 + ANSWER supervisore 17/11):
 * il doppione resta quando i due account hanno un accesso diverso
 * (servizio o Google): duplicateTeamHints resta muto. La stessa risoluzione
 * della persona deve coprire anche accessi diversi: due righe che dipingono
 * lo stesso nome vanno segnalate in Impostazioni anche con access diversi.
 */
test('backlog:6563edf41aab: doppione con accessi diversi va segnalato', () => {
  const rows = buildTeamRows([
    { subject: 'google|1049887766', displayName: 'Daniele Pelleri', role: 'owner', status: 'active' },
    { subject: 'broker+adopted-7f3a', displayName: 'daniele pelleri', role: 'operator', status: 'active' },
  ]);
  assert.equal(rows.length, 2, 'due righe distinte (chiavi e accessi diversi, il nome da solo non fonde)');
  const accesses = rows.map((row) => row.access);
  assert.ok(
    accesses.some((access) => typeof access === 'string' && access.includes('Google')),
    `una riga legge Accesso Google, letto: ${JSON.stringify(accesses)}`,
  );
  const hints = duplicateTeamHints(rows);
  assert.equal(hints.length, 1, 'stesso nome dipinto con accessi diversi: un segnale in Impostazioni');
  assert.match(hints[0].text, /daniele pelleri/i, 'il segnale nomina la persona');
});
