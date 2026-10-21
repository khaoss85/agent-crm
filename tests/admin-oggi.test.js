import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_STRINGS,
  buildOggiLinks,
  greetingForHour,
  isSpaceMount,
  oggiDateLine,
  renderOggi,
} from '../apps/admin/public/admin-oggi.js';
import { renderDemoChrome } from '../apps/admin/public/admin-demo.js';
import {
  buildShellNav,
  createShellView,
} from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Home under a space mount (backlog:7eee63a5): the Oggi frame instead of the
 * framework demo, and the demo kept for the standalone server. These tests
 * drive the real view code with the dependency-free fake DOM — no browser.
 */

test('isSpaceMount is true for any mount prefix, false at the domain root', () => {
  assert.equal(isSpaceMount(''), false);
  assert.equal(isSpaceMount('/bo'), true);
  assert.equal(isSpaceMount('/w/abc/bo'), true);
  assert.equal(isSpaceMount(undefined), false);
  assert.equal(isSpaceMount(null), false);
});

test('greeting follows the hour, in Italian', () => {
  assert.equal(greetingForHour(5), 'Buongiorno');
  assert.equal(greetingForHour(8), 'Buongiorno');
  assert.equal(greetingForHour(11), 'Buongiorno');
  assert.equal(greetingForHour(12), 'Buon pomeriggio');
  assert.equal(greetingForHour(15), 'Buon pomeriggio');
  assert.equal(greetingForHour(18), 'Buonasera');
  assert.equal(greetingForHour(23), 'Buonasera');
  assert.equal(greetingForHour(0), 'Buonasera');
  assert.equal(greetingForHour(4), 'Buonasera');
});

test('date line is the real date, in Italian', () => {
  // 2026-10-19 is a Monday: the line names the weekday and month in Italian.
  assert.equal(oggiDateLine(new Date(2026, 9, 19, 12)), 'Luned\u00EC 19 ottobre');
});

test('Oggi links are the delivered screens only, never Oggi itself', () => {
  const items = buildShellNav({
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    customModules: [{ name: 'magazzino' }],
    customerDataAvailable: true,
  });
  const links = buildOggiLinks(items);
  const routes = links.map((link) => link.route);
  assert.ok(routes.includes('#/customer-data'), 'Clienti links the delivered screen');
  assert.ok(routes.includes('#/pipelines/vendite'), 'Pipeline links the composed board');
  assert.ok(routes.includes('#/modules/magazzino'), 'custom modules link their screen');
  assert.ok(routes.includes('#/impostazioni'), 'Impostazioni links the settings entry');
  assert.ok(!routes.includes('#/'), 'Oggi never links itself');
  assert.ok(links.every((link) => typeof link.label === 'string' && link.label !== ''));
  // Without composed packages only Oggi and Impostazioni are available.
  const bare = buildOggiLinks(buildShellNav());
  assert.deepEqual(bare.map((link) => link.route), ['#/impostazioni']);
  assert.deepEqual(buildOggiLinks(null), []);
  assert.deepEqual(buildOggiLinks('nope'), []);
});

test('Oggi frame greets with the space and shows no demo text', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio di prova',
    links: [{ id: 'clienti', label: 'Clienti', route: '#/customer-data' }],
    navigate: (hash) => seen.push(hash),
    now: new Date(2026, 9, 19, 9),
  });
  const text = mount.textContent;
  assert.ok(text.includes('Luned\u00EC 19 ottobre'), 'real date line');
  assert.ok(text.includes('Buongiorno, Spazio di prova'), 'greeting with the space');
  for (const banned of DEMO_STRINGS) {
    assert.ok(!text.includes(banned), `no demo text: ${banned}`);
  }
  const anchors = mount.findAll('a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].getAttribute('href'), '#/customer-data');
  anchors[0].dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/customer-data']);
});

test('Oggi frame with no delivered screen says so honestly', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({ doc, mount, spaceName: 'Spazio di prova', links: [], now: new Date(2026, 9, 19, 9) });
  assert.ok(mount.textContent.includes('Nessuna schermata pronta'));
  for (const banned of DEMO_STRINGS) {
    assert.ok(!mount.textContent.includes(banned), `no demo text: ${banned}`);
  }
});

test('hostile space name in the greeting is text, never markup', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderOggi({
    doc,
    mount,
    spaceName: '<script>alert(1)</script>',
    links: [],
    now: new Date(2026, 9, 19, 9),
  });
  assert.equal(mount.findAll('script').length, 0);
  assert.ok(mount.textContent.includes('<script>alert(1)</script>'));
});

test('standalone demo chrome keeps the demo, with its controls', () => {
  const doc = createFakeDocument();
  const main = createMount();
  const moduleView = createMount();
  const dashboardView = createMount();
  main.appendChild(moduleView);
  main.appendChild(dashboardView);
  main.insertBefore = function insertBefore(node, ref) {
    const at = this.childNodes.indexOf(ref);
    if (at === -1) this.appendChild(node);
    else {
      this.childNodes.splice(at, 0, node);
      node.parentNode = this;
    }
    return node;
  };
  const refs = renderDemoChrome({ doc, main, moduleView, dashboardView });
  const text = main.textContent;
  for (const kept of DEMO_STRINGS) {
    assert.ok(text.includes(kept), `standalone keeps the demo: ${kept}`);
  }
  assert.equal(main.querySelector('button[id="demoButton"]').textContent, 'Run demo');
  assert.equal(main.querySelector('button[id="refreshButton"]').textContent, 'Refresh');
  assert.ok(main.querySelector('span[id="generatedNav"]'));
  assert.ok(refs.metrics && refs.opportunities && refs.approvals && refs.traces);
});

test('sidebar under a space mount shows the Italian voices and links the delivered screens', () => {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  const seen = [];
  const items = buildShellNav({
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    customModules: [],
    customerDataAvailable: true,
  });
  createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
    user: { name: 'Operatore', email: 'op@example.it' },
    screenId: 'oggi',
    screenLabel: 'Oggi',
    navigate: (hash) => seen.push(hash),
    win: null,
  }).update({ items, activeScreenId: 'oggi', screenLabel: 'Oggi' });
  const text = sidebar.textContent;
  for (const voice of ['Spazio di prova', 'Oggi', 'Clienti', 'Pipeline', 'Calendario',
    'Sequenze', 'Moduli nativi', 'Moduli personalizzati', '+ Nuovo modulo',
    'Impostazioni', 'Esci']) {
    assert.ok(text.includes(voice), `sidebar shows ${voice}`);
  }
  for (const banned of DEMO_STRINGS) {
    assert.ok(!text.includes(banned), `sidebar shows no demo text: ${banned}`);
  }
  const byHref = (href) => sidebar.findAll('a').find((node) => node.getAttribute('href') === href);
  for (const href of ['#/', '#/customer-data', '#/pipelines/vendite', '#/impostazioni']) {
    assert.ok(byHref(href), `sidebar links ${href}`);
  }
  byHref('#/customer-data').dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/customer-data']);
});
