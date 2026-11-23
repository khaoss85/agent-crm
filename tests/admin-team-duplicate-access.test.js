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

/**
 * backlog:6563edf41aab (review indipendente PR #1043, P2 su
 * admin-spazi-accessi.js:471): due righe senza nome («Membro del team») con
 * accessi diversi non sono un doppione — il segnaposto non fa prova e
 * l'avviso invita a rimuovere una persona viva.
 */
test('backlog:6563edf41aab: il segnaposto senza nome non è un doppione', () => {
  const rows = buildTeamRows([
    { subject: 'google|111', role: 'operator', status: 'active' },
    { subject: 'broker+xyz', role: 'operator', status: 'active' },
  ]);
  assert.deepEqual(rows.map((row) => row.name), ['Membro del team', 'Membro del team']);
  assert.equal(duplicateTeamHints(rows).length, 0, 'due segnaposto con accessi diversi: nessun falso avviso');
});

/**
 * backlog:6563edf41aab (ANSWER supervisore 18/11 22:0xZ, punti b+c): l'avviso
 * spiega la causa (una riga è l'accesso di servizio, l'altra il login Google)
 * e non consiglia mai Rimuovi: sospende la persona in tutta l'organizzazione.
 */
test('backlog:6563edf41aab: l\u2019avviso spiega gli accessi e non consiglia Rimuovi', () => {
  const rows = buildTeamRows([
    { subject: 'google|1049887766', displayName: 'Daniele Pelleri', role: 'owner', status: 'active' },
    { subject: 'broker+adopted-7f3a', displayName: 'daniele pelleri', role: 'operator', status: 'active' },
  ]);
  const hints = duplicateTeamHints(rows);
  assert.equal(hints.length, 1);
  assert.ok(!hints[0].text.includes('Rimuovi'), `niente consiglio pericoloso, letto: ${hints[0].text}`);
  assert.match(hints[0].text, /Google/, 'l\u2019avviso dice da dove viene una riga');
  assert.match(hints[0].text, /servizio/i, 'l\u2019avviso dice da dove viene l\u2019altra riga');
});
