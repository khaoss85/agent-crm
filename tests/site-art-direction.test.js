// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('the homepage Flow states every authority boundary in semantic HTML', () => {
  const home = read('site/templates/index.html');
  for (const state of ['Agent request', 'Policy check', 'Human decision', 'Audit recorded']) {
    assert.match(home, new RegExp(`>${state}<`), `${state} must remain readable without CSS or motion`);
  }
  assert.match(home, /<ol class="approval-flow">/);
  assert.doesNotMatch(home, /<canvas|<video/);
});

test('the marquee has two complete, equal cycles and moves by exactly one cycle', () => {
  const home = read('site/templates/index.html');
  const css = read('site/assets/styles.css');
  const sets = [...home.matchAll(/<div class="flow-marquee-set"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((match) => [...match[1].matchAll(/<span>(.*?)<\/span>/g)].map((item) => item[1]));
  assert.equal(sets.length, 2);
  assert.deepEqual(sets[1], sets[0]);
  assert.equal(sets[0].length, 7);
  assert.match(css, /\.flow-marquee-set \{[^}]*min-width: 100vw;/);
  assert.match(css, /@keyframes flow-rail \{ to \{ transform: translateX\(-50%\); \} \}/);
});

test('solution and resource cards are whole semantic links, not inert lookalikes', () => {
  for (const path of ['site/templates/index.html', 'site/templates/solutions.html', 'site/templates/for-ai-agents.html', 'site/templates/resources.html']) {
    const source = read(path);
    for (const grid of source.matchAll(/<div class="(?:solution|resource)-grid">([\s\S]*?)<\/div>/g)) {
      assert.match(grid[1], /<a href=/, `${path} grid should expose whole-card anchors`);
      assert.doesNotMatch(grid[1], /<article|<div/, `${path} grid must not mix inert card-shaped siblings with links`);
    }
  }
});

test('reduced motion resolves the scene to the end of its story, not to an empty rail', () => {
  const css = read('site/assets/styles.css');
  const start = css.lastIndexOf('@media (prefers-reduced-motion: reduce) {');
  assert.ok(start > 0, 'the stylesheet answers prefers-reduced-motion');
  const reduced = css.slice(start);

  // Switching the animations off is the easy half. The half that matters is that every actor
  // is left in its finished state — the request made, the gate open, the human's stamp landed,
  // the audit recorded — because that ending is the argument the section exists to make. A
  // visitor who asks for stillness must not get a blank line and four invisible labels.
  assert.match(reduced, /\.approval-flow li \{ animation: none; opacity: 1; \}/);
  assert.match(reduced, /\.flow-gate i \{ animation: none; background: var\(--accord\); \}/);
  assert.match(reduced, /\.state-human strong \{[^}]*opacity: 1;/);
  assert.match(reduced, /\.flow-mint \{[^}]*opacity: 1;/);
  assert.match(reduced, /\.flow-marquee-track \{ transform: none; \}/);
  assert.match(reduced, /\.hero-seal \.seal \{ animation: none; \}/);
});

test('the full-bleed scene uses no viewport unit, because a viewport unit includes the scrollbar', () => {
  const css = read('site/assets/styles.css');

  // This assertion previously said the opposite, and it was wrong.
  //
  // `width: 100vw` with `margin-inline: calc(50% - 50vw)` looks like it must cancel, and does —
  // right up until the page is long enough to show a scrollbar. `100vw` is the viewport
  // *including* the scrollbar; the 50% is resolved against a parent that excludes it; the
  // element lands half a scrollbar too wide and every page gets a horizontal scrollbar.
  // Measured in Chromium at 1280x700 with a 15px scrollbar: 7.5px of overflow on main's
  // successor, 0px on main. Headless captures taken with --hide-scrollbars show none of it.
  //
  // The scene is a direct child of <main>, which has no width, padding or border, so `100%` is
  // already exactly the width the viewport actually offers. No vw, nothing to cancel.
  const block = /\.flow-scene \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.ok(block, '.flow-scene must exist');
  // Only the box's own size and offsets are in question. A `vw` inside a clamp() that sets
  // vertical spacing cannot put the element past the viewport edge, and banning it outright
  // would be a rule about the letter rather than the defect.
  const width = /width: ([^;]+);/.exec(block)?.[1]?.trim();
  assert.equal(width, '100%');
  assert.doesNotMatch(width ?? '', /vw/, '.flow-scene must not size itself in viewport units');

  // The horizontal halves of the margin shorthand are the ones that can push the box sideways.
  // Split on top-level spaces only — `clamp(26px, 4vw, 52px)` is one value, not three, and its
  // vw is vertical spacing.
  const margin = /margin: ([^;]+);/.exec(block)?.[1]?.trim() ?? '';
  const parts = splitTopLevel(margin);
  const inline = parts.length >= 2 ? [parts[1], parts[3] ?? parts[1]] : [];
  for (const side of inline) {
    assert.doesNotMatch(side, /vw/, `.flow-scene offsets itself sideways with "${side}"`);
  }
});

test('a grid track that can shrink is paired with items that can shrink too', () => {
  const css = read('site/assets/styles.css');

  // `minmax(0, 1fr)` lets the *track* go below its content's min-content width. It says nothing
  // about the *item*, whose automatic minimum size is still its own min-content — so the item
  // overflows the track it was supposed to fit, and the page grows sideways instead of the
  // source pane scrolling in its own box. Measured at 390px: a 303px track holding 366px items.
  assert.match(css, /\.practice-grid > \* \{ min-width: 0; \}/);
  for (const [, columns] of css.matchAll(/\.practice-grid \{[^}]*grid-template-columns: ([^;]+);/g)) {
    // Every flexible track must be wrapped in minmax(0, …). Strip those, then any `fr` still
    // standing is a bare one — `1fr` means `minmax(auto, 1fr)`, which is the whole problem.
    const bare = columns.replace(/minmax\(0,\s*[\d.]*fr\)/g, '');
    assert.doesNotMatch(bare, /[\d.]+fr/,
      `bare fr track in "${columns.trim()}" — it cannot shrink, which defeats the min-width above`);
  }
});

test('the page spine is one continuous line with an actor-coloured node per section', () => {
  const css = read('site/assets/styles.css');
  const home = read('site/templates/index.html');

  // The rail from the hero does not stop at the first viewport: below it the same line turns
  // vertical and every section hangs off it. The line is drawn per-section and abuts its
  // neighbours, so it must span the section's full height or the page shows gaps between them.
  assert.match(css, /main > \.shell > section::before \{[^}]*top: 0; bottom: 0;/);
  assert.match(css, /main > \.shell > section::after \{[^}]*border-radius: 50%;/);

  // At the same selector depth as the rule that sets the default node colour, or the default
  // wins on specificity and every node on the page silently comes out green.
  for (const actor of ['agent', 'policy', 'human', 'evidence']) {
    assert.match(css, new RegExp(`main > \\.shell > section\\.spine-${actor} \\{ --node: var\\(--(?:${actor}|pending|data)\\); \\}`),
      `a section about the ${actor} must carry the ${actor}'s colour on the spine`);
  }
  assert.match(home, /<section class="spine-human"/, 'the authority section is the human\'s');
  assert.match(home, /<section class="spine-evidence"/, 'the proof section is the evidence\'s');
});

test('both typefaces are served from this origin, because the CSP allows no other', () => {
  const css = read('site/assets/styles.css');
  const head = read('site/partials/head.html');
  const vercel = JSON.parse(read('vercel.json'));

  const csp = vercel.headers
    .flatMap((/** @type {any} */ entry) => entry.headers)
    .find((/** @type {any} */ header) => header.key === 'Content-Security-Policy')?.value ?? '';
  assert.match(csp, /font-src 'self'/, 'the site fetches no third-party font');
  assert.match(csp, /style-src 'self' 'unsafe-inline'/, 'and no third-party stylesheet either');

  // Which means a font CDN link is not a slower option here, it is a blocked one: the face
  // would silently never arrive. Both @font-face rules must therefore point at a relative path.
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com|@import/);
  assert.doesNotMatch(head, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  for (const family of ['Bricolage Grotesque', 'Spline Sans Mono']) {
    const face = new RegExp(`@font-face \\{[^}]*font-family: '${family}';[^}]*src: url\\('fonts/[^']+\\.woff2'\\)`);
    assert.match(css, face, `${family} must be served from this origin`);
  }
  // Every family still ends in a system stack: a blocked or slow font must degrade to a
  // rendered page, never to invisible text.
  const brand = JSON.parse(read('site/brand.json'));
  for (const stack of [brand.typography.sans, brand.typography.mono, brand.typography.display]) {
    assert.match(stack, /(system-ui|ui-monospace|sans-serif|monospace)/, `"${stack}" has no system fallback`);
  }
});

test('the dark code pane is measured against its own ground, not against paper', () => {
  const css = read('site/assets/styles.css');

  // Code panes are a dark terminal ground in both themes. Colours written for the light pane
  // they replaced do not survive the move — --warning lands at 3.32:1 on #171912 and --accent at
  // 2.68:1 — so every foreground the pane uses is stated in the pane's own palette and checked
  // here against the pane, not against the page.
  const pane = /\.code \{[^}]*background: (#[0-9a-f]{6});/i.exec(css)?.[1];
  assert.ok(pane, '.code must state its own ground');

  const block = css.slice(css.indexOf('.code { background: ' + pane));
  const foregrounds = [...block.slice(0, 800).matchAll(/\.code[^{]*\{[^}]*color: (#[0-9a-f]{6})/gi)]
    .map((match) => match[1]);
  assert.ok(foregrounds.length >= 4, 'the pane states its own foregrounds');
  for (const ink of foregrounds) {
    const ratio = contrast(ink, pane);
    assert.ok(ratio >= 4.5, `${ink} on the code pane ${pane} is ${ratio.toFixed(2)}:1`);
  }

  // The refusal receipt's mark was a border-color on a rule whose border-width this direction
  // set to 0 — a silent loss on the page the site calls its most differentiated. It keeps a
  // width of its own now.
  assert.match(css, /\.code\.refusal \{[^}]*border-left: \d+px solid/);
});

test('the seal is drawn from the shared actor tokens, never from loose hex', () => {
  const brand = JSON.parse(read('site/brand.json'));
  const mark = read('site/assets/mark.svg');

  // Four arcs, one per authority, closing on a green centre. The mark, the social preview, the
  // nav, the footer and the stylesheet all draw the same object; the moment one of them owns a
  // literal colour, the five copies start drifting apart.
  // Both token groups reach the page unescaped, exactly as `color.*` always has — they are
  // written straight into SVG attributes and CSS values. Pinning them to a literal hex is what
  // makes that safe, so the shape is asserted rather than assumed.
  for (const [group, keys] of [['siteColors', ['paper', 'ink']], ['flowColors', []]]) {
    for (const key of keys) {
      assert.match(brand[group][key] ?? '', /^#[0-9a-f]{6}$/i, `${group}.${key} must be a literal hex`);
    }
  }
  for (const actor of ['agent', 'policy', 'human', 'evidence', 'accord']) {
    assert.match(brand.flowColors[actor] ?? '', /^#[0-9a-f]{6}$/i, `flowColors.${actor} is missing`);
    assert.match(mark, new RegExp(`\\{\\{flow\\.${actor}\\}\\}`), `the mark must read flow.${actor} from brand.json`);
  }
  assert.doesNotMatch(mark, /#[0-9a-f]{3,8}\b/i, 'the mark hardcodes a colour');
});

test('the implementation boundary is on every page, just no longer above the brand', () => {
  const nav = read('site/partials/nav.html');
  const footer = read('site/partials/footer.html');
  const home = read('site/templates/index.html');

  // It used to sit in a banner above the wordmark. Moving it was an art-direction decision —
  // the first viewport should carry the durable product truth — and it is only defensible
  // while the sentence itself stays on every page, unedited. This is that condition.
  assert.doesNotMatch(nav, /\{\{status\.text\}\}(?![\s\S]*-->)/, 'the boundary is no longer a banner above the hero');
  assert.match(footer, /\{\{status\.text\}\}/, 'and it is in the colophon of every page instead');
  assert.match(home, /\{\{status\.text\}\}/, 'and stated again where the evidence is');
});

test('semantic foregrounds meet WCAG AA against their backgrounds in both themes', () => {
  // Read from the stylesheet rather than repeated here, so a token edited in one place cannot
  // pass a test that is quietly checking the colour it used to be.
  const css = read('site/assets/styles.css');
  const light = tokens(css, css.lastIndexOf('\n:root {'));
  const dark = tokens(css, css.lastIndexOf('@media (prefers-color-scheme: dark)'));

  for (const [theme, set] of [['light', light], ['dark', dark]]) {
    for (const [ink, ground] of [
      ['flow-ink', 'paper'], ['agent-ink', 'agent-soft'], ['human-ink', 'human-soft'],
      ['pending-ink', 'pending-soft'], ['data-ink', 'data-soft'],
      // The green that words are set in, against both grounds it is ever set on. This is the
      // pair the fill green used to fail: it is a rail colour, and it was also every link.
      ['accent', 'paper'], ['accent', 'surface'], ['accent', 'accent-soft'],
      ['muted', 'paper'], ['dim', 'paper'],
    ]) {
      assert.ok(set[ink] && set[ground], `${theme}: token --${ink} or --${ground} is missing`);
      const ratio = contrast(set[ink], set[ground]);
      assert.ok(ratio >= 4.5,
        `${theme} --${ink} on --${ground} is ${ratio.toFixed(2)}:1, below WCAG AA for normal text`);
    }
  }
});

/**
 * The custom properties declared in the block starting at `from`, as {name: '#rrggbb'}.
 *
 * The stylesheet is a template, so a token's value may be a `{{site.paper}}`-style reference into
 * brand.json rather than a literal — those are resolved here the same way the build resolves
 * them, which is the point: the colour a page actually renders is the one being measured. A
 * token defined as `var(--other)` is resolved by the browser, not here, and is skipped.
 * @param {string} css @param {number} from
 */
function tokens(css, from) {
  const brand = JSON.parse(read('site/brand.json'));
  const block = css.slice(from, css.indexOf('\n}', css.indexOf('{', from)));
  const resolved = block.replace(/\{\{(site|flow|color)\.([\w]+)\}\}/g, (match, group, key) => {
    const table = { site: brand.siteColors, flow: brand.flowColors, color: brand.colors };
    return table[group]?.[key] ?? match;
  });
  return Object.fromEntries([...resolved.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)]
    .map((match) => [match[1], match[2]]));
}

/** @param {string} foreground @param {string} background */
function contrast(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/.{2}/g)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
    const [red, green, blue] = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return .2126 * red + .7152 * green + .0722 * blue;
  };
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + .05) / (darker + .05);
}

/**
 * A CSS shorthand's values, splitting on spaces that are not inside parentheses — so
 * `clamp(26px, 4vw, 52px) 0 0` is three values rather than five.
 * @param {string} value
 */
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ' ' && depth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}
