import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * backlog:930b3bc9ba24 — layout a 1280 px (giro UX 11/11, punto 39). A 1280
 * il contenuto del /bo è largo 952 px (sidebar e margini tolti, misurato
 * sull'harness di bo-shots con il vero styles.css):
 * - Pipeline: 5 colonne da 200 px più gli spazi facevano 1056 px, la board
 *   scorreva di lato e la colonna Perso era tagliata;
 * - Calendario: colonna di sinistra 300 px, settimana 634 px, titoli tagliati;
 * - Clienti: il nome del cliente tagliato con i puntini.
 * Le regole qui sotto sono quelle che il browser applica (ultima vince a
 * parità di selettore).
 */

const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
const CONTENT_AT_1280 = 952;

/** Every declaration block of a selector, outside @media, in file order. */
function topLevelBlocks(selector) {
  const out = [];
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    if (css.startsWith('/*', i)) { i = css.indexOf('*/', i) + 2; continue; }
    if (css[i] === '}') { depth -= 1; i += 1; continue; }
    if (css[i] === '{') {
      const head = css.slice(css.lastIndexOf('}', i - 1) + 1, i).replace(/\/\*[\s\S]*?\*\//g, '').trim();
      const end = css.indexOf('}', i);
      if (depth === 0 && head.split(',').map((part) => part.trim()).includes(selector)) out.push(css.slice(i + 1, end));
      if (head.startsWith('@media')) { depth += 1; i += 1; continue; }
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

function lastValue(selector, property) {
  let value = null;
  for (const block of topLevelBlocks(selector)) {
    const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(block);
    if (match) value = match[1].trim();
  }
  return value;
}

test('930b3bc9ba24: at 1280 the five Pipeline columns fit the page, no sideways scroll', () => {
  const minWidth = Number.parseFloat(lastValue('.pipeline-column', 'min-width'));
  const gap = Number.parseFloat(lastValue('.pipeline-board', 'gap'));
  assert.ok(Number.isFinite(minWidth) && Number.isFinite(gap), 'column minimum and gap are declared');
  assert.ok(5 * minWidth + 4 * gap <= CONTENT_AT_1280,
    `5 columns × ${minWidth}px + 4 × ${gap}px = ${5 * minWidth + 4 * gap}px must fit ${CONTENT_AT_1280}px`);
  assert.equal(lastValue('.pipeline-column', 'flex'), '1 1 0', 'columns share the width equally');
  assert.ok(minWidth >= 160, 'and stay readable: never squeezed under 160px');
});

test('930b3bc9ba24: between 701 and 1400 px the Calendario rail narrows so the week gets the room', () => {
  const media = /@media \(min-width: 701px\) and \(max-width: 1400px\) \{([\s\S]*?)\n\}/.exec(css);
  assert.ok(media, 'a desktop-narrow media block exists');
  const rule = /\.cal-layout \{[^}]*grid-template-columns:\s*(\d+)px minmax\(0, 1fr\)/.exec(media[1]);
  assert.ok(rule, 'it sets the calendar columns');
  assert.ok(Number(rule[1]) < 300, `the rail is narrower than 300px (${rule[1]}px)`);
});

test('930b3bc9ba24: calendar event titles and client names wrap instead of «…»', () => {
  assert.equal(lastValue('.cal-grid .cal-event strong', 'white-space'), 'normal');
  assert.equal(lastValue('.cal-grid .cal-event strong', '-webkit-line-clamp'), '2');
  assert.equal(lastValue('.bo-clienti-who a', 'white-space'), 'normal');
  assert.equal(lastValue('.bo-clienti-who a', '-webkit-line-clamp'), '2');
});
