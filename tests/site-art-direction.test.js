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

test('motion has a complete reduced-motion fallback', () => {
  const css = read('site/assets/styles.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.approval-flow li \{ opacity: 1; transform: none; \}/);
  assert.match(css, /\.flow-marquee-track \{ transform: none; \}/);
});

test('mobile editorial backgrounds stay inside the viewport', () => {
  const css = read('site/assets/styles.css');
  assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*main > \.shell:nth-of-type\(even\) > section::before \{ inset-inline: 0; \}/);
});

test('semantic foregrounds meet WCAG AA against their backgrounds in both themes', () => {
  const pairs = [
    ['light flow', '#176b2a', '#f7f3e9'],
    ['light agent', '#4c2fc5', '#ebe6ff'],
    ['light human', '#9b292d', '#ffe6e1'],
    ['light pending', '#665000', '#fff3bd'],
    ['light evidence', '#00677a', '#dff8fd'],
    ['dark flow', '#8cf39a', '#10120e'],
    ['dark agent', '#c8bcff', '#292342'],
    ['dark human', '#ffb5b0', '#402321'],
    ['dark pending', '#ffe080', '#3a3219'],
    ['dark evidence', '#9eeafa', '#17343a'],
  ];
  for (const [name, foreground, background] of pairs) {
    assert.ok(contrast(foreground, background) >= 4.5, `${name} normal text must meet WCAG AA`);
  }
});

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
