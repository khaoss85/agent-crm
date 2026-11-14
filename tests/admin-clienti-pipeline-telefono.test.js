// Telefono a 390 px: Clienti e Pipeline non scorrono di lato (backlog:7f38e6e4).
// Le etichette sr-only (.bo-clienti-label e .pipeline-column .stage-type) sono
// in posizione assoluta dentro un contenitore che scorre: senza un antenato
// posizionato scappano dal contenitore e allargano il documento oltre 390 px.
// La cura e position: relative sui due contenitori che scorrono
// (.bo-clienti-table e .pipeline-board); le etichette restano sr-only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');

function rule(selector) {
  const found = CSS.match(new RegExp(`${selector} \\{([^}]*)\\}`, ''));
  assert.ok(found, `la regola ${selector} esiste nel foglio di stile`);
  return found[1];
}

test('Clienti e Pipeline a 390 px: i contenitori che scorrono trattengono le etichette sr-only (backlog:7f38e6e4)', () => {
  const table = rule('\\.bo-clienti-table');
  assert.match(table, /position: relative;/, '.bo-clienti-table posiziona i discendenti assoluti');
  assert.match(table, /overflow-x: auto;/, '.bo-clienti-table scorre dentro di se, non di lato');

  const board = rule('\\.pipeline-board');
  assert.match(board, /position: relative;/, '.pipeline-board posiziona i discendenti assoluti');
  assert.match(board, /overflow-x: auto;/, '.pipeline-board scorre dentro di se, non di lato');
});

test('le etichette per lettori di schermo restano sr-only dentro il contenitore (backlog:7f38e6e4)', () => {
  const label = rule('\\.bo-clienti-label');
  assert.match(label, /position: absolute;/, '.bo-clienti-label resta fuori dal flusso');
  assert.match(label, /width: 1px;/, '.bo-clienti-label resta larga 1px');
  assert.match(label, /clip: rect\(0 0 0 0\);/, '.bo-clienti-label resta ritagliata');

  const stage = rule('\\.pipeline-column \\.stage-type');
  assert.match(stage, /position: absolute;/, '.stage-type resta fuori dal flusso');
  assert.match(stage, /width: 1px;/, '.stage-type resta largo 1px');
  assert.match(stage, /clip: rect\(0 0 0 0\);/, '.stage-type resta ritagliato');
});
