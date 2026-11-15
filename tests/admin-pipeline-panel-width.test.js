import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * backlog:23f92c6a72ea — a 606 px il pannello dell'offerta (Apri) era una
 * finestra da 420 px ancorata a destra: copriva la prima colonna della
 * kanban senza lasciarla leggibile. Fino a 700 px — la Pipeline da telefono,
 * colonne da 248 px che scorrono — il pannello è un foglio a tutta larghezza.
 */

const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');

/** The declarations of `.bo-scheda-composer.bo-pipeline-offer` inside each @media (max-width: Npx) block. */
function panelRulesByMaxWidth() {
  const out = new Map();
  const re = /@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g;
  for (const match of css.matchAll(re)) {
    const rule = /\.bo-scheda-composer\.bo-pipeline-offer \{([^}]*)\}/.exec(match[2]);
    if (rule) out.set(Number(match[1]), rule[1]);
  }
  return out;
}

test('23f92c6a72ea: at 606 px the offer panel is a full-width sheet, not a half window over the first column', () => {
  const rules = panelRulesByMaxWidth();
  const applying = [...rules.entries()].filter(([max]) => 606 <= max);
  assert.ok(applying.length > 0, 'a narrow-screen rule reaches 606 px');
  const rule = applying.map(([, body]) => body).join(';');
  assert.match(rule, /left:\s*8px/, 'it spans from the left edge');
  assert.match(rule, /right:\s*8px/, 'to the right edge');
  assert.match(rule, /width:\s*auto/, 'with no fixed 420 px width');
});

test('23f92c6a72ea: above 700 px the panel stays the window beside the board', () => {
  const rules = panelRulesByMaxWidth();
  assert.ok(![...rules.keys()].some((max) => max > 700), 'no full-width rule above 700 px');
  assert.match(css, /\.bo-scheda-composer\.bo-pipeline-offer \{[^}]*width: min\(420px/, 'the desktop window keeps its width');
});
