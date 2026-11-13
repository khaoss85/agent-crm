// @ts-check

/**
 * cta-loading (Dan 11/11): «quando clicco su aggiungi nome non c'è un loader
 * sul CTA che fa capire che la sta salvando (da verificare in generale su
 * tutte le CTA: salva, modifica ecc)».
 *
 * One shared helper, `uiBusy` in admin-ui.js, gives every write button of
 * the /bo the same waiting state: off, aria-busy, «Salvo…». It comes back
 * as it was after a refusal, and a double tap is one write. Views that
 * rebuild their buttons while the write is in flight use `uiMarkBusy` on
 * the rebuilt button instead.
 *
 * The guard at the end keeps it that way: a click handler that writes on its
 * own, or a view file that writes without either helper, fails here unless
 * it is listed below with the reason it already shows its wait.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_BUSY_LOCKED, uiBusy, uiHold, uiIcon, uiMarkBusy } from '../apps/admin/public/admin-ui.js';
import { addFieldForm } from '../apps/admin/public/admin-custom-fields.js';
import { createFakeDocument } from './helpers/fake-dom.js';
import { writeButtonsWithoutWait } from './helpers/cta-busy-scan.js';

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/** A promise the test settles by hand. */
function deferred() {
  /** @type {(value?: any) => void} */
  let resolve = () => {};
  /** @type {(error: any) => void} */
  let reject = () => {};
  const promise = new Promise((ok, ko) => { resolve = ok; reject = ko; });
  return { promise, resolve, reject };
}

function button(doc, label) {
  const node = doc.createElement('button');
  node.textContent = label;
  return node;
}

test('uiBusy: while the write runs the button is off, busy and says «Salvo…»', async () => {
  const doc = createFakeDocument();
  const save = button(doc, 'Salva');
  const gate = deferred();
  const running = uiBusy(save, 'Salvo…', () => gate.promise);
  assert.equal(save.textContent, 'Salvo…');
  assert.equal(save.getAttribute('aria-busy'), 'true');
  assert.equal(save.disabled, true);
  gate.resolve('ok');
  assert.equal(await running, 'ok', 'the work result comes back to the caller');
  assert.equal(save.textContent, 'Salva', 'the label is back after success');
  assert.equal(save.getAttribute('aria-busy'), null);
  assert.equal(save.disabled, false);
});

test('uiBusy: a refusal gives the button back and reaches the caller', async () => {
  const doc = createFakeDocument();
  const save = button(doc, 'Salva');
  const error = doc.createElement('small');
  const click = () => uiBusy(save, 'Salvo…', async () => {
    try {
      throw Object.assign(new Error('boom'), { status: 500 });
    } catch {
      error.textContent = 'Salvataggio non riuscito. Riprova più tardi.';
    }
  });
  await click();
  assert.equal(save.textContent, 'Salva');
  assert.equal(save.disabled, false, 'pressable again to retry');
  assert.equal(save.getAttribute('aria-busy'), null);
  assert.equal(error.textContent, 'Salvataggio non riuscito. Riprova più tardi.', 'the caller still writes its own message');
  await assert.rejects(uiBusy(save, 'Salvo…', async () => { throw new Error('uncaught'); }), /uncaught/,
    'an error the caller did not catch is not swallowed');
  assert.equal(save.textContent, 'Salva', 'restored even when the error escapes');
  assert.equal(save.disabled, false);
});

test('uiBusy: a double tap is one write', async () => {
  const doc = createFakeDocument();
  const save = button(doc, 'Salva');
  const gate = deferred();
  let writes = 0;
  save.addEventListener('click', () => uiBusy(save, 'Salvo…', async () => { writes += 1; await gate.promise; }));
  save.dispatch('click');
  save.dispatch('click');
  save.dispatch('click');
  await flush();
  assert.equal(writes, 1, 'one write for three taps');
  gate.resolve();
  await flush();
  save.dispatch('click');
  await flush();
  assert.equal(writes, 2, 'once settled, the next press writes again');
});

test('uiBusy: icons come back, a button that was off stays off, LOCKED keeps it off', async () => {
  const doc = createFakeDocument();
  const tile = doc.createElement('button');
  tile.appendChild(uiIcon(doc, 'telefono-piu'));
  const words = doc.createElement('span');
  words.textContent = 'Aggiungi telefono';
  tile.appendChild(words);
  await uiBusy(tile, 'Salvo…', async () => {
    assert.equal(tile.textContent, 'Salvo…');
  });
  assert.equal(tile.childNodes.length, 2, 'the icon and the words are back');
  assert.equal(tile.textContent, 'Aggiungi telefono');

  const off = button(doc, 'Conferma');
  off.disabled = true;
  await uiBusy(off, 'Invio…', async () => {});
  assert.equal(off.disabled, true, 'its previous state, not a blanket enable');

  const uncertain = button(doc, 'Conferma');
  await uiBusy(uncertain, 'Creo…', async () => UI_BUSY_LOCKED);
  assert.equal(uncertain.disabled, true, 'an uncertain create stays locked');
  assert.equal(uncertain.textContent, 'Conferma');
  assert.equal(uncertain.getAttribute('aria-busy'), null);

  const iconRenamed = doc.createElement('button');
  iconRenamed.appendChild(uiIcon(doc, 'telefono-piu'));
  await uiBusy(iconRenamed, 'Salvo…', async () => { iconRenamed.textContent = 'Salvato'; });
  assert.equal(iconRenamed.textContent, 'Salvato', 'an icon button keeps the label its work wrote too');

  const renamed = button(doc, 'Invia');
  await uiBusy(renamed, 'Invio…', async () => { renamed.textContent = 'Inviato'; });
  assert.equal(renamed.textContent, 'Inviato', 'a label the work wrote itself stays');
});

test('uiHold: a write that starts mid-handler holds the button and gives it back', () => {
  const doc = createFakeDocument();
  const confirm = button(doc, 'Conferma');
  const release = uiHold(confirm, 'Prenoto…');
  assert.equal(confirm.textContent, 'Prenoto…');
  assert.equal(confirm.getAttribute('aria-busy'), 'true');
  assert.equal(confirm.disabled, true);
  release();
  assert.equal(confirm.textContent, 'Conferma');
  assert.equal(confirm.getAttribute('aria-busy'), null);
  assert.equal(confirm.disabled, false);
  const locked = uiHold(confirm, 'Prenoto…');
  locked(true);
  assert.equal(confirm.disabled, true, 'keepOff leaves it off');
});

test('uiMarkBusy: the busy look for a rebuilt button', () => {
  const doc = createFakeDocument();
  const invite = button(doc, 'Invita');
  assert.equal(uiMarkBusy(invite, 'Invito…'), invite);
  assert.equal(invite.textContent, 'Invito…');
  assert.equal(invite.disabled, true);
  assert.equal(invite.getAttribute('aria-busy'), 'true');
});

// The scheda «+ Aggiungi campo» form: Dan's «aggiungi nome» may be the name
// of a new field. Crea campo reads «Creo…» while the definition is posted.
test('Crea campo reads «Creo…» while it posts and «Crea campo» after a refusal', async () => {
  const doc = createFakeDocument();
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.setAttribute('class', cls);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const gate = deferred();
  let posts = 0;
  const form = addFieldForm(el, { onDefine: async () => { posts += 1; return gate.promise; } });
  const label = form.wrap.findAll('input').find((node) => node.getAttribute('name') === 'nuovo-campo-label');
  label.value = 'Amico';
  const save = form.wrap.findAll('button').find((node) => node.getAttribute('data-action') === 'create-field');
  save.dispatch('click');
  save.dispatch('click');
  await flush();
  assert.equal(save.textContent, 'Creo…');
  assert.equal(save.getAttribute('aria-busy'), 'true');
  assert.equal(posts, 1, 'a double tap is one definition');
  gate.reject(new Error('Esiste già un campo con questo nome.'));
  await flush();
  assert.equal(save.textContent, 'Crea campo');
  assert.equal(save.disabled, false);
  const error = form.wrap.findAll('small').find((node) => node.getAttribute('class') === 'field-error');
  assert.equal(error.textContent, 'Esiste già un campo con questo nome.', 'the refusal reads next to the button');
});

// ---------------------------------------------------------------------------
// Guard, one button at a time (backlog:07895caaa4be, seguito della review
// Muse di #775): every click/submit handler of a /bo view that writes shows
// its wait, or is named below with the reason. The scan is in
// tests/helpers/cta-busy-scan.js.
// ---------------------------------------------------------------------------

const ADMIN_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'admin', 'public');

/**
 * Write buttons the scan cannot judge, checked by hand: mostly views that
 * rebuild the pressed button from their own state while the write runs (or
 * show it through an object method), plus two Annulla whose only write is
 * the background mark-read of the card they re-read. Key `file#button` → how many such handlers the
 * file has, and where the wait is painted. The counts are exact: a new
 * handler fails here, and one that moves to uiBusy/uiHold asks to shrink
 * the list.
 */
const HAND_CHECKED = new Map([
  ['admin-agenti.js#once', [1, 'Affida reads «Invio…» from draft.busy at render']],
  ['admin-agenti.js#save', [1, 'Salva modifica reads «Salvo…» from decision.busy at render']],
  ['admin-agenti.js#confirm', [1, 'Conferma rifiuto reads «Rifiuto…» from decision.busy at render']],
  ['admin-agenti.js#add', [1, 'Aggiungi reads «Aggiungo…» from state.adding at render']],
  ['admin-calendario.js#yes', [1, 'annulla appuntamento: Sì is off and aria-busy from state.cancelBusy at render']],
  ['admin-calendario.js#move', [1, 'Sposta reads «Spostamento in corso…» via uiMarkBusy from state.moveBusy']],
  ['admin-calendario.js#find', [1, 'Trova slot liberi reads «Cerco…» via uiMarkBusy from state.aiLoading']],
  ['admin-calendario.js#retry', [1, 'phrase Riprova: the card is replaced by «Sto cercando…» and the find button reads «Cerco…»']],
  ['admin-connectors.js#go', [3, 'Autorizza/Concludi/Collega read «Collego…»/«Concludo…» via uiMarkBusy from flow.busy']],
  ['admin-connectors.js#more', [1, 'Continua l’importazione reads «Importo…» via uiMarkBusy from flow.busy']],
  ['admin-customer-card.js#go', [1, 'Genera reads «Scrivo…» and is off inside generate()']],
  ['admin-customer-card.js#cancel', [1, 'Annulla re-reads the card; its only write is the background mark-read (markRead), no CTA']],
  ['admin-customer-card.js#form.cancel', [1, 'Annulla of + Aggiungi campo re-reads the card; only the background mark-read writes']],
  ['admin-offer-panel.js#go', [1, 'Compila reads «Compilo…» and is off inside fill()']],
  ['admin-personalizzazione.js#toggle', [1, 'Disattiva reads «Disattivo…» via uiMarkBusy (busyOn) at render']],
  ['admin-personalizzazione.js#add', [1, 'Attiva reads «Attivo…» via uiMarkBusy (busyOn) at render']],
  ['admin-pipeline.js#moveButton', [1, 'the card and Sposta go aria-busy through cardView.start (markCardBusy)']],
  ['admin-pipeline.js#confirmYes', [1, 'the card goes aria-busy and Conferma off through cardView.start (markCardBusy)']],
  ['admin-pipeline.js#go', [1, 'the panel Sposta goes aria-busy through drawer.moveView.start (lockControls)']],
  ['admin-pipeline.js#confirmPanel.yes', [1, 'the panel goes aria-busy through drawer.moveView.start (lockControls)']],
  ['admin-sequenze.js#create', [1, 'Crea la sequenza reads «Creo…» via uiMarkBusy from form.busy']],
  ['admin-sequenze.js#confirm', [1, 'Crea la sequenza (AI) reads «Creo…» via uiMarkBusy from panelState.busy']],
  ['admin-spazi-accessi.js#yes', [2, 'Conferma rimozione/interruttore read «Rimuovo…»/«Salvo…» via uiMarkBusy (busyOn)']],
  ['admin-spazi-accessi.js#send', [1, 'Invita reads «Invito…» via uiMarkBusy (busyOn)']],
  ['admin-sync.js#button', [1, 'Sincronizza ora reads «Sincronizzo…» with a spinner from state.syncingAll at render']],
]);

function viewFiles() {
  return readdirSync(ADMIN_PUBLIC).filter((name) => name.endsWith('.js')).sort();
}

test('scan: a button that writes with no wait is reported, with its chain', () => {
  const direct = `
    save.addEventListener('click', async () => {
      await client.request('/api/x', { method: 'POST', body: '{}' });
    });`;
  assert.deepEqual(writeButtonsWithoutWait(direct).map((row) => row.button), ['save']);
  // Review Muse #775 P3: a sync wrapper or a delegated helper is followed.
  const wrapped = `
    async function mutate(path) { return client.request(path, { method: 'POST' }); }
    async function invite() { await mutate('/api/invite'); }
    send.addEventListener('click', () => { void invite(); });
    keep.addEventListener('click', invite);`;
  const rows = writeButtonsWithoutWait(wrapped);
  assert.deepEqual(rows.map((row) => row.button), ['send', 'keep']);
  assert.deepEqual(rows[0].chain, ['invite', 'mutate']);
  // A file with uiBusy somewhere does not cover its other buttons.
  const mixed = `
    a.addEventListener('click', () => uiBusy(a, 'Salvo…', async () => { await client.request('/a', { method: 'PATCH' }); }));
    b.addEventListener('click', async () => { await client.request('/b', { method: 'DELETE' }); });`;
  assert.deepEqual(writeButtonsWithoutWait(mixed).map((row) => row.button), ['b']);
});

test('scan: a wait shown by the handler or the function it calls covers it; deferred code does not write', () => {
  const covered = `
    function hold() { const release = uiHold(go, 'Salvo…'); return client.request('/x', { method: 'POST' }).finally(release); }
    go.addEventListener('click', () => { void hold(); });
    flag.addEventListener('click', async () => {
      flag.setAttribute('aria-busy', 'true');
      await client.request('/y', { method: 'PUT' });
    });`;
  assert.deepEqual(writeButtonsWithoutWait(covered), []);
  // Annulla re-renders a card whose Salva writes later: Annulla writes nothing.
  const deferred = `
    function renderCard() {
      const save = el('button');
      save.addEventListener('click', () => uiBusy(save, 'Salvo…', () => client.request('/z', { method: 'POST' })));
      const later = () => client.request('/w', { method: 'POST' });
      return later;
    }
    cancel.addEventListener('click', () => { renderCard(); });`;
  assert.deepEqual(writeButtonsWithoutWait(deferred), []);
});

// Review Muse #831: the press's own continuations are followed; comments
// never count; double quotes and parameters with parentheses are read.
test('scan: a write in a .then, a forEach or an IIFE of the press is still the press', () => {
  const continuation = `
    save.addEventListener('click', () => { void Promise.resolve().then(async () => { await client.request('/x', { method: 'POST' }); }); });
    each.addEventListener('click', () => { rows.forEach((row) => { void client.request('/r', { method: 'DELETE' }); }); });
    iife.addEventListener('click', () => { (async () => { await client.request('/i', { method: 'PATCH' }); })(); });`;
  assert.deepEqual(writeButtonsWithoutWait(continuation).map((row) => row.button), ['save', 'each', 'iife']);
});

test('scan: comments never cover, double quotes and parenthesised parameters are read', () => {
  const commented = `
    go.addEventListener('click', async () => {
      // TODO: set 'aria-busy' here
      await client.request('/x', { method: 'POST' });
    });`;
  assert.deepEqual(writeButtonsWithoutWait(commented).map((row) => row.button), ['go']);
  const doubleQuoted = `
    a.addEventListener("click", async () => { await client.request("/a", { method: "POST" }); });
    b.addEventListener("click", async () => { b.setAttribute("aria-busy", "true"); await client.request("/b", { method: "POST" }); });`;
  assert.deepEqual(writeButtonsWithoutWait(doubleQuoted).map((row) => row.button), ['a']);
  const params = `
    c.addEventListener('click', async (event = pick(1)) => { await client.request('/c', { method: 'PUT' }); });`;
  assert.deepEqual(writeButtonsWithoutWait(params).map((row) => row.button), ['c']);
});

test('guard: every /bo write button shows its wait, or is named with where it is painted', () => {
  /** @type {Map<string, Array<string>>} */
  const found = new Map();
  for (const file of viewFiles()) {
    const source = readFileSync(join(ADMIN_PUBLIC, file), 'utf8');
    for (const row of writeButtonsWithoutWait(source)) {
      const key = `${file}#${row.button}`;
      found.set(key, [...(found.get(key) ?? []), `${file}:${row.line} ${row.button} → ${row.chain.join(' › ') || '(writes itself)'}`]);
    }
  }
  const unlisted = [];
  const wrongCount = [];
  for (const [key, rows] of found) {
    const listed = HAND_CHECKED.get(key);
    if (!listed) unlisted.push(...rows);
    else if (listed[0] !== rows.length) wrongCount.push(`${key}: listed ${listed[0]}, found ${rows.length}`);
  }
  const gone = [...HAND_CHECKED.keys()].filter((key) => !found.has(key));
  assert.deepEqual(unlisted, [],
    'a write button goes through uiBusy(button, \'Salvo…\', …) or uiHold, so it shows it is working');
  assert.deepEqual(wrongCount, [], 'HAND_CHECKED counts are exact');
  assert.deepEqual(gone, [], 'a button now covered by the helper leaves HAND_CHECKED');
});
