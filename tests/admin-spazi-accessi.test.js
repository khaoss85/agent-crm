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
import assert from 'node:assert/strict';
import {
  SPAZI_AI_DEFAULTS,
  SPAZI_AI_SWITCHES,
  buildSpaziCards,
  buildTeamRows,
  createSpaziAccessiView,
  effectiveSwitches,
  spaceRoleLabel,
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

function stubClient({ context = null, members = [], overrides = [], calls = null, fail = {} } = {}) {
  return {
    async request(path, options = {}) {
      const rawBody = options?.body ?? null;
      let body = rawBody;
      if (typeof rawBody === 'string' && rawBody !== '') {
        try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      }
      if (calls) calls.push({ path, body, method: options?.method ?? 'GET' });
      if (path === '/api/spine/context') {
        if (fail.context) throw fail.context;
        return context ?? { membership: { role: 'owner' }, roles: { owner: [], operator: [], observer: [] } };
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
        const subject = decodeURIComponent(path.split('/')[3]);
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
      throw new Error(`unexpected request ${path}`);
    },
  };
}

function view({ client, spaces = [{ id: SPACE, name: 'Negozio', initials: 'NE' }], active = SPACE } = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = { toast: [], picked: [], navigated: [] };
  const v = createSpaziAccessiView({
    doc,
    mount,
    client: client ?? stubClient(),
    navigate: (hash) => seen.navigated.push(hash),
    spaces: () => spaces,
    activeSpaceId: () => active,
    onPickSpace: (id) => seen.picked.push(id),
    toast: (message, error = false) => seen.toast.push({ message, error }),
  });
  return { doc, mount, seen, view: v };
}

const text = (mount) => mount.textContent;

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
  assert.equal(cards[0].role, 'Proprietario');
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

test('the screen lists spaces with roles, team and the five switches', async () => {
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
  assert.match(rendered, /Tu: Proprietario/);
  assert.match(rendered, /Team dell\u2019organizzazione/);
  assert.match(rendered, /intera organizzazione/);
  assert.match(rendered, /marco/);
  assert.match(rendered, /Cosa pu\u00F2 fare l\u2019AI/);
  for (const entry of SPAZI_AI_SWITCHES) {
    assert.ok(rendered.includes(entry.label), `switch ${entry.key} is listed`);
    assert.ok(rendered.includes(entry.line), `switch ${entry.key} explains itself`);
  }
  const toggles = mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  assert.equal(toggles.length, 5);
  assert.equal(toggles.find((node) => node.getAttribute('aria-label') === 'Inviare senza approvazione')?.getAttribute('aria-checked'), 'false');
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
  assert.match(text(mount), /non sono composti in questo spazio/);
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch').length, 0);
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
  assert.match(lucaRow, /luca/);
  const remove = mount.findAll('button').find((node) => node.textContent === 'Rimuovi' && node.parentNode?.textContent?.includes('luca'));
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
  const { mount, view: v } = view({ client: stubClient({ calls, overrides }) });
  await v.render();
  await flush();
  const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Inviare senza approvazione');
  await toggle.listeners.click[0]();
  await flush();
  assert.match(text(mount), /Accendere/, 'the flip asks before writing');
  assert.ok(!calls.some((call) => call.path === '/api/space-permissions/set-permission'), 'nothing flips before confirm');
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  await confirm.listeners.click[0]();
  await flush(20);
  const flip = calls.find((call) => call.path === '/api/space-permissions/set-permission');
  assert.deepEqual(flip?.body, { spaceId: SPACE, permission: 'send-without-approval', enabled: 'on' });
  assert.match(text(mount), /accesa/, 'the flip is said aloud');
  const toggles = mount.findAll('button').filter((node) => node.getAttribute('role') === 'switch');
  assert.equal(toggles.find((node) => node.getAttribute('aria-label') === 'Inviare senza approvazione')?.getAttribute('aria-checked'), 'true');
});

test('a refused flip renders the server refusal and keeps the screen usable', async () => {
  const refusing = {
    async request(path, options = {}) {
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
  const toggle = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Preparare bozze');
  await toggle.listeners.click[0]();
  await flush();
  const confirm = mount.findAll('button').find((node) => node.textContent === 'Conferma');
  await confirm.listeners.click[0]();
  await flush(20);
  assert.ok(seen.toast.some((row) => row.error && /human user actor/.test(row.message)), 'the refusal is said aloud');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('role') === 'switch'), 'the switches stay usable');
});
