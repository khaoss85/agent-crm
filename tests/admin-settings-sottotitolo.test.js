import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderSettingsPanel } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// backlog:ef0888bf5a3f: in Impostazioni e Personalizzazione il sottotitolo
// dell'intestazione era nascosto a schermo (styles.css lo riduceva a 1px
// con clip), mentre Spazi e accessi mostra il suo. Le tre pagine condividono
// la stessa intestazione con sottotitolo visibile. Rosso prima della cura
// (regola di nascondimento), verde dopo (lede visibile come Spazi e accessi).
test('backlog:ef0888bf5a3f — Impostazioni header paints a non-empty subtitle', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderSettingsPanel({ doc, mount, fixCount: 0, customerDataAvailable: true });
  const titles = mount.findAll('h2');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].textContent, 'Impostazioni');
  const subtitles = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('muted'));
  assert.ok(subtitles.length >= 1, 'the header paints a subtitle paragraph');
  assert.ok(subtitles[0].textContent.length > 0, 'the subtitle names the page contents');
});

test('backlog:ef0888bf5a3f — the settings subtitle is visible on screen', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const rule = css.split('\n').find((line) => line.startsWith('.personalizzazione .panel-title + .muted {'));
  assert.ok(rule, 'the settings subtitle rule exists');
  assert.doesNotMatch(rule, /position: absolute/, 'never visually hidden off-screen');
  assert.doesNotMatch(rule, /clip: rect/, 'never clipped out');
  assert.doesNotMatch(rule, /width: 1px/, 'never shrunk to one pixel');
  assert.match(rule, /font-size: 16px/, 'the same 16px lede size as Spazi e accessi');
});
