// backlog:d7c78e9cdf53 (VALIDAZIONE-PRODOTTO B5): on a 390px phone one sends
// from the scheda, books an appointment without dragging and never zooms or
// scrolls sideways. The PNG proof is `npm run bo:shots` (headless Chrome);
// these tests lock the stylesheet rules it relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'apps/admin/public/styles.css'), 'utf8');

/**
 * Bodies of every `@media` block whose query matches `query` (balanced
 * braces, one level of nested rules).
 * @param {RegExp} query
 */
function mediaBodies(query) {
  const out = [];
  const re = /@media([^{]+)\{/g;
  let match;
  while ((match = re.exec(css)) !== null) {
    if (!query.test(match[1])) continue;
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

const phone = mediaBodies(/max-width:\s*(560|640|700|720)px/).join('\n');

test('on a phone every typed field reads at 16px, so iOS never zooms on focus', () => {
  const rule = phone.match(/([^{}]*\btextarea\b[^{}]*)\{[^}]*font-size:\s*16px[^}]*\}/);
  assert.ok(rule, 'a phone rule lifts input/select/textarea to 16px');
  for (const tag of ['input', 'select', 'textarea']) {
    assert.match(rule[1], new RegExp(`\\b${tag}\\b`), `${tag} is covered`);
  }
  // Checkboxes and radios are not typed fields: they keep their size.
  assert.match(rule[1], /:not\(\[type="checkbox"\]\)/);
  assert.match(rule[1], /:not\(\[type="radio"\]\)/);
});

test('on a phone the composer «Scrivi al cliente» takes the whole screen', () => {
  const rule = phone.match(/\.bo-scheda-composer\s*\{([^}]*)\}/);
  assert.ok(rule, 'a phone rule reshapes the composer window');
  assert.match(rule[1], /inset:\s*0/, 'full width and full viewport height');
  assert.match(rule[1], /max-height:\s*none/);
});

// The stylesheet checks below are lint: they pin the rules the phone layout
// needs. The behaviour they enable — a tap on the stacked week opens the
// 30-minute form, a swipe (pointercancel) opens nothing — is proven with the
// fake DOM in tests/admin-calendario.test.js (backlog:d7c78e9cdf53 tests).
test('lint: the stacked phone week lets a finger scroll; wide touch screens keep the drag', () => {
  const stacked = mediaBodies(/^\s*\(max-width:\s*700px\)\s*$/).join('\n');
  assert.match(stacked, /\.cal-day\s*\{[^}]*touch-action:\s*manipulation/,
    'touch-action none (press-and-drag) is lifted on the stacked phone layout');
  assert.doesNotMatch(css, /@media[^{]*pointer:\s*coarse[^{]*\{[^@]*\.cal-day\s*\{[^}]*touch-action/,
    'no touch-only query lifts it at desktop width (a 1280px touch laptop keeps press-and-drag)');
});

// backlog:c2f21b5debdd (review #813): the B5 cure was phone-only, and the
// desktop form kept the lens over the placeholder (pilot 11/11). The 36px
// lens room and the full-row search are now a rule for every width; the
// phone block keeps only the full-row person picker beside it.
test('lint: the new-appointment form, every width: the magnifier never covers the placeholder', () => {
  const outside = css.replace(/@media[^{]+\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
  assert.match(outside, /\.cal-form \.ui-search \.ui-search-input\s*\{[^}]*padding-left:\s*36px/, 'the lens room holds on desktop too');
  assert.match(outside, /\.cal-form \.ui-search\s*\{[^}]*flex:\s*1 1 100%/, 'the search takes the whole row on desktop too');
  assert.match(phone, /\.cal-form \.ui-search,\s*\.cal-form \.ui-select\s*\{[^}]*flex:\s*1 1 100%/);
});

// The strip-scrolling tests of #641 (revealActiveVoice) left with the strip
// itself: up to 700 px the sidebar is now the ☰ drawer, a vertical list
// (design: shell telefono, tests/admin-shell-telefono.test.js), so no voice
// can be cut at the edge any more.
