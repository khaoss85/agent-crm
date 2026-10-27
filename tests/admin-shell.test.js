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
  clientBadge,
  settingsBadge,
  settingsTabs,
  countFixes,
  loadClientCount,
  loadFixCount,
  resolveBadgeSpaceId,
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
import { parseCustomerListQuery } from '../packages/customer-data/src/customers.js';
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
    'Nuovo modulo',
    'Impostazioni',
  ]);
  const groups = Object.fromEntries(SHELL_ITEMS.map((item) => [item.id, item.group]));
  assert.equal(groups.oggi, 'home');
  for (const id of ['clienti', 'pipeline', 'calendario', 'sequenze']) assert.equal(groups[id], 'native');
  assert.equal(groups.reporting, 'custom');
  assert.equal(groups['nuovo-modulo'], 'custom');
  assert.equal(groups.impostazioni, 'settings');
  const headers = Object.fromEntries(SHELL_GROUPS.map((group) => [group.id, group.header]));
  assert.equal(headers.native, 'Moduli nativi');
  assert.equal(headers.custom, 'Moduli personalizzati');
});

test('every sidebar voice has its own icon (BO-F6-01)', () => {
  // Icons come from the single component library (BO-F6-02, MEM_ACC_REUSE):
  // every voice names one, and the rendered row carries the shared ui-icon.
  for (const item of SHELL_ITEMS) {
    assert.ok(typeof item.icon === 'string' && item.icon !== '', `${item.id} names an icon`);
  }
  const { sidebar } = renderShell({ items: buildShellNav({ customerDataAvailable: true }) });
  const voices = [...sidebar.findAll('a'), ...sidebar.findAll('span')]
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-nav-item'));
  assert.ok(voices.length >= SHELL_ITEMS.length, `each voice renders (${voices.length} shown)`);
  for (const voice of voices) {
    assert.equal(voice.findAll('svg').length, 1, `${voice.textContent} carries its icon`);
  }
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

test('a failed sync half of the badge logs its cause and keeps the quality count', async () => {
  const client = {
    async request(path) {
      if (path.includes('data-quality-issue')) return { items: [{ status: 'open' }] };
      if (path.includes('duplicate-candidate')) return { items: [] };
      throw new Error('sync giù');
    },
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  try {
    assert.equal(await loadFixCount(client, { spaceId: 'prova' }), 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('bo-shell sync count unreadable'));
  assert.ok(warnings[0].includes('Error'));
  assert.ok(warnings[0].includes('spaceId=prova'));
  assert.ok(!warnings[0].includes('sync giù'));
});

test('the badge counts the session space first, the stored one only without a session', () => {
  const stored = { getItem: () => 'locale' };
  // A real session: the live space wins even when storage names another one.
  assert.equal(resolveBadgeSpaceId('aurora', stored), 'aurora');
  assert.equal(resolveBadgeSpaceId('aurora', { getItem: () => '' }), 'aurora');
  assert.equal(resolveBadgeSpaceId('aurora', { getItem: () => { throw new Error('storage giù'); } }), 'aurora');
  // No session: the stored selection is the space.
  assert.equal(resolveBadgeSpaceId(null, stored), 'locale');
  assert.equal(resolveBadgeSpaceId('', stored), 'locale');
  assert.equal(resolveBadgeSpaceId(undefined, stored), 'locale');
  // Neither: the sync half stays unknown, never a guessed space.
  assert.equal(resolveBadgeSpaceId(null, { getItem: () => '' }), '');
  assert.equal(resolveBadgeSpaceId(null, { getItem: () => { throw new Error('storage giù'); } }), '');
  assert.equal(resolveBadgeSpaceId(null, null), '');
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

  // Calendario ships its admin screen (BO-F3 \"07 Calendario\"): the voice
  // links unconditionally like Reporting — the screen itself renders honest
  // states when the package is not composed, so it is never a dead link.
  const calendar = bare.find((item) => item.id === 'calendario');
  assert.equal(calendar.available, true);
  assert.equal(calendar.route, '#/calendario');

  // Sequenze has no admin screen (the framework read exists, but no screen):
  // it stays disabled with the story named instead of linking anywhere.
  // Reporting and Nuovo modulo are delivered by BO-F5-01, so both link.
  {
    const voice = bare.find((item) => item.id === 'sequenze');
    assert.equal(voice.available, false);
    assert.equal(voice.route, null);
    assert.match(voice.disabledReason, /BO-F3/);
  }
  for (const [id, route] of [['reporting', '#/reporting'], ['nuovo-modulo', '#/nuovo-modulo']]) {
    const voice = bare.find((item) => item.id === id);
    assert.equal(voice.available, true);
    assert.equal(voice.route, route);
    assert.equal(voice.story, 'BO-F5-01');
  }

  const withCustom = buildShellNav({ customModules: [{ name: 'partner', origin: 'bundle' }, { name: 'BAD NAME', origin: 'bundle' }, {}] });
  const custom = withCustom.filter((item) => item.group === 'custom' && item.id.startsWith('module-'));
  assert.deepEqual(custom.map((item) => item.route), ['#/modules/partner']);
});

test('the sidebar never lists kernel generated tables, only bundles (BO-F6-01)', () => {
  // Mirrors a real `/api/schema` payload: framework tables (channel inbox,
  // import state, quality rows…) beside one opt-in user bundle.
  const nav = buildShellNav({
    customModules: [
      { name: 'channel-inbox-event', origin: 'kernel', kind: 'generated', capabilities: ['list'], fields: [] },
      { name: 'data-quality-issue', kind: 'generated', capabilities: ['list'], fields: [] },
      { name: 'sonde-kpi', origin: 'bundle', kind: 'generated', capabilities: ['list'], fields: [] },
    ],
  });
  const custom = nav.filter((item) => item.group === 'custom' && item.id.startsWith('module-'));
  assert.deepEqual(custom.map((item) => item.route), ['#/modules/sonde-kpi']);
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
  assert.equal(byId.sequenze.available, false, 'sequenze has no admin screen yet');
  assert.equal(byId.sequenze.route, null);
  // BO-F3: Calendario ships its screen now.
  for (const id of ['reporting', 'nuovo-modulo', 'calendario']) {
    assert.equal(byId[id].available, true, `${id} links its delivered screen`);
  }
  assert.equal(byId.calendario.route, '#/calendario');
  const oggiRoutes = buildOggiLinks(nav).map((link) => link.route);
  for (const href of ['#/customer-data', '#/pipelines/vendite', '#/reporting', '#/nuovo-modulo', '#/calendario', '#/impostazioni']) {
    assert.ok(oggiRoutes.includes(href), `Oggi lists the ready screen ${href}`);
  }
});

test('AI entry placeholder is per screen, in Italian, with a fallback', () => {
  assert.equal(aiPlaceholder('oggi'), 'Chiedi: «cosa è più urgente oggi?»');
  assert.equal(aiPlaceholder('calendario'), 'Scrivi: «trova 45 minuti con Marco e Sara»');
  assert.equal(aiPlaceholder('stato-sync'), 'Chiedi: «c’è qualcosa che non si è sincronizzato?»');
  assert.equal(aiPlaceholder('unknown-screen'), AI_ENTRY_FALLBACK);
  assert.equal(aiPlaceholder(null), AI_ENTRY_FALLBACK);
});

test('settings tabs list the four areas with the open one underlined', () => {
  const doc = createFakeDocument();
  const navigated = [];
  const bar = settingsTabs(doc, { activeId: 'stato-sync', fixCount: 2, navigate: (hash) => navigated.push(hash) });
  const tabs = bar.findAll('button');
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-tab')), ['personalizzazione', 'catalogo', 'stato-sync', 'spazi-accessi']);
  assert.deepEqual(tabs.map((tab) => tab.textContent), ['Personalizzazione', 'Catalogo prodotti', 'Stato sync2', 'Spazi e accessi']);
  assert.equal(tabs.find((tab) => tab.getAttribute('data-tab') === 'stato-sync').getAttribute('aria-selected'), 'true');
  // Every tab keeps a ui-* class (BO-F6-02 enforcement covers this screen).
  for (const tab of tabs) {
    assert.ok((tab.getAttribute('class') ?? '').split(/\s+/).some((cls) => cls.startsWith('ui-')), 'tab keeps a ui-* class');
  }
  // The badge is absent at zero and when the count is unknown.
  assert.ok(!settingsTabs(doc, { activeId: 'stato-sync', fixCount: 0 }).textContent.includes('da sistemare'));
  assert.ok(!settingsTabs(doc, { activeId: 'stato-sync', fixCount: null }).textContent.includes('da sistemare'));
  // Other tabs navigate to their area; the open one stays put.
  tabs.find((tab) => tab.getAttribute('data-tab') === 'catalogo').dispatch('click');
  assert.deepEqual(navigated, ['#/catalogo']);
  tabs.find((tab) => tab.getAttribute('data-tab') === 'stato-sync').dispatch('click');
  assert.deepEqual(navigated, ['#/catalogo']);
});

test('breadcrumb reads "<space> / <screen>"', () => {
  assert.equal(crumb('Studio Aurora', 'Clienti'), 'Studio Aurora / Clienti');
});

test('sync screen chrome names the screen and asks about sync', () => {
  const { view, topbar, sidebar } = renderShell();
  // The sync screen lives under Impostazioni: the sidebar still highlights
  // the section, but the crumb names the open screen (uppercased by CSS).
  view.update({ activeScreenId: 'impostazioni', aiScreenId: 'stato-sync', screenLabel: 'Stato sync' });
  assert.ok(topbar.textContent.includes('Studio Aurora / Stato sync'));
  assert.ok(!topbar.textContent.includes('Studio Aurora / Impostazioni'));
  const input = topbar.findAll('input')[0];
  assert.equal(input.getAttribute('placeholder'), 'Chiedi: «c’è qualcosa che non si è sincronizzato?»');
  assert.ok(sidebar.textContent.includes('Impostazioni'));
  // Other screens fall back to their own placeholder again.
  view.update({ activeScreenId: 'oggi', aiScreenId: null, screenLabel: 'Oggi' });
  assert.ok(topbar.textContent.includes('Studio Aurora / Oggi'));
  assert.equal(topbar.findAll('input')[0].getAttribute('placeholder'), 'Chiedi: «cosa è più urgente oggi?»');
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
    '+ Nuovo modulo', 'Impostazioni', 'Elena Rinaldi']) {
    assert.ok(text.includes(voice), `sidebar shows ${voice}`);
  }
  // BO-F6-01: every voice row carries its own icon from the component
  // library; the exit keeps the prototype icon with a visible label
  // (BO-F6-03 reviewed behavior) and an assistive-tech name.
  const icons = sidebar.findAll('svg').filter((node) => (node.getAttribute('class') ?? '').includes('ui-icon'));
  assert.ok(icons.length >= SHELL_ITEMS.length, `each voice has an icon (${icons.length} shown)`);
  const logout = sidebar.findAll('button').find((node) => node.getAttribute('aria-label') === 'Esci');
  assert.ok(logout, 'sidebar shows the exit button');
  assert.ok(logout.textContent.includes('Esci'), 'the exit action names itself');
  assert.equal(logout.findAll('svg').length, 1, 'the exit keeps its icon');
  // No session in local development: the switcher shows no role line.
  assert.ok(!text.includes('Titolare'), 'no role without a session');
  assert.ok(topbar.textContent.includes('Studio Aurora / Oggi'));
  assert.ok(topbar.textContent.includes('⌘K'));
  assert.ok(topbar.textContent.includes('✦'), 'the AI bar opens with the spark');
  // No badge at zero fixes.
  assert.equal(sidebar.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
});

test('Clienti badge lights only from a real count, grey like the prototype (BO-F6-01)', () => {
  assert.equal(clientBadge(0), '0');
  assert.equal(clientBadge(3), '3');
  assert.equal(clientBadge(3, false), '3+');
  for (const bad of [-1, 2.5, '3', null, undefined, NaN]) {
    assert.equal(clientBadge(bad), '', `no Clienti badge for ${String(bad)}`);
  }
  assert.equal(clientBadge(null), '');
});

test('loadClientCount reads the customer total once, unknown on failure', async () => {
  assert.deepEqual(
    await loadClientCount({ async request() { return { items: [], total: 3, totalIsExact: true }; } }),
    { count: 3, exact: true },
  );
  assert.deepEqual(
    await loadClientCount({ async request() { return { items: [], total: 3, totalIsExact: false }; } }),
    { count: 3, exact: false },
  );
  const failing = { async request() { throw new Error('not composed'); } };
  assert.equal(await loadClientCount(failing), null);
  const shapeless = { async request() { return { items: [] }; } };
  assert.equal(await loadClientCount(shapeless), null);
});

test('loadClientCount requests a supported page size on the real list path (BO-F6-01)', async () => {
  // Regression: pageSize=1 is rejected by parseCustomerListQuery (400: only
  // 10, 25 and 50 are accepted), so the grey pill never lit on the real
  // path while the stubbed unit test stayed green. The badge must ask for a
  // size the contract accepts, on the endpoint the Clienti screen reads.
  const seen = [];
  const result = await loadClientCount({
    async request(path) {
      seen.push(path);
      return { items: [], total: 7, totalIsExact: true };
    },
  });
  assert.deepEqual(result, { count: 7, exact: true });
  assert.equal(seen.length, 1);
  const url = new URL(seen[0], 'http://bo.local');
  assert.equal(url.pathname, '/api/customer-data/customers');
  const parsed = parseCustomerListQuery(Object.fromEntries(url.searchParams));
  assert.equal(parsed.pageSize, 10);
});

test('shell shows the Clienti count pill after a real count arrives (BO-F6-01)', () => {
  const { sidebar, view } = renderShell({ items: buildShellNav({ customerDataAvailable: true }) });
  const pills = () => sidebar.findAll('span').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-count'));
  assert.equal(pills().length, 0);
  view.update({ clientCount: null });
  assert.equal(pills().length, 0);
  view.update({ clientCount: 3, clientCountExact: true });
  assert.equal(pills().length, 1);
  assert.equal(pills()[0].textContent, '3');
  view.update({ clientCount: 3, clientCountExact: false });
  assert.equal(pills()[0].textContent, '3+');
});

test('space switcher shows the member role under the space name (BO-F6-01)', () => {
  // The role comes from the session contract (BO-F6-03, reused): only the
  // known codes render, as Italian labels; anything else shows no role line.
  const plain = renderShell();
  assert.ok(!plain.sidebar.textContent.includes('Titolare'));
  const { sidebar } = renderShell({ user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' } });
  assert.ok(sidebar.textContent.includes('Titolare'), 'switcher shows the role');
  const hostile = renderShell({ user: { name: 'Elena', email: 'e@s.it', role: '<img src=x onerror=alert(1)>' } });
  assert.equal(hostile.sidebar.findAll('img').length, 0);
  assert.ok(!hostile.sidebar.textContent.includes('Titolare'), 'no role for an unknown code');
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
  const logout = sidebar.findAll('button').find((node) => node.getAttribute('aria-label') === 'Esci');
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
  // Personalizzazione (BO-F4-01, #323), Catalogo prodotti (BO-F2-05),
  // Stato sync (BO-F1-03) and Spazi e accessi (BO-F0-06) all link, in area
  // order.
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/stato-sync', '#/spazi-accessi']);
  for (const link of links) link.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(navigated, ['#/personalizzazione', '#/catalogo', '#/stato-sync', '#/spazi-accessi']);

  const empty = createMount();
  renderSettingsPanel({ doc, mount: empty, fixCount: 0 });
  assert.ok(empty.textContent.includes('Niente da sistemare.'));

  const unknown = createMount();
  renderSettingsPanel({ doc, mount: unknown, fixCount: null });
  assert.ok(unknown.textContent.includes('Non è stato possibile leggerle'));
  assert.ok(!unknown.textContent.includes('Niente da sistemare.'));
});

test('Stato sync links its own screen once customer-data is composed', () => {
  const doc = createFakeDocument();
  const off = createMount();
  renderSettingsPanel({ doc, mount: off, fixCount: 2, customerDataAvailable: false });
  // Personalizzazione, Catalogo prodotti and Spazi e accessi link; Stato sync
  // stays an honest note until the customer-data package is composed.
  assert.deepEqual(off.findAll('a').map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/spazi-accessi']);
  assert.ok(off.textContent.includes('Stato sync'));
  assert.ok(off.textContent.includes('non composto'));

  const implicit = createMount();
  renderSettingsPanel({ doc, mount: implicit, fixCount: 2 });
  assert.deepEqual(implicit.findAll('a').map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/spazi-accessi']);

  const on = createMount();
  renderSettingsPanel({ doc, mount: on, fixCount: 2, customerDataAvailable: true });
  // With the package composed Stato sync links its own screen (BO-F1-03),
  // in area order beside Spazi e accessi.
  assert.deepEqual(on.findAll('a').map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/stato-sync', '#/spazi-accessi']);
  assert.ok(on.textContent.includes('Stato sync'));
  assert.ok(!on.textContent.includes('non composto'));
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
  renderSettingsPanel({ doc, mount: unknown, fixCount: null });
  assert.equal(unknown.findAll('span').filter((node) => node.className.includes('bo-badge')).length, 0);
});

test('shell stylesheet stays fluid under 700px', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(css.includes('@media (max-width: 700px)'), 'narrow-viewport rules exist');
  assert.ok(css.includes('.bo-sidebar'), 'sidebar rules exist');
  const narrow = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.ok(narrow.includes('.bo-sidebar'), 'narrow rules restyle the sidebar');
});

test('shell stylesheet matches the prototype chrome (BO-F6-01)', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  // Full-height flat rail, never a box.
  assert.ok(css.includes('border-right: 1px solid var(--line)'), 'sidebar keeps only its divider edge');
  // Voice icons come from the single component library (BO-F6-02): the
  // sidebar sizes the shared ui-icon, BO-F6-01 adds no icon geometry.
  assert.ok(css.includes('.bo-sidebar .ui-icon'), 'voice icon rules exist');
  assert.ok(css.includes('.bo-count'), 'Clienti count pill rules exist');
  // Uppercase mono path and the violet AI spark.
  const crumbRule = css.slice(css.indexOf('.bo-crumb'));
  assert.ok(crumbRule.includes('text-transform: uppercase'), 'path reads uppercase');
  assert.ok(css.includes('.bo-ai-spark'), 'AI spark rules exist');
  // BO-F6-01 keeps no local icon geometry: the shell reuses admin-ui.js.
  const shell = readFileSync(new URL('../apps/admin/public/admin-shell.js', import.meta.url), 'utf8');
  assert.ok(!shell.includes('SHELL_ICONS'), 'no duplicated icon set in the shell');
});

test('a real session shows the space, the role, the name and the email (BO-F6-03)', () => {
  const { sidebar, topbar } = renderShell({
    spaces: [{ id: 'presti-group', name: 'Presti Group', initials: 'PR' }],
    user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
  });
  const text = sidebar.textContent;
  assert.ok(text.includes('Presti Group'));
  assert.ok(text.includes('Titolare'));
  assert.ok(text.includes('Elena Rinaldi'));
  assert.ok(text.includes('elena@studioaurora.it'));
  assert.ok(!text.includes('Spazio locale'));
  assert.ok(!text.includes('Operatore locale'));
  assert.ok(!text.includes('sviluppo locale'));
  assert.ok(topbar.textContent.includes('Presti Group / Oggi'));
});

test('without a session role no role line renders, never a development string', () => {
  const { sidebar } = renderShell();
  assert.ok(!sidebar.textContent.includes('Titolare'));
  assert.ok(!sidebar.textContent.includes('Operatore locale'));
  assert.ok(sidebar.textContent.includes('Elena Rinaldi'));
});

test('a hostile role renders as text, never markup', () => {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'x', name: 'Prova' }],
    user: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner<script>' },
  });
  assert.ok(!sidebar.textContent.includes('Titolare'));
  assert.equal(sidebar.findAll('script').length, 0);
});
