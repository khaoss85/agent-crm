// Il foglio di stile dell'admin resta ben formato (agent-crm#603, 06/11): un
// rebase aveva tolto la `}` che chiude un `@media (max-width: 720px)` e tutto
// lo stile del preventivo era finito dentro la regola mobile, senza nessun
// test rosso. Le graffe si contano fuori da commenti e stringhe e non vanno
// mai sotto zero; ogni @media si chiude prima del blocco successivo di primo
// livello.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');

function strip(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length));
}

test('styles.css: graffe bilanciate, mai sotto zero', () => {
  let depth = 0;
  let line = 1;
  for (const char of strip(CSS)) {
    if (char === '\n') line += 1;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      assert.ok(depth >= 0, `} in più alla riga ${line}`);
    }
  }
  assert.equal(depth, 0, 'un blocco resta aperto fino alla fine del file');
});

test('styles.css: nessun @media dentro un altro @media', () => {
  const lines = strip(CSS).split('\n');
  let depth = 0;
  let mediaAt = null;
  lines.forEach((text, index) => {
    if (/^\s*@media\b/.test(text)) {
      assert.equal(mediaAt, null,
        `@media alla riga ${index + 1} dentro il @media aperto alla riga ${mediaAt}: manca una }`);
      mediaAt = index + 1;
    }
    for (const char of text) {
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
    }
    if (depth === 0) mediaAt = null;
  });
});
