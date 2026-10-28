// @ts-check

// Spazi e accessi (BO-F0-06 — backoffice "08 Spazi e accessi").
//
// The backoffice screen for one space's world: the operator's spaces with
// their role, the organization team with invite and removal, and the five AI
// switches of the space. Nothing here invents: spaces come from the shell's
// own space list (the same source the sidebar switcher reads), the team from
// the spine membership store, and the switches from the space-permissions
// package — keys, defaults and the flip path it owns.
//
// The team is the ORGANIZATION's team, shared by every space of the
// postazione: membership lives in the spine per organization, and the
// framework stores no per-space membership (space-permissions says so in its
// own contract). The screen therefore never labels the team "di <spazio>" —
// removal suspends the person in the whole organization, and the confirm step
// says exactly that.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the shell spaces (injected, like every other view injects its
//   space), GET /api/spine/context (my membership role), GET
//   /api/spine/memberships (the organization team), GET
//   /api/space-permissions/effective (the flipped switches, scoped
//   server-side: the generic records surface cannot filter the override
//   module by space, so the screen never pages it), GET /api/connectors
//   (active connections per space, for the card statistic) and GET
//   /api/customer-data/customers (exact total only, for the same row);
// - writes: POST /api/spine/memberships (grant) and
//   POST /api/spine/memberships/:subject/suspend (removal), the same store
//   the Identity screen uses — grant names a reason, removal is two-step;
// - flips: POST /api/space-permissions/set-permission, the operation that
//   runs the package's own `set-permission` action (human-only, same codes),
//   never a direct row write — every override row field is managed;
// - the backoffice tokens and rows of styles.css (bo-*): team and AI panels
//   in a two-column row like prototype screen 08, single column under 700px.
//
// Conventions follow apps/admin/public/admin-shell.js: the model builders are
// pure and DOM-free (unit-tested under node:test without a browser) and the
// renderer uses DOM APIs only — createElement + textContent/setAttribute —
// never innerHTML with data, so hostile space, member or role strings are
// inert text, never markup.

import { humanReadError } from './admin-core.js';
import { bindAdminMutations } from './admin-submission.js';
import { settingsTabs } from './admin-shell.js';

/**
 * The five AI switches, in the package's own order, with the Italian label
 * and the one line that says what the switch means. The keys and the
 * defaults live in `packages/space-permissions` — this list mirrors them,
 * and `tests/admin-spazi-accessi.test.js` fails the moment the two drift
 * apart. The one-liners describe the OFF side, because the screen subtitle
 * already states the rule once: what is off becomes a proposal to approve.
 */
export const SPAZI_AI_SWITCHES = Object.freeze([
  {
    key: 'merge-duplicates',
    label: 'Unire i contatti duplicati',
    line: 'Solo quando nome, recapiti e richiesta coincidono. Negli altri casi ti chiedo.',
  },
  {
    key: 'drafts',
    label: 'Scrivere bozze di risposta',
    line: 'Le trovi gi\u00E0 pronte nel campo di risposta del cliente.',
  },
  {
    key: 'send-without-approval',
    label: 'Inviare risposte senza approvazione',
    line: 'Se \u00E8 spento, ogni messaggio aspetta il tuo ok.',
  },
  {
    key: 'book-appointments',
    label: 'Fissare appuntamenti negli slot liberi',
    line: 'Solo con chi l\u2019ha chiesto, nel calendario condiviso.',
  },
  {
    key: 'move-offers',
    label: 'Spostare offerte nella pipeline',
    line: 'Se \u00E8 spento, ti propongo lo spostamento.',
  },
]);

/** Switch defaults, mirrored from the package — pinned by the drift test. */
export const SPAZI_AI_DEFAULTS = Object.freeze({
  'merge-duplicates': true,
  drafts: true,
  'send-without-approval': false,
  'book-appointments': true,
  'move-offers': true,
});

/** Italian names for the control-plane membership roles the spine mirrors. */
export const SPACE_ROLE_LABELS = Object.freeze({
  owner: 'Proprietario',
  operator: 'Operatore',
  observer: 'Osservatore',
});

/**
 * Italian label for a membership role. A role the framework does not know is
 * shown as-is, never blank and never mapped to a wrong one.
 * @param {unknown} role
 */
export function spaceRoleLabel(role) {
  if (typeof role === 'string' && role !== '' && Object.hasOwn(SPACE_ROLE_LABELS, role)) {
    return SPACE_ROLE_LABELS[role];
  }
  return typeof role === 'string' && role !== '' ? role : 'non disponibile';
}

/**
 * The statistic of one space card, in the prototype's own pattern
 * `<n> canali · <m> persone · <k> clienti` with Italian singulars. Every
 * count is real: active connections of the space (`GET /api/connectors`),
 * memberships of the organization (`GET /api/spine/memberships`) and the
 * exact customer total (`GET /api/customer-data/customers`, only when
 * `totalIsExact`). Any unknown count yields null and the card simply shows
 * no statistic — a package that is not composed, or an inexact total, must
 * never invent a row. People and customers are organization-wide (the team
 * is one per postazione, like the roster this screen already shows), so the
 * same two numbers honestly repeat on every card until customer records are
 * scoped per space server-side.
 * @param {{channels?: unknown, members?: unknown, customers?: unknown}} input
 */
export function formatSpaceStat({ channels = null, members = null, customers = null } = {}) {
  for (const count of [channels, members, customers]) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0 || !Number.isInteger(count)) return null;
  }
  const word = (count, one, many) => `${count} ${count === 1 ? one : many}`;
  return `${word(channels, 'canale', 'canali')} · ${word(members, 'persona', 'persone')} · ${word(customers, 'cliente', 'clienti')}`;
}

/**
 * Active connections of one space from `GET /api/connectors`: a revoked or
 * suspended connection is not "collegato". No `connectors` array means the
 * package is not composed here, never zero.
 * @param {unknown} answer
 */
export function countSpaceChannels(answer) {
  const entries = answer !== null && typeof answer === 'object'
    ? /** @type {{connectors?: unknown}} */ (answer).connectors
    : null;
  if (!Array.isArray(entries)) return null;
  return entries.filter((entry) => entry !== null && typeof entry === 'object'
    && /** @type {{status?: unknown}} */ (entry).status === 'active').length;
}

/**
 * Exact customer total from `GET /api/customer-data/customers`. An inexact
 * total (`totalIsExact: false`) reads as unknown: showing it would pass a
 * floor off as the count.
 * @param {unknown} answer
 */
export function countSpaceCustomers(answer) {
  if (answer === null || typeof answer !== 'object') return null;
  const shaped = /** @type {{total?: unknown, totalIsExact?: unknown}} */ (answer);
  if (shaped.totalIsExact !== true) return null;
  return typeof shaped.total === 'number' && Number.isInteger(shaped.total) && shaped.total >= 0
    ? shaped.total
    : null;
}

/**
 * One space card: identity from the shell space, the operator's role beside
 * it, and whether this is the space being worked in.
 * @param {{spaces?: Array<{id?: unknown, name?: unknown, initials?: unknown}>, activeSpaceId?: unknown, role?: unknown}} input
 */
export function buildSpaziCards({ spaces = [], activeSpaceId = null, role = null } = {}) {
  const list = Array.isArray(spaces) ? spaces : [];
  return list
    .filter((space) => space && typeof space === 'object' && typeof space.id === 'string' && space.id !== '')
    .map((space) => ({
      id: space.id,
      name: typeof space.name === 'string' && space.name !== '' ? space.name : space.id,
      initials: typeof space.initials === 'string' && space.initials !== '' ? space.initials : '·',
      role: spaceRoleLabel(role),
      roleKnown: typeof role === 'string' && role !== '',
      active: space.id === activeSpaceId,
    }));
}

/**
 * Avatar initials for a team subject: the first two alphanumeric characters,
 * uppercased. The spine membership store carries no display name and no
 * email, so the subject itself is the only honest source — never a prettier
 * invention. Prototype screen 08 shows name/email per member; those fields do
 * not exist in the store, and the screen states the reason instead of
 * inventing them.
 * @param {unknown} subject
 */
export function memberInitials(subject) {
  if (typeof subject !== 'string') return '·';
  const clean = subject.replace(/[^0-9a-zA-Z\u00c0-\u00de\u00e0-\u00ff]/g, '');
  if (clean === '') return '·';
  return clean.slice(0, 2).toUpperCase();
}

/**
 * One team row per membership: avatar initials, subject, Italian role pill,
 * status. Sorted by subject so the list is stable regardless of store order.
 * @param {Array<{subject?: unknown, role?: unknown, status?: unknown}>} members
 */
const MEMBER_STATUS = Object.freeze({ active: 'attivo', suspended: 'sospeso', invited: 'invitato', pending: 'in attesa' });

export function buildTeamRows(members = []) {
  const list = Array.isArray(members) ? members : [];
  return list
    .filter((member) => member && typeof member === 'object' && typeof member.subject === 'string' && member.subject !== '')
    .map((member) => ({
      subject: member.subject,
      initials: memberInitials(member.subject),
      role: spaceRoleLabel(member.role),
      status: MEMBER_STATUS[member.status] ?? (typeof member.status === 'string' && member.status !== '' ? member.status : 'sconosciuto'),
    }))
    .sort((left, right) => (left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0));
}

/**
 * The five switches with their effective value: the flipped row wins, the
 * package default covers the rest. Rows of another space never leak in —
 * only rows carrying this space id are honored.
 * @param {string} spaceId
 * @param {Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>} [overrideRows]
 */
export function effectiveSwitches(spaceId, overrideRows = []) {
  const rows = Array.isArray(overrideRows) ? overrideRows : [];
  return SPAZI_AI_SWITCHES.map((entry) => {
    const flipped = rows.find(
      (row) => row && typeof row === 'object' && row.spaceId === spaceId && row.permission === entry.key,
    );
    return {
      key: entry.key,
      label: entry.label,
      line: entry.line,
      enabled: flipped ? flipped.enabled === true : SPAZI_AI_DEFAULTS[entry.key] === true,
    };
  });
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, cls?: string, attrs?: Record<string, string>}} [options]
 */
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * A view controller for the Spazi e accessi screen. Injecting `doc`,
 * `client`, spaces and the space picker keeps it testable without a browser.
 *
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, navigate?: (hash: string) => void, spaces?: () => Array<{id: string, name?: string, initials?: string}>, activeSpaceId?: () => string | null, onPickSpace?: (id: string) => void, toast?: (message: string, error?: boolean) => void, storage?: any}} deps
 */
export function createSpaziAccessiView(deps) {
  const { doc, mount, navigate } = deps;
  // POSTs go through the submission controller with idempotency, like every
  // other admin view; GETs stay on the raw client.
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});
  const readSpaces = () => {
    try {
      const spaces = deps.spaces ? deps.spaces() : [];
      return Array.isArray(spaces) ? spaces : [];
    } catch {
      return [];
    }
  };
  const readActiveSpace = () => {
    try {
      const id = deps.activeSpaceId ? deps.activeSpaceId() : null;
      return typeof id === 'string' ? id : '';
    } catch {
      return '';
    }
  };

  const state = {
    /** The invite form opens in place from the team card head. */
    inviteOpen: false,
    /** @type {string|null} my membership role, or null when unknown */
    myRole: null,
    /** @type {Array<string>|null} roles the server advertises, or null */
    roles: null,
    /** @type {Array<any>|null} team rows, or null when unread */
    members: null,
    /** @type {string|null} why the team is not shown */
    membersUnavailable: null,
    /** @type {Array<any>|null} override rows, or null when unread */
    overrides: null,
    /** @type {string|null} why the switches are not shown */
    switchesUnavailable: null,
    /** @type {Map<string, string>} card statistic by space id; a space with
     * an unknown count simply has no entry, never an invented row */
    stats: new Map(),
    /** @type {string|null} subject armed for the two-step removal */
    confirmRemove: null,
    /** @type {{key: string, to: boolean}|null} switch flip armed for confirm */
    confirmFlip: null,
    busy: false,
    /** @type {string|null} last server refusal, shown next to the form */
    refusal: null,
  };

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message @param {boolean} [isError] */
  function say(message, isError = false) {
    toast(message, isError);
  }

  /**
   * Normalize a client rejection without losing what the page branches on.
   * A rejection with a code passes through untouched; anything else becomes
   * {code: 'UNKNOWN', ...} keeping the record's own status and message, so a
   * status-only 404 still reads as not-composed and the log keeps the cause.
   * @param {unknown} error
   */
  function errorOf(error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error;
    if (error instanceof Error) {
      /** @type {{code: string, message: string, status?: number}} */
      const normalized = { code: 'UNKNOWN', message: error.message };
      const status = /** @type {any} */ (error).status;
      if (typeof status === 'number') normalized.status = status;
      return normalized;
    }
    if (error && typeof error === 'object') return { ...error, code: 'UNKNOWN' };
    return { code: 'UNKNOWN', message: String(error) };
  }

  /**
   * The statistic of one space card from the composed reads. Any unreadable
   * count yields null and the card shows no statistic: a failure here is a
   * missing enhancement, never a page error, so it stays silent.
   * @param {string} spaceId
   * @param {number|null} memberCount
   */
  async function loadSpaceStat(spaceId, memberCount) {
    if (memberCount === null) return null;
    try {
      const [channelsAnswer, customersAnswer] = await Promise.all([
        client.request(`/api/connectors?spaceId=${encodeURIComponent(spaceId)}`),
        client.request(`/api/customer-data/customers?spaceId=${encodeURIComponent(spaceId)}`),
      ]);
      return formatSpaceStat({
        channels: countSpaceChannels(channelsAnswer),
        members: memberCount,
        customers: countSpaceCustomers(customersAnswer),
      });
    } catch {
      return null;
    }
  }

  async function load() {
    const space = readActiveSpace().trim();
    state.myRole = null;
    state.roles = null;
    state.members = null;
    state.membersUnavailable = null;
    state.overrides = null;
    state.switchesUnavailable = null;
    state.stats = new Map();
    state.confirmRemove = null;
    state.confirmFlip = null;
    state.refusal = null;
    if (space === '') return;
    try {
      const context = await client.request('/api/spine/context');
      state.myRole = typeof context?.membership?.role === 'string' ? context.membership.role : null;
      state.roles = context?.roles && typeof context.roles === 'object'
        ? Object.keys(context.roles).filter((name) => name !== '')
        : null;
    } catch {
      state.myRole = null;
      state.roles = null;
    }
    try {
      const answer = await client.request('/api/spine/memberships');
      state.members = Array.isArray(answer?.items) ? answer.items : [];
    } catch (error) {
      const failure = errorOf(error);
      state.members = null;
      state.membersUnavailable = failure.code === 'SPINE_MEMBERSHIP_FORBIDDEN' || failure.status === 403
        ? 'Non hai il permesso di vedere il team: il server ha rifiutato la lettura, e questa non \u00E8 una lista vuota.'
        : humanReadError(failure, {
          failed: 'Il team non si \u00E8 potuto leggere. Riprova pi\u00F9 tardi: niente \u00E8 stato inventato al suo posto.',
        });
    }
    try {
      const answer = await client.request(
        `/api/space-permissions/effective?spaceId=${encodeURIComponent(space)}`,
      );
      const items = Array.isArray(answer?.overrides) ? answer.overrides : [];
      state.overrides = items;
    } catch (error) {
      const failure = errorOf(error);
      state.overrides = null;
      state.switchesUnavailable = humanReadError(failure, {
        failed: 'I permessi AI non si sono potuti leggere. Riprova pi\u00F9 tardi.',
        notComposed: 'I permessi AI non sono attivi in questo spazio: la schermata li mostra quando saranno attivi.',
      });
    }
    const memberCount = Array.isArray(state.members) ? state.members.length : null;
    const ids = readSpaces()
      .filter((entry) => entry !== null && typeof entry === 'object'
        && typeof /** @type {{id?: unknown}} */ (entry).id === 'string'
        && /** @type {{id?: unknown}} */ (entry).id !== '')
      .map((entry) => /** @type {string} */ (/** @type {{id?: unknown}} */ (entry).id));
    await Promise.all(ids.map(async (id) => {
      const stat = await loadSpaceStat(id, memberCount);
      if (stat !== null) state.stats.set(id, stat);
    }));
  }

  async function mutate(path, body) {
    state.busy = true;
    render();
    try {
      return await client.request(path, { method: 'POST', body });
    } finally {
      state.busy = false;
    }
  }

  function activeSpace() {
    const spaces = readSpaces();
    const id = readActiveSpace();
    return spaces.find((space) => space && space.id === id) ?? null;
  }

  function renderHeader(box) {
    box.appendChild(el(doc, 'p', { text: 'Spazi e accessi', cls: 'bo-kicker' }));
    box.appendChild(el(doc, 'h2', { text: 'Spazi di lavoro', cls: 'bo-spazi-title' }));
    box.appendChild(el(doc, 'p', {
      text: 'Passa da un\u2019attivit\u00E0 all\u2019altra senza uscire. Ogni spazio ha i suoi canali, clienti e team, e nessuno vede i dati degli altri.',
      cls: 'bo-muted bo-spazi-lede',
    }));
  }

  function renderSpaces(box) {
    const cards = buildSpaziCards({ spaces: readSpaces(), activeSpaceId: readActiveSpace(), role: state.myRole });
    const grid = el(doc, 'div', { cls: 'bo-spazi-grid' });
    if (cards.length === 0) {
      grid.appendChild(el(doc, 'p', {
        text: 'Nessuno spazio in questa postazione: aggiungi uno spazio prima di continuare.',
        cls: 'bo-muted',
      }));
    }
    for (const card of cards) {
      const cell = el(doc, 'div', { cls: 'bo-spazi-card' });
      const head = el(doc, 'div', { cls: 'bo-spazi-head' });
      head.appendChild(el(doc, 'span', { text: card.initials, cls: 'bo-spazi-initials' }));
      const names = el(doc, 'div', { cls: 'bo-spazi-names' });
      names.appendChild(el(doc, 'div', { text: card.name, cls: 'bo-spazi-name' }));
      names.appendChild(el(doc, 'div', {
        text: card.roleKnown ? `Tu: ${card.role}` : 'Tu: ruolo non riconosciuto',
        cls: 'bo-muted',
      }));
      head.appendChild(names);
      cell.appendChild(head);
      const stat = state.stats.get(card.id) ?? null;
      if (stat !== null) {
        cell.appendChild(el(doc, 'div', { text: stat, cls: 'bo-spazi-stat bo-muted' }));
      }
      if (card.active) {
        cell.appendChild(el(doc, 'span', { text: 'Stai lavorando qui', cls: 'bo-spazi-here' }));
      } else if (typeof deps.onPickSpace === 'function') {
        const open = el(doc, 'button', { text: 'Apri', cls: 'bo-spazi-open', attrs: { type: 'button' } });
        open.disabled = state.busy;
        open.addEventListener('click', () => {
          deps.onPickSpace(card.id);
          if (typeof navigate === 'function') navigate('#/');
          void refresh();
        });
        cell.appendChild(open);
      }
      grid.appendChild(cell);
    }
    box.appendChild(grid);
  }

  function renderTeam(box) {
    const section = el(doc, 'section', { cls: 'bo-spazi-section bo-spazi-panel bo-spazi-team-panel' });
    // Prototype 08: the team card head carries the green «Invita persona»,
    // which opens the invite form in place.
    const teamHead = el(doc, 'div', { cls: 'bo-spazi-teamhead' });
    teamHead.appendChild(el(doc, 'h3', { text: 'Team dell\u2019organizzazione' }));
    const inviteToggle = el(doc, 'button', { text: 'Invita persona ▾', cls: 'cta bo-spazi-invite-toggle', attrs: { type: 'button', 'aria-expanded': state.inviteOpen ? 'true' : 'false' } });
    inviteToggle.addEventListener('click', () => { state.inviteOpen = !state.inviteOpen; render(); });
    teamHead.appendChild(inviteToggle);
    section.appendChild(teamHead);
    section.appendChild(el(doc, 'p', {
      text: 'Lo stesso team per tutti gli spazi di questa postazione: rimuovere sospende la persona nell\u2019intera organizzazione, non nel singolo spazio.',
      cls: 'bo-muted',
    }));
    if (state.members === null) {
      section.appendChild(el(doc, 'p', { text: state.membersUnavailable ?? 'Team non disponibile.', cls: 'bo-muted' }));
      box.appendChild(section);
      return;
    }
    const rows = buildTeamRows(state.members);
    const list = el(doc, 'div', { cls: 'bo-spazi-team' });
    if (rows.length === 0) {
      list.appendChild(el(doc, 'p', { text: 'Nessun membro oltre a te.', cls: 'bo-muted' }));
    }
    for (const row of rows) {
      const item = el(doc, 'div', { cls: 'bo-spazi-member' });
      const identity = el(doc, 'div', { cls: 'bo-spazi-identity' });
      identity.appendChild(el(doc, 'span', { text: row.initials, cls: 'bo-spazi-avatar', attrs: { 'aria-hidden': 'true' } }));
      const names = el(doc, 'div', { cls: 'bo-spazi-names' });
      names.appendChild(el(doc, 'div', { text: row.subject, cls: 'bo-spazi-subject' }));
      names.appendChild(el(doc, 'div', { text: row.status, cls: 'bo-spazi-status' }));
      identity.appendChild(names);
      item.appendChild(identity);
      item.appendChild(el(doc, 'span', { text: row.role, cls: 'bo-spazi-role' }));
      if (state.confirmRemove === row.subject) {
        const confirmBox = el(doc, 'div', { cls: 'bo-spazi-confirm' });
        confirmBox.appendChild(el(doc, 'p', {
          text: `Rimuovere ${row.subject} dal team? La sospensione vale per l\u2019intera organizzazione. Il motivo resta registrato.`,
          cls: 'bo-muted',
        }));
        const reason = el(doc, 'input', {
          cls: 'bo-spazi-input',
          attrs: { type: 'text', placeholder: 'Motivo (obbligatorio)', 'aria-label': `Motivo della rimozione di ${row.subject}` },
        });
        confirmBox.appendChild(reason);
        const yes = el(doc, 'button', { text: 'Conferma rimozione', cls: 'bo-spazi-danger', attrs: { type: 'button' } });
        yes.disabled = state.busy;
        yes.addEventListener('click', async () => {
          const motive = String(reason.value ?? '').trim();
          if (motive === '') {
            say('Serve un motivo: senza, il server rifiuta la rimozione.', true);
            return;
          }
          try {
            await mutate(`/api/spine/memberships/${encodeURIComponent(row.subject)}/suspend`, { reason: motive });
            say(`${row.subject} rimosso dal team.`);
          } catch (error) {
            const failure = errorOf(error);
            state.refusal = failure.message ?? String(failure.code ?? 'rimozione rifiutata');
            say(state.refusal, true);
          }
          await refresh();
        });
        const no = el(doc, 'button', { text: 'Annulla', cls: 'bo-spazi-quiet', attrs: { type: 'button' } });
        no.addEventListener('click', () => { state.confirmRemove = null; state.refusal = null; render(); });
        confirmBox.appendChild(yes);
        confirmBox.appendChild(no);
        item.appendChild(confirmBox);
      } else {
        const remove = el(doc, 'button', { text: 'Rimuovi', cls: 'bo-spazi-quiet', attrs: { type: 'button' } });
        remove.disabled = state.busy;
        remove.addEventListener('click', () => { state.confirmRemove = row.subject; state.refusal = null; render(); });
        item.appendChild(remove);
      }
      list.appendChild(item);
    }
    section.appendChild(list);

    const invite = el(doc, 'div', { cls: `bo-spazi-invite${state.inviteOpen || state.refusal !== null ? ' open' : ''}` });
    invite.appendChild(el(doc, 'h4', { text: 'Invita persona' }));
    const subject = el(doc, 'input', {
      cls: 'bo-spazi-input',
      attrs: { type: 'text', placeholder: 'Email o account Google della persona', 'aria-label': 'Identificativo della persona da invitare' },
    });
    invite.appendChild(subject);
    const role = el(doc, 'select', { cls: 'bo-spazi-input', attrs: { 'aria-label': 'Ruolo del nuovo membro' } });
    const roleNames = Array.isArray(state.roles) && state.roles.length > 0
      ? state.roles
      : ['owner', 'operator', 'observer'];
    for (const name of roleNames) {
      const option = el(doc, 'option', { text: spaceRoleLabel(name), attrs: { value: name } });
      role.appendChild(option);
    }
    try { role.value = 'operator'; } catch { /* keep the rendered order */ }
    invite.appendChild(role);
    const reason = el(doc, 'input', {
      cls: 'bo-spazi-input',
      attrs: { type: 'text', placeholder: 'Motivo (obbligatorio, resta registrato)', 'aria-label': 'Motivo dell\u2019invito' },
    });
    invite.appendChild(reason);
    const send = el(doc, 'button', { text: 'Invita', cls: 'bo-spazi-open', attrs: { type: 'button' } });
    send.disabled = state.busy;
    send.addEventListener('click', async () => {
      const who = String(subject.value ?? '').trim();
      const picked = String(role.value ?? '').trim() || 'operator';
      const motive = String(reason.value ?? '').trim();
      if (who === '' || motive === '') {
        say('Servono la persona e il motivo: senza motivo, il server rifiuta l\u2019invito.', true);
        return;
      }
      try {
        await mutate('/api/spine/memberships', { subject: who, role: picked, reason: motive });
        say(`${who} invitato come ${spaceRoleLabel(picked)}.`);
      } catch (error) {
        const failure = errorOf(error);
        state.refusal = failure.message ?? String(failure.code ?? 'invito rifiutato');
        say(state.refusal, true);
      }
      await refresh();
    });
    invite.appendChild(send);
    if (state.refusal !== null) {
      invite.appendChild(el(doc, 'p', { text: state.refusal, cls: 'bo-spazi-refusal' }));
    }
    invite.appendChild(el(doc, 'p', {
      text: 'Nessuna email parte da qui: la persona entra con il suo account Google al primo accesso.',
      cls: 'bo-muted',
    }));
    section.appendChild(invite);
    box.appendChild(section);
  }

  function renderSwitches(box, space) {
    const section = el(doc, 'section', { cls: 'bo-spazi-section bo-spazi-panel bo-spazi-ai-panel' });
    section.appendChild(el(doc, 'h3', { text: '\u2726 Cosa pu\u00F2 fare l\u2019AI' }));
    section.appendChild(el(doc, 'p', {
      text: `Vale per tutto lo spazio ${space.name}. Quello che \u00E8 spento diventa una proposta da approvare.`,
      cls: 'bo-muted',
    }));
    if (state.overrides === null) {
      section.appendChild(el(doc, 'p', { text: state.switchesUnavailable ?? 'Permessi non disponibili.', cls: 'bo-muted' }));
      box.appendChild(section);
      return;
    }
    const switches = effectiveSwitches(space.id, state.overrides);
    const list = el(doc, 'div', { cls: 'bo-spazi-switches' });
    for (const entry of switches) {
      const row = el(doc, 'div', { cls: 'bo-spazi-switch' });
      const texts = el(doc, 'div', { cls: 'bo-spazi-texts' });
      texts.appendChild(el(doc, 'div', { text: entry.label, cls: 'bo-spazi-label' }));
      texts.appendChild(el(doc, 'div', { text: entry.line, cls: 'bo-muted' }));
      row.appendChild(texts);
      const toggle = el(doc, 'button', {
        cls: 'bo-spazi-toggle',
        attrs: { type: 'button', role: 'switch', 'aria-checked': entry.enabled ? 'true' : 'false', 'aria-label': entry.label },
      });
      toggle.setAttribute('data-on', entry.enabled ? 'true' : 'false');
      toggle.disabled = state.busy;
      toggle.addEventListener('click', () => {
        state.confirmFlip = { key: entry.key, to: !entry.enabled };
        state.refusal = null;
        render();
      });
      const knob = el(doc, 'span', { cls: 'bo-spazi-knob' });
      toggle.appendChild(knob);
      row.appendChild(toggle);
      list.appendChild(row);
      if (state.confirmFlip !== null && state.confirmFlip.key === entry.key) {
        const pending = state.confirmFlip;
        const confirmBox = el(doc, 'div', { cls: 'bo-spazi-confirm' });
        confirmBox.appendChild(el(doc, 'p', {
          text: pending.to
            ? `Accendere \u00AB${entry.label}\u00BB? Da accesa, l\u2019AI agisce da sola.`
            : `Spegnere \u00AB${entry.label}\u00BB? Da spenta, diventa una proposta da approvare.`,
          cls: 'bo-muted',
        }));
        const yes = el(doc, 'button', { text: 'Conferma', cls: 'bo-spazi-open', attrs: { type: 'button' } });
        yes.disabled = state.busy;
        yes.addEventListener('click', async () => {
          try {
            await mutate('/api/space-permissions/set-permission', {
              spaceId: space.id,
              permission: pending.key,
              enabled: pending.to ? 'on' : 'off',
            });
            say(`\u00AB${entry.label}\u00BB ${pending.to ? 'accesa' : 'spenta'}.`);
          } catch (error) {
            const failure = errorOf(error);
            state.refusal = failure.message ?? String(failure.code ?? 'modifica rifiutata');
            say(state.refusal, true);
          }
          await refresh();
        });
        const no = el(doc, 'button', { text: 'Annulla', cls: 'bo-spazi-quiet', attrs: { type: 'button' } });
        no.addEventListener('click', () => { state.confirmFlip = null; state.refusal = null; render(); });
        confirmBox.appendChild(yes);
        confirmBox.appendChild(no);
        list.appendChild(confirmBox);
      }
    }
    section.appendChild(list);
    if (state.refusal !== null && state.confirmFlip === null) {
      section.appendChild(el(doc, 'p', { text: state.refusal, cls: 'bo-spazi-refusal' }));
    }
    box.appendChild(section);
  }

  // Every refresh stamps its own generation and snapshots the mount's
  // children. While its requests are in flight the operator may open another
  // module, which renders into the same shared mount (the catalog and clienti
  // views keep a token for their own reloads; a token alone cannot see a
  // takeover from another view). A late answer renders only when it is still
  // the newest refresh AND the mount still holds exactly what it held before
  // the load — otherwise the shell moved on and this screen stays out.
  let generation = 0;
  const childrenOf = () => Array.from(mount?.childNodes ?? []);

  function render() {
    clear();
    const space = activeSpace();
    mount.appendChild(settingsTabs(doc, { activeId: 'spazi-accessi', navigate: typeof navigate === 'function' ? navigate : () => {} }));
    renderHeader(mount);
    renderSpaces(mount);
    if (space === null) {
      mount.appendChild(el(doc, 'p', {
        text: 'Scegli uno spazio per vederne il team e i permessi AI.',
        cls: 'bo-muted',
      }));
      return;
    }
    // Team and AI panels sit side by side on wide screens (flex row, team
    // 1.5fr + AI 1fr, like prototype screen 08) and stack in one column
    // under 700px. The panels wrap instead of overflowing in between.
    const panels = el(doc, 'div', { cls: 'bo-spazi-panels' });
    renderTeam(panels);
    renderSwitches(panels, space);
    mount.appendChild(panels);
  }

  async function refresh() {
    const mine = (generation += 1);
    const before = childrenOf();
    await load();
    if (mine !== generation) return;
    const now = childrenOf();
    if (now.length !== before.length || now.some((node, index) => node !== before[index])) return;
    render();
  }

  async function renderView() {
    await refresh();
  }

  return { render: renderView };
}
