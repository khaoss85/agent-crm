// @ts-check

/**
 * Backoffice settings header (backlog:ef0888bf5a3f): the header subtitle,
 * aligned and visible across the three settings pages.
 *
 * What it must prove: `paintSettingsHead`
 * (apps/admin/public/admin-settings.js) paints the page title plus its
 * subtitle in one shared wrapper; the Impostazioni index, Personalizzazione
 * and Spazi e accessi all paint through it with their own words; and no
 * stylesheet rule hides the header subtitle anymore (the Personalizzazione
 * subtitle used to be clipped to a 1px box). Fake document plus the real
 * styles.css — no browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { paintSettingsHead } from '../apps/admin/public/admin-settings.js';
import { renderSettingsPanel } from '../apps/admin/public/admin-shell.js';
import { createPersonalizzazioneView } from '../apps/admin/public/admin-personalizzazione.js';
import { createSpaziAccessiView } from '../apps/admin/public/admin-spazi-accessi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const headOf = (mount) => {
  const heads = mount.findAll('div')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-settings-head'));
  assert.equal(heads.length, 1, 'exactly one shared settings header paints');
  return heads[0];
};

const titleOf = (head) => {
  const titles = head.findAll('h2');
  assert.equal(titles.length, 1, 'the header carries one title');
  return titles[0];
};

const subtitleOf = (head) => {
  const subs = head.findAll('p')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-settings-sub'));
  assert.equal(subs.length, 1, 'the header carries one visible subtitle');
  return subs[0];
};

test('paintSettingsHead paints the title plus a visible subtitle, in order', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  paintSettingsHead(doc, mount, { title: 'Titolo', subtitle: 'Una riga che si legge.' });
  const head = headOf(mount);
  assert.equal(titleOf(head).textContent, 'Titolo');
  assert.ok(titleOf(head).getAttribute('class').split(/\s+/).includes('panel-title'), 'the hero title class');
  assert.equal(subtitleOf(head).textContent, 'Una riga che si legge.');
  const order = head.childNodes.map((node) => String(node.tagName).toLowerCase());
  assert.deepEqual(order, ['h2', 'p'], 'title first, subtitle second');
  for (const node of head.findAll('h2').concat(head.findAll('p'))) {
    assert.equal(node.getAttribute('style'), null, 'no inline rule hides the header');
  }
});

test('Impostazioni index paints the shared header with its own words', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderSettingsPanel({ doc, mount, fixCount: 0, customerDataAvailable: true });
  const head = headOf(mount);
  assert.equal(titleOf(head).textContent, 'Impostazioni');
  assert.ok(subtitleOf(head).textContent.length > 0, 'the index subtitle reads');
});

function persoClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/space-packages/catalog') return { units: [] };
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors?')) return { connectors: [] };
      if (path.includes('/api/modules/data-quality-issue/records')) return { items: [] };
      if (path.includes('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path.startsWith('/api/connectors/activity')) return { needsFix: 0 };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('Personalizzazione paints the shared header with a readable subtitle', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createPersonalizzazioneView({
    doc, mount, client: persoClient(), navigate: () => {}, spaceId: () => 'spazio-1',
  });
  await view.render();
  await flush();
  const head = headOf(mount);
  assert.equal(titleOf(head).textContent, 'Personalizzazione');
  assert.ok(
    subtitleOf(head).textContent.includes('La Prova mostra dati veri'),
    'the subtitle reads instead of hiding',
  );
});

function spaziClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/context') {
        return { membership: { role: 'owner' }, roles: { owner: [], operator: [], observer: [] } };
      }
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/space-permissions/effective')) return { spaceId: 'spazio-1', overrides: [] };
      if (path.startsWith('/api/connectors/activity')) return { spaceId: 'spazio-1', needsFix: 0 };
      if (path.startsWith('/api/connectors')) return { spaceId: 'spazio-1', connectors: [] };
      if (path.includes('/api/modules/data-quality-issue/records')) return { items: [] };
      if (path.includes('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path.startsWith('/api/customer-data/customers')) return { items: [], page: 1, pageSize: 10, pages: 0, total: 0, totalIsExact: true };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('Spazi e accessi paints the shared header with its own words', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSpaziAccessiView({
    doc,
    mount,
    client: spaziClient(),
    navigate: () => {},
    spaces: () => [{ id: 'spazio-1', name: 'Negozio', initials: 'NE' }],
    activeSpaceId: () => 'spazio-1',
    onPickSpace: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const head = headOf(mount);
  assert.equal(titleOf(head).textContent, 'Spazi di lavoro');
  assert.ok(
    subtitleOf(head).textContent.includes('Passa da un\u2019attivit\u00E0 all\u2019altra'),
    'the lede stays the screen\u2019s own',
  );
  assert.ok(mount.textContent.includes('Spazi e accessi'), 'the area name stays on screen (tab row)');
});

test('styles.css hides the settings header subtitle nowhere', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.panel-title\s*\+\s*\.muted/, 'the old 1px clipping rule is gone');
  assert.match(css, /\.bo-settings-head\s+\.bo-settings-sub/, 'the shared subtitle has a visible rule');
  const rule = css.slice(css.indexOf('.bo-settings-head .bo-settings-sub'));
  assert.doesNotMatch(rule.slice(0, rule.indexOf('}')), /clip:\s*rect/, 'no clipping inside the subtitle rule');
});
