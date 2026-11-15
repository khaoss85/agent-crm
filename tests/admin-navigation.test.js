// @ts-check

/**
 * Cambio di schermata (backlog:a0d10875): il percorso in alto cambia subito,
 * il contenuto vecchio deve sparire nello stesso istante e la nuova
 * schermata mostra uno stato di caricamento coerente col tema — mai 5-25 s
 * di schermata vecchia sotto un percorso nuovo. Una lettura lenta che si
 * risolve dopo l'uscita dalla schermata non dipinge più sopra quella nuova.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMountGate,
  paintScreenFailure,
  paintScreenLoading,
  resetScreenScroll,
} from '../apps/admin/public/admin-navigation.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

function paintOldScreen(mount, doc) {
  const old = doc.createElement('div');
  old.setAttribute('class', 'old-screen');
  old.textContent = 'Contenuto della schermata precedente';
  mount.appendChild(old);
  return old;
}

test('il cambio di vista toglie subito il contenuto vecchio e mostra il caricamento', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const old = paintOldScreen(mount, doc);

  const loading = paintScreenLoading({ doc, mount, label: 'Clienti' });

  assert.equal(mount.contains(old), false, 'il vecchio contenuto lascia il mount nello stesso istante');
  assert.equal(mount.childNodes.length, 1);
  assert.equal(mount.childNodes[0], loading);
  assert.equal(loading.getAttribute('class'), 'ui-loading');
  assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(loading.textContent, 'Carico Clienti…');
});

test('senza nome di schermata il caricamento resta neutro', () => {
  const doc = createFakeDocument();
  const mount = createMount();

  const loading = paintScreenLoading({ doc, mount });

  assert.equal(loading.textContent, 'Carico…');
  assert.equal(loading.getAttribute('aria-busy'), 'true');
});

test('la vista non attiva non dipinge sopra quella nuova (lettura lenta)', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const gate = createMountGate(mount);

  gate.activate('clienti');
  const clienti = gate.owned('clienti');
  const calendario = gate.owned('calendario');

  const line = doc.createElement('p');
  line.textContent = 'Clienti caricati';
  clienti.appendChild(line);
  assert.equal(mount.textContent.includes('Clienti caricati'), true);

  // L'operatore cambia schermata: la maniglia vecchia diventa inerte.
  gate.activate('calendario');
  const late = doc.createElement('p');
  late.textContent = 'Risposta lenta dei Clienti';
  clienti.appendChild(late);
  clienti.textContent = 'Risposta lenta dei Clienti';
  assert.equal(mount.textContent.includes('Risposta lenta'), false);

  // La vista attiva dipinge ancora.
  const fresh = doc.createElement('p');
  fresh.textContent = 'Calendario caricato';
  calendario.appendChild(fresh);
  assert.equal(mount.textContent.includes('Calendario caricato'), true);
});

test('la schermata che fallisce dice che non si apre, con Riprova', () => {
  const doc = createFakeDocument();
  const mount = createMount();

  const loading = paintScreenLoading({ doc, mount, label: 'Pipeline' });
  let retried = 0;
  const painted = paintScreenFailure({
    doc,
    mount,
    loading,
    label: 'Pipeline',
    onRetry: () => { retried += 1; },
  });

  assert.equal(painted, true);
  assert.equal(mount.textContent.includes('Carico'), false);
  assert.equal(mount.textContent.includes('Pipeline'), true);
  const note = mount.childNodes[0];
  assert.equal(note.getAttribute('role'), 'alert');
  const retry = note.findAll('button')[0];
  assert.ok(retry, 'la nota ha il bottone Riprova');
  retry.dispatch('click');
  assert.equal(retried, 1);
});

test('la nota di errore non tocca una schermata già dipinta', () => {
  const doc = createFakeDocument();
  const mount = createMount();

  const loading = paintScreenLoading({ doc, mount, label: 'Oggi' });
  // La vista dipinge davvero prima che l'errore arrivi (o l'operatore è
  // già su un'altra schermata): la riga di caricamento non c'è più.
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const painted = doc.createElement('p');
  painted.textContent = 'Oggi caricato';
  mount.appendChild(painted);

  const result = paintScreenFailure({ doc, mount, loading, label: 'Oggi', onRetry: () => {} });

  assert.equal(result, false);
  assert.equal(mount.textContent, 'Oggi caricato');
});

test('il cambio di schermata azzera lo scroll della finestra (backlog:25cf0cd8c678)', () => {
  const calls = [];
  const win = { scrollTo: (x, y) => { calls.push([x, y]); } };

  const result = resetScreenScroll({ win, doc: null });

  assert.equal(result, true);
  assert.deepEqual(calls, [[0, 0]]);
});

test('senza scrollTo lo scroll si azzera dal documento', () => {
  const root = { scrollTop: 500 };
  const body = { scrollTop: 500 };

  const result = resetScreenScroll({ win: {}, doc: { documentElement: root, body } });

  assert.equal(result, true);
  assert.equal(root.scrollTop, 0);
  assert.equal(body.scrollTop, 0);
});

test('senza finestra né documento non c’è niente da azzerare', () => {
  assert.equal(resetScreenScroll({}), false);
  assert.equal(resetScreenScroll(), false);
});
