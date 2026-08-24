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
  assert.match(css, /\.flow-marquee > div \{ transform: none; \}/);
});
