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

test('the week grid lets a finger scroll the page and tap a slot', () => {
  const touch = mediaBodies(/max-width:\s*700px[^)]*\)\s*,\s*\(pointer:\s*coarse\)/).join('\n');
  assert.match(touch, /\.cal-day\s*\{[^}]*touch-action:\s*manipulation/,
    'touch-action none (mouse drag) is lifted on phones and touch screens');
});

test('the inline new-appointment form: the magnifier never covers the placeholder', () => {
  assert.match(css, /\.cal-form \.ui-search \.ui-search-input\s*\{[^}]*padding-left:\s*36px/);
  assert.match(phone, /\.cal-form \.ui-search,\s*\.cal-form \.ui-select\s*\{[^}]*flex:\s*1 1 100%/);
});

/** A fake DOM with just enough layout for a 390px horizontal nav strip. */
function phoneDoc({ activeLeft }) {
  const doc = createFakeDocument();
  const create = doc.createElement;
  doc.createElement = (tag) => {
    const node = create(tag);
    node.scrollLeft = 0;
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

test('on a phone the nav strip scrolls the active voice into view', () => {
  // Calendario painted past the 390px edge (left 500): the strip — never
  // the page — scrolls so the voice sits centred: 500 - (390 - 120) / 2.
  const nav = shell(phoneDoc({ activeLeft: 500 }), 'calendario');
  assert.ok(nav, 'the main nav renders');
  assert.equal(nav.scrollLeft, 365);
});

test('a voice already in view leaves the strip at its start', () => {
  const nav = shell(phoneDoc({ activeLeft: 20 }), 'oggi');
  assert.equal(nav.scrollLeft, 0);
});
