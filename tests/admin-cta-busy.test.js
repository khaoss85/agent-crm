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
import { UI_BUSY_LOCKED, uiBusy, uiIcon, uiMarkBusy } from '../apps/admin/public/admin-ui.js';
import { addFieldForm } from '../apps/admin/public/admin-custom-fields.js';
import { createFakeDocument } from './helpers/fake-dom.js';

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

  const renamed = button(doc, 'Invia');
  await uiBusy(renamed, 'Invio…', async () => { renamed.textContent = 'Inviato'; });
  assert.equal(renamed.textContent, 'Inviato', 'a label the work wrote itself stays');
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
// Guard: every write button goes through the helper.
// ---------------------------------------------------------------------------

const ADMIN_PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'admin', 'public');
const WRITE = /method: ['"](POST|PATCH|PUT|DELETE)['"]|submissions\.submit\(/;

/**
 * View files that write and show their wait with their own state instead of
 * the helper. Each says where. A file listed here that starts using the
 * helper fails the ratchet below, so the list only shrinks.
 */
const OWN_BUSY = new Map([
  ['admin-agenti.js', 'Affida/Approva/Rifiuta/Salva modifica read «Invio…», «Salvo…», «Rifiuto…» from the decision state at render'],
  ['admin-assistant.js', 'the panel reads «Lavoro in corso…» and disables its buttons while state.busy'],
  ['admin-offer-panel.js', 'Compila reads «Compilo…» and Crea offerta «Creo…» with aria-busy'],
  ['admin-pipeline.js', 'Sposta is aria-busy and the card says «Spostamento in corso…»; a queued move keeps it locked'],
  ['app.js', 'the legacy demo console: toggleBusy disables and marks aria-busy'],
  ['login.js', 'Accedi reads its sending copy with aria-busy (LOGIN_COPY.sending)'],
  ['admin-submission.js', 'the write controller itself: it owns no button'],
]);

/**
 * Views whose write handlers re-render first and mark the rebuilt button
 * with uiMarkBusy (the pressed one no longer exists by then).
 */
const MARKED_ON_RENDER = new Set(['admin-connectors.js']);

function viewFiles() {
  return readdirSync(ADMIN_PUBLIC).filter((name) => name.endsWith('.js')).sort();
}

/** The body of every `X.addEventListener('click'|'submit', async (…) => {…})`. */
function asyncWriteHandlers(source) {
  const found = [];
  const opener = /addEventListener\('(?:click|submit)', async \([^)]*\) => \{/g;
  let match;
  while ((match = opener.exec(source)) !== null) {
    let depth = 1;
    let k = match.index + match[0].length;
    let quote = null;
    for (; k < source.length && depth > 0; k += 1) {
      const c = source[k];
      if (quote) {
        if (c === '\\') k += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '\'' || c === '"' || c === '`') quote = c;
      else if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
    }
    const body = source.slice(match.index, k);
    // A handler that marks its own button aria-busy shows its wait already.
    if (WRITE.test(body) && !body.includes("setAttribute('aria-busy', 'true')")) found.push(source.slice(0, match.index).split('\n').length);
  }
  return found;
}

test('guard: no click or submit handler writes without uiBusy', () => {
  const offenders = [];
  for (const file of viewFiles()) {
    if (OWN_BUSY.has(file) || MARKED_ON_RENDER.has(file)) continue;
    const source = readFileSync(join(ADMIN_PUBLIC, file), 'utf8');
    for (const line of asyncWriteHandlers(source)) offenders.push(`${file}:${line}`);
  }
  assert.deepEqual(offenders, [],
    'a write handler goes through uiBusy(button, \'Salvo…\', async () => {…}) so the button shows it is working');
});

test('guard: every /bo file that writes uses uiBusy or uiMarkBusy, or says why not', () => {
  const missing = [];
  const stale = [];
  for (const file of viewFiles()) {
    const source = readFileSync(join(ADMIN_PUBLIC, file), 'utf8');
    if (!WRITE.test(source)) continue;
    const helped = /\buiBusy\(|\buiMarkBusy\(/.test(source);
    if (OWN_BUSY.has(file)) {
      if (helped) stale.push(file);
      continue;
    }
    if (!helped) missing.push(file);
  }
  assert.deepEqual(missing, [], 'a new writing view shows its wait through the shared helper');
  assert.deepEqual(stale, [], 'a file now on the helper leaves OWN_BUSY');
});
