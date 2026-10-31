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
  countSpaceChannels,
  countSpaceCustomers,
  createSpaziAccessiView,
  effectiveSwitches,
  formatSpaceStat,
  memberInitials,
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

function stubClient({ context = null, members = [], overrides = [], calls = null, fail = {}, connectorsBySpace = null, customersBySpace = null } = {}) {
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
      if (path.startsWith('/api/connectors')) {
        if (fail.connectors) throw fail.connectors;
        const spaceId = new URL(path, 'http://stub.test').searchParams.get('spaceId') ?? SPACE;
        const connectors = connectorsBySpace !== null && Object.hasOwn(connectorsBySpace, spaceId)
          ? connectorsBySpace[spaceId]
          : [];
        return { spaceId, connectors };
      }
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
  assert.equal(toggles.find((node) => node.getAttribute('aria-label') === 'Inviare risposte senza approvazione')?.getAttribute('aria-checked'), 'false');
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
  const said = seen.toast.find((row) => row.error);
  assert.ok(said, 'the refusal is said aloud');
  assert.match(said.message, /non \u00e8 riuscita|non permette/, 'the spoken refusal is Italian');
  assert.ok(!/human user actor|HUMAN_APPROVAL/.test(said.message), 'no technical detail is spoken');
  assert.ok(!/human user actor|HUMAN_APPROVAL/.test(text(mount)), 'no technical detail is rendered');
  assert.match(text(mount), /non \u00e8 riuscita|non permette/, 'the refusal renders next to the switches');
  assert.ok(mount.findAll('button').some((node) => node.getAttribute('role') === 'switch'), 'the switches stay usable');
});

// backlog:9046f940: a 405 on the AI switch keeps the switch as it was and
// names the refusal in Italian next to the command (never silence).
test('a 405 flip keeps the switch and shows an Italian refusal', async () => {
  const refusing = {
    async request(path, options = {}) {
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
  const said = seen.toast.find((row) => row.error);
  assert.ok(said, 'the 405 is said aloud');
  assert.match(said.message, /non permette/, 'the 405 names the refusal in Italian');
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

test('countSpaceChannels counts active connections, countSpaceCustomers needs an exact total', () => {
  assert.equal(countSpaceChannels({ connectors: [
    { connectionKey: 'a', status: 'active' },
    { connectionKey: 'b', status: 'suspended' },
    { connectionKey: 'c', status: 'active' },
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
          { connectionKey: 'wa', status: 'active' },
          { connectionKey: 'ig', status: 'active' },
        ],
      },
      customersBySpace: { [SPACE]: { total: 3, totalIsExact: true } },
    }),
  });
  await v.render();
  await flush();
  assert.match(text(mount), /2 canali · 2 persone · 3 clienti/);
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
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
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
    console.error = originalError;
  }
});

test('an inexact customer total omits the statistic instead of a floor', async () => {
  const members = [{ subject: 'marco', role: 'operator', status: 'active' }];
  const { mount, view: v } = view({
    client: stubClient({
      members,
      connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', status: 'active' }] },
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
      connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', status: 'active' }] },
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
      connectorsBySpace: { [SPACE]: [{ connectionKey: 'wa', status: 'active' }] },
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
