import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SHELL_ITEMS,
  SHELL_GROUPS,
  SETTINGS_AREAS,
  AI_ENTRY_FALLBACK,
  aiPlaceholder,
  crumb,
  settingsBadge,
  countFixes,
  loadFixCount,
  defaultSpaces,
  readSpaces,
  resolveSpaceShortcut,
  spaceMenuItems,
  buildShellNav,
  createShellView,
  renderSettingsPanel,
} from '../apps/admin/public/admin-shell.js';
import { shellNavInput } from '../apps/admin/public/admin-core.js';
import { buildOggiLinks } from '../apps/admin/public/admin-oggi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

test('sidebar voices are the prototype voices, in Italian', () => {
  const labels = SHELL_ITEMS.map((item) => item.label);
  assert.deepEqual(labels, [
    'Oggi',
    'Clienti',
    'Pipeline',
    'Calendario',
    'Sequenze',
    'Reporting',
    'Impostazioni',
  ]);
  const groups = Object.fromEntries(SHELL_ITEMS.map((item) => [item.id, item.group]));
  assert.equal(groups.oggi, 'home');
  for (const id of ['clienti', 'pipeline', 'calendario', 'sequenze']) assert.equal(groups[id], 'native');
  assert.equal(groups.reporting, 'custom');
  assert.equal(groups.impostazioni, 'settings');
  const headers = Object.fromEntries(SHELL_GROUPS.map((group) => [group.id, group.header]));
  assert.equal(headers.native, 'Moduli nativi');
  assert.equal(headers.custom, 'Moduli personalizzati');
});

test('Impostazioni badge lights only from a real count (0 = no badge)', () => {
  assert.equal(settingsBadge(0), '');
  assert.equal(settingsBadge(-2), '');
  assert.equal(settingsBadge(2.5), '');
  assert.equal(settingsBadge('3'), '');
  assert.equal(settingsBadge(null), '');
  assert.equal(settingsBadge(undefined), '');
  assert.equal(settingsBadge(3), '3');
  assert.equal(settingsBadge(1), '1');
});

test('countFixes counts open issues and unresolved candidates only', () => {
  assert.equal(countFixes({ issues: [], candidates: [] }), 0);
  assert.equal(countFixes({
    issues: [{ status: 'open' }, { status: 'open' }, { status: 'resolved' }, { status: 'governed' }],
    candidates: [{ status: 'unresolved' }, { status: 'linked' }, { status: 'dismissed' }],
  }), 3);
  assert.equal(countFixes({}), 0);
});

test('loadFixCount returns null (unknown) when a read fails — never 0-as-none', async () => {
  const client = {
    async request(path) {
      if (path.includes('data-quality-issue')) return { items: [{ status: 'open' }, { status: 'open' }] };
      return { items: [{ status: 'unresolved' }] };
    },
  };
  assert.equal(await loadFixCount(client), 3);

  const failing = { async request() { throw new Error('no such module'); } };
  assert.equal(await loadFixCount(failing), null);

  const shapeless = { async request() { return { items: null }; } };
  assert.equal(await loadFixCount(shapeless), null);

  const halfShapeless = {
    async request(path) {
      if (path.includes('data-quality-issue')) return { items: [] };
      return { nope: true };
    },
  };
  assert.equal(await loadFixCount(halfShapeless), null);

  const empty = {
    async request() { return { items: [] }; },
  };
  assert.equal(await loadFixCount(empty), 0);
});

test('⌘1/2/3 switch among the user spaces only', () => {
  const spaces = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(resolveSpaceShortcut({ metaKey: true, key: '2' }, spaces), 'b');
  assert.equal(resolveSpaceShortcut({ ctrlKey: true, key: '3' }, spaces), 'c');
  assert.equal(resolveSpaceShortcut({ key: '2' }, spaces), null);
  assert.equal(resolveSpaceShortcut({ metaKey: true, key: '9' }, spaces), null);
  assert.equal(resolveSpaceShortcut({ metaKey: true, key: 'k' }, spaces), null);
  assert.equal(resolveSpaceShortcut({ metaKey: true, key: '2' }, [{ id: 'only' }]), null);
  assert.equal(resolveSpaceShortcut(null, spaces), null);
});

test('space menu carries the ⌘N hint and marks the active space', () => {
  const rows = spaceMenuItems(
    [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta', initials: 'BE' }],
    'b',
  );
  assert.equal(rows[0].keyHint, '⌘1');
  assert.equal(rows[1].keyHint, '⌘2');
  assert.equal(rows[0].active, false);
  assert.equal(rows[1].active, true);
  assert.equal(rows[0].initials, 'AL');
});

test('readSpaces falls back to the single local space, never empty', () => {
  assert.deepEqual(defaultSpaces(), [{ id: 'locale', name: 'Spazio locale', initials: 'SL' }]);
  assert.deepEqual(readSpaces(null), defaultSpaces());
  assert.deepEqual(readSpaces({ getItem: () => null }), defaultSpaces());
  assert.deepEqual(readSpaces({ getItem: () => 'not json' }), defaultSpaces());
  assert.deepEqual(readSpaces({ getItem: () => '[]' }), defaultSpaces());
  const stored = readSpaces({ getItem: () => JSON.stringify([{ id: 'x', name: 'X' }, { id: '', name: '' }]) });
  assert.deepEqual(stored, [{ id: 'x', name: 'X', initials: 'X' }]);
});

test('buildShellNav resolves Pipeline from the schema and leaves future screens disabled', () => {
  const nav = buildShellNav({ pipelines: [{ name: 'accordo-sales', label: 'Sales' }] });
  const pipeline = nav.find((item) => item.id === 'pipeline');
  assert.equal(pipeline.route, '#/pipelines/accordo-sales');
  assert.equal(pipeline.available, true);

  const bare = buildShellNav({ pipelines: [] });
  assert.equal(bare.find((item) => item.id === 'pipeline').available, false);

  const calendar = bare.find((item) => item.id === 'calendario');
  assert.equal(calendar.available, false);
  assert.match(calendar.disabledReason, /BO-F3/);

  // Sequenze and Reporting have no admin screen either (framework reads for
  // Calendario/Sequenze exist, but no screen): they stay disabled with the
  // story named instead of linking anywhere.
  for (const [id, story] of [['sequenze', /BO-F3/], ['reporting', /BO-F5/]]) {
    const voice = bare.find((item) => item.id === id);
    assert.equal(voice.available, false);
    assert.equal(voice.route, null);
    assert.match(voice.disabledReason, story);
  }

  const withCustom = buildShellNav({ customModules: [{ name: 'partner' }, { name: 'BAD NAME' }, {}] });
  const custom = withCustom.filter((item) => item.group === 'custom' && item.id.startsWith('module-'));
  assert.deepEqual(custom.map((item) => item.route), ['#/modules/partner']);
});

test('Clienti is available only when the customer-data package is composed', () => {
  const on = buildShellNav({ customerDataAvailable: true }).find((item) => item.id === 'clienti');
  assert.equal(on.available, true);
  assert.equal(on.route, '#/customer-data');

  for (const nav of [buildShellNav(), buildShellNav({ customerDataAvailable: false })]) {
    const off = nav.find((item) => item.id === 'clienti');
    assert.equal(off.available, false);
    assert.equal(off.route, null);
    assert.match(off.disabledReason, /non composto/);
    assert.equal(off.story, 'BO-F1');
  }
});

test('a composed schema envelope links every delivered screen (backlog:42fd49b8)', () => {
  // The whole chain the shell runs after the schema arrives: envelope in,
  // sidebar voices out. Every link is a hash route, so it reaches the same
  // screen under a space mount (/bo) as standalone. Voices with no admin
  // screen stay out, and Oggi lists exactly the screens that are there.
  const envelope = {
    generatedResourceContract: 1,
    generatedModules: [],
    pipelineContract: 1,
    pipelines: [{ name: 'vendite', label: 'Vendite' }],
    domains: { 'customer-data': { customerDataContract: 1, resources: [] } },
  };
  const nav = buildShellNav(shellNavInput(envelope));
  const byId = Object.fromEntries(nav.map((item) => [item.id, item]));
  assert.equal(byId.clienti.route, '#/customer-data');
  assert.equal(byId.pipeline.route, '#/pipelines/vendite');
  assert.equal(byId.impostazioni.route, '#/impostazioni');
  assert.equal(byId.oggi.route, '#/');
  for (const id of ['clienti', 'pipeline', 'impostazioni', 'oggi']) {
    assert.equal(byId[id].available, true, `${id} links its delivered screen`);
  }
  for (const id of ['calendario', 'sequenze', 'reporting']) {
    assert.equal(byId[id].available, false, `${id} has no admin screen yet`);
    assert.equal(byId[id].route, null);
  }
  const oggiRoutes = buildOggiLinks(nav).map((link) => link.route);
  for (const href of ['#/customer-data', '#/pipelines/vendite', '#/impostazioni']) {
    assert.ok(oggiRoutes.includes(href), `Oggi lists the ready screen ${href}`);
  }
});

test('AI entry placeholder is per screen, in Italian, with a fallback', () => {
  assert.equal(aiPlaceholder('oggi'), 'Chiedi: «cosa è più urgente oggi?»');
  assert.equal(aiPlaceholder('calendario'), 'Scrivi: «trova 45 minuti con Marco e Sara»');
  assert.equal(aiPlaceholder('unknown-screen'), AI_ENTRY_FALLBACK);
  assert.equal(aiPlaceholder(null), AI_ENTRY_FALLBACK);
});

test('breadcrumb reads "<space> / <screen>"', () => {
  assert.equal(crumb('Studio Aurora', 'Clienti'), 'Studio Aurora / Clienti');
});

function renderShell(overrides = {}) {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  const seen = { navigated: [], notified: [], picked: [], loggedOut: 0 };
  const view = createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [
      { id: 'aurora', name: 'Studio Aurora', initials: 'SA' },
      { id: 'outlet', name: 'Aurora Outlet', initials: 'AO' },
      { id: 'verde', name: 'Casa Verde', initials: 'CV' },
    ],
    user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it' },
    navigate: (hash) => seen.navigated.push(hash),
    notify: (message) => seen.notified.push(message),
    onLogout: () => { seen.loggedOut += 1; },
    onPickSpace: (id) => seen.picked.push(id),
    ...overrides,
  });
  return { doc, sidebar, topbar, view, seen };
}

test('shell renders sidebar voices, groups, add-module entry and logout', () => {
  const { sidebar, topbar } = renderShell();
  const text = sidebar.textContent;
  for (const voice of ['Studio Aurora', 'Oggi', 'Clienti', 'Moduli nativi', 'Moduli personalizzati',
    '+ Nuovo modulo', 'Impostazioni', 'Elena Rinaldi', 'Esci']) {
    assert.ok(text.includes(voice), `sidebar shows ${voice}`);
  }
  assert.ok(topbar.textContent.includes('Studio Aurora / Oggi'));
  assert.ok(topbar.textContent.includes('⌘K'));
  // No badge at zero fixes.
  assert.equal(sidebar.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
});

test('shell shows the badge only after a real count arrives', () => {
  const { sidebar, view } = renderShell();
  view.update({ fixCount: 0 });
  assert.equal(sidebar.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
  view.update({ fixCount: null });
  assert.equal(sidebar.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
  view.update({ fixCount: 2 });
  const badges = sidebar.findAll('span').filter((node) => node.className.includes('bo-badge'));
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, '2');
});

test('hostile space and user names render as text, never markup', () => {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'x', name: '<script>alert(1)</script>' }],
    user: { name: '<img src=x onerror=alert(1)>', email: 'a@b.c' },
  });
  assert.equal(sidebar.findAll('script').length, 0);
  assert.equal(sidebar.findAll('img').length, 0);
  assert.ok(sidebar.textContent.includes('<script>alert(1)</script>'));
});

test('keyboard: ⌘2 switches space, ⌘K focuses the AI entry', () => {
  const listeners = {};
  const win = { addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); } };
  const { topbar, seen } = renderShell({ win });
  for (const handler of listeners.keydown) handler({ metaKey: true, key: '2', preventDefault: () => {} });
  assert.deepEqual(seen.picked, ['outlet']);
  assert.ok(topbar.textContent.includes('Aurora Outlet / Oggi'));
  // The space switch re-renders the topbar: grab the current entry.
  const input = topbar.findAll('input')[0];
  let focused = 0;
  input.focus = () => { focused += 1; };
  for (const handler of listeners.keydown) handler({ metaKey: true, key: 'k', preventDefault: () => {} });
  assert.equal(focused, 1);
  // Plain keys never switch spaces.
  for (const handler of listeners.keydown) handler({ key: '1', preventDefault: () => {} });
  assert.deepEqual(seen.picked, ['outlet']);
});

test('logout calls back instead of faking a session', () => {
  const { sidebar, seen } = renderShell();
  const logout = sidebar.findAll('button').find((node) => node.textContent === 'Esci');
  assert.ok(logout);
  logout.dispatch('click');
  assert.equal(seen.loggedOut, 1);
});

test('settings panel lists the four areas with honest availability', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  renderSettingsPanel({ doc, mount, fixCount: 2, navigate: (hash) => navigated.push(hash), customerDataAvailable: true });
  const text = mount.textContent;
  for (const area of ['Personalizzazione', 'Catalogo prodotti', 'Stato sync', 'Spazi e accessi']) {
    assert.ok(text.includes(area), `settings lists ${area}`);
  }
  assert.ok(text.includes('2 cose da sistemare'));
  const links = mount.findAll('a');
  // Personalizzazione (BO-F1-02) and Catalogo prodotti (BO-F2-05) both link
  // beside the Stato sync link, in area order.
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['#/connettori', '#/catalogo', '#/customer-data']);
  for (const link of links) link.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(navigated, ['#/connettori', '#/catalogo', '#/customer-data']);

  const empty = createMount();
  renderSettingsPanel({ doc, mount: empty, fixCount: 0 });
  assert.ok(empty.textContent.includes('Niente da sistemare.'));

  const unknown = createMount();
  renderSettingsPanel({ doc, mount: unknown, fixCount: null });
  assert.ok(unknown.textContent.includes('Non è stato possibile leggerle'));
  assert.ok(!unknown.textContent.includes('Niente da sistemare.'));
});

test('Stato sync links only when the customer-data package is composed', () => {
  const doc = createFakeDocument();
  const off = createMount();
  renderSettingsPanel({ doc, mount: off, fixCount: 2, customerDataAvailable: false });
  // Personalizzazione and Catalogo prodotti link; Stato sync stays an honest
  // note until the customer-data package is composed.
  assert.deepEqual(off.findAll('a').map((link) => link.getAttribute('href')), ['#/connettori', '#/catalogo']);
  assert.ok(off.textContent.includes('Stato sync'));
  assert.ok(off.textContent.includes('non composto'));

  const implicit = createMount();
  renderSettingsPanel({ doc, mount: implicit, fixCount: 2 });
  assert.deepEqual(implicit.findAll('a').map((link) => link.getAttribute('href')), ['#/connettori', '#/catalogo']);
});

test('Stato sync row carries the real fix-count badge, absent at zero', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderSettingsPanel({ doc, mount, fixCount: 2, customerDataAvailable: true });
  const badges = mount.findAll('span').filter((node) => node.className.includes('bo-badge'));
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, '2');
  assert.ok(badges[0].parentNode.textContent.includes('Stato sync'));

  const zero = createMount();
  renderSettingsPanel({ doc, mount: zero, fixCount: 0, customerDataAvailable: true });
  assert.equal(zero.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
  assert.ok(zero.textContent.includes('Niente da sistemare.'));

  const unknown = createMount();
  renderSettingsPanel({ doc, mount: unknown, fixCount: null, customerDataAvailable: true });
  assert.equal(unknown.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
});

test('shell stylesheet stays fluid under 700px', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@media (max-width: 700px)'), 'narrow-viewport rules exist');
  assert.ok(css.includes('.bo-sidebar'), 'sidebar rules exist');
  const narrow = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.ok(narrow.includes('.bo-sidebar'), 'narrow rules restyle the sidebar');
});
