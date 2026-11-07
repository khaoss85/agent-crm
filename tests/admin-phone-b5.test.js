// backlog:d7c78e9cdf53 (VALIDAZIONE-PRODOTTO B5): on a 390px phone one sends
// from the scheda, books an appointment without dragging and never zooms or
// scrolls sideways. The PNG proof is `npm run bo:shots` (headless Chrome);
// these tests lock the stylesheet rules and the shell behaviour it relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createShellView } from '../apps/admin/public/admin-shell.js';

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

test('lint: the inline new-appointment form, phone only: the magnifier never covers the placeholder', () => {
  assert.match(phone, /\.cal-form \.ui-search \.ui-search-input\s*\{[^}]*padding-left:\s*36px/);
  const outside = css.replace(/@media[^{]+\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, '');
  assert.doesNotMatch(outside, /\.cal-form \.ui-search \.ui-search-input/, 'desktop forms are untouched');
  assert.match(phone, /\.cal-form \.ui-search,\s*\.cal-form \.ui-select\s*\{[^}]*flex:\s*1 1 100%/);
});

/** A fake DOM with just enough layout for a 390px horizontal nav strip. */
function phoneDoc({ activeLeft, scrollLeft = 0 }) {
  const doc = createFakeDocument();
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const node = create(tag);
    node.scrollLeft = tag === 'nav' ? scrollLeft : 0;
    node.scrollWidth = tag === 'nav' ? 820 : 0;
    node.clientWidth = tag === 'nav' ? 390 : 0;
    node.getBoundingClientRect = () => (node.getAttribute('aria-current') === 'page'
      ? { left: activeLeft, width: 120 }
      : { left: 0, width: 390 });
    return node;
  };
  return doc;
}

function shell(doc, screenId) {
  const sidebar = createMount();
  createShellView({
    doc,
    sidebar,
    topbar: createMount(),
    spaces: [{ id: 'aurora', name: 'Studio Aurora', initials: 'SA' }],
    user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it' },
    screenId,
  });
  return sidebar.findAll('nav').find((node) => node.getAttribute('aria-label') === 'Sezioni');
}

test('a voice past the right edge scrolls the strip just enough to show it', () => {
  // Calendario painted at 500–620 in a 0–390 strip: the strip — never the
  // page — scrolls by 620 - 390 = 230, so the voice ends at the edge.
  const nav = shell(phoneDoc({ activeLeft: 500 }), 'calendario');
  assert.ok(nav, 'the main nav renders');
  assert.equal(nav.scrollLeft, 230);
});

test('a voice past the left edge scrolls the strip back just enough', () => {
  // Strip already scrolled by 200, voice at -50: scroll back by 50.
  const nav = shell(phoneDoc({ activeLeft: -50, scrollLeft: 200 }), 'oggi');
  assert.equal(nav.scrollLeft, 150);
});

test('a voice fully in view leaves the strip where it is, even mid-strip', () => {
  // Review of #641: left 250 width 120 is inside 0–390; recentring would
  // hide the leading voices for nothing.
  assert.equal(shell(phoneDoc({ activeLeft: 250 }), 'calendario').scrollLeft, 0);
  assert.equal(shell(phoneDoc({ activeLeft: 20 }), 'oggi').scrollLeft, 0);
  assert.equal(shell(phoneDoc({ activeLeft: 100, scrollLeft: 80 }), 'calendario').scrollLeft, 80);
});
