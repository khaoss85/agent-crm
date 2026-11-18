import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SHELL_ITEMS,
  SHELL_GROUPS,
  SETTINGS_AREAS,
  AI_ENTRY_FALLBACK,
  AI_SPACE_OFF_PLACEHOLDER,
  aiPlaceholder,
  crumb,
  clientBadge,
  settingsBadge,
  settingsTabs,
  shellScreenFor,
  countFixes,
  loadClientCount,
  loadFixCount,
  resolveBadgeSpaceId,
  defaultSpaces,
  mergeSpaces,
  readSpaces,
  readStoredSpaces,
  resolveSpaceShortcut,
  spaceInitialsFor,
  spaceBadgeColor,
  spaceBadgeClass,
  spaceBadgeHue,
  spaceBadgeIndex,
  spaceSwitcherLabel,
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
    'Agenti',
    'Sequenze',
    'Reporting',
    'Nuovo modulo',
    'Impostazioni',
  ]);
  const groups = Object.fromEntries(SHELL_ITEMS.map((item) => [item.id, item.group]));
  assert.equal(groups.oggi, 'home');
  for (const id of ['clienti', 'pipeline', 'calendario', 'agenti', 'sequenze']) assert.equal(groups[id], 'native');
  // backlog:33782ba68747 + backlog:b368bbf992ce: Sequenze stay hidden by
  // default and get their voice only when the module is composed.
  assert.equal(SHELL_ITEMS.find((item) => item.id === 'sequenze').nav, false);
  assert.notEqual(SHELL_ITEMS.find((item) => item.id === 'agenti').nav, false);
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
  // nuovo-modulo has no voice (design pass 6): the dashed button is its entry.
  assert.ok(voices.length >= SHELL_ITEMS.filter((item) => item.nav !== false).length, `each voice renders (${voices.length} shown)`);
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
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.includes('data-quality-issue')) return { items: [{ status: 'open' }, { status: 'open' }] };
      return { items: [{ status: 'unresolved' }] };
    },
  };
  assert.equal(await loadFixCount(client), 3);

  const failing = { async request(path = '', options = {}) { enforceAdminWriteGate(path, options); throw new Error('no such module'); } };
  assert.equal(await loadFixCount(failing), null);

  const shapeless = { async request(path = '', options = {}) { enforceAdminWriteGate(path, options); return { items: null }; } };
  assert.equal(await loadFixCount(shapeless), null);

  const halfShapeless = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.includes('data-quality-issue')) return { items: [] };
      return { nope: true };
    },
  };
  assert.equal(await loadFixCount(halfShapeless), null);

  const empty = {
    async request(path = '', options = {}) { enforceAdminWriteGate(path, options); return { items: [] }; },
  };
  assert.equal(await loadFixCount(empty), 0);
});

test('a failed sync half of the badge logs its cause and keeps the quality count', async () => {
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
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

test('backlog:ecb26347d12c — space initials read from the name words', () => {
  assert.equal(spaceInitialsFor('Presti Group'), 'PG');
  assert.equal(spaceInitialsFor('Prova Validazione B1'), 'PV');
  assert.equal(spaceInitialsFor('Spazio locale'), 'SL');
  assert.equal(spaceInitialsFor('Alpha'), 'AL');
  assert.equal(spaceInitialsFor('X'), 'X');
});

test('backlog:ecb26347d12c — colliding space initials read differently', () => {
  const rows = spaceMenuItems(
    [
      { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
      { id: 'presti-group', name: 'Presti Group', initials: 'PR' },
    ],
    'b1',
  );
  assert.equal(rows[0].initials, 'PR');
  assert.equal(rows[1].initials, 'PG');
  assert.notEqual(rows[0].color, rows[1].color);
  assert.equal(rows[0].color, spaceBadgeColor('b1'));
  // Two spaces with the very same name still read differently.
  const twins = spaceMenuItems(
    [{ id: 'p1', name: 'Presti' }, { id: 'p2', name: 'Presti' }],
    'p1',
  );
  assert.notEqual(twins[0].initials, twins[1].initials);
});

test('backlog:ecb26347d12c — the switcher label lists only the shortcuts that exist', () => {
  assert.equal(spaceSwitcherLabel([{ id: 'a' }]), 'Cambia spazio');
  assert.equal(spaceSwitcherLabel([{ id: 'a' }, { id: 'b' }]), 'Cambia spazio (⌘1/2)');
  assert.equal(
    spaceSwitcherLabel([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    'Cambia spazio (⌘1/2/3)',
  );
  const ten = Array.from({ length: 10 }, (_, index) => ({ id: `s${index}` }));
  assert.equal(spaceSwitcherLabel(ten), 'Cambia spazio (⌘1/2/3/4/5/6/7/8/9)');
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

test('backlog:029409ff — mergeSpaces joins the session spaces with the visited ones', () => {
  // The reported bug: the menu showed only the session space. The primary
  // source (session profile) leads, visited spaces fill in, blanks and
  // duplicates collapse — Presti appears next to Prova Validazione B1.
  const merged = mergeSpaces(
    [{ id: 'b1', name: 'Prova Validazione B1', initials: 'PR' }],
    [{ id: 'presti', name: 'Presti' }, { id: 'b1', name: 'B1 duplicato' }, { id: '', name: '' }, null],
  );
  assert.deepEqual(merged, [
    { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
    { id: 'presti', name: 'Presti', initials: 'PR' },
  ]);
  // With nothing usable the menu still shows the single local space.
  assert.deepEqual(mergeSpaces([], []), defaultSpaces());
  assert.deepEqual(mergeSpaces(null, undefined), defaultSpaces());
});

test('backlog:029409ff — a fresh browser never merges «Spazio locale» into a real session', () => {
  // Codex P2 on agent-crm#754: readSpaces falls back to defaultSpaces, so a
  // fresh, missing or corrupt storage merged a fictitious «Spazio locale»
  // into the session spaces and persisted it. The session merge reads the
  // stored history without the development fallback instead.
  const fresh = { getItem: () => null };
  const corrupt = { getItem: () => 'not json' };
  assert.deepEqual(readStoredSpaces(null), []);
  assert.deepEqual(readStoredSpaces(fresh), []);
  assert.deepEqual(readStoredSpaces(corrupt), []);
  assert.deepEqual(readStoredSpaces({ getItem: () => '[]' }), []);
  const sessionSpaces = [
    { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
    { id: 'presti', name: 'Presti', initials: 'PR' },
  ];
  for (const storage of [fresh, corrupt]) {
    const merged = mergeSpaces(sessionSpaces, readStoredSpaces(storage));
    assert.deepEqual(merged, sessionSpaces);
    assert.ok(!merged.some((space) => space.id === 'locale'));
  }
  // The sessionless shell keeps its single local space fallback.
  assert.deepEqual(readSpaces(fresh), defaultSpaces());
});

test('backlog:029409ff — the «Cambia spazio» menu lists every space, picking one picks it', () => {
  const { sidebar, seen } = renderShell({
    spaces: [
      { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
      { id: 'presti', name: 'Presti', initials: 'PR' },
    ],
  });
  const names = sidebar.textContent;
  assert.ok(names.includes('Prova Validazione B1'));
  assert.ok(names.includes('Presti'));
  const picks = sidebar.findAll('button').filter((node) => (node.className ?? '').includes('bo-space-pick'));
  // Two spaces, two rows: the active one plus the other, never one alone.
  assert.equal(picks.length, 2);
  const other = picks.find((node) => !((node.className ?? '').includes('active')));
  other.dispatch('click', {});
  assert.deepEqual(seen.picked, ['presti']);
});

test('backlog:ca7008cac764 — spaceMenuItems marks rows outside the session member list', () => {
  const spaces = [{ id: 'b1', name: 'B1' }, { id: 'vecchio', name: 'Vecchio' }];
  // Without a member list every row reads as a plain switch, like before.
  for (const row of spaceMenuItems(spaces, 'b1')) assert.equal(row.needsAccess, false);
  for (const row of spaceMenuItems(spaces, 'b1', null)) assert.equal(row.needsAccess, false);
  // With the host list only the unlisted row is marked; the active one never is.
  const rows = spaceMenuItems(spaces, 'b1', ['b1']);
  assert.equal(rows[0].needsAccess, false);
  assert.equal(rows[1].needsAccess, true);
  const both = spaceMenuItems(spaces, 'b1', ['b1', 'vecchio']);
  assert.equal(both[0].needsAccess, false);
  assert.equal(both[1].needsAccess, false);
});

test('backlog:ca7008cac764 — il menu dice quando uno spazio può chiedere l’accesso', () => {
  const profile = {
    space: { id: 'b1', name: 'Prova Validazione B1' },
    spaces: [{ id: 'b1', name: 'Prova Validazione B1' }],
    role: 'owner',
    name: 'Elena Rinaldi',
    email: 'elena@studioaurora.it',
  };
  const doc = createFakeDocument();
  doc.querySelector = (selector) => (selector === 'script[id="bo-session"]'
    ? { textContent: JSON.stringify(profile) }
    : null);
  const { sidebar, seen } = renderShell({
    doc,
    spaces: [
      { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
      { id: 'vecchio', name: 'Vecchio' },
    ],
  });
  const picks = sidebar.findAll('button').filter((node) => (node.className ?? '').split(/\s+/).includes('bo-space-pick'));
  assert.equal(picks.length, 2);
  const marked = picks.find((node) => !((node.className ?? '').includes('active')));
  assert.ok(marked.textContent.includes('può chiedere l’accesso'));
  assert.equal(marked.getAttribute('title'), 'Questo spazio potrebbe chiedere di accedere di nuovo');
  // The unlisted row still opens: the host decides, the menu only warns.
  marked.dispatch('click', {});
  assert.deepEqual(seen.picked, ['vecchio']);
  // Without a session (local development) no row is marked.
  const plain = renderShell({ spaces: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
  assert.ok(!plain.sidebar.textContent.includes('può chiedere l’accesso'));
});

test('backlog:ecb26347d12c — the «Cambia spazio» button names only the shortcuts that exist', () => {
  const { sidebar } = renderShell({
    spaces: [
      { id: 'b1', name: 'Prova Validazione B1', initials: 'PR' },
      { id: 'presti-group', name: 'Presti Group', initials: 'PR' },
    ],
  });
  const button = sidebar.findAll('button').find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-space'));
  assert.equal(button.getAttribute('title'), 'Cambia spazio (⌘1/2)');
  assert.equal(button.getAttribute('aria-label'), 'Cambia spazio (⌘1/2)');
  const badges = sidebar.findAll('span').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-space-badge'));
  // Switcher badge plus two menu rows; the menu rows read differently.
  assert.equal(badges.length, 3);
  const rowBadges = badges.slice(1).map((badge) => badge.textContent);
  assert.notEqual(rowBadges[0], rowBadges[1]);
  assert.equal(badges[0].textContent, rowBadges[0]);
  // backlog:b545aca18b8f: the color lives in the stylesheet class, never
  // in an inline style, so a pilot CSP refusing inline styles cannot
  // strip it. Each badge names its hue class AND the stylesheet maps that
  // class to the same hsl the helper computes.
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  for (const badge of badges) assert.equal(badge.getAttribute('style'), null, 'no inline style on a space badge');
  const slots = badges.map((badge) => {
    const cls = (badge.getAttribute('class') ?? '').split(/\s+/).find((name) => name.startsWith('bo-space-badge--p'));
    assert.ok(cls, 'badge carries its palette class');
    return cls;
  });
  assert.ok(new Set(slots).size > 1, 'the two spaces have different colors');
  for (const id of ['b1', 'presti-group']) {
    const cls = spaceBadgeClass(id);
    assert.ok(slots.includes(cls), `badge list carries ${cls} for space ${id}`);
    assert.ok(
      css.includes(`.${cls} { background-color: ${spaceBadgeColor(id)}; }`),
      `stylesheet maps ${cls} to the helper color`,
    );
  }
});

test('backlog:b545aca18b8f — sidebar draws with empty spaces and badge color without inline style', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  // Empty or missing lists never reach the renderers: the constructor
  // normalizes to the single local space, and setSpaces ignores empties —
  // those are the load-bearing invariants, so the test pins them.
  for (const spaces of [[], null, undefined]) {
    const { sidebar, topbar } = renderShell({ spaces });
    const text = sidebar.textContent;
    assert.ok(text.includes('Moduli nativi'), 'empty list still draws the native group');
    assert.ok(text.includes('Spazio locale'), 'empty list falls back to the local space');
    const badges = [...sidebar.findAll('span'), ...topbar.findAll('span')]
      .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-space-badge'));
    assert.ok(badges.length >= 2, 'switcher and phone badges draw without spaces');
    for (const badge of badges) {
      assert.equal(badge.getAttribute('style'), null, 'no inline style (pilot CSP refuses inline styles)');
      const cls = (badge.getAttribute('class') ?? '').split(/\s+/).find((name) => name.startsWith('bo-space-badge--p'));
      assert.ok(cls, 'fallback badge carries its palette class');
      assert.equal(cls, spaceBadgeClass('locale'), 'fallback badge uses the local-space slot');
      assert.ok(
        css.includes(`.${cls} { background-color: ${spaceBadgeColor('locale')}; }`),
        'stylesheet maps the fallback slot to the helper color',
      );
    }
  }
  // The class and the color string always agree on the palette slot.
  for (const id of ['locale', 'aurora', 'presti-group', '']) {
    assert.equal(spaceBadgeClass(id), `bo-space-badge--p${spaceBadgeIndex(id)}`);
    assert.equal(spaceBadgeColor(id), spaceBadgeColor(id));
    assert.ok(
      css.includes(`.${spaceBadgeClass(id)} { background-color: ${spaceBadgeColor(id)}; }`),
      `stylesheet maps ${spaceBadgeClass(id)} to the helper color`,
    );
  }
});

// backlog:f6ad46980054 (review #895 P3): the agent name is space-scoped —
// a space switch drops it, so the bar never names the previous space's
// agent before the new space's own read lands.
test('f6ad46980054 switching space drops the previous space agent name from the AI bar', () => {
  const spaces = [
    { id: 'aurora', name: 'Studio Aurora', initials: 'SA' },
    { id: 'outlet', name: 'Aurora Outlet', initials: 'AO' },
    { id: 'verde', name: 'Casa Verde', initials: 'CV' },
  ];
  const { view, sidebar, topbar, seen } = renderShell({ spaces });
  const input = () => topbar.findAll('input')[0];
  view.update({ aiScreenId: 'agenti', aiAgentName: 'Mano' });
  assert.ok(input().getAttribute('placeholder').includes('Mano'), 'the bar names this space agent');
  // The sidebar menu pick clears it at once, before the host calls back.
  const picks = sidebar.findAll('button').filter((node) => (node.className ?? '').includes('bo-space-pick'));
  const other = picks.find((node) => !((node.className ?? '').includes('active')));
  other.dispatch('click', {});
  assert.deepEqual(seen.picked, ['outlet']);
  assert.ok(!input().getAttribute('placeholder').includes('Mano'), 'no previous-space agent after the menu pick');
  assert.equal(input().getAttribute('placeholder'), aiPlaceholder('agenti'));
  // The host funnel clears it too: a new name lands, then setSpaces moves on.
  view.update({ aiAgentName: 'Mano' });
  assert.ok(input().getAttribute('placeholder').includes('Mano'), 'the new space names its own agent');
  view.setSpaces(spaces, 'verde');
  assert.ok(!input().getAttribute('placeholder').includes('Mano'), 'no previous-space agent after setSpaces');
  assert.equal(input().getAttribute('placeholder'), aiPlaceholder('agenti'));
  // A same-space refresh keeps the freshly read name.
  view.update({ aiAgentName: 'Guido' });
  view.setSpaces(spaces, 'verde');
  assert.ok(input().getAttribute('placeholder').includes('Guido'), 'same-space refresh keeps the name');
});

test('backlog:b545aca18b8f — setSpaces ignores an empty list and keeps the open space', () => {
  const { sidebar, view } = renderShell();
  assert.ok(sidebar.textContent.includes('Studio Aurora'));
  view.setSpaces([], 'aurora');
  assert.ok(sidebar.textContent.includes('Studio Aurora'), 'empty setSpaces keeps the previous spaces');
  view.setSpaces(null, 'aurora');
  assert.ok(sidebar.textContent.includes('Studio Aurora'), 'null setSpaces keeps the previous spaces');
  view.setSpaces([{ id: 'verde', name: 'Casa Verde', initials: 'CV' }], 'verde');
  assert.ok(sidebar.textContent.includes('Casa Verde'), 'a real list still replaces the spaces');
  assert.ok(!sidebar.textContent.includes('Studio Aurora'), 'the old space leaves the switcher');
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
  assert.equal(byId.impostazioni.route, '#/personalizzazione', 'Impostazioni opens the Personalizzazione tab');
  assert.equal(byId.oggi.route, '#/');
  for (const id of ['clienti', 'pipeline', 'impostazioni', 'oggi']) {
    assert.equal(byId[id].available, true, `${id} links its delivered screen`);
  }
  assert.equal(byId.sequenze.available, false, 'sequenze has no admin screen yet');
  assert.equal(byId.sequenze.route, null);
  assert.equal(byId.agenti.available, false, 'agenti need the agents package composed');
  // BO-F3: Calendario ships its screen now.
  for (const id of ['reporting', 'nuovo-modulo', 'calendario']) {
    assert.equal(byId[id].available, true, `${id} links its delivered screen`);
  }
  assert.equal(byId.calendario.route, '#/calendario');
  const oggiRoutes = buildOggiLinks(nav).map((link) => link.route);
  for (const href of ['#/customer-data', '#/pipelines/vendite', '#/reporting', '#/nuovo-modulo', '#/calendario', '#/personalizzazione']) {
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

// backlog 3136d15da7bd: with the space AI off the bar says so instead of
// inviting a question the AI would not answer.
test('AI entry placeholder names the off space AI on every screen', () => {
  assert.equal(aiPlaceholder('oggi', '', true), AI_SPACE_OFF_PLACEHOLDER);
  assert.equal(aiPlaceholder('calendario', '', true), AI_SPACE_OFF_PLACEHOLDER);
  assert.equal(aiPlaceholder('agenti', 'Mano', true), AI_SPACE_OFF_PLACEHOLDER);
  assert.equal(aiPlaceholder('unknown-screen', '', true), AI_SPACE_OFF_PLACEHOLDER);
  assert.match(AI_SPACE_OFF_PLACEHOLDER, /spenta/);
  assert.match(AI_SPACE_OFF_PLACEHOLDER, /Spazi e accessi/);
});

test('shell update({ aiSpaceOff }) swaps the top bar words, never its search', () => {
  const { view, topbar } = renderShell();
  const input = () => topbar.findAll('input')[0];
  assert.equal(input().getAttribute('placeholder'), 'Chiedi: «cosa è più urgente oggi?»');
  view.update({ aiSpaceOff: true });
  assert.equal(input().getAttribute('placeholder'), AI_SPACE_OFF_PLACEHOLDER);
  assert.ok(!/Chiedi: «cosa/.test(input().getAttribute('placeholder')), 'no inviting question while off');
  view.update({ aiSpaceOff: false });
  assert.equal(input().getAttribute('placeholder'), 'Chiedi: «cosa è più urgente oggi?»');
});

// backlog 3136d15da7bd: pickSpace paints no optimistic aiSpaceOff — the bar
// keeps the last words until the new space's own master read lands, so it
// never flashes an inviting question for a space whose AI is off.
test('3136d15da7bd pickSpace never resets the AI bar before the master read', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /update\(\{\s*aiSpaceOff:\s*false\s*\}\)/);
});

// backlog 3136d15da7bd: a failed space master read logs its cause with the
// space, never the token or the body, and keeps the last words.
test('3136d15da7bd a failed AI master read logs cause and space', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /bo-ai space master unreadable/);
  assert.match(app, /spaceId=\$\{spaceId\}/);
});

test('settings tabs list the four areas with the open one underlined', () => {
  const doc = createFakeDocument();
  const navigated = [];
  const bar = settingsTabs(doc, { activeId: 'stato-sync', fixCount: 2, navigate: (hash) => navigated.push(hash) });
  const tabs = bar.findAll('button');
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-tab')), ['personalizzazione', 'catalogo', 'stato-sync', 'spazi-accessi', 'profilo']);
  // backlog:8618ad3f72db: Profilo is a settings tab too.
  assert.deepEqual(tabs.map((tab) => tab.textContent), ['Personalizzazione', 'Catalogo prodotti', 'Stato sync2', 'Spazi e accessi', 'Profilo']);
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

test('"+ Nuovo modulo" is the only entry: two prototype options, the manual one opens the form screen', () => {
  const { sidebar, seen } = renderShell({ items: buildShellNav({ customerDataAvailable: true }) });
  // Design pass 6: no "Nuovo modulo" voice under Moduli personalizzati.
  const voices = sidebar.findAll('a').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-nav-item'));
  assert.ok(!voices.some((node) => node.getAttribute('href') === '#/nuovo-modulo'), 'no sidebar voice links #/nuovo-modulo');
  const options = sidebar.findAll('button').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('ui-add-option'));
  assert.deepEqual(options.map((node) => node.findAll('span').find((span) => span.getAttribute('class') === 'ui-add-title').textContent),
    ['Crea con l’AI', 'Compila manualmente']);
  assert.ok(options[1].textContent.includes('Nome, dati usati e chi può vederlo'), 'the manual option says what it asks');
  options[1].dispatch('click', {});
  assert.deepEqual(seen.navigated, ['#/nuovo-modulo'], 'the manual option opens the form screen');
  assert.deepEqual(seen.notified, [], 'no command line is shown to the owner');
});

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
  // No lit badge at zero fixes: its room stays reserved as a hidden
  // placeholder (backlog:b76770f82fe9), so the rows below never move.
  const badges = sidebar.findAll('span').filter((node) => node.className.includes('bo-badge'));
  assert.equal(badges.length, 1);
  assert.ok(badges[0].className.split(/\s+/).includes('is-empty'));
  assert.equal(badges[0].getAttribute('aria-hidden'), 'true');
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
    await loadClientCount({ async request(path = '', options = {}) { enforceAdminWriteGate(path, options); return { items: [], total: 3, totalIsExact: true }; } }),
    { count: 3, exact: true },
  );
  assert.deepEqual(
    await loadClientCount({ async request(path = '', options = {}) { enforceAdminWriteGate(path, options); return { items: [], total: 3, totalIsExact: false }; } }),
    { count: 3, exact: false },
  );
  const failing = { async request(path = '', options = {}) { enforceAdminWriteGate(path, options); throw new Error('not composed'); } };
  assert.equal(await loadClientCount(failing), null);
  const shapeless = { async request(path = '', options = {}) { enforceAdminWriteGate(path, options); return { items: [] }; } };
  assert.equal(await loadClientCount(shapeless), null);
});

test('loadClientCount requests a supported page size on the real list path (BO-F6-01)', async () => {
  // Regression: pageSize=1 is rejected by parseCustomerListQuery (400: only
  // 10, 25 and 50 are accepted), so the grey pill never lit on the real
  // path while the stubbed unit test stayed green. The badge must ask for a
  // size the contract accepts, on the endpoint the Clienti screen reads.
  const seen = [];
  const result = await loadClientCount({
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
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
  const lit = () => pills().filter((node) => !((node.getAttribute('class') ?? '').split(/\s+/).includes('is-empty')));
  // backlog:b76770f82fe9: an unknown count keeps a hidden placeholder, so
  // the row keeps its height before the number lights up.
  assert.equal(lit().length, 0);
  assert.equal(pills().length, 1);
  assert.equal(pills()[0].getAttribute('aria-hidden'), 'true');
  view.update({ clientCount: null });
  assert.equal(lit().length, 0);
  assert.equal(pills().length, 1);
  view.update({ clientCount: 3, clientCountExact: true });
  assert.equal(pills().length, 1);
  assert.equal(pills()[0].textContent, '3');
  assert.equal(pills()[0].getAttribute('aria-hidden'), null);
  view.update({ clientCount: 3, clientCountExact: false });
  assert.equal(pills()[0].textContent, '3+');
});

test('menu badges reserve their room: the row keeps its height when the number lights (backlog:b76770f82fe9)', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  // The placeholder must stay laid out while hidden: parse the rule that
  // covers both empty badges, not the selector text alone. A `display: none`
  // (or emptied) rule would pass a mere includes() check while rows move again.
  const rules = css.match(/[^{}]+{[^{}]*}/g) ?? [];
  const reserved = rules.find((rule) => rule.includes('.bo-count.is-empty') && rule.includes('.bo-badge.is-empty'));
  assert.ok(reserved, 'shared hidden placeholder rule for both badges exists');
  const body = reserved.slice(reserved.indexOf('{') + 1, reserved.lastIndexOf('}')).toLowerCase();
  assert.match(body, /visibility\s*:\s*hidden/, 'empty badges stay laid out but invisible');
  assert.doesNotMatch(body, /display\s*:\s*none/, 'empty badges must not leave the layout');
  const { sidebar, view } = renderShell({ items: buildShellNav({ customerDataAvailable: true }) });
  const pillClasses = () => sidebar.findAll('span')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-count'))
    .map((node) => node.getAttribute('class'));
  const badgeClasses = () => sidebar.findAll('span')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-badge'))
    .map((node) => node.getAttribute('class'));
  // One pill slot per badged voice, before and after the numbers arrive:
  // the row's box never changes, only the placeholder fills in.
  assert.deepEqual(pillClasses(), ['bo-count is-empty']);
  assert.deepEqual(badgeClasses(), ['bo-badge is-empty']);
  const empties = sidebar.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('is-empty'));
  assert.equal(empties.length, 2);
  for (const node of empties) {
    assert.equal(node.textContent, '0');
    assert.equal(node.getAttribute('aria-hidden'), 'true');
  }
  view.update({ clientCount: 12, clientCountExact: true, fixCount: 2 });
  assert.deepEqual(pillClasses(), ['bo-count']);
  assert.deepEqual(badgeClasses(), ['bo-badge']);
  assert.equal(sidebar.findAll('span').filter((node) => (node.getAttribute('class') ?? '') === 'bo-count')[0].textContent, '12');
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
  const badges = () => sidebar.findAll('span').filter((node) => node.className.includes('bo-badge'));
  const lit = () => badges().filter((node) => !node.className.split(/\s+/).includes('is-empty'));
  // backlog:b76770f82fe9: zero or unknown keeps the hidden placeholder.
  view.update({ fixCount: 0 });
  assert.equal(lit().length, 0);
  assert.equal(badges().length, 1);
  view.update({ fixCount: null });
  assert.equal(lit().length, 0);
  assert.equal(badges().length, 1);
  view.update({ fixCount: 2 });
  assert.equal(badges().length, 1);
  assert.equal(badges()[0].textContent, '2');
  assert.ok(!badges()[0].className.split(/\s+/).includes('is-empty'));
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
  assert.deepEqual(links.map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/stato-sync', '#/spazi-accessi', '#/profilo']);
  for (const link of links) link.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(navigated, ['#/personalizzazione', '#/catalogo', '#/stato-sync', '#/spazi-accessi', '#/profilo']);

  const empty = createMount();
  renderSettingsPanel({ doc, mount: empty, fixCount: 0 });
  assert.ok(empty.textContent.includes('Niente da sistemare.'));

  const unknown = createMount();
  renderSettingsPanel({ doc, mount: unknown, fixCount: null });
  assert.ok(unknown.textContent.includes('Non sono riuscito a leggere le cose da sistemare'));
  assert.ok(!unknown.textContent.includes('Niente da sistemare.'));
});

test('backlog:2302655b1fcf — Impostazioni header matches Personalizzazione, no BACKOFFICE kicker', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderSettingsPanel({ doc, mount, fixCount: 0, customerDataAvailable: true });
  const titles = mount.findAll('h2');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].textContent, 'Impostazioni');
  assert.ok((titles[0].getAttribute('class') ?? '').split(/\s+/).includes('panel-title'), 'same title class as Personalizzazione');
  assert.ok(!mount.textContent.includes('Backoffice'), 'no BACKOFFICE kicker');
  const subtitles = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('muted'));
  assert.ok(subtitles.length >= 1, 'a subtitle like Personalizzazione');
});

// backlog:2302655b1fcf repro: the Impostazioni index painted a bare
// h2.panel-title with no tab row, while every other settings screen paints
// the IMPOSTAZIONI tab row above the same Personalizzazione header
// component (46px hero title). Red before the cure, green after.
test('backlog:2302655b1fcf — Impostazioni index shares the Personalizzazione header component and tab row', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderSettingsPanel({ doc, mount, fixCount: 0, customerDataAvailable: true });
  // The tab row: the same IMPOSTAZIONI occhiello + area tabs every other
  // settings screen paints above its header.
  const labels = mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-settings-label'));
  assert.equal(labels.length, 1, 'the IMPOSTAZIONI occhiello paints on the index too');
  assert.equal(labels[0].textContent, 'IMPOSTAZIONI');
  const tabs = mount.findAll('button').filter((node) => node.getAttribute('data-tab') !== null);
  assert.deepEqual(tabs.map((tab) => tab.getAttribute('data-tab')), ['personalizzazione', 'catalogo', 'stato-sync', 'spazi-accessi', 'profilo']);
  assert.ok(tabs.every((tab) => tab.getAttribute('aria-selected') !== 'true'), 'no tab underlined on the index');
  // The header: h2.panel-title inside the same .panel.personalizzazione
  // block Personalizzazione paints, so the title keeps its 46px hero size.
  const panels = mount.findAll('div').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('personalizzazione'));
  assert.equal(panels.length, 1, 'the index header lives in the same panel component');
  const titles = panels[0].findAll('h2');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].textContent, 'Impostazioni');
});

test('backlog:2302655b1fcf — Personalizzazione header paints through the shared settings head', () => {
  const source = readFileSync(new URL('../apps/admin/public/admin-personalizzazione.js', import.meta.url), 'utf8');
  assert.match(source, /paintSettingsHead\(doc, box,/);
});

test('backlog:2302655b1fcf — «Gestisci spazi e accessi» opens Spazi e accessi directly', () => {
  const { sidebar, seen } = renderShell({ items: buildShellNav({ customerDataAvailable: true }) });
  const manage = sidebar.findAll('button').find((node) => node.textContent === 'Gestisci spazi e accessi');
  assert.ok(manage, 'the space menu carries the entry');
  manage.dispatch('click', {});
  assert.deepEqual(seen.navigated, ['#/spazi-accessi']);
});

// backlog:1d33b335fba0: «Non è stato possibile leggerle (non è detto che non
// ce ne siano)» named nothing and offered nothing. The panel says what was
// not read and offers Riprova, which reads the count again.
test('1d33b335fba0: an unread fix count says what is missing and Riprova reads it again', async () => {
  const doc = createFakeDocument();
  const flushAll = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const mount = createMount();
  const answers = [null, 3];
  const asked = [];
  const onRetry = async () => { asked.push(true); return answers.shift(); };
  renderSettingsPanel({ doc, mount, fixCount: null, onRetry });
  const text = mount.textContent;
  assert.ok(text.includes('Non sono riuscito a leggere le cose da sistemare'), 'names what was not read');
  assert.ok(text.includes('problemi nei dati e schede doppie'), 'in plain words');
  assert.ok(!text.includes('leggerle'), 'never the old dangling pronoun');
  assert.ok(!text.includes('non è detto che non ce ne siano'));
  const retryOf = (node) => node.findAll('button').find((button) => button.getAttribute('data-action') === 'settings-retry');
  let retry = retryOf(mount);
  assert.ok(retry, 'Riprova is offered');
  assert.equal(retry.textContent, 'Riprova');
  // Still unreadable: the same note and Riprova again.
  retry.dispatch('click', {});
  assert.equal(retry.getAttribute('aria-busy'), 'true', 'the button says it is working');
  await flushAll();
  assert.equal(asked.length, 1);
  retry = retryOf(mount);
  assert.ok(retry, 'still unreadable: Riprova stays');
  // Read: the count replaces the note.
  retry.dispatch('click', {});
  await flushAll();
  assert.equal(asked.length, 2);
  assert.ok(mount.textContent.includes('3 cose da sistemare'), 'the fresh count shows');
  assert.ok(!retryOf(mount), 'no Riprova once read');
  // A failing retry keeps the note, never throws.
  const failing = createMount();
  renderSettingsPanel({ doc, mount: failing, fixCount: null, onRetry: async () => { throw new Error('down'); } });
  retryOf(failing).dispatch('click', {});
  await flushAll();
  assert.ok(failing.textContent.includes('Non sono riuscito a leggere'));
  assert.ok(retryOf(failing), 'Riprova again after a failure');
  // Review #833 P2: the retry answers the live availability too — Stato
  // sync composed since the first paint links once the count is read.
  const late = createMount();
  renderSettingsPanel({ doc, mount: late, fixCount: null, customerDataAvailable: false,
    onRetry: async () => ({ fixCount: 2, customerDataAvailable: true }) });
  assert.ok(!late.findAll('a').some((link) => link.getAttribute('href') === '#/stato-sync'), 'first paint: Stato sync not composed yet');
  retryOf(late).dispatch('click', {});
  await flushAll();
  assert.ok(late.textContent.includes('2 cose da sistemare'));
  assert.ok(late.findAll('a').some((link) => link.getAttribute('href') === '#/stato-sync'), 'the fresh availability links Stato sync');
  // Left meanwhile: the late answer never repaints the new screen.
  const left = createMount();
  let release;
  renderSettingsPanel({ doc, mount: left, fixCount: null, onRetry: () => new Promise((resolve) => { release = resolve; }) });
  retryOf(left).dispatch('click', {});
  while (left.firstChild) left.removeChild(left.firstChild);
  left.appendChild(doc.createElement('p')).textContent = 'Clienti';
  release(5);
  await flushAll();
  assert.equal(left.textContent, 'Clienti', 'the screen opened meanwhile stays');
});

test('Stato sync links its own screen once customer-data is composed', () => {
  const doc = createFakeDocument();
  const off = createMount();
  renderSettingsPanel({ doc, mount: off, fixCount: 2, customerDataAvailable: false });
  // Personalizzazione, Catalogo prodotti and Spazi e accessi link; Stato sync
  // stays an honest note until the customer-data package is composed.
  assert.deepEqual(off.findAll('a').map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/spazi-accessi', '#/profilo']);
  assert.ok(off.textContent.includes('Stato sync'));
  assert.ok(off.textContent.includes('non composto'));

  const implicit = createMount();
  renderSettingsPanel({ doc, mount: implicit, fixCount: 2 });
  assert.deepEqual(implicit.findAll('a').map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/spazi-accessi', '#/profilo']);

  const on = createMount();
  renderSettingsPanel({ doc, mount: on, fixCount: 2, customerDataAvailable: true });
  // With the package composed Stato sync links its own screen (BO-F1-03),
  // in area order beside Spazi e accessi.
  assert.deepEqual(on.findAll('a').map((link) => link.getAttribute('href')), ['#/personalizzazione', '#/catalogo', '#/stato-sync', '#/spazi-accessi', '#/profilo']);
  assert.ok(on.textContent.includes('Stato sync'));
  assert.ok(!on.textContent.includes('non composto'));
});

test('Stato sync row carries the real fix-count badge, absent at zero', () => {
  const doc = createFakeDocument();
  const mount = createMount();
  renderSettingsPanel({ doc, mount, fixCount: 2, customerDataAvailable: true });
  const badges = mount.findAll('span').filter((node) => node.className.includes('bo-badge'));
  // backlog:2302655b1fcf: the index paints the tab row too, so the count
  // lights twice — on the Stato sync tab and on its row. The row badge
  // keeps the old contract: real count, absent at zero and when unknown.
  assert.equal(badges.length, 2);
  const inRow = badges.filter((node) => (node.parentNode.getAttribute('class') ?? '').split(/\s+/).includes('bo-setting-row'));
  assert.equal(inRow.length, 1);
  assert.equal(inRow[0].textContent, '2');
  assert.ok(inRow[0].parentNode.textContent.includes('Stato sync'));

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

test('sidebar voices stay readable in hover, active included (backlog:46270e08)', () => {
  // Root cause: `a.bo-nav-item:hover` (0,2,1) beat `.bo-nav-item.active`
  // (0,2,0), so the active voice hovered into paper text on the soft wash —
  // the label and the currentColor icon vanished and only the grey pills
  // stayed. This test replays the cascade for both hover states and proves
  // every winning foreground/background pair passes WCAG AA (4.5:1).
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map();
  const root = bare.match(/:root\s*\{([^}]*)\}/);
  assert.ok(root, ':root tokens exist');
  for (const [, name, value] of root[1].matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
    tokens.set(name, value);
  }
  const rules = [];
  for (const m of bare.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    for (const selector of m[1].split(',')) {
      const text = selector.trim();
      if (text === '' || /[\s>+~]/.test(text)) continue;
      const classes = new Set([...text.matchAll(/\.([\w-]+)/g)].map((c) => c[1]));
      const pseudos = new Set([...text.matchAll(/:([\w-]+)/g)].map((c) => c[1]));
      const element = (/^([a-zA-Z][\w-]*)/.exec(text) ?? [])[1] ?? null;
      const ids = (text.match(/#/g) ?? []).length;
      const decls = new Map();
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':');
        if (i === -1) continue;
        decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
      }
      rules.push({ text, element, classes, pseudos, ids, decls, order: rules.length });
    }
  }
  const lum = (hex) => {
    const f = (c) => {
      const v = parseInt(hex.slice(c, c + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(1) + 0.7152 * f(3) + 0.0722 * f(5);
  };
  const contrast = (a, b) => {
    const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
    return (hi + 0.05) / (lo + 0.05);
  };
  const resolve = (value) => {
    const v = /^var\(--([\w-]+)\)/.exec(value ?? '') ?? [];
    return v[1] !== undefined && tokens.has(v[1]) ? tokens.get(v[1]) : null;
  };
  // Winning pair for a link state: later rules win ties, higher
  // [classes+pseudos, elements] wins outright; unset background is the
  // sidebar paper, unset color inherits the non-hover voice color.
  const pairFor = (active) => {
    const state = { element: 'a', classes: new Set(['bo-nav-item', ...(active ? ['active'] : [])]), pseudos: new Set(['hover']) };
    let bg = null;
    let fg = null;
    let bgRank = null;
    let fgRank = null;
    for (const rule of rules) {
      if (rule.element !== null && rule.element !== state.element) continue;
      if (![...rule.classes].every((c) => state.classes.has(c))) continue;
      if (![...rule.pseudos].every((p) => state.pseudos.has(p))) continue;
      const rank = [rule.classes.size + rule.pseudos.size + rule.ids * 100, rule.element === null ? 0 : 1, rule.order];
      const beats = (prev) => prev === null
        || rank[0] > prev[0] || (rank[0] === prev[0] && (rank[1] > prev[1] || (rank[1] === prev[1] && rank[2] > prev[2])));
      // A non-hover base rule still paints the resting half of the state.
      const isBase = rule.pseudos.size === 0;
      if (!isBase || active || !rule.classes.has('active')) {
        if (rule.decls.has('background') || rule.decls.has('background-color')) {
          const raw = rule.decls.get('background') ?? rule.decls.get('background-color');
          if (beats(bgRank)) {
            bg = raw === 'transparent' ? tokens.get('paper') : (resolve(raw) ?? (isBase ? bg : bg));
            bgRank = rank;
          }
        }
        if (rule.decls.has('color') && beats(fgRank)) {
          fg = resolve(rule.decls.get('color'));
          fgRank = rank;
        }
      }
    }
    return { bg: bg ?? tokens.get('paper'), fg: fg ?? tokens.get('ink') };
  };
  for (const active of [false, true]) {
    const { bg, fg } = pairFor(active);
    assert.ok(bg !== null && fg !== null, `${active ? 'active' : 'plain'} hover resolves to tokens`);
    assert.ok(
      contrast(bg, fg) >= 4.5,
      `${active ? 'active' : 'plain'} hover readable: ${fg} on ${bg} (${contrast(bg, fg).toFixed(2)}:1)`,
    );
  }
  const activeHover = pairFor(true);
  assert.equal(activeHover.bg, tokens.get('ink'), 'active hover keeps the ink wash');
  assert.equal(activeHover.fg, tokens.get('paper'), 'active hover keeps the paper voice');
  // The pills that survive a wash — Clienti count, Impostazioni badge —
  // carry their own pairs and must pass too.
  assert.ok(contrast(tokens.get('surface-soft'), tokens.get('muted')) >= 4.5, 'count pill readable');
  assert.ok(contrast(tokens.get('pending'), tokens.get('pending-ink')) >= 4.5, 'settings badge readable');
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

// Voce 19c2e22a64a1 (1): the Stato sync badge counts the current space live
// through the same loader the Impostazioni tabs use — two spaces with
// different attention rows read different counts, never each other's.
test('loadFixCount counts each space live — never another space count', async () => {
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.includes('data-quality-issue')) return { items: [] };
      if (path.includes('duplicate-candidate')) return { items: [] };
      if (path.includes('spaceId=spazio-a')) return { needsFix: 2 };
      if (path.includes('spaceId=spazio-b')) return { needsFix: 0 };
      throw new Error(`unexpected request ${path}`);
    },
  };
  assert.equal(await loadFixCount(client, { spaceId: 'spazio-a' }), 2);
  assert.equal(await loadFixCount(client, { spaceId: 'spazio-b' }), 0);
  assert.equal(await loadFixCount(client, { spaceId: '' }), 0);
});

// Voce 19c2e22a64a1 (1): the badge lights on all four Impostazioni tabs with
// the explicitly passed current-space count, and stays dark when unknown.
test('the Stato sync badge renders on all four Impostazioni tabs', () => {
  const doc = createFakeDocument();
  for (const activeId of ['personalizzazione', 'catalogo', 'stato-sync', 'spazi-accessi']) {
    const bar = settingsTabs(doc, { activeId, fixCount: 3, navigate: () => {} });
    const badges = bar.findAll('span')
      .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-badge'));
    assert.equal(badges.length, 1, `${activeId} shows exactly one badge`);
    assert.equal(badges[0].textContent, '3', `${activeId} badge carries the current space count`);
    assert.equal(badges[0].getAttribute('aria-label'), '3 da sistemare', `${activeId} badge names the count`);
  }
  for (const activeId of ['personalizzazione', 'catalogo', 'stato-sync', 'spazi-accessi']) {
    const bar = settingsTabs(doc, { activeId, fixCount: null, navigate: () => {} });
    assert.equal(bar.findAll('span')
      .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-badge')).length,
    0, `${activeId} lights no badge on an unknown count`);
  }
});

test('Agenti link their screen only when the agents package publishes create-agent (backlog:33782ba68747)', () => {
  const composed = shellNavInput({
    domains: { agents: { resources: ['teammate-agent'], operations: [{ name: 'create-agent', appMethod: 'createTeammateAgent' }] } },
  });
  assert.equal(composed.agentsAvailable, true);
  const on = buildShellNav(composed).find((item) => item.id === 'agenti');
  assert.equal(on.available, true);
  assert.equal(on.route, '#/agenti');
  assert.equal(on.label, 'Agenti');
  const without = shellNavInput({ domains: { agents: { resources: ['teammate-agent'], operations: [] } } });
  assert.equal(without.agentsAvailable, false);
  const off = buildShellNav(without).find((item) => item.id === 'agenti');
  assert.equal(off.available, false);
  assert.equal(off.route, null);
});

// backlog:8618ad3f72db (verifica 13-14/11): on Catalogo prodotti the sidebar
// «Impostazioni» lost its highlight. Every view under the Impostazioni tab
// row keeps it, Profilo included.
test('8618ad3f72db: every Impostazioni tab keeps «Impostazioni» highlighted in the sidebar', () => {
  for (const [view, label] of [
    ['personalizzazione', 'Personalizzazione'], ['catalog', 'Catalogo prodotti'], ['sync', 'Stato sync'],
    ['spazi-accessi', 'Spazi e accessi'], ['profilo', 'Profilo'],
  ]) {
    const screen = shellScreenFor({ view });
    assert.equal(screen.id, 'impostazioni', `${view}: the sidebar highlights Impostazioni`);
    assert.equal(screen.label, label);
  }
  assert.equal(shellScreenFor({ view: 'pipeline' }).id, 'pipeline');
});
