// @ts-check

/**
 * Backoffice BO-F0-06 Spazi e accessi (backlog:5872e92b).
 *
 * What it must prove: the route parses; the switch list mirrors the package
 * keys and defaults (a drift fails here, not in review); each space card
 * names the operator's role; the team lists, invites and removes with a
 * two-step confirmation; flips run through set-permission with a confirm
 * step; hostile server text stays text; unreadable team or switches render
 * an honest note, never invented rows. DOM-free builders plus the fake
 * document — no browser.
 */

import test from 'node:test';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  SPAZI_AI_DEFAULTS,
  SPAZI_AI_MASTER,
  SPAZI_AI_MASTER_DEFAULT,
  SPAZI_AI_SWITCHES,
  buildSpaziCards,
  buildTeamRows,
  countSpaceChannels,
  countSpaceCustomers,
  createSpaziAccessiView,
  effectiveSwitches,
  formatSpaceStat,
  memberInitials,
  spaceRoleLabel,
  teamCalendarState,
  teamChannelTiles,
} from '../apps/admin/public/admin-spazi-accessi.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import {
  SPACE_AI_PERMISSIONS,
  SPACE_AI_PERMISSION_DEFAULTS,
} from '../packages/space-permissions/src/index.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const SPACE = 'spazio-1';

function stubClient({ context = null, members = [], overrides = [], calls = null, fail = {}, connectorsBySpace = null, customersBySpace = null, needsBySpace = null } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const rawBody = options?.body ?? null;
      let body = rawBody;
      if (typeof rawBody === 'string' && rawBody !== '') {
        try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      }
      if (calls) calls.push({ path, body, method: options?.method ?? 'GET' });
      if (path === '/api/spine/context') {
        if (fail.context) throw fail.context;
        return context ?? { identity: { subject: 'google|sessione-test' }, membership: { role: 'owner', subject: 'google|sessione-test' }, roles: { owner: [], operator: [], observer: [] } };
      }
      if (path === '/api/spine/memberships') {
        if (fail.members) throw fail.members;
        if ((options?.method ?? 'GET').toUpperCase() === 'POST') {
          members.push({ subject: body.subject, role: body.role, status: 'active' });
          return { subject: body.subject };
        }
        return { items: members };
      }
      if (path.startsWith('/api/spine/memberships/') && path.endsWith('/suspend')) {
        const subject = decodeURIComponent(path.split('/')[4]);
        if (fail.suspend && Object.hasOwn(fail.suspend, subject)) throw fail.suspend[subject];
        const found = members.find((row) => row.subject === subject);
        if (!found) throw Object.assign(new Error('no such member'), { code: 'NOT_FOUND' });
        members.splice(members.indexOf(found), 1);
        return { subject };
      }
      if (path.startsWith('/api/space-permissions/effective')) {
        if (fail.overrides) throw fail.overrides;
        return { spaceId: SPACE, overrides: overrides.filter((row) => row.spaceId === SPACE) };
      }
      if (path === '/api/space-permissions/set-permission') {
        const found = overrides.find((row) => row.spaceId === body.spaceId && row.permission === body.permission);
        if (found) found.enabled = body.enabled === 'on';
        else overrides.push({ spaceId: body.spaceId, permission: body.permission, enabled: body.enabled === 'on' });
        return { spaceId: body.spaceId, permission: body.permission, enabled: body.enabled === 'on' };
      }
      if (path.startsWith('/api/connectors/activity')) {
        const spaceId = new URL(path, 'http://stub.test').searchParams.get('spaceId') ?? SPACE;
        const needsFix = needsBySpace !== null && Object.hasOwn(needsBySpace, spaceId)
          ? needsBySpace[spaceId] : 0;
        return { spaceId, needsFix };
      }
      if (path.startsWith('/api/connectors')) {
        if (fail.connectors) throw fail.connectors;
        const spaceId = new URL(path, 'http://stub.test').searchParams.get('spaceId') ?? SPACE;
        const connectors = connectorsBySpace !== null && Object.hasOwn(connectorsBySpace, spaceId)
          ? connectorsBySpace[spaceId]
          : [];
        return { spaceId, connectors };
      }
      if (path.includes('/api/modules/data-quality-issue/records')) return { items: [] };
      if (path.includes('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path.startsWith('/api/customer-data/customers')) {
        if (fail.customers) throw fail.customers;
        const spaceId = new URL(path, 'http://stub.test').searchParams.get('spaceId') ?? SPACE;
        const shaped = customersBySpace !== null && Object.hasOwn(customersBySpace, spaceId)
          ? customersBySpace[spaceId]
          : { total: 0, totalIsExact: true };
        return { items: [], page: 1, pageSize: 10, pages: 0, ...shaped };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
}

function view({ client, spaces = [{ id: SPACE, name: 'Negozio', initials: 'NE' }], active = SPACE, doc = null } = {}) {
  const docNode = doc ?? createFakeDocument();
  const mount = createMount();
  const seen = { toast: [], picked: [], navigated: [] };
  const v = createSpaziAccessiView({
    doc: docNode,
    mount,
    client: client ?? stubClient(),
    navigate: (hash) => seen.navigated.push(hash),
    spaces: () => spaces,
    activeSpaceId: () => active,
    onPickSpace: (id) => seen.picked.push(id),
    toast: (message, error = false) => seen.toast.push({ message, error }),
  });
  return { doc: docNode, mount, seen, view: v };
}

const text = (mount) => mount.textContent;

// Voce 19c2e22a64a1 (1): the tab badge counts the active space live — a
// space with attention rows lights the badge, a quiet space never wears
// the other space's count.
test('the tab badge counts the active space live — never another space', async () => {
  const spaces = [
    { id: 'spazio-a', name: 'Negozio A', initials: 'NA' },
    { id: 'spazio-b', name: 'Negozio B', initials: 'NB' },
  ];
  const client = stubClient({ needsBySpace: { 'spazio-a': 5, 'spazio-b': 0 } });
  const badgeOf = (mount) => mount.findAll('span')
    .find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-badge'));
  const first = view({ client, spaces, active: 'spazio-a' });
  await first.view.render();
  await flush();
  assert.ok(badgeOf(first.mount), 'spazio-a lights the badge');
  assert.equal(badgeOf(first.mount).textContent, '5', 'the badge carries spazio-a count');
  const second = view({ client, spaces, active: 'spazio-b' });
  await second.view.render();
  await flush();
  assert.equal(badgeOf(second.mount), undefined, 'spazio-b wears no badge — never spazio-a count');
});

test('the spazi-accessi route parses, deeper paths stay invalid', () => {
  assert.equal(parseModuleRoute('#/spazi-accessi').view, 'spazi-accessi');
  assert.equal(parseModuleRoute('#/spazi-accessi/altro').view, 'invalid');
});

test('the switch list mirrors the package keys and defaults', () => {
  assert.deepEqual(SPAZI_AI_SWITCHES.map((entry) => entry.key), [...SPACE_AI_PERMISSIONS]);
  assert.deepEqual({ ...SPAZI_AI_DEFAULTS }, { ...SPACE_AI_PERMISSION_DEFAULTS });
  for (const entry of SPAZI_AI_SWITCHES) {
    assert.ok(entry.label.trim() !== '', `${entry.key} has a label`);
    assert.ok(entry.line.trim() !== '', `${entry.key} explains itself in one line`);
  }
});

test('space cards name the operator role, hostile names stay text', () => {
  const cards = buildSpaziCards({
    spaces: [{ id: 'a<script>', name: '<b>Negozio</b>', initials: 'NE' }],
    activeSpaceId: 'a<script>',
    role: 'owner',
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].role, 'Titolare', 'the same word the shell prints under the space name');
  assert.equal(cards[0].roleKnown, true);
  assert.equal(cards[0].active, true);
  assert.equal(spaceRoleLabel('operator'), 'Operatore');
  assert.equal(spaceRoleLabel('observer'), 'Osservatore');
  assert.equal(spaceRoleLabel('sconosciuto'), 'sconosciuto');
  assert.equal(spaceRoleLabel(null), 'non disponibile');
});

test('effective switches default on except send-without-approval, other spaces never leak in', () => {
  const switches = effectiveSwitches(SPACE, [
    { spaceId: 'altrove', permission: 'drafts', enabled: false },
    { spaceId: SPACE, permission: 'drafts', enabled: false },
  ]);
  assert.equal(switches.length, 5);
  const byKey = Object.fromEntries(switches.map((entry) => [entry.key, entry.enabled]));
  assert.equal(byKey.drafts, false);
  assert.equal(byKey['send-without-approval'], false);
  assert.equal(byKey['merge-duplicates'], true);
});

test('team rows sort by subject, hostile subjects stay text', () => {
  const rows = buildTeamRows([
    { subject: 'zeta', role: 'operator', status: 'active' },
    { subject: '<img src=x>', role: 'owner', status: 'active' },
  ]);
  assert.deepEqual(rows.map((row) => row.subject), ['<img src=x>', 'zeta']);
});

test('member initials come from the subject, never invented', () => {
  assert.equal(memberInitials('marco'), 'MA');
  assert.equal(memberInitials('owner-1'), 'OW');
  assert.equal(memberInitials('luca.rossi@example.it'), 'LU');
  assert.equal(memberInitials('<img src=x>'), 'IM');
  assert.equal(memberInitials(''), '·');
  assert.equal(memberInitials('---'), '·');
  assert.equal(memberInitials(null), '·');
  const rows = buildTeamRows([{ subject: 'marco', role: 'operator', status: 'active' }]);
  assert.equal(rows[0].initials, 'MA');
  assert.equal(rows[0].role, 'Operatore');
});

test('team and AI panels share one row container, members show avatar and role pill', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const { mount, view: v } = view({ client: stubClient({ members }) });
  await v.render();
  await flush();
  const byClass = (tag, cls) => mount.findAll(tag)
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes(cls));
  assert.equal(byClass('div', 'bo-spazi-panels').length, 1, 'one panels row holds team and AI');
  const teamPanels = byClass('section', 'bo-spazi-team-panel');
  const aiPanels = byClass('section', 'bo-spazi-ai-panel');
  assert.equal(teamPanels.length, 1, 'the team panel renders');
  assert.equal(aiPanels.length, 1, 'the AI panel renders');
  assert.equal(teamPanels[0].parentNode, byClass('div', 'bo-spazi-panels')[0], 'team sits inside the row');
  assert.equal(aiPanels[0].parentNode, byClass('div', 'bo-spazi-panels')[0], 'AI sits inside the row');
  const avatars = byClass('span', 'bo-spazi-avatar');
  assert.equal(avatars.length, 1, 'one avatar for one member');
  assert.equal(avatars[0].textContent, 'MA', 'the avatar reads the subject initials');
  const pills = byClass('span', 'bo-spazi-role');
  assert.equal(pills.length, 1, 'one role pill for one member');
  assert.equal(pills[0].textContent, 'Operatore', 'the pill names the Italian role');
  assert.match(text(mount), /attivo/, 'the status stays next to the subject, in Italian');
});

test('the screen lists spaces with roles, team, the master AI switch and the five switches (backlog:2c3156a47f8e)', async () => {
  const members = [
    { subject: 'owner-1', role: 'owner', status: 'active' },
    { subject: 'marco', role: 'operator', status: 'active' },
  ];
  const { mount, view: v } = view({ client: stubClient({ members }) });
  await v.render();
  await flush();
  const rendered = text(mount);
  assert.match(rendered, /Spazi di lavoro/);
  assert.match(rendered, /Stai lavorando qui/);
  assert.match(rendered, /Tu: Titolare/);
  assert.match(rendered, /Team dell\u2019organizzazione/);
  assert.match(rendered, /intera organizzazione/);
  // Supervisor design check on #644: the team is the organization's, the
  // screen never says «postazione».
  assert.match(rendered, /Lo stesso team per tutta l’organizzazione/);
  assert.doesNotMatch(rendered, /postazione/);
  assert.match(rendered, /Marco/);
  assert.match(rendered, /Cosa pu\u00F2 fare l\u2019AI/);
  assert.equal(SPAZI_AI_MASTER.key, 'ai-enabled');
  assert.equal(SPAZI_AI_MASTER_DEFAULT, true);
  assert.ok(rendered.includes(SPAZI_AI_MASTER.label), 'the master AI switch is listed first');
  assert.ok(rendered.includes(SPAZI_AI_MASTER.line), 'the master AI switch explains itself');
  assert.match(rendered, /AI dello spazio: accesa/);
  for (const entry of SPAZI_AI_SWITCHES) {
    assert.ok(rendered.includes(entry.label), `switch ${entry.key} is listed`);
    assert.ok(rendered.includes(entry.line), `switch ${entry.key} explains itself`);
  }
  const toggles = mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  assert.equal(toggles.length, 6);
  assert.equal(toggles[0].getAttribute('aria-label'), SPAZI_AI_MASTER.label);
  assert.equal(toggles[0].getAttribute('aria-checked'), 'true');
  assert.equal(toggles.find((node) => node.getAttribute('aria-label') === 'Inviare risposte senza approvazione')?.getAttribute('aria-checked'), 'false');
});

test('with the master AI switch off the screen says spenta and locks the five (backlog:2c3156a47f8e)', async () => {
  const { mount, view: v } = view({
    client: stubClient({ overrides: [{ spaceId: SPACE, permission: 'ai-enabled', enabled: false }] }),
  });
  await v.render();
  await flush();
  const rendered = text(mount);
  assert.match(rendered, /AI dello spazio: spenta/);
  const toggles = mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  assert.equal(toggles.length, 6);
  const master = toggles.find((node) => node.getAttribute('aria-label') === SPAZI_AI_MASTER.label);
  assert.equal(master?.getAttribute('aria-checked'), 'false');
  assert.equal(master?.disabled, false, 'the master stays flippable while everything else locks');
  for (const node of toggles) {
    if (node.getAttribute('aria-label') === SPAZI_AI_MASTER.label) continue;
    assert.equal(node.disabled, true, `${node.getAttribute('aria-label')} locks while the master is off`);
  }
});

// backlog:cb1a32dc46b2: with the AI off only the AI's actions become
// proposals — a person's Conferma books, a person's save saves. The screen
// never says «ogni azione» any more.
test('cb1a32dc46b2: with the AI off the screen says only the AI\'s actions become proposals', async () => {
  const { mount, view: v } = view({
    client: stubClient({ overrides: [{ spaceId: SPACE, permission: 'ai-enabled', enabled: false }] }),
  });
  await v.render();
  await flush();
  const rendered = text(mount);
  assert.match(rendered, /le azioni dell\u2019AI diventano proposte da approvare/);
  assert.match(rendered, /quello che fai tu resta com\u2019è/);
  assert.doesNotMatch(rendered, /ogni azione diventa una proposta/);
  assert.match(SPAZI_AI_MASTER.line, /le azioni dell\u2019AI diventano proposte da approvare; quello che fai tu resta com\u2019è/);
  assert.doesNotMatch(SPAZI_AI_MASTER.line, /ogni azione/);
});

// backlog:1cfc68175ab7 (giro UX 11/11, punto 34): with the AI off the five
// stayed green (aria-checked=true, disabled). They decide nothing until the
// AI is back on: grey and «in pausa», never on.
test('1cfc68175ab7: with the space AI off the five read paused, never green', async () => {
  const { mount, view: v } = view({
    client: stubClient({ overrides: [{ spaceId: SPACE, permission: 'ai-enabled', enabled: false }] }),
  });
  await v.render();
  await flush();
  const toggles = mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  const five = toggles.filter((node) => node.getAttribute('aria-label') !== SPAZI_AI_MASTER.label);
  assert.equal(five.length, 5);
  for (const node of five) {
    assert.equal(node.getAttribute('data-on'), 'false', `${node.getAttribute('aria-label')} is not green`);
    assert.equal(node.getAttribute('aria-checked'), 'false', `${node.getAttribute('aria-label')} is not announced on`);
    assert.equal(node.getAttribute('data-paused'), 'true');
    assert.equal(node.disabled, true);
  }
  const rendered = text(mount);
  assert.match(rendered, /In pausa/, 'each switch says it is paused');
  // Back on: the five show their own values again, nothing paused.
  const { mount: onMount, view: onView } = view({ client: stubClient({}) });
  await onView.render();
  await flush();
  const onToggles = onMount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  assert.ok(onToggles.some((node) => node.getAttribute('aria-label') !== SPAZI_AI_MASTER.label && node.getAttribute('data-on') === 'true'),
    'with the AI on a switch that is on reads green');
  assert.equal(onToggles.filter((node) => node.getAttribute('data-paused') === 'true').length, 0);
  assert.doesNotMatch(text(onMount), /In pausa/);
});

// backlog:1a96094db71d (giro UX 11/11): Spazi e accessi stayed on «Carico…»
// for more than 10 s — eight reads one after the other, 2,5–4 s each. Now
// the page paints at once with a skeleton, every read starts together, and
// the data replaces the skeleton when the reads land.
test('1a96094db71d: the page paints a skeleton at once and starts every read together', async () => {
  const pending = [];
  const base = stubClient({
    members: [{ subject: 'owner-1', role: 'owner', status: 'active' }, { subject: 'marco', role: 'operator', status: 'active' }],
    connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', channel: 'whatsapp', status: 'active' }] },
    customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
  });
  const client = {
    request(path, options = {}) {
      return new Promise((resolve, reject) => {
        pending.push({ path, release: () => base.request(path, options).then(resolve, reject) });
      });
    },
  };
  const { mount, view: v } = view({ client });
  const done = v.render();
  await flush();
  // Nothing has answered yet: the page is already there.
  const before = text(mount);
  assert.match(before, /IMPOSTAZIONI/, 'the tabs paint at once');
  assert.match(before, /Spazi di lavoro/, 'the header paints at once');
  assert.match(before, /Team dell\u2019organizzazione/, 'the team card is there');
  assert.ok(mount.findAll('section').some((node) => node.getAttribute('data-skeleton') === 'true'), 'a skeleton, not «Carico…»');
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch').length, 0,
    'no switch to flip before its value is known');
  const started = pending.map((entry) => entry.path);
  for (const expected of ['/api/spine/context', '/api/spine/memberships', '/api/space-permissions/effective', '/api/connectors', '/api/customer-data/customers']) {
    assert.ok(started.some((path) => path.startsWith(expected)), `${expected} starts before any answer`);
  }
  // Release everything (and whatever the answers start), then the data replaces the skeleton.
  for (let round = 0; round < 6 && pending.length > 0; round += 1) {
    for (const entry of pending.splice(0)) entry.release();
    await flush();
  }
  await done;
  await flush();
  assert.ok(!mount.findAll('section').some((node) => node.getAttribute('data-skeleton') === 'true'), 'the skeleton is gone');
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch').length, 6, 'the switches arrive');
  assert.match(text(mount), /1 canale · 2 persone · 3 clienti/, 'the space card statistic arrives');
});

// Review #830 P2: a menu opened while the first reads are pending repaints
// the mount from inside the view; when the reads land the data must still
// replace the skeleton, never stay stuck behind it.
test('1a96094db71d review: a menu opened during loading never leaves the skeleton on screen', async () => {
  const pending = [];
  const base = stubClient({
    members: [{ subject: 'owner-1', role: 'owner', status: 'active' }, { subject: 'marco', role: 'operator', status: 'active' }],
    connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', channel: 'whatsapp', status: 'active' }] },
    customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
  });
  const client = {
    request(path, options = {}) {
      return new Promise((resolve, reject) => {
        pending.push({ release: () => base.request(path, options).then(resolve, reject) });
      });
    },
  };
  const { mount, view: v } = view({ client });
  const done = v.render();
  await flush();
  assert.ok(mount.findAll('section').some((node) => node.getAttribute('data-skeleton') === 'true'), 'the skeleton is up');
  const adder = mount.findAll('button').find((node) => node.textContent === '+ Nuovo spazio di lavoro');
  assert.ok(adder, 'the new-space menu toggle is there while loading');
  adder.dispatch('click', {});
  assert.ok(mount.findAll('section').some((node) => node.getAttribute('data-skeleton') === 'true'), 'still loading after the menu opens');
  for (let round = 0; round < 6 && pending.length > 0; round += 1) {
    for (const entry of pending.splice(0)) entry.release();
    await flush();
  }
  await done;
  await flush();
  assert.ok(!mount.findAll('section').some((node) => node.getAttribute('data-skeleton') === 'true'), 'the skeleton is gone');
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch').length, 6, 'the switches arrive');
  assert.match(text(mount), /1 canale · 2 persone · 3 clienti/, 'the statistic arrives');
});

test('1a96094db71d: a refresh after a write keeps the screen, never the skeleton', async () => {
  const { mount, view: v } = view({ client: stubClient({}) });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.getAttribute('role') === 'switch' && node.getAttribute('aria-label') !== SPAZI_AI_MASTER.label);
  toggle.dispatch('click', {});
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  assert.ok(confirm, 'the confirm step opens');
  const writing = confirm.dispatch('click', {});
  void writing;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!mount.findAll('section').some((node) => node.getAttribute('data-skeleton') === 'true'), 'no skeleton flash after a write');
  await flush();
});

test('a refused team read renders as a refusal, not an empty team', async () => {
  const denied = Object.assign(new Error('forbidden'), { code: 'SPINE_MEMBERSHIP_FORBIDDEN', status: 403 });
  const { mount, view: v } = view({ client: stubClient({ fail: { members: denied } }) });
  await v.render();
  await flush();
  assert.match(text(mount), /ha rifiutato la lettura/);
  assert.doesNotMatch(text(mount), /Nessun membro oltre a te/);
});

test('missing permission rows render an honest note, never invented switches', async () => {
  const missing = Object.assign(new Error('not found'), { code: 'NOT_FOUND', status: 404 });
  const { mount, view: v } = view({ client: stubClient({ fail: { overrides: missing } }) });
  await v.render();
  await flush();
  assert.match(text(mount), /non sono attivi in questo spazio/);
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch').length, 0);
});

test('a status-only 404 on the switches reads as not composed, never transient', async () => {
  // The rejection carries no code, only a status: the normalization must
  // keep it, or the page would answer the transient 'retry later' instead
  // of the not-composed note.
  const { mount, view: v } = view({ client: stubClient({ fail: { overrides: { status: 404 } } }) });
  await v.render();
  await flush();
  assert.match(text(mount), /non sono attivi in questo spazio/);
  assert.doesNotMatch(text(mount), /Riprova più tardi/);
});

test('a status-only 403 on the team reads as a refusal, not an empty team', async () => {
  const { mount, view: v } = view({ client: stubClient({ fail: { members: { status: 403 } } }) });
  await v.render();
  await flush();
  assert.match(text(mount), /ha rifiutato la lettura/);
  assert.doesNotMatch(text(mount), /Nessun membro oltre a te/);
});

test('a plain server failure reaches the page as a human note while the log keeps its message', async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const { mount, view: v } = view({ client: stubClient({ fail: { members: new Error('boom') } }) });
    await v.render();
    await flush();
    const rendered = text(mount);
    assert.match(rendered, /Il team non si è potuto leggere/);
    assert.doesNotMatch(rendered, /boom/);
    assert.doesNotMatch(rendered, /UNKNOWN/);
    const entry = logged.find((args) => String(args[0]).includes('[bo] lettura fallita'));
    assert.ok(entry, 'the failure is logged for the operator console');
    assert.equal(entry[1]?.code, 'UNKNOWN');
    assert.equal(entry[1]?.message, 'boom', 'the log keeps the real message, not [object Object]');
  } finally {
    console.error = originalError;
  }
});

test('inviting names subject, role and reason; removal asks twice with a reason', async () => {
  const members = [{ subject: 'owner-1', role: 'owner', status: 'active' }];
  const calls = [];
  const { mount, seen, view: v } = view({ client: stubClient({ members, calls }) });
  await v.render();
  await flush();
  const inputs = mount.findAll('input');
  const subject = inputs.find((node) => node.getAttribute('aria-label') === 'Identificativo della persona da invitare');
  assert.ok(subject, 'the invite names its subject accessibly');
  subject.value = 'luca';
  const inviteButton = mount.findAll('button').find((node) => node.textContent === 'Invita');
  await inviteButton.listeners.click[0]();
  await flush(20);
  const grant = calls.find((call) => call.path === '/api/spine/memberships' && call.method === 'POST');
  assert.ok(!grant, 'no grant without a reason: the server would refuse');
  assert.ok(seen.toast.some((row) => row.error), 'the missing reason is said aloud');

  const reason = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo dell\u2019invito');
  reason.value = 'commesso del negozio';
  await inviteButton.listeners.click[0]();
  await flush(20);
  const granted = calls.find((call) => call.path === '/api/spine/memberships' && call.method === 'POST');
  assert.equal(granted?.body?.subject, 'luca');
  assert.equal(granted?.body?.role, 'operator');
  assert.equal(granted?.body?.reason, 'commesso del negozio');

  const lucaRow = text(mount);
  assert.match(lucaRow, /Luca/);
  const remove = mount.findAll('button').find((node) => node.textContent === 'Rimuovi' && node.parentNode?.textContent?.includes('Luca'));
  assert.ok(remove, 'each member has its own removal');
  await remove.listeners.click[0]();
  await flush();
  assert.match(text(mount), /Conferma rimozione/, 'removal is two-step');
  assert.match(text(mount), /intera organizzazione/, 'the confirm says the suspension is organization-wide');
  assert.ok(!calls.some((call) => call.path.includes('/suspend')), 'nothing is suspended before confirm');
  const confirmReason = mount.findAll('input').find((node) => (node.getAttribute('aria-label') ?? '').startsWith('Motivo della rimozione'));
  confirmReason.value = 'fine rapporto';
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma rimozione');
  await confirm.listeners.click[0]();
  await flush(20);
  assert.ok(calls.some((call) => call.path === '/api/spine/memberships/luca/suspend'), 'confirm suspends with the reason');
});

test('a late answer never repaints over the screen that replaced it', async () => {
  let releaseMembers = null;
  const membersGate = new Promise((resolve) => { releaseMembers = resolve; });
  let membersCalls = 0;
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const inner = stubClient({ members });
  const gated = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = (options?.method ?? 'GET').toUpperCase();
      if (path === '/api/spine/memberships' && method !== 'POST' && membersCalls++ === 0) {
        await membersGate;
      }
      return inner.request(path, options);
    },
  };
  const { doc, mount, view: v } = view({ client: gated });
  const first = v.render();
  await flush(6);
  // The operator opens another module while the team read is still in
  // flight: the shell owns the mount now, and this screen must not touch it.
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const foreign = doc.createElement('p');
  foreign.textContent = 'Modulo clienti';
  mount.appendChild(foreign);
  releaseMembers();
  await first;
  await flush(10);
  assert.match(text(mount), /Modulo clienti/);
  assert.doesNotMatch(text(mount), /Spazi di lavoro/, 'the stale answer stays out');
});

test('flipping a switch confirms first, then runs set-permission', async () => {
  const calls = [];
  const overrides = [];
  const { mount, seen, view: v } = view({ client: stubClient({ calls, overrides }) });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Inviare risposte senza approvazione');
  await toggle.listeners.click[0]();
  await flush();
  assert.match(text(mount), /Accendere/, 'the flip asks before writing');
  assert.ok(!calls.some((call) => call.path === '/api/space-permissions/set-permission'), 'nothing flips before confirm');
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  await confirm.listeners.click[0]();
  await flush(20);
  const flip = calls.find((call) => call.path === '/api/space-permissions/set-permission');
  assert.deepEqual(flip?.body, { spaceId: SPACE, permission: 'send-without-approval', enabled: 'on' });
  assert.ok(seen.toast.some((row) => !row.error && /accesa/.test(row.message)), 'the flip is said aloud');
  const toggles = mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  assert.equal(toggles.find((node) => node.getAttribute('aria-label') === 'Inviare risposte senza approvazione')?.getAttribute('aria-checked'), 'true');
});

test('a refused flip renders the server refusal and keeps the screen usable', async () => {
  const refusing = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/context') return { membership: { role: 'observer' }, roles: { observer: [] } };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/space-permissions/effective')) return { spaceId: 'spazio-1', overrides: [] };
      if (path === '/api/space-permissions/set-permission') {
        throw Object.assign(new Error('Flipping a space AI switch requires a human user actor'), { code: 'HUMAN_APPROVAL_REQUIRED' });
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const { mount, seen, view: v } = view({ client: refusing });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Scrivere bozze di risposta');
  await toggle.listeners.click[0]();
  await flush();
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  await confirm.listeners.click[0]();
  await flush(20);
  // backlog:9046f940: the refusal is Italian next to the command, never the
  // technical message — the detail stays in the log, not in the DOM.
  // backlog:7d30fb517785: one message only, next to the switch (an alert),
  // no toast beside it.
  assert.ok(!seen.toast.some((row) => row.error), 'no second copy in a toast');
  const refusals = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-spazi-refusal');
  assert.equal(refusals.length, 1, 'one refusal on screen');
  assert.equal(refusals[0].getAttribute('role'), 'alert', 'the refusal is said aloud by an alert');
  assert.ok(!/human user actor|HUMAN_APPROVAL/.test(text(mount)), 'no technical detail is rendered');
  assert.match(text(mount), /non \u00e8 riuscita|non permette/, 'the refusal renders next to the switches');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('role') === 'switch'), 'the switches stay usable');
});

// backlog:9046f940: a 405 on the AI switch keeps the switch as it was and
// names the refusal in Italian next to the command (never silence).
test('a 405 flip keeps the switch and shows an Italian refusal', async () => {
  const refusing = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/context') return { membership: { role: 'owner' }, roles: { owner: [] } };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/space-permissions/effective')) return { spaceId: 'spazio-1', overrides: [] };
      if (path === '/api/space-permissions/set-permission') {
        throw Object.assign(new Error('Method Not Allowed'), { code: 'METHOD_NOT_ALLOWED', status: 405 });
      }
      if (path.startsWith('/api/connectors') || path.startsWith('/api/customer-data/customers')) {
        return { connectors: [], items: [], total: 0, totalIsExact: true };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const { mount, seen, view: v } = view({ client: refusing });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Inviare risposte senza approvazione');
  assert.equal(toggle.getAttribute('aria-checked'), 'false', 'the switch starts off');
  await toggle.listeners.click[0]();
  await flush();
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  await confirm.listeners.click[0]();
  await flush(20);
  assert.ok(!seen.toast.some((row) => row.error), 'one message: no toast beside the inline one (7d30fb517785)');
  assert.match(text(mount), /non permette/, 'the 405 renders next to the switches');
  const kept = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Inviare risposte senza approvazione');
  assert.equal(kept.getAttribute('aria-checked'), 'false', 'the switch is back as it was');
});

test('the switches speak the prototype verbatim, the header states the honest team scope (BO-F6-17 slices 1-2)', async () => {
  // specs/account.md fixed copy: the five titles and descriptions plus the
  // AI subtitle pattern. Keys and defaults stay owned by
  // packages/space-permissions — only the view words move.
  // The header paragraph is NOT the prototype verbatim on purpose: the
  // prototype promises a per-space team ('e team') while the screen
  // discloses a single org-wide shared team, so the header states the
  // honest scope until slice 4 confirms the model (review P2 on bb3a3b6).
  assert.deepEqual(SPAZI_AI_SWITCHES.map((entry) => entry.label), [
    'Unire i contatti duplicati',
    'Scrivere bozze di risposta',
    'Inviare risposte senza approvazione',
    'Fissare appuntamenti negli slot liberi',
    'Spostare offerte nella pipeline',
  ]);
  assert.deepEqual(SPAZI_AI_SWITCHES.map((entry) => entry.line), [
    'Solo quando nome, recapiti e richiesta coincidono. Negli altri casi ti chiedo.',
    'Le trovi già pronte nel campo di risposta del cliente.',
    'Se è spento, ogni messaggio aspetta il tuo ok.',
    'Solo con chi l\u2019ha chiesto, nel calendario condiviso.',
    'Se è spento, ti propongo lo spostamento.',
  ]);
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const { mount, view: v } = view({
    client: stubClient({ members }),
    spaces: [{ id: SPACE, name: 'Negozio', initials: 'NE' }],
  });
  await v.render();
  await flush();
  const rendered = text(mount);
  assert.match(rendered, /Spazi e accessi/);
  assert.match(rendered, /Spazi di lavoro/);
  assert.ok(
    rendered.includes('Passa da un\u2019attivit\u00E0 all\u2019altra senza uscire. Ogni spazio ha i suoi canali e clienti, e nessuno vede i dati degli altri; il team invece \u00E8 uno solo per tutta l\u2019organizzazione.'),
    'the header paragraph states the honest team scope, not the prototype verbatim',
  );
  assert.ok(
    rendered.includes('Vale per tutto lo spazio Negozio. Quello che \u00E8 spento diventa una proposta da approvare.'),
    'the AI subtitle names the current space and the off-means-proposal rule',
  );
  for (const label of [
    'Unire i contatti duplicati',
    'Scrivere bozze di risposta',
    'Inviare risposte senza approvazione',
    'Fissare appuntamenti negli slot liberi',
    'Spostare offerte nella pipeline',
  ]) {
    const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === label);
    assert.ok(toggle, `switch "${label}" exposes its title as its accessible name`);
    assert.equal(toggle.getAttribute('role'), 'switch', `switch "${label}" keeps the switch role`);
  }
});

test('the spazi screen renders no raw control', async () => {
  // BO-F6-17 acceptance: nessun button/select/input senza le classi del
  // sistema visivo nella schermata. Every control reaches the DOM through
  // the shared `el` library, which normalizes legacy classes onto `ui-*`
  // (the same sweep admin-pipeline.test.js runs for its board).
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const { mount, view: v } = view({ client: stubClient({ members }) });
  await v.render();
  await flush();
  // Open every confirm path too: the flip confirm and the removal confirm
  // add their own buttons and inputs, and they must stay normalized.
  const toggle = mount.findAll('button').find((node) => node.getAttribute('role') === 'switch');
  await toggle.listeners.click[0]();
  await flush();
  const remove = mount.findAll('button').find((node) => node.textContent === 'Rimuovi');
  await remove.listeners.click[0]();
  await flush();
  const raw = [];
  const walk = (node) => {
    const tag = String(node.tagName ?? '').toLowerCase();
    if (['button', 'select', 'input', 'textarea'].includes(tag)) {
      const classes = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
      if (!classes.some((cls) => cls === 'ui' || cls.startsWith('ui-'))) {
        raw.push(`${tag}[${classes.join('.')}]`);
      }
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(mount);
  assert.deepEqual(raw, [], 'every spazi control carries a ui-* system class');
});

test('formatSpaceStat speaks the prototype pattern with real counts, null when unknown', () => {
  // specs/account.md C7: `<n> canali · <m> persone · <k> clienti`, with
  // Italian singulars; any unknown count omits the row instead of inventing.
  assert.equal(formatSpaceStat({ channels: 2, members: 2, customers: 3 }), '2 canali · 2 persone · 3 clienti');
  assert.equal(formatSpaceStat({ channels: 1, members: 1, customers: 1 }), '1 canale · 1 persona · 1 cliente');
  assert.equal(formatSpaceStat({ channels: 0, members: 0, customers: 0 }), '0 canali · 0 persone · 0 clienti');
  assert.equal(formatSpaceStat({ channels: null, members: 2, customers: 3 }), null);
  assert.equal(formatSpaceStat({ channels: 2, members: null, customers: 3 }), null);
  assert.equal(formatSpaceStat({ channels: 2, members: 2, customers: null }), null);
  assert.equal(formatSpaceStat({ channels: Number.NaN, members: 2, customers: 3 }), null);
  assert.equal(formatSpaceStat({ channels: -1, members: 2, customers: 3 }), null);
});

test('countSpaceChannels counts linked channels, countSpaceCustomers needs an exact total', () => {
  assert.equal(countSpaceChannels({ connectors: [
    { connectionKey: 'a', channel: 'whatsapp', status: 'active' },
    { connectionKey: 'b', channel: 'instagram', status: 'suspended' },
    { connectionKey: 'c', channel: 'calendar', status: 'active' },
  ] }), 2);
  // backlog:e381c48581fa: the shared count — two accounts on one channel
  // are one channel, like «2 di 9» on Oggi and Stato sync.
  assert.equal(countSpaceChannels({ connectors: [
    { connectionKey: 'a', channel: 'whatsapp', status: 'active' },
    { connectionKey: 'b', channel: 'whatsapp', status: 'active' },
    { connectionKey: 'c', channel: 'google-calendar', status: 'active' },
  ] }), 2);
  assert.equal(countSpaceChannels({ connectors: [] }), 0);
  assert.equal(countSpaceChannels({}), null);
  assert.equal(countSpaceChannels(null), null);
  assert.equal(countSpaceCustomers({ total: 3, totalIsExact: true }), 3);
  assert.equal(countSpaceCustomers({ total: 3, totalIsExact: false }), null);
  assert.equal(countSpaceCustomers({ items: [] }), null);
  assert.equal(countSpaceCustomers(null), null);
});

test('space cards show the real statistic from the composed reads (BO-F6-17 slice 3)', async () => {
  const members = [
    { subject: 'owner-1', role: 'owner', status: 'active' },
    { subject: 'marco', role: 'operator', status: 'active' },
  ];
  const { mount, view: v } = view({
    client: stubClient({
      members,
      connectorsBySpace: {
        [SPACE]: [
          { connectionKey: 'wa', channel: 'whatsapp', status: 'active' },
          { connectionKey: 'ig', channel: 'instagram', status: 'active' },
        ],
      },
      customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
    }),
  });
  await v.render();
  await flush();
  assert.match(text(mount), /2 canali · 2 persone · 3 clienti/);
});

// Review #782 P1: the raw GET /api/connectors carries no profile link; the
// Google and Meta links live in GET /api/profile. The active space card
// counts them like Oggi's «x di 9»; another space's card never borrows them.
// Backlog:3805161965cd (P1 giro 8 on #848): the profile-Gmail stand-in is
// no channel — without a real channel connection the send fails 409 — so
// the card counts Calendar but never Gmail; Oggi and Stato sync agree.
test('e381c48581fa: the active space card counts the profile Calendar but never the Gmail stand-in, another space does not', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const base = stubClient({
    members,
    connectorsBySpace: { [SPACE]: [], altro: [] },
    customersBySpace: { [SPACE]: { total: 3, totalIsExact: true }, altro: { total: 3, totalIsExact: true } },
  });
  const profile = { connections: { available: true, items: [
    { connector: 'calendar', status: 'connected', account: 'dan@presti.it' },
    { connector: 'gmail', status: 'connected', account: 'dan@presti.it' },
  ] } };
  const client = {
    async request(path, options = {}) {
      if (path === '/api/profile') return profile;
      return base.request(path, options);
    },
  };
  const { mount, view: v } = view({
    client,
    spaces: [{ id: SPACE, name: 'Negozio', initials: 'NE' }, { id: 'altro', name: 'Altro', initials: 'AL' }],
  });
  await v.render();
  await flush();
  const rendered = text(mount);
  assert.match(rendered, /1 canale · 1 persona · 3 clienti/, 'the active space counts Calendar, the Gmail stand-in votes nothing (backlog:3805161965cd)');
  // backlog:9d06eb1e174b: another space is never read, so its card has no
  // statistic at all — never one borrowed from the profile.
  assert.equal((rendered.match(/canal[ie] ·/g) ?? []).length, 1, 'only the open space carries a statistic');
});

// backlog:9d06eb1e174b (verifica 13-14/11): opening Spazi e accessi read
// GET /bo/api/connectors?spaceId=<another space> — 403 for this session —
// and logged console.error «[bo] lettura fallita». The page reads only the
// open space's connectors and customers; nothing refused, nothing in red.
test('9d06eb1e174b: the page never reads another space\'s connectors or customers, and logs no console.error', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const forbidden = Object.assign(new Error('forbidden'), { code: 'BO_SPACE_FORBIDDEN', status: 403 });
  const base = stubClient({
    members,
    connectorsBySpace: { [SPACE]: [] },
    customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
  });
  const asked = [];
  const client = {
    async request(path, options = {}) {
      asked.push(path);
      if (path.includes('spaceId=altro')) throw forbidden;
      return base.request(path, options);
    },
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    const { view: v } = view({
      client,
      spaces: [{ id: SPACE, name: 'Negozio', initials: 'NE' }, { id: 'altro', name: 'Altro', initials: 'AL' }],
    });
    await v.render();
    await flush();
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(asked.filter((path) => path.includes('altro')), [], 'no read for a space that is not open');
  assert.ok(asked.some((path) => path.startsWith(`/api/connectors?spaceId=${SPACE}`)), 'the open space is still read');
  assert.deepEqual(errors.filter((args) => String(args[0]).includes('[bo]')), [], 'no console.error');
});

// Backlog:3805161965cd (supervisore 14/11, P1 giro 8 on #848): with the
// profile Gmail alone, Spazi e accessi read 1 channel while Oggi and Stato
// sync read 0. The three screens share one answer: the Gmail stand-in
// votes Email nowhere — without a real channel connection the send fails
// 409 — and a real active Email row votes once on all three.
test('3805161965cd: profile-only Gmail votes Email on no screen — Spazi, Oggi and Stato sync agree', async () => {
  const { countConnectedNine } = await import('../apps/admin/public/admin-oggi.js');
  const { withProfileConnections } = await import('../apps/admin/public/admin-sync.js');
  const {
    channelConnectionCount,
    isNonCanonicalEmailRow,
    isProfileEmailStandinRow,
  } = await import('../apps/admin/public/admin-channels-count.js');
  const profile = { connections: { available: true, items: [
    { connector: 'gmail', status: 'connected', account: 'op@palestra.it' },
  ] } };
  const syncCountOf = (activity) => {
    const merged = withProfileConnections(activity, profile);
    const rows = merged !== null && typeof merged === 'object' && Array.isArray(merged.connections)
      ? merged.connections
      : [];
    return channelConnectionCount(
      rows.filter((row) => !isProfileEmailStandinRow(row) && !isNonCanonicalEmailRow(row)),
    );
  };
  // Same input everywhere: no rows, profile Gmail connected.
  assert.equal(countSpaceChannels({ connectors: [] }, profile), 0, 'Spazi e accessi: the stand-in is no channel');
  assert.equal(countConnectedNine([], profile), 0, 'Oggi: the stand-in votes no Email');
  const syncAlone = syncCountOf({ connections: [] });
  assert.equal(syncAlone.connected, 0, 'Stato sync: the stand-in votes no Email');
  assert.ok(!syncAlone.connectedChannels.includes('email'), 'Stato sync names no Email among the connected');
  // A real active Email row votes once on all three.
  const real = [{ connectionKey: 'mail-1', channel: 'email', status: 'active' }];
  assert.equal(countSpaceChannels({ connectors: real }, profile), 1, 'Spazi e accessi: a real Email row is one channel');
  assert.equal(countConnectedNine(real, profile), 1, 'Oggi: a real Email row connects Email');
  const syncReal = syncCountOf({ connections: real });
  assert.equal(syncReal.connected, 1, 'Stato sync: a real Email row connects Email');
  assert.ok(syncReal.connectedChannels.includes('email'), 'Stato sync names Email among the connected');
});

test('an unreadable count omits the statistic, never an invented row', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const notFound = Object.assign(new Error('not found'), { code: 'NOT_FOUND', status: 404 });
  const { mount, view: v } = view({ client: stubClient({ members, fail: { connectors: notFound } }) });
  await v.render();
  await flush();
  const rendered = text(mount);
  assert.doesNotMatch(rendered, /canali ·/);
  assert.doesNotMatch(rendered, /NOT_FOUND/);
  assert.match(rendered, /Stai lavorando qui/, 'the card still names the role without its statistic');
});

test('a failed statistic read logs its cause with the space before omitting the row', async () => {
  // backlog:9d06eb1e174b: a missing statistic is a handled state — a warn.
  const logged = [];
  const originalError = console.warn;
  console.warn = (...args) => { logged.push(args); };
  try {
    const down = Object.assign(new Error('down'), { code: 'CHANNELS_DOWN', status: 500 });
    const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
    const { mount, view: v } = view({ client: stubClient({ members, fail: { connectors: down } }) });
    await v.render();
    await flush();
    assert.doesNotMatch(text(mount), /canali ·/, 'no invented row');
    assert.doesNotMatch(text(mount), /CHANNELS_DOWN/, 'no technical code on the page');
    const entry = logged.find((args) => String(args[0]).includes('[bo] lettura fallita'));
    assert.ok(entry, 'the failed read leaves a diagnostic');
    assert.equal(entry[1]?.code, 'CHANNELS_DOWN', 'the log keeps the error code');
    assert.equal(entry[1]?.spaceId, SPACE, 'the log names the space');
  } finally {
    console.warn = originalError;
  }
});

test('an inexact customer total omits the statistic instead of a floor', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const { mount, view: v } = view({
    client: stubClient({
      members,
      connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', channel: 'whatsapp', status: 'active' }] },
      customersBySpace: { [SPACE]: { total: 3, totalIsExact: false } },
    }),
  });
  await v.render();
  await flush();
  assert.doesNotMatch(text(mount), /canali ·/);
});

test('the statistic counts rendered team rows, not raw membership items', async () => {
  // Review follow-up on #419 (P3 :420): a malformed or offboarded row must
  // never leak into the card number. The count equals buildTeamRows().length.
  const members = [
    { subject: 'owner-1', role: 'owner', status: 'active' },
    { subject: '', role: 'operator', status: 'active' },
    { role: 'observer', status: 'active' },
    { subject: 'marco', role: 'operator', status: 'active' },
  ];
  const { mount, view: v } = view({
    client: stubClient({
      members,
      connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', channel: 'whatsapp', status: 'active' }] },
      customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
    }),
  });
  await v.render();
  await flush();
  assert.match(text(mount), /1 canale · 2 persone · 3 clienti/, 'only the two rendered rows count');
});

test('the card statistic qualifies the organization-wide numbers', async () => {
  // Review follow-up on #419 (P3 :452): persone/clienti repeat on every card
  // because they are organization-wide. Visible text keeps the C7 pattern;
  // the title says which numbers are org-wide.
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const { mount, view: v } = view({
    client: stubClient({
      members,
      connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', channel: 'whatsapp', status: 'active' }] },
      customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
    }),
  });
  await v.render();
  await flush();
  const stats = mount.findAll('div')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-spazi-stat'));
  assert.equal(stats.length, 1, 'one statistic row on the single card');
  assert.equal(stats[0].textContent, '1 canale · 1 persona · 3 clienti', 'visible text keeps the C7 pattern');
  assert.match(stats[0].getAttribute('title') ?? '', /organizzazione/, 'the title qualifies the org-wide numbers');
});

test('Apri on another space picks it and goes back to Oggi; the active card never offers Apri', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const spaces = [
    { id: 'spazio-1', name: 'Negozio', initials: 'NE' },
    { id: 'spazio-2', name: 'Palestra', initials: 'PA' },
  ];
  const { mount, seen, view: v } = view({ client: stubClient({ members }), spaces, active: 'spazio-1' });
  await v.render();
  await flush();
  const openers = mount.findAll('button').filter((node) => node.textContent === 'Apri');
  assert.equal(openers.length, 1, 'one Apri: on the non-active card only');
  assert.match(text(mount), /Stai lavorando qui/, 'the active card marks where you work');
  await openers[0].listeners.click[0]();
  await flush();
  assert.deepEqual(seen.picked, ['spazio-2'], 'picking switches to the other space');
  assert.deepEqual(seen.navigated, ['#/'], 'picking goes back to Oggi');
});

test('the dashed new-space box stays last and opens the verbatim C20 menu', async () => {
  // specs/account.md C11 + C20 (fetta 5): riquadro after the cards, menu with
  // the two verbatim voices and subtitles. Picking a voice invents nothing:
  // creation lives in the control plane, the page only says so.
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const calls = [];
  const { mount, seen, view: v } = view({ client: stubClient({ members, calls }) });
  await v.render();
  await flush();
  const grids = mount.findAll('div')
    .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-spazi-grid'));
  assert.equal(grids.length, 1, 'one space grid');
  const cells = Array.from(grids[0].childNodes ?? []).filter((node) => node.tagName);
  assert.ok(cells.length >= 2, 'at least one card plus the dashed box');
  assert.match(cells[cells.length - 1].textContent ?? '', /\+ Nuovo spazio di lavoro/, 'the box stays last');
  const adderToggle = mount.findAll('button').find((node) => node.textContent === '+ Nuovo spazio di lavoro');
  assert.ok(adderToggle, 'the dashed box opens a menu');
  assert.equal(adderToggle.getAttribute('aria-haspopup'), 'true');
  await adderToggle.listeners.click[0]();
  await flush();
  const opened = text(mount);
  assert.ok(opened.includes('Crea con l\u2019AI'), 'C20 AI voice is verbatim');
  assert.ok(opened.includes('Descrivi l\u2019attivit\u00E0, propongo canali e team'), 'C20 AI subtitle is verbatim');
  assert.ok(opened.includes('Compila manualmente'), 'C20 manual voice is verbatim');
  assert.ok(opened.includes('Nome e settore'), 'C20 manual subtitle is verbatim');
  const manual = mount.findAll('button').find((node) => String(node.textContent).startsWith('Compila manualmente'));
  assert.ok(manual, 'the manual voice is a menu item');
  await manual.listeners.click[0]();
  await flush();
  assert.match(text(mount), /control plane/, 'manual is honest: no space is invented here');
  assert.ok(!calls.some((call) => String(call.path).includes('space') && call.method === 'POST'), 'no space creation call exists');
  assert.ok(seen.toast.length >= 0, 'toast channel stays available');
});

test('the invite menu shows the verbatim C21 voices; manual opens the spine form', async () => {
  // specs/account.md C21 (fetta 5): «Invita persona» opens Crea con l'AI /
  // Compila manualmente with verbatim subtitles. Manual reuses the existing
  // inline spine form (the only real write); AI stays honest with a toast.
  const members = [{ subject: 'owner-1', role: 'owner', status: 'active' }];
  const calls = [];
  const { mount, seen, view: v } = view({ client: stubClient({ members, calls }) });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾');
  assert.ok(toggle, 'the team head carries the invite menu toggle');
  await toggle.listeners.click[0]();
  await flush();
  const opened = text(mount);
  assert.ok(opened.includes('Crea con l\u2019AI'), 'C21 AI voice is verbatim');
  assert.ok(opened.includes('Es. \u00ABLuca, vendite, solo Instagram e WhatsApp\u00BB'), 'C21 AI subtitle is verbatim');
  assert.ok(opened.includes('Compila manualmente'), 'C21 manual voice is verbatim');
  assert.ok(opened.includes('Email e ruolo'), 'C21 manual subtitle is verbatim');
  const ai = mount.findAll('button').find((node) => String(node.textContent).includes('Crea con l\u2019AI'));
  assert.ok(ai, 'the AI voice is a menu item');
  await ai.listeners.click[0]();
  await flush();
  assert.ok(seen.toast.some((row) => !row.error && /Compila manualmente/.test(row.message)), 'AI voice stays honest with a toast');
  assert.ok(!calls.some((call) => call.path === '/api/spine/memberships' && call.method === 'POST'), 'AI voice invents no invite');
  const reopen = mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾');
  await reopen.listeners.click[0]();
  await flush();
  const manual = mount.findAll('button').find((node) => String(node.textContent).startsWith('Compila manualmente'));
  await manual.listeners.click[0]();
  await flush();
  const subject = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Identificativo della persona da invitare');
  assert.ok(subject, 'manual opens the existing inline spine form');
});

test('the invite toggle closes the inline form and aria-expanded tracks menu or form', async () => {
  // Review findings on #428 (P2 regression + P2 aria-expanded): reopening the
  // toggle with the manual form open must close the form, and aria-expanded
  // must stay true while either the menu or the form is open.
  const members = [{ subject: 'owner-1', role: 'owner', status: 'active' }];
  const { mount, view: v } = view({ client: stubClient({ members }) });
  await v.render();
  await flush();
  const toggle = () => mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾');
  const formOpen = () => mount.findAll('div').some((node) => {
    const cls = (node.getAttribute('class') ?? '').split(/\s+/);
    return cls.includes('bo-spazi-invite') && cls.includes('open');
  });
  assert.equal(toggle().getAttribute('aria-expanded'), 'false', 'collapsed when menu and form are closed');
  await toggle().listeners.click[0]();
  await flush();
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'expanded while the menu is open');
  const manual = mount.findAll('button').find((node) => String(node.textContent).startsWith('Compila manualmente'));
  await manual.listeners.click[0]();
  await flush();
  assert.ok(formOpen(), 'manual opens the inline form and closes the menu');
  assert.equal(toggle().getAttribute('aria-expanded'), 'true', 'expanded while the form is open with the menu closed');
  await toggle().listeners.click[0]();
  await flush();
  assert.ok(!formOpen(), 'the toggle closes the inline form again');
  assert.equal(toggle().getAttribute('aria-expanded'), 'false', 'collapsed once menu and form are both closed');
});

// backlog:6b44b0e9fcdf — Spazi e accessi like prototype 08: one team row per
// person (prod 07/11 listed «Daniele Pelleri» twice: the adopted broker
// member and the Google one), name over email, and the card foot.

const byClassIn = (mount, tag, cls) => mount.findAll(tag)
  .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes(cls));

test('6b44b0e9fcdf: subjects sharing a mailbox read as one person; a shared name alone never merges', () => {
  const rows = buildTeamRows([
    { subject: 'broker|dan', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'dan@esempio.invalid' },
    { subject: 'google|42', role: 'owner', status: 'active', displayName: 'Daniele Pelleri', email: ' DAN@esempio.invalid ' },
    { subject: 'google|7', role: 'operator', status: 'active', displayName: 'Marco Rossi' },
    { subject: 'google|8', role: 'observer', status: 'active', displayName: 'Marco Rossi' },
  ]);
  assert.equal(rows.length, 3, 'Daniele is one row; the two email-less homonyms stay two people');
  const dan = rows.find((row) => row.name === 'Daniele Pelleri');
  assert.deepEqual(dan.subjects, ['broker|dan', 'google|42'], 'the row keeps every subject, nothing merges server-side');
  assert.deepEqual(dan.removable, ['broker|dan', 'google|42']);
  assert.equal(dan.email, 'dan@esempio.invalid');
  assert.equal(dan.initials, 'DP', 'initials follow the person name');
  assert.equal(dan.role, 'Titolare', 'a person holding two roles shows the stronger one');
  assert.equal(dan.status, 'attivo');
  assert.equal(rows.filter((row) => row.name === 'Marco Rossi').length, 2);
  // Without enrichment the row reads exactly as before.
  const [bare] = buildTeamRows([{ subject: 'marco', role: 'operator', status: 'active' }]);
  assert.equal(bare.name, 'Marco');
  assert.equal(bare.email, null);
  assert.equal(bare.initials, 'MA');
  // A suspended subject is not suspended twice.
  const [half] = buildTeamRows([
    { subject: 'a', role: 'owner', status: 'suspended', displayName: 'Ada', email: 'x@esempio.invalid' },
    { subject: 'b', role: 'owner', status: 'active', displayName: 'Ada', email: 'x@esempio.invalid' },
  ]);
  assert.deepEqual(half.removable, ['b']);
  assert.equal(half.status, 'attivo', 'a person with one live subject is active');
});

test('6b44b0e9fcdf review: a mailbox alone never merges — different or missing names stay separate people', () => {
  const rows = buildTeamRows([
    { subject: 'a', role: 'owner', status: 'active', displayName: 'Anna Bianchi', email: 'info@studio.invalid' },
    { subject: 'b', role: 'operator', status: 'active', displayName: 'Bruno Verdi', email: 'INFO@studio.invalid' },
    { subject: 'c', role: 'observer', status: 'active', email: 'info@studio.invalid' },
    { subject: 'd', role: 'observer', status: 'active', displayName: ' anna  BIANCHI ', email: 'info@studio.invalid' },
  ]);
  assert.equal(rows.length, 3, 'Anna (two subjects), Bruno and the nameless subject');
  const anna = rows.find((row) => row.subjects.includes('a'));
  assert.deepEqual(anna.subjects, ['a', 'd'], 'same mailbox AND same name (trimmed, any case) is one person');
  const bruno = rows.find((row) => row.subjects.includes('b'));
  assert.equal(bruno.name, 'Bruno Verdi', 'a different human on a shared mailbox keeps their own row');
  assert.deepEqual(bruno.removable, ['b'], 'removing Anna never suspends Bruno');
  assert.deepEqual(rows.find((row) => row.subjects.includes('c')).subjects, ['c'], 'a nameless subject is not folded in by mailbox');
});

test('ed0552dc1933: the adopted broker, github and google subjects of one operator are one row, and no @accordo.invalid paints', () => {
  const members = [
    { subject: 'broker|adopted-abc', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+adopted-abc@accordo.invalid', operatorAccountId: 'op-1' },
    { subject: 'broker|github-48571113', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+github-48571113@accordo.invalid', operatorAccountId: 'op-1' },
    { subject: 'google|1049', role: 'owner', status: 'active', displayName: 'Daniele Pelleri', email: 'daniele@esempio.it', operatorAccountId: 'op-1' },
  ];
  const rows = buildTeamRows(members);
  assert.equal(rows.length, 1, 'the same person reads once, not twice');
  const [dan] = rows;
  assert.equal(dan.name, 'Daniele Pelleri', 'the row carries the profile name');
  assert.deepEqual(dan.subjects, ['broker|adopted-abc', 'broker|github-48571113', 'google|1049'], 'the row keeps every subject');
  assert.deepEqual(dan.removable, ['broker|adopted-abc', 'broker|github-48571113', 'google|1049']);
  assert.equal(dan.email, 'daniele@esempio.it', 'the row shows the real mailbox, never the broker one');
  assert.equal(dan.initials, 'DP');
  assert.equal(dan.role, 'Titolare', 'a person holding two roles shows the stronger one');
  assert.ok(!JSON.stringify(dan).includes('accordo.invalid'), 'no internal mailbox survives in the row');
});

test('ed0552dc1933: only broker subjects still read as one profile row with no email line', () => {
  const rows = buildTeamRows([
    { subject: 'broker|github-48571113', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+github-48571113@ACCORDO.INVALID', operatorAccountId: 'op-1' },
    { subject: 'broker|adopted-abc', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+adopted-abc@accordo.invalid', operatorAccountId: 'op-1' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Daniele Pelleri');
  assert.equal(rows[0].email, null, 'an internal mailbox is not a row email, even uppercase');
});

test('ed0552dc1933: two operator keys never merge, even on the same name with internal mailboxes', () => {
  const rows = buildTeamRows([
    { subject: 'broker|github-48571113', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+github-48571113@accordo.invalid', operatorAccountId: 'op-1' },
    { subject: 'broker|adopted-xyz', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+adopted-xyz@accordo.invalid', operatorAccountId: 'op-2' },
  ]);
  assert.equal(rows.length, 2, 'different humans stay two rows');
  assert.ok(rows.every((row) => row.email === null), 'no internal mailbox paints on either row');
  assert.ok(rows.every((row) => row.name === 'Daniele Pelleri'));
});

test('ed0552dc1933 review (Codex P2): two explicit operator keys bridge no group — the shared mailbox does not pull a stranger in', () => {
  const rows = buildTeamRows([
    { subject: 'a', role: 'owner', status: 'active', displayName: 'Anna Bianchi', email: 'squadra@esempio.it', operatorAccountId: 'op-1' },
    { subject: 'b', role: 'operator', status: 'active', displayName: 'Anna Bianchi', email: 'squadra@esempio.it', operatorAccountId: 'op-2' },
    { subject: 'c', role: 'observer', status: 'active', displayName: 'Anna Due', email: 'anna2@esempio.it', operatorAccountId: 'op-2' },
  ]);
  assert.equal(rows.length, 2, 'no single row across the two operator accounts');
  const anna1 = rows.find((row) => row.subjects.includes('a'));
  const anna2 = rows.find((row) => row.subjects.includes('b'));
  assert.deepEqual(anna1.subjects, ['a'], 'the first account keeps its own row');
  assert.deepEqual(anna2.subjects, ['b', 'c'], 'the second account still unites its own subjects');
  assert.deepEqual(anna1.removable, ['a'], 'removing the first row never suspends the stranger');
});

test('ed0552dc1933: the painted team names Daniele once and shows no broker mailbox', async () => {
  const members = [
    { subject: 'broker|adopted-abc', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+adopted-abc@accordo.invalid', operatorAccountId: 'op-1' },
    { subject: 'broker|github-48571113', role: 'operator', status: 'active', displayName: 'Daniele Pelleri', email: 'broker+github-48571113@accordo.invalid', operatorAccountId: 'op-1' },
    { subject: 'google|7', role: 'operator', status: 'active', displayName: 'Marco Ferri', email: 'marco@esempio.invalid' },
  ];
  const { mount, view: v } = view({ client: stubClient({ members, calls: [] }) });
  await v.render();
  await flush();
  const names = byClassIn(mount, 'div', 'bo-spazi-subject').map((node) => node.textContent);
  assert.deepEqual(names, ['Daniele Pelleri', 'Marco Ferri'], 'Daniele appears once');
  assert.ok(!text(mount).includes('accordo.invalid'), 'no internal broker mailbox on screen');
  assert.ok(!text(mount).includes('broker|adopted-abc') && !text(mount).includes('broker|github-48571113'), 'no technical subject on screen');
  assert.match(text(mount), /2 persone/, 'the card statistic counts people, not subjects');
});

test('6b44b0e9fcdf review: the person status is deterministic and reads sospeso only when every subject is suspended', () => {
  const person = (statuses) => buildTeamRows(statuses.map((status, index) => ({
    subject: `s${index}`, role: 'operator', status, displayName: 'Ada Neri', email: 'ada@esempio.invalid',
  })));
  assert.equal(person(['suspended', 'invited'])[0].status, 'invitato');
  assert.equal(person(['invited', 'suspended'])[0].status, 'invitato', 'the store order does not change the row');
  assert.equal(person(['pending', 'invited'])[0].status, 'invitato');
  assert.equal(person(['suspended', 'active', 'invited'])[0].status, 'attivo');
  assert.equal(person(['suspended', 'suspended'])[0].status, 'sospeso');
});

test('6b44b0e9fcdf review: a refused subject does not stop the others, the outcome is told and Riprova asks only for the refused one', async () => {
  const members = [
    { subject: 'broker|dan', role: 'owner', status: 'active', displayName: 'Daniele Pelleri', email: 'dan@esempio.invalid' },
    { subject: 'google|42', role: 'owner', status: 'active', displayName: 'Daniele Pelleri', email: 'dan@esempio.invalid' },
    { subject: 'google|7', role: 'operator', status: 'active', displayName: 'Marco Ferri', email: 'marco@esempio.invalid' },
  ];
  const calls = [];
  const fail = { suspend: { 'broker|dan': Object.assign(new Error('ultimo amministratore'), { code: 'SPINE_LAST_ADMIN', status: 403 }) } };
  const { mount, seen, view: v } = view({ client: stubClient({ members, calls, fail }) });
  await v.render();
  await flush();
  const remove = mount.findAll('button').find((node) => node.textContent === 'Rimuovi' && node.parentNode?.textContent?.includes('Daniele Pelleri'));
  await remove.listeners.click[0]();
  await flush();
  const reason = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo della rimozione di Daniele Pelleri');
  reason.value = 'doppio account';
  await mount.findAll('button').find((node) => node.textContent === 'Conferma rimozione').listeners.click[0]();
  await flush(30);
  const suspendPaths = () => calls.filter((call) => call.path.endsWith('/suspend')).map((call) => call.path);
  assert.deepEqual(suspendPaths(), [
    `/api/spine/memberships/${encodeURIComponent('broker|dan')}/suspend`,
    `/api/spine/memberships/${encodeURIComponent('google|42')}/suspend`,
  ], 'the first refusal does not stop the second subject');
  assert.ok(!seen.toast.some((row) => row.error), 'one message: no toast beside the row (7d30fb517785)');
  assert.match(text(mount), /account sospesi 1 su 2, rifiutati 1/, 'the partial outcome is counted next to the row, not hidden behind a generic failure');
  assert.ok(!text(mount).includes('broker|dan') && !text(mount).includes('google|42'), 'no technical subject on screen');
  const retry = mount.findAll('button').find((node) => node.textContent === 'Riprova');
  assert.ok(retry, 'the row stays open with Riprova');
  const kept = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo della rimozione di Daniele Pelleri');
  assert.equal(kept.value, 'doppio account', 'the motive is kept for the retry');

  delete fail.suspend['broker|dan'];
  await retry.listeners.click[0]();
  await flush(30);
  assert.deepEqual(suspendPaths().slice(2), [
    `/api/spine/memberships/${encodeURIComponent('broker|dan')}/suspend`,
  ], 'Riprova suspends only the refused subject');
  assert.equal(seen.toast.at(-1).message, 'Daniele Pelleri rimosso dal team.');
  assert.ok(!mount.findAll('button').some((node) => node.textContent === 'Riprova'), 'a full success closes the retry');
});

test('6b44b0e9fcdf: the team paints one row per person with name over email, and removal suspends each subject', async () => {
  const members = [
    { subject: 'broker|dan', role: 'owner', status: 'active', displayName: 'Daniele Pelleri', email: 'dan@esempio.invalid' },
    { subject: 'google|42', role: 'owner', status: 'active', displayName: 'Daniele Pelleri', email: 'dan@esempio.invalid' },
    { subject: 'google|7', role: 'operator', status: 'active', displayName: 'Marco Ferri', email: 'marco@esempio.invalid' },
  ];
  const calls = [];
  const { mount, view: v } = view({ client: stubClient({ members, calls }) });
  await v.render();
  await flush();
  const names = byClassIn(mount, 'div', 'bo-spazi-subject').map((node) => node.textContent);
  assert.deepEqual(names, ['Daniele Pelleri', 'Marco Ferri'], 'Daniele appears once');
  assert.ok(!text(mount).includes('broker|dan') && !text(mount).includes('google|42'), 'no technical subject on screen');
  const emails = byClassIn(mount, 'div', 'bo-spazi-email');
  assert.deepEqual(emails.map((node) => node.textContent), ['dan@esempio.invalid', 'marco@esempio.invalid']);
  assert.equal(emails[0].getAttribute('title'), 'dan@esempio.invalid', 'the full address survives the ellipsis');
  assert.match(text(mount), /2 persone/, 'the card statistic counts people, not subjects');

  const remove = mount.findAll('button').find((node) => node.textContent === 'Rimuovi' && node.parentNode?.textContent?.includes('Daniele Pelleri'));
  await remove.listeners.click[0]();
  await flush();
  assert.match(text(mount), /Rimuovere Daniele Pelleri dal team\?/);
  const reason = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo della rimozione di Daniele Pelleri');
  reason.value = 'prova';
  await mount.findAll('button').find((node) => node.textContent === 'Conferma rimozione').listeners.click[0]();
  await flush(30);
  const suspended = calls.filter((call) => call.path.endsWith('/suspend')).map((call) => call.path);
  assert.deepEqual(suspended, [
    `/api/spine/memberships/${encodeURIComponent('broker|dan')}/suspend`,
    `/api/spine/memberships/${encodeURIComponent('google|42')}/suspend`,
  ], 'each subject of the person is suspended through the spine route');
});

test('6b44b0e9fcdf: the card foot pairs Tu: <ruolo> with the badge or Apri; a description shows only when the space carries one', async () => {
  const spaces = [
    { id: 'spazio-1', name: 'Negozio', initials: 'NE', description: 'Abbigliamento · Torino' },
    { id: 'spazio-2', name: 'Palestra', initials: 'PA' },
  ];
  const { mount, view: v } = view({ client: stubClient({ members: [{ subject: 'marco', role: 'operator', status: 'active' }] }), spaces, active: 'spazio-1' });
  await v.render();
  await flush();
  const feet = byClassIn(mount, 'div', 'bo-spazi-foot');
  assert.equal(feet.length, 2, 'one foot per space card');
  assert.equal(feet[0].textContent, 'Tu: TitolareStai lavorando qui');
  assert.equal(feet[1].textContent, 'Tu: TitolareApri');
  const open = feet[1].findAll('button')[0];
  assert.ok((open.getAttribute('class') ?? '').split(/\s+/).includes('ui-btn-primary'), 'Apri is the system primary button');
  const descriptions = byClassIn(mount, 'div', 'bo-spazi-desc').map((node) => node.textContent);
  assert.deepEqual(descriptions, ['Abbigliamento · Torino'], 'no description is invented for the space without one');
  const cards = byClassIn(mount, 'div', 'bo-spazi-card');
  assert.ok((cards.at(-1).getAttribute('class') ?? '').includes('bo-spazi-adder'), 'the dashed adder stays last');
});

// backlog:7d30fb517785 (production 10/11, Spazi e accessi): a 503
// OPERATION_APP_UNAVAILABLE on the AI switch printed «Connessione non
// riuscita, riprova.» twice — once under the invite form, which opened by
// itself — and the text was false: the server answered. One true message,
// under the switch that failed; the invite form stays closed.
test('7d30fb517785: a 5xx on a switch shows one true message under that switch, the invite form stays closed', async () => {
  const inner = stubClient();
  const client = {
    async request(path, options = {}) {
      if (path === '/api/space-permissions/set-permission') {
        throw Object.assign(new Error('Operation app unavailable'), { status: 503, code: 'OPERATION_APP_UNAVAILABLE' });
      }
      return inner.request(path, options);
    },
  };
  const { mount, seen, view: v } = view({ client });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Scrivere bozze di risposta');
  await toggle.listeners.click[0]();
  await flush();
  await mount.findAll('button').find((node) => node.textContent === 'Conferma').listeners.click[0]();
  await flush(20);

  const refusals = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-spazi-refusal');
  assert.equal(refusals.length, 1, `one message, not ${refusals.length}`);
  assert.equal(refusals[0].textContent, 'Non riesco a salvare la modifica adesso, riprova tra poco.');
  assert.ok(!text(mount).includes('Connessione non riuscita'), 'the server answered: never a connection fault');
  assert.ok(!seen.toast.some((row) => row.error), 'no toast beside it');
  // Next to the control that failed: right after that switch's row.
  const switches = mount.findAll('div').find((node) => node.getAttribute('class') === 'bo-spazi-switches');
  const kids = switches.childNodes;
  const at = kids.indexOf(refusals[0]);
  assert.ok(at > 0, 'the message sits in the switch list');
  const before = kids[at - 1];
  assert.ok(before.findAll('button').some((node) => node.getAttribute('aria-label') === 'Scrivere bozze di risposta'), 'right under the switch that failed');
  const invite = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-spazi-invite'));
  assert.ok(invite, 'the invite form is there');
  assert.ok(!(invite.getAttribute('class') ?? '').split(/\s+/).includes('open'), 'the invite form does not open by itself');
  assert.ok(!invite.textContent.includes('riprova'), 'nothing of the switch failure under Invita');
});

// backlog:7d30fb517785: a refused invite keeps its message inside the form,
// never under the switches; a lost answer (no status) is the only
// «Connessione non riuscita».
test('7d30fb517785: a refused invite shows its message once, inside the invite form', async () => {
  const inner = stubClient();
  const client = {
    async request(path, options = {}) {
      if (path === '/api/spine/memberships' && String(options?.method ?? 'GET').toUpperCase() === 'POST') {
        throw new TypeError('Failed to fetch');
      }
      return inner.request(path, options);
    },
  };
  const { mount, seen, view: v } = view({ client });
  await v.render();
  await flush();
  await mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾').listeners.click[0]();
  await flush();
  await mount.findAll('button').find((node) => node.textContent.includes('Compila manualmente')).listeners.click[0]();
  await flush();
  mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Identificativo della persona da invitare').value = 'luca@example.test';
  mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo dell\u2019invito').value = 'nuovo collega';
  await mount.findAll('button').find((node) => node.textContent === 'Invita').listeners.click[0]();
  await flush(20);
  const refusals = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-spazi-refusal');
  assert.equal(refusals.length, 1, `one message, not ${refusals.length}`);
  assert.equal(refusals[0].textContent, 'Connessione non riuscita, riprova.', 'no answer at all: the connection text is true here');
  const invite = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-spazi-invite'));
  assert.ok(invite.findAll('p').includes(refusals[0]), 'inside the invite form');
  assert.ok((invite.getAttribute('class') ?? '').split(/\s+/).includes('open'), 'the form stays open for the retry');
  assert.ok(!seen.toast.some((row) => row.error), 'no toast beside it');
});

// Review #746 (P1): when the reload after a refused write fails too, the
// inline message has nowhere to go — it falls back to one toast with the
// same text. Always exactly one visible message, never none, never two.
test('7d30fb517785: a refused switch whose reload fails too still shows exactly one message, as a toast', async () => {
  const inner = stubClient();
  let refused = false;
  const client = {
    async request(path, options = {}) {
      if (path === '/api/space-permissions/set-permission') {
        refused = true;
        throw Object.assign(new Error('Operation app unavailable'), { status: 503, code: 'OPERATION_APP_UNAVAILABLE' });
      }
      if (refused && path.startsWith('/api/space-permissions/effective')) {
        throw Object.assign(new Error('Operation app unavailable'), { status: 503, code: 'OPERATION_APP_UNAVAILABLE' });
      }
      return inner.request(path, options);
    },
  };
  const { mount, seen, view: v } = view({ client });
  await v.render();
  await flush();
  await mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Scrivere bozze di risposta').listeners.click[0]();
  await flush();
  await mount.findAll('button').find((node) => node.textContent === 'Conferma').listeners.click[0]();
  await flush(20);
  const inline = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-spazi-refusal');
  const toasts = seen.toast.filter((row) => row.error);
  assert.equal(inline.length + toasts.length, 1, `exactly one visible message, not ${inline.length} inline + ${toasts.length} toast`);
  assert.equal(toasts[0]?.message, 'Non riesco a salvare la modifica adesso, riprova tra poco.', 'the switch failure survives the failed reload');
});

test('7d30fb517785: a refused invite whose reload fails too still shows exactly one message, as a toast', async () => {
  const inner = stubClient();
  let refused = false;
  const client = {
    async request(path, options = {}) {
      if (path === '/api/spine/memberships') {
        if (String(options?.method ?? 'GET').toUpperCase() === 'POST') {
          refused = true;
          throw Object.assign(new Error('Operation app unavailable'), { status: 503, code: 'OPERATION_APP_UNAVAILABLE' });
        }
        if (refused) throw Object.assign(new Error('Operation app unavailable'), { status: 503, code: 'OPERATION_APP_UNAVAILABLE' });
      }
      return inner.request(path, options);
    },
  };
  const { mount, seen, view: v } = view({ client });
  await v.render();
  await flush();
  await mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾').listeners.click[0]();
  await flush();
  await mount.findAll('button').find((node) => node.textContent.includes('Compila manualmente')).listeners.click[0]();
  await flush();
  mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Identificativo della persona da invitare').value = 'luca@example.test';
  mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo dell\u2019invito').value = 'nuovo collega';
  await mount.findAll('button').find((node) => node.textContent === 'Invita').listeners.click[0]();
  await flush(20);
  const inline = mount.findAll('p').filter((node) => node.getAttribute('class') === 'bo-spazi-refusal');
  const toasts = seen.toast.filter((row) => row.error);
  assert.equal(inline.length + toasts.length, 1, `exactly one visible message, not ${inline.length} inline + ${toasts.length} toast`);
  assert.equal(toasts[0]?.message, 'Non riesco a salvare la modifica adesso, riprova tra poco.');
});

// backlog:dd570f6d501e — the «+ Nuovo spazio di lavoro» menu (C11/C20)
// closes with Escape and with an outside click, and focus returns to the
// button. Same contract as the Nuova sequenza menu, scoped to this view.
const newSpaceToggle = (mount) => mount.findAll('button')
  .find((node) => node.textContent === '+ Nuovo spazio di lavoro');
const newSpaceMenus = (mount) => mount.findAll('div')
  .filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('ui-add-menu'));

test('dd570f6d501e: Escape in the new-space menu closes it and focus returns to the button', async () => {
  const { mount, view: v } = view({});
  await v.render();
  await flush();
  await newSpaceToggle(mount).listeners.click[0]();
  await flush();
  assert.equal(newSpaceMenus(mount).length, 1, 'click opens the menu');
  newSpaceMenus(mount)[0].dispatch('keydown', { key: 'Escape' });
  await flush();
  assert.equal(newSpaceMenus(mount).length, 0, 'Escape closes the menu');
  assert.equal(newSpaceToggle(mount).getAttribute('aria-expanded'), 'false', 'the button reads collapsed');
  assert.equal(newSpaceToggle(mount).__focused, true, 'focus returns to the button');
});

test('dd570f6d501e: Escape on the new-space button closes the menu too', async () => {
  const { mount, view: v } = view({});
  await v.render();
  await flush();
  await newSpaceToggle(mount).listeners.click[0]();
  await flush();
  assert.equal(newSpaceMenus(mount).length, 1, 'click opens the menu');
  newSpaceToggle(mount).dispatch('keydown', { key: 'Escape' });
  await flush();
  assert.equal(newSpaceMenus(mount).length, 0, 'Escape on the button closes the menu');
  assert.equal(newSpaceToggle(mount).__focused, true, 'focus stays on the button');
});

test('dd570f6d501e: an outside click closes the new-space menu without stealing focus', async () => {
  const docClicks = [];
  const doc = {
    ...createFakeDocument(),
    addEventListener: (type, handler) => {
      if (type === 'click') docClicks.push(handler);
    },
  };
  const { mount, view: v } = view({ doc });
  await v.render();
  await flush();
  await newSpaceToggle(mount).listeners.click[0]();
  await flush();
  assert.equal(newSpaceMenus(mount).length, 1, 'click opens the menu');
  for (const handler of docClicks) handler({ target: mount });
  await flush();
  assert.equal(newSpaceMenus(mount).length, 0, 'an outside click closes the menu');
  assert.notEqual(newSpaceToggle(mount).__focused, true, 'an outside click leaves focus where the user put it');
});

test('dd570f6d501e: the opening click stops propagation so the document closer never sees it', async () => {
  const docClicks = [];
  const doc = {
    ...createFakeDocument(),
    addEventListener: (type, handler) => {
      if (type === 'click') docClicks.push(handler);
    },
  };
  const { mount, view: v } = view({ doc });
  await v.render();
  await flush();
  // A real browser bubbles the opening click to the document after the
  // toggle handler repainted: the toggle stops it, so the outside closer
  // (which would shut anything outside the tracked menu wrap) never fires
  // for the click that just opened the menu.
  let stopped = 0;
  await newSpaceToggle(mount).listeners.click[0]({ target: newSpaceToggle(mount), stopPropagation: () => { stopped += 1; } });
  await flush();
  assert.equal(newSpaceMenus(mount).length, 1, 'click opens the menu');
  assert.equal(stopped, 1, 'the opening click stops propagation');
  await newSpaceToggle(mount).listeners.click[0]({ target: newSpaceToggle(mount), stopPropagation: () => {} });
  await flush();
  assert.equal(newSpaceMenus(mount).length, 0, 'clicking the toggle again closes the menu');
  assert.equal(newSpaceToggle(mount).__focused, true, 'closing from the toggle keeps focus on it');
});

test('dd570f6d501e: a document-level Escape closes the menu when focus left the button', async () => {
  const docHandlers = [];
  const doc = {
    ...createFakeDocument(),
    addEventListener: (type, handler) => {
      docHandlers.push({ type, handler });
    },
  };
  const { mount, view: v } = view({ doc });
  await v.render();
  await flush();
  await newSpaceToggle(mount).listeners.click[0]();
  await flush();
  assert.equal(newSpaceMenus(mount).length, 1, 'click opens the menu');
  for (const { type, handler } of docHandlers) {
    if (type === 'keydown') handler({ key: 'Escape', target: mount });
  }
  await flush();
  assert.equal(newSpaceMenus(mount).length, 0, 'a document-level Escape closes the menu');
  assert.equal(newSpaceToggle(mount).__focused, true, 'a document-level Escape returns focus to the button');
});

test('dd570f6d501e: picking a voice closes the menu and focus returns to the button', async () => {
  const { mount, view: v } = view({ client: stubClient({ members: [] }) });
  await v.render();
  await flush();
  await newSpaceToggle(mount).listeners.click[0]();
  await flush();
  const manual = mount.findAll('button').find((node) => String(node.textContent).startsWith('Compila manualmente'));
  assert.ok(manual, 'the manual voice is a menu item');
  await manual.listeners.click[0]();
  await flush();
  assert.equal(newSpaceMenus(mount).length, 0, 'picking a voice closes the menu');
  assert.match(text(mount), /control plane/, 'manual stays honest: no space is invented here');
  assert.equal(newSpaceToggle(mount).__focused, true, 'focus returns to the button');
});

test('backlog:76ded4e3: the two menus never stay open together, Escape and a click outside close them', async () => {
  // Second return of 6b44b0e9fcdf (supervisor 2026-11-07.md:58): «+ Nuovo
  // spazio di lavoro» closed nothing (no Escape, no outside click) and both
  // menus could sit open at once. The menus share the clienti and
  // personalizzazione contract: opening one closes the other, Escape
  // closes, a click outside closes.
  const doc = createFakeDocument();
  // The dependency-free fake document carries no listeners: give this one
  // the listener surface a real document has, so the test exercises the
  // view's own outside-click wiring instead of a copy of it.
  const docListeners = Object.create(null);
  doc.addEventListener = (type, handler) => { (docListeners[type] ??= []).push(handler); };
  const fireDoc = (type, event) => { for (const handler of docListeners[type] ?? []) handler(event); };
  const mount = createMount();
  const seen = { toast: [], picked: [], navigated: [] };
  const spaces = [{ id: SPACE, name: 'Negozio', initials: 'NE' }];
  const v = createSpaziAccessiView({
    doc,
    mount,
    client: stubClient({ members: [{ subject: 'owner-1', role: 'owner', status: 'active' }] }),
    navigate: (hash) => seen.navigated.push(hash),
    spaces: () => spaces,
    activeSpaceId: () => SPACE,
    onPickSpace: (id) => seen.picked.push(id),
    toast: (message, error = false) => seen.toast.push({ message, error }),
  });
  await v.render();
  await flush();
  const newSpaceToggle = () => mount.findAll('button').find((node) => node.textContent === '+ Nuovo spazio di lavoro');
  const inviteToggle = () => mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾');
  const newSpaceMenu = () => mount.querySelector('div[aria-label="Nuovo spazio di lavoro"]');
  const inviteMenu = () => mount.querySelector('div[aria-label="Invita persona"]');
  assert.ok(newSpaceToggle() && inviteToggle(), 'both menu toggles render');

  await newSpaceToggle().listeners.click[0]();
  await flush();
  assert.ok(newSpaceMenu(), 'the new-space menu opens');
  await inviteToggle().listeners.click[0]();
  await flush();
  assert.ok(inviteMenu(), 'the invite menu opens');
  assert.equal(newSpaceMenu(), null, 'opening Invita persona closes + Nuovo spazio: never two menus open');
  await newSpaceToggle().listeners.click[0]();
  await flush();
  assert.ok(newSpaceMenu(), 'the new-space menu reopens');
  assert.equal(inviteMenu(), null, 'opening + Nuovo spazio closes Invita persona: never two menus open');

  // Codex P2 on #763: after render() the focused toggle is gone, so in a
  // real browser focus sits on the body and Escape only reaches the
  // document. The view listens for Escape at document level; this dispatch
  // proves the document path, not a node-local handler.
  fireDoc('keydown', { key: 'Escape' });
  await flush();
  assert.equal(newSpaceMenu(), null, 'Escape closes the new-space menu');
  assert.equal(newSpaceToggle().getAttribute('aria-expanded'), 'false', 'the toggle names the closed menu');
  await inviteToggle().listeners.click[0]();
  await flush();
  assert.ok(inviteMenu(), 'the invite menu opens again');
  fireDoc('keydown', { key: 'Escape' });
  await flush();
  assert.equal(inviteMenu(), null, 'Escape at document level closes the invite menu');

  await newSpaceToggle().listeners.click[0]();
  await flush();
  assert.ok(newSpaceMenu(), 'the new-space menu opens a third time');
  fireDoc('click', { target: newSpaceMenu() });
  await flush();
  assert.ok(newSpaceMenu(), 'a click inside the menu keeps it open');
  fireDoc('click', { target: mount });
  await flush();
  assert.equal(newSpaceMenu(), null, 'a click outside closes the new-space menu');
  assert.equal(inviteMenu(), null, 'a click outside leaves no menu open');
});

test('the two menus open as popovers without moving the content below', async () => {
  // Like the clienti and personalizzazione add menus: each menu is absolute
  // on a relative anchor, so opening one paints over the page instead of
  // pushing the grid, the team list or the panels below. The flow shape —
  // every node but the popover itself, in order — is the same closed and
  // open: the same position before and after.
  const doc = createFakeDocument();
  const mount = createMount();
  const spaces = [{ id: SPACE, name: 'Negozio', initials: 'NE' }];
  const v = createSpaziAccessiView({
    doc,
    mount,
    client: stubClient({ members: [{ subject: 'owner-1', role: 'owner', status: 'active' }] }),
    navigate: () => {},
    spaces: () => spaces,
    activeSpaceId: () => SPACE,
    onPickSpace: () => {},
    toast: () => {},
  });
  await v.render();
  await flush();
  const shapeOf = () => {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        const isMenu = child.getAttribute?.('role') === 'menu'
          && (child.getAttribute?.('aria-label') === 'Nuovo spazio di lavoro'
            || child.getAttribute?.('aria-label') === 'Invita persona');
        if (isMenu) continue;
        out.push(`${child.tagName}.${child.getAttribute?.('class') ?? ''}`);
        walk(child);
      }
    };
    walk(mount);
    return out;
  };
  const anchorOf = (menu) => {
    let node = menu.parentNode ?? null;
    while (node) {
      if (/position:\s*relative/.test(node.getAttribute?.('style') ?? '')) return node;
      node = node.parentNode ?? null;
    }
    return null;
  };
  const newSpaceToggle = () => mount.findAll('button').find((node) => node.textContent === '+ Nuovo spazio di lavoro');
  const inviteToggle = () => mount.findAll('button').find((node) => node.textContent === 'Invita persona ▾');
  const newSpaceMenu = () => mount.querySelector('div[aria-label="Nuovo spazio di lavoro"]');
  const inviteMenu = () => mount.querySelector('div[aria-label="Invita persona"]');

  const closed = shapeOf();
  await newSpaceToggle().listeners.click[0]({ stopPropagation: () => {} });
  await flush();
  assert.ok(newSpaceMenu(), 'the new-space menu opens');
  assert.match(newSpaceMenu().getAttribute('style') ?? '', /position:\s*absolute/, 'the new-space menu is out of flow');
  assert.ok(anchorOf(newSpaceMenu()), 'the new-space menu hangs off a relative anchor');
  assert.deepEqual(shapeOf(), closed, 'opening + Nuovo spazio leaves every content node where it was');

  await newSpaceToggle().listeners.click[0]({ stopPropagation: () => {} });
  await flush();
  await inviteToggle().listeners.click[0]({ stopPropagation: () => {} });
  await flush();
  assert.ok(inviteMenu(), 'the invite menu opens');
  assert.match(inviteMenu().getAttribute('style') ?? '', /position:\s*absolute/, 'the invite menu is out of flow');
  assert.ok(anchorOf(inviteMenu()), 'the invite menu hangs off a relative anchor');
  assert.deepEqual(shapeOf(), closed, 'opening Invita persona leaves every content node where it was');
});
// backlog:67e14a50efb6 (2° ritorno, supervisor 2026-11-07.md:58 NON PASSA
// C13/C14): ogni riga del team mostra lo stato del calendario e le tessere
// dei canali. Prima il rosso: sul codice di prima le righe non portano né
// l'uno né le altre.
test('67e14a50efb6: every team row names the shared calendar state and carries the channel tiles', async () => {
  const members = [
    { subject: 'owner-1', role: 'owner', status: 'active' },
    { subject: 'marco', role: 'operator', status: 'active' },
  ];
  const { mount, view: v } = view({
    client: stubClient({
      members,
      connectorsBySpace: {
        [SPACE]: [
          { connectionKey: 'cal-1', channel: 'calendar', account: 'studio@example.test', status: 'active' },
          { connectionKey: 'wa-1', channel: 'whatsapp', account: '+39 02 1234567', status: 'active' },
          { connectionKey: 'ig-1', channel: 'instagram', account: 'studio.esempio', status: 'active' },
        ],
      },
    }),
  });
  await v.render();
  await flush();
  const rows = byClassIn(mount, 'div', 'bo-spazi-member');
  assert.equal(rows.length, 2, 'two rendered team rows');
  for (const row of rows) {
    assert.match(row.textContent ?? '', /Calendario condiviso: collegato/, 'each row names the shared calendar state');
    const tiles = row.findAll('span').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('ui-chip'));
    assert.deepEqual(tiles.map((node) => node.textContent).sort(), ['IG', 'WA'], 'each row carries the active channel tiles, never the calendar');
  }
});

test('67e14a50efb6: teamCalendarState reads only the calendar entries, fail-closed', () => {
  assert.equal(teamCalendarState([
    { connectionKey: 'cal-1', channel: 'calendar', status: 'active' },
    { connectionKey: 'wa-1', channel: 'whatsapp', status: 'suspended' },
  ]), 'Calendario condiviso: collegato');
  assert.equal(teamCalendarState([
    { connectionKey: 'cal-1', channel: 'calendar', status: 'suspended' },
  ]), 'Calendario condiviso: scollegato');
  assert.equal(teamCalendarState([
    { connectionKey: 'cal-1', channel: 'calendar', status: 'pending' },
  ]), 'Calendario condiviso: da collegare');
  assert.equal(teamCalendarState([
    { connectionKey: 'wa-1', channel: 'whatsapp', status: 'active' },
  ]), 'Calendario condiviso: da collegare');
  assert.equal(teamCalendarState([]), 'Calendario condiviso: da collegare');
  assert.equal(teamCalendarState(null), null, 'unreadable connectors invent no calendar line');
  assert.equal(teamCalendarState({}), null);
});

test('67e14a50efb6: teamChannelTiles lists one tile per active channel, never the calendar', () => {
  assert.deepEqual(teamChannelTiles([
    { connectionKey: 'wa-1', channel: 'whatsapp', status: 'active' },
    { connectionKey: 'wa-2', channel: 'whatsapp', status: 'active' },
    { connectionKey: 'ig-1', channel: 'instagram', status: 'active' },
    { connectionKey: 'cal-1', channel: 'calendar', status: 'active' },
    { connectionKey: 'old-1', channel: 'instagram', status: 'revoked' },
    { connectionKey: 'no-channel', status: 'active' },
  ]), [
    { channel: 'instagram', tile: 'IG', tint: 'ui-chip-ig', label: 'Instagram' },
    { channel: 'whatsapp', tile: 'WA', tint: 'ui-chip-wa', label: 'WhatsApp' },
  ]);
  assert.deepEqual(teamChannelTiles([]), []);
  assert.deepEqual(teamChannelTiles(null), [], 'unreadable connectors tile nothing');
  const [unknown] = teamChannelTiles([{ connectionKey: 'x-1', channel: 'carrier-pigeon', status: 'active' }]);
  assert.equal(unknown.tile, '?', 'an unknown channel never invents a tile');
});

test('67e14a50efb6: unreadable connectors read honestly on every row, never silently bare', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const notFound = Object.assign(new Error('not found'), { code: 'NOT_FOUND', status: 404 });
  const { mount, view: v } = view({ client: stubClient({ members, fail: { connectors: notFound } }) });
  await v.render();
  await flush();
  const rows = byClassIn(mount, 'div', 'bo-spazi-member');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent ?? '', /non sono attivi in questo spazio/, 'each row says the channels are not active here');
  assert.doesNotMatch(rows[0].textContent ?? '', /NOT_FOUND/, 'no technical code on the page');
  assert.equal(rows[0].findAll('span').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('ui-chip')).length, 0, 'no invented tiles');
});

test('67e14a50efb6 Codex P2 on #756: a failed customer count keeps the team calendar and channel tiles', async () => {
  // Repro: /api/connectors ok (active calendar + WA) but
  // /api/customer-data/customers 404 — the shared Promise.all discarded the
  // good connectors and every row read «non sono attivi». Red before, green
  // after: the rows keep the indicators, only the card statistic is omitted.
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const missing = Object.assign(new Error('no listCustomers'), { code: 'NOT_FOUND', status: 404 });
  const { mount, view: v } = view({
    client: stubClient({
      members,
      fail: { customers: missing },
      connectorsBySpace: {
        [SPACE]: [
          { connectionKey: 'cal-1', channel: 'calendar', status: 'active' },
          { connectionKey: 'wa-1', channel: 'whatsapp', status: 'active' },
        ],
      },
    }),
  });
  await v.render();
  await flush();
  const rows = byClassIn(mount, 'div', 'bo-spazi-member');
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent ?? '', /Calendario condiviso: collegato/, 'the row keeps the calendar state');
  assert.deepEqual(rows[0].findAll('span').filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('ui-chip')).map((node) => node.textContent), ['WA'], 'the row keeps the active channel tile');
  assert.doesNotMatch(text(mount), /canali ·/, 'only the card statistic is omitted');
});

// backlog:9d06eb1e174b (verifica 13-14/11): the space cards read «Tu: ruolo
// non riconosciuto» for the 2-7 s of the context read, then «Tu: Titolare».
// While the role is not known the card shows a skeleton.
test('9d06eb1e174b: the card role is a skeleton while the context read is out, then the role', async () => {
  let release;
  const contextGate = new Promise((resolve) => { release = resolve; });
  const base = stubClient({ members: [{ subject: 'marco', role: 'operator', status: 'active' }] });
  const client = {
    async request(path, options = {}) {
      if (path === '/api/spine/context') {
        await contextGate;
      }
      return base.request(path, options);
    },
  };
  const { mount, view: v } = view({ client });
  const done = v.render();
  await flush();
  assert.doesNotMatch(text(mount), /ruolo non riconosciuto/, 'never «non riconosciuto» while the read is out');
  const you = mount.findAll('span').find((node) => String(node.getAttribute('class') ?? '').includes('bo-spazi-you'));
  assert.equal(you?.getAttribute('aria-busy'), 'true', 'the role reads as loading');
  release();
  await done;
  await flush();
  assert.match(text(mount), /Tu: Titolare/);
});

test('9d06eb1e174b: a failed context read still says the role is not recognized', async () => {
  const failed = Object.assign(new Error('down'), { code: 'SPINE_DOWN', status: 500 });
  const { mount, view: v } = view({ client: stubClient({ fail: { context: failed } }) });
  await v.render();
  await flush();
  assert.match(text(mount), /ruolo non riconosciuto/);
});

// backlog:9d06eb1e174b (verifica 13-14/11, roster di produzione): one owner
// listed three times — the verified Google login (real mailbox, person
// key), the pilot's adopted broker member (same name, internal mailbox
// only) and the GitHub login — all with «Rimuovi», on their own account too.
const ROSTER_SELF = [
  { subject: 'broker+adopted-aa11@accordo.invalid', role: 'owner', status: 'active', displayName: 'Dario Esempio', email: 'broker+adopted-aa11@accordo.invalid' },
  { subject: 'github|1001', role: 'owner', status: 'active', displayName: 'dario-gh', email: 'broker+github-1001@accordo.invalid' },
  { subject: 'google|2002', role: 'owner', status: 'active', displayName: 'dario esempio', email: 'dario@esempio.invalid', operatorAccountId: 'acc-1' },
  { subject: 'google|3003', role: 'operator', status: 'active', displayName: 'Marta Esempio', email: 'marta@esempio.invalid', operatorAccountId: 'acc-2' },
];

// Review Muse #897 P1: a name is never a proof of identity, not even the
// session's own. A same-named subject with no mailbox and no person key
// stays a row of its own, with its «Rimuovi», told apart by its access kind.
test('9d06eb1e174b: a same-named subject without a mailbox stays its own row, with its access kind and «Rimuovi»', () => {
  const rows = buildTeamRows(ROSTER_SELF, { selfSubject: 'google|2002' });
  assert.equal(rows.length, 4, 'no name-only merge, not even for the session\'s own name');
  const self = rows.find((row) => row.subjects.includes('google|2002'));
  assert.deepEqual(self.subjects, ['google|2002']);
  assert.equal(self.self, true);
  const homonym = rows.find((row) => row.subjects.includes('broker+adopted-aa11@accordo.invalid'));
  assert.equal(homonym.self, false, 'the homonym is not the session');
  assert.equal(homonym.access, 'Accesso aggiunto dal pilota');
  assert.equal(rows.find((row) => row.subjects.includes('github|1001')).access, 'Accesso GitHub');
  assert.ok(!JSON.stringify(rows.map((row) => row.access)).includes('|'), 'never a technical id');
});

test('9d06eb1e174b: no «Rimuovi» on one\'s own row; the others keep it', async () => {
  const context = { identity: { subject: 'google|2002', kind: 'verified-user' }, membership: { role: 'owner', subject: 'google|2002' }, roles: { owner: [], operator: [], observer: [] } };
  const { mount, view: v } = view({ client: stubClient({ context, members: ROSTER_SELF }) });
  await v.render();
  await flush();
  const items = mount.findAll('div').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-spazi-member'));
  const rowOf = (needle) => items.find((node) => node.textContent.includes(needle));
  const removeIn = (node) => node.findAll('button').filter((button) => button.textContent === 'Rimuovi');
  assert.equal(items.length, 4, 'every subject without a proof of identity is a row of its own');
  assert.equal(removeIn(rowOf('Marta Esempio')).length, 1, 'another person keeps «Rimuovi»');
  assert.equal(removeIn(rowOf('dario@esempio.invalid')).length, 0, 'never «Rimuovi» on one\'s own account');
  const homonym = rowOf('Accesso aggiunto dal pilota');
  assert.ok(homonym, 'the same-named row reads its access kind');
  assert.equal(removeIn(homonym).length, 1, 'a homonym keeps its «Rimuovi»');
});

test('8618ad3f72db: a child switch paused by the space AI shows not-allowed, never the wait cursor', () => {
  const css = fs.readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bo-spazi-toggle\[data-paused="true"\]:disabled\s*\{[^}]*cursor:\s*not-allowed/);
});

// Review Muse #897 P2: an empty identity subject never switches off the
// protection — the membership subject still names who «Tu» is.
test('9d06eb1e174b: an empty identity subject falls back to the membership subject', async () => {
  const context = { identity: { subject: '' }, membership: { role: 'owner', subject: 'google|2002' }, roles: { owner: [], operator: [], observer: [] } };
  const { mount, view: v } = view({ client: stubClient({ context, members: ROSTER_SELF }) });
  await v.render();
  await flush();
  const own = mount.findAll('div').find((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('bo-spazi-member')
    && node.textContent.includes('dario@esempio.invalid'));
  assert.equal(own.findAll('button').filter((button) => button.textContent === 'Rimuovi').length, 0);
});

// Review Muse #897 giro 2 (P1): the guard fails closed. While who «Tu» is
// stays unknown — context failed, or no subject in it — no row offers
// «Rimuovi», and one line says why; with the identity known only the
// other rows offer it.
test('9d06eb1e174b: with the session unknown no row offers «Rimuovi»; known, only the others do', async () => {
  const removes = (mount) => mount.findAll('button').filter((button) => button.textContent === 'Rimuovi');
  const failed = Object.assign(new Error('down'), { code: 'SPINE_DOWN', status: 500 });
  for (const client of [
    stubClient({ fail: { context: failed }, members: ROSTER_SELF }),
    stubClient({ context: { identity: { subject: '' }, membership: { role: 'owner', subject: '' }, roles: { owner: [] } }, members: ROSTER_SELF }),
  ]) {
    const { mount, view: v } = view({ client });
    await v.render();
    await flush();
    assert.equal(removes(mount).length, 0, 'no «Rimuovi» while the session is unknown');
    assert.match(text(mount), /Rimuovi non è disponibile: non sono riuscito a verificare il tuo account/);
  }
  const context = { identity: { subject: 'google|2002' }, membership: { role: 'owner', subject: 'google|2002' }, roles: { owner: [] } };
  const { mount, view: v } = view({ client: stubClient({ context, members: ROSTER_SELF }) });
  await v.render();
  await flush();
  assert.equal(removes(mount).length, 3, 'every other row offers «Rimuovi», never the own one');
  assert.doesNotMatch(text(mount), /Rimuovi non è disponibile/);
});
