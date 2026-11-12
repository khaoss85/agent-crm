import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildShellNav, createShellView } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Shell on a phone (design: shell telefono, oggi.md C26). Up to 700 px —
 * the breakpoint every phone rule uses — the sidebar hides behind a ☰
 * button in the top bar and opens as a modal drawer over the page. What it
 * must prove: the button speaks its state (aria-expanded, aria-controls),
 * the open drawer is a «Menu» dialog that locks the page and traps Tab,
 * opening moves focus into it, Esc and a tap outside close it, and choosing
 * a voice closes it and navigates. Desktop keeps the button hidden
 * (stylesheet rules below).
 */

function mountShell(overrides = {}) {
  const doc = createFakeDocument();
  doc.body = createMount();
  const sidebar = createMount();
  sidebar.setAttribute('id', 'boSidebar');
  sidebar.setAttribute('aria-label', 'Navigazione backoffice');
  const topbar = createMount();
  const navigated = [];
  const handlers = {};
  const win = { addEventListener: (type, handler) => { (handlers[type] ??= []).push(handler); } };
  const fire = (type, event) => { for (const handler of handlers[type] ?? []) handler(event); };
  const view = createShellView({
    doc, sidebar, topbar,
    spaces: overrides.spaces ?? [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
    user: overrides.user ?? { name: 'Elena Rinaldi', email: 'elena@example.it' },
    screenId: 'oggi', screenLabel: 'Oggi',
    navigate: (hash) => navigated.push(hash),
    win,
  });
  view.update({ items: buildShellNav({ customerDataAvailable: true }), activeScreenId: 'oggi', screenLabel: 'Oggi' });
  const toggle = () => topbar.findAll('button').find((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-menu-toggle'));
  const isOpen = () => sidebar.classList.contains('bo-drawer-open');
  return { doc, sidebar, topbar, navigated, fire, view, toggle, isOpen };
}

test('the top bar carries one ☰ button that controls the sidebar, closed at start', () => {
  const { toggle, isOpen } = mountShell();
  const button = toggle();
  assert.ok(button, 'the menu button exists');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-controls'), 'boSidebar');
  assert.equal(button.getAttribute('aria-label'), 'Apri il menu');
  assert.ok(String(button.getAttribute('class')).split(/\s+/).some((cls) => cls.startsWith('ui-')), 'a system control, never raw');
  assert.equal(isOpen(), false);
});

test('☰ opens the drawer, moves focus into it and flips aria-expanded', () => {
  const { sidebar, toggle, isOpen } = mountShell();
  toggle().dispatch('click', {});
  assert.equal(isOpen(), true);
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
  assert.equal(toggle().getAttribute('aria-label'), 'Chiudi il menu');
  assert.equal(sidebar.querySelector('button').__focused, true, 'focus lands on the first control of the drawer');
  toggle().dispatch('click', {});
  assert.equal(isOpen(), false, 'a second tap closes it');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
});

test('Esc closes the open drawer and returns focus to ☰', () => {
  const { fire, toggle, isOpen } = mountShell();
  fire('keydown', { key: 'Escape' });
  assert.equal(isOpen(), false, 'Esc on a closed drawer does nothing');
  assert.notEqual(toggle().__focused, true);
  toggle().dispatch('click', {});
  fire('keydown', { key: 'Escape' });
  assert.equal(isOpen(), false);
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.equal(toggle().__focused, true, 'focus returns to the menu button');
});

test('a tap outside closes the drawer, a tap inside keeps it open', () => {
  const { sidebar, fire, toggle, isOpen } = mountShell();
  toggle().dispatch('click', {});
  const stopped = [];
  const tap = (target) => ({
    target,
    preventDefault: () => stopped.push('prevent'),
    stopPropagation: () => stopped.push('stop'),
  });
  fire('click', tap(sidebar.querySelector('button')));
  assert.equal(isOpen(), true, 'inside the drawer');
  fire('click', tap(toggle()));
  assert.equal(isOpen(), true, 'the toggle handles its own tap');
  assert.deepEqual(stopped, [], 'taps inside reach their control');
  fire('click', tap(createMount()));
  assert.equal(isOpen(), false, 'outside the drawer');
  assert.deepEqual(stopped, ['prevent', 'stop'], 'the dismissing tap never presses the page under the scrim');
});

test('choosing a voice closes the drawer and navigates', () => {
  const { sidebar, navigated, toggle, isOpen } = mountShell();
  toggle().dispatch('click', {});
  const clienti = sidebar.findAll('a').find((node) => node.getAttribute('href') === '#/customer-data');
  clienti.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(navigated, ['#/customer-data']);
  assert.equal(isOpen(), false);
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
});

test('the phone top bar names the space with its badge and role', () => {
  const { topbar } = mountShell();
  const label = topbar.findAll('div').find((node) => node.getAttribute('class') === 'bo-phonebar-space');
  assert.ok(label, 'the phone space label exists');
  assert.ok(label.textContent.includes('SP') && label.textContent.includes('Spazio di prova'));
});

test('a shell repaint keeps the open state on the button', () => {
  const { view, toggle, isOpen } = mountShell();
  toggle().dispatch('click', {});
  view.update({ clientCount: 3 });
  assert.equal(isOpen(), true);
  assert.equal(toggle().getAttribute('aria-expanded'), 'true');
});

test('the open drawer is a modal «Menu» dialog that locks the page, undone on close', () => {
  const { doc, sidebar, fire, toggle } = mountShell();
  assert.equal(sidebar.getAttribute('role'), null, 'closed: a plain navigation landmark');
  toggle().dispatch('click', {});
  assert.equal(sidebar.getAttribute('role'), 'dialog');
  assert.equal(sidebar.getAttribute('aria-modal'), 'true');
  assert.equal(sidebar.getAttribute('aria-label'), 'Menu');
  assert.equal(doc.body.classList.contains('bo-scroll-lock'), true, 'the page behind is locked');
  fire('keydown', { key: 'Escape' });
  assert.equal(sidebar.getAttribute('role'), null);
  assert.equal(sidebar.getAttribute('aria-modal'), null);
  assert.equal(sidebar.getAttribute('aria-label'), 'Navigazione backoffice', 'the landmark label returns');
  assert.equal(doc.body.classList.contains('bo-scroll-lock'), false, 'the page scrolls again');
});

test('Tab and Shift+Tab cycle inside the open drawer', () => {
  const { doc, sidebar, fire, toggle } = mountShell();
  toggle().dispatch('click', {});
  const first = sidebar.querySelector('button');
  const last = sidebar.findAll('button').find((node) => node.getAttribute('aria-label') === 'Esci');
  const keys = [];
  const key = (shiftKey) => ({ key: 'Tab', shiftKey, preventDefault: () => keys.push('prevent') });
  first.__focused = false;
  doc.activeElement = last;
  fire('keydown', key(false));
  assert.equal(first.__focused, true, 'Tab on the last control wraps to the first');
  last.__focused = false;
  doc.activeElement = first;
  fire('keydown', key(true));
  assert.equal(last.__focused, true, 'Shift+Tab on the first control wraps to the last');
  assert.deepEqual(keys, ['prevent', 'prevent']);
  const middle = sidebar.findAll('a').find((node) => node.getAttribute('href') === '#/customer-data');
  doc.activeElement = middle;
  fire('keydown', key(false));
  assert.equal(keys.length, 2, 'inside the cycle the browser moves focus itself');
  doc.activeElement = createMount();
  first.__focused = false;
  fire('keydown', key(false));
  assert.equal(first.__focused, true, 'focus outside the drawer is pulled back to the first control');
});

test('stylesheet: ☰ hidden on desktop, modal drawer and compact bar up to 700px', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const phone = css.indexOf('@media (max-width: 700px) {\n  /* design: shell telefono');
  assert.ok(phone !== -1, 'the phone shell uses the 700px breakpoint of every other phone rule');
  assert.ok(!css.includes('@media (max-width: 560px) {\n  /* design: shell telefono'), 'no second, narrower shell breakpoint');
  const outside = css.slice(0, phone);
  assert.match(outside, /\.bo-menu-toggle, \.bo-phonebar-space \{ display: none; \}/, 'desktop never shows ☰ nor the phone space label');
  const block = css.slice(phone, css.indexOf('\n}\n', phone));
  assert.match(block, /\.bo-sidebar \{ display: none; \}/, 'the sidebar hides on a phone');
  assert.match(block, /\.bo-sidebar\.bo-drawer-open \{[^}]*position: fixed;[^}]*z-index: 40;/, 'the open sidebar is a drawer over the page');
  assert.match(block, /body\.bo-scroll-lock \{ overflow: hidden; \}/, 'the open drawer locks the page scroll');
  assert.match(block, /\.bo-topbar \.bo-menu-toggle \{[^}]*display: inline-flex;/, 'the phone shows ☰, above the later ui-btn sizing');
  assert.doesNotMatch(css, /\.bo-nav \{ flex-direction: row;/, 'the 300px horizontal strip is gone');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}\b/, 'no new colour');
});

test('the phone content starts within 120px at 390px, short and long names with role (backlog:4419cc25e2df)', () => {
  // Rendered measurement, not stylesheet literals: the row structure comes
  // from the mounted top bar, the row heights from the computed stylesheet
  // values, and the load-bearing assertion is the stacked total against the
  // 120px budget. Growing a height, widening a padding or adding a bar row
  // moves the total and fails this test. At 390px the 700px phone block
  // applies; its grid (minmax(0, 1fr) auto, path and AI bar spanning both
  // columns) keeps long names on the first row with an ellipsis instead of
  // growing new rows.
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  const phone = css.indexOf('@media (max-width: 700px) {\n  /* design: shell telefono');
  assert.ok(phone !== -1, 'the phone shell block exists');
  const block = css.slice(phone, css.indexOf('\n}\n', phone));
  // A value the budget cannot parse fails by name instead of silently
  // passing on a stale constant.
  const px = (source, pattern, name) => {
    const found = source.match(pattern);
    assert.ok(found, `${name} is declared, so the budget stays measurable`);
    return Number(found[1]);
  };
  const ratio = (source, pattern, name) => {
    const found = source.match(pattern);
    assert.ok(found, `${name} is declared, so the budget stays measurable`);
    return Number(found[1]);
  };
  const barPadV = 2 * px(block, /\.bo-topbar \{[^}]*padding: (\d+)px \d+px;/, 'phone bar vertical padding');
  const rowGap = px(block, /\.bo-topbar \{[^}]*gap: (\d+)px/, 'phone bar row gap');
  const toggleH = px(block, /\.bo-menu-toggle \{[^}]*height: (\d+)px;/, 'phone menu button height');
  const badgeH = px(block, /\.bo-space-badge \{[^}]*height: (\d+)px;/, 'phone space badge height');
  const spacePadV = 2 * px(block, /\.bo-phonebar-space \{[^}]*padding: (\d+)px \d+px;/, 'phone space row vertical padding');
  const nameLine = px(block, /\.bo-space-name \{[^}]*font-size: (\d+)px;/, 'phone space name size')
    * ratio(block, /\.bo-space-name \{[^}]*line-height: ([\d.]+);/, 'phone space name line height');
  const roleLine = px(block, /\.bo-space-role \{[^}]*font-size: (\d+)px;/, 'phone space role size')
    * ratio(block, /\.bo-space-role \{[^}]*line-height: ([\d.]+);/, 'phone space role line height');
  const crumbLine = px(css, /\.bo-crumb \{[^}]*font-size: (\d+)px;/, 'crumb size')
    * ratio(block, /\.bo-crumb \{[^}]*line-height: ([\d.]+);/, 'phone crumb line height');
  const aiH = px(block, /\.bo-ai \{[^}]*height: (\d+)px;/, 'phone AI bar height');
  const contentGap = px(block, /\.bo-main > \.bo-topbar \+ \* \{[^}]*margin-top: (\d+)px;/, 'gap between the bar and the content');
  assert.doesNotMatch(css, /\.bo-nav \{ flex-direction: row;/, 'diagnostic: the 300px horizontal strip is gone');
  assert.match(block, /\.bo-crumb \{[^}]*white-space: nowrap;/, 'diagnostic: the crumb keeps one line');
  const hasClass = (node, cls) => String(node.getAttribute('class') ?? '').split(/\s+/).includes(cls);
  const cases = [
    {
      label: 'short name without a role',
      spaces: [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
      user: { name: 'Elena Rinaldi', email: 'elena@example.it' },
      withRole: false,
    },
    {
      label: 'long name with a role',
      spaces: [{ id: 'prova', name: 'Spazio di prova molto lungo per il taglio', initials: 'SP' }],
      user: { name: 'Elena Rinaldi', email: 'elena@example.it', role: 'owner' },
      withRole: true,
    },
  ];
  for (const { label, spaces, user, withRole } of cases) {
    const { topbar } = mountShell({ spaces, user });
    const rows = topbar.childNodes.filter((node) => typeof node.tagName === 'string');
    assert.deepEqual(
      rows.map((node) => String(node.getAttribute('class') ?? '').split(/\s+/)[0]),
      ['bo-phonebar-space', 'bo-menu-toggle', 'bo-crumb', 'bo-ai'],
      `${label}: the phone bar renders three rows (space + menu button, path, AI bar)`,
    );
    const spaceText = rows[0].findAll('span').find((node) => hasClass(node, 'bo-space-text'));
    assert.ok(spaceText, `${label}: the space label renders`);
    const stacked = spaceText.childNodes.filter((node) => typeof node.tagName === 'string');
    assert.equal(stacked.length, withRole ? 2 : 1, `${label}: the role stacks inside the first row, never as a new bar row`);
    const textStack = withRole ? nameLine + roleLine : nameLine;
    const firstRow = Math.max(toggleH, badgeH > textStack ? badgeH + spacePadV : textStack + spacePadV);
    const crumb = rows[2];
    assert.ok(
      crumb.textContent.includes(spaces[0].name) && crumb.textContent.includes('Oggi'),
      `${label}: the rendered path still names the space and the screen`,
    );
    const total = barPadV + firstRow + rowGap + crumbLine + rowGap + aiH + contentGap;
    assert.ok(total <= 120, `${label}: the content starts at ${total.toFixed(1)}px, within the 120px budget`);
  }
});
