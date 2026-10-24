// @ts-check

// Spazi e accessi (BO-F0-06 — backoffice "08 Spazi e accessi").
//
// The backoffice screen for one space's world: the operator's spaces with
// their role, the space team with invite and removal, and the five AI
// switches of the space. Nothing here invents: spaces come from the shell's
// own space list (the same source the sidebar switcher reads), roles and
// members from the spine membership store, and the switches from the
// space-permissions package — keys, defaults and the flip path it owns.
//
// What it reuses, never duplicates (MEM_ACC_REUSE):
// - reads: the shell spaces (injected, like every other view injects its
//   space), GET /api/spine/context (my membership role), GET
//   /api/spine/memberships (the team), GET
//   /api/modules/space-permission-override/records (the flipped switches);
// - writes: POST /api/spine/memberships (grant) and
//   POST /api/spine/memberships/:subject/suspend (removal), the same store
//   the Identity screen uses — grant names a reason, removal is two-step;
// - flips: POST /api/space-permissions/set-permission, the operation that
//   runs the package's own `set-permission` action (human-only, same codes),
//   never a direct row write — every override row field is managed;
// - the backoffice tokens and rows of styles.css (bo-*), single column under
//   700px like every other backoffice screen.
//
// Conventions follow apps/admin/public/admin-shell.js: the model builders are
// pure and DOM-free (unit-tested under node:test without a browser) and the
// renderer uses DOM APIs only — createElement + textContent/setAttribute —
// never innerHTML with data, so hostile space, member or role strings are
// inert text, never markup.

import { bindAdminMutations } from './admin-submission.js';

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
    label: 'Unire i duplicati',
    line: 'Da spenta, ogni possibile doppione diventa una proposta da approvare.',
  },
  {
    key: 'drafts',
    label: 'Preparare bozze',
    line: 'Da spenta, nessuna bozza nasce senza la tua approvazione.',
  },
  {
    key: 'send-without-approval',
    label: 'Inviare senza approvazione',
    line: 'Spenta all\u2019inizio: da accesa, i messaggi partono da soli.',
  },
  {
    key: 'book-appointments',
    label: 'Fissare appuntamenti',
    line: 'Da spenta, ogni proposta di orario diventa una proposta da approvare.',
  },
  {
    key: 'move-offers',
    label: 'Spostare offerte',
    line: 'Da spenta, ogni avanzamento dell\u2019offerta aspetta il tuo ok.',
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
 * One team row per membership: subject, Italian role, status. Sorted by
 * subject so the list is stable regardless of store order.
 * @param {Array<{subject?: unknown, role?: unknown, status?: unknown}>} members
 */
export function buildTeamRows(members = []) {
  const list = Array.isArray(members) ? members : [];
  return list
    .filter((member) => member && typeof member === 'object' && typeof member.subject === 'string' && member.subject !== '')
    .map((member) => ({
      subject: member.subject,
      role: spaceRoleLabel(member.role),
      status: typeof member.status === 'string' && member.status !== '' ? member.status : 'sconosciuto',
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
function el(doc, tag, options = {}) {
  const node = doc.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text; // safe: text, not HTML
  if (options.cls) node.setAttribute('class', options.cls);
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  return node;
}

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

  /** @param {unknown} error */
  function errorOf(error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error;
    return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
  }

  async function load() {
    const space = readActiveSpace().trim();
    state.myRole = null;
    state.roles = null;
    state.members = null;
    state.membersUnavailable = null;
    state.overrides = null;
    state.switchesUnavailable = null;
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
        : `Il team non si \u00E8 potuto leggere (${failure.code}). Niente \u00E8 stato inventato al suo posto.`;
    }
    try {
      const answer = await client.request(
        `/api/modules/space-permission-override/records?filter.spaceId=${encodeURIComponent(space)}`,
      );
      const items = Array.isArray(answer?.items) ? answer.items : (Array.isArray(answer) ? answer : []);
      state.overrides = items;
    } catch (error) {
      const failure = errorOf(error);
      state.overrides = null;
      state.switchesUnavailable = failure.code === 'NOT_FOUND' || failure.status === 404
        ? 'I permessi AI non sono composti in questo spazio: la schermata li mostra quando il pacchetto space-permissions \u00E8 attivo.'
        : `I permessi AI non si sono potuti leggere (${failure.code}).`;
    }
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
    box.appendChild(el(doc, 'h2', { text: 'Spazi di lavoro' }));
    box.appendChild(el(doc, 'p', {
      text: 'Passa da un\u2019attivit\u00E0 all\u2019altra senza uscire. Ogni spazio ha i suoi canali, clienti e team, e nessuno vede i dati degli altri.',
      cls: 'bo-muted',
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
        text: card.roleKnown ? `Tu: ${card.role}` : 'Tu: ruolo non disponibile',
        cls: 'bo-muted',
      }));
      head.appendChild(names);
      cell.appendChild(head);
      if (card.active) {
        cell.appendChild(el(doc, 'span', { text: 'Stai lavorando qui', cls: 'bo-spazi-here' }));
      } else if (typeof deps.onPickSpace === 'function') {
        const open = el(doc, 'button', { text: 'Apri', cls: 'bo-spazi-open', attrs: { type: 'button' } });
        open.disabled = state.busy;
        open.addEventListener('click', () => {
          deps.onPickSpace(card.id);
          if (typeof navigate === 'function') navigate('#/');
          void load().then(render);
        });
        cell.appendChild(open);
      }
      grid.appendChild(cell);
    }
    box.appendChild(grid);
  }

  function renderTeam(box, space) {
    const section = el(doc, 'section', { cls: 'bo-spazi-section' });
    section.appendChild(el(doc, 'h3', { text: `Team di ${space.name}` }));
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
      item.appendChild(el(doc, 'span', { text: row.subject, cls: 'bo-spazi-subject' }));
      item.appendChild(el(doc, 'span', { text: `${row.role} · ${row.status}`, cls: 'bo-muted' }));
      if (state.confirmRemove === row.subject) {
        const confirmBox = el(doc, 'div', { cls: 'bo-spazi-confirm' });
        confirmBox.appendChild(el(doc, 'p', {
          text: `Rimuovere ${row.subject} dal team? Il motivo resta registrato.`,
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
          await load().then(render);
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

    const invite = el(doc, 'div', { cls: 'bo-spazi-invite' });
    invite.appendChild(el(doc, 'h4', { text: 'Invita persona' }));
    const subject = el(doc, 'input', {
      cls: 'bo-spazi-input',
      attrs: { type: 'text', placeholder: 'Identificativo del provider di identit\u00E0', 'aria-label': 'Identificativo della persona da invitare' },
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
      await load().then(render);
    });
    invite.appendChild(send);
    if (state.refusal !== null) {
      invite.appendChild(el(doc, 'p', { text: state.refusal, cls: 'bo-spazi-refusal' }));
    }
    invite.appendChild(el(doc, 'p', {
      text: 'Nessuna email parte da qui: l\u2019invito registra una decisione su un identificativo che il provider di identit\u00E0 conosce gi\u00E0.',
      cls: 'bo-muted',
    }));
    section.appendChild(invite);
    box.appendChild(section);
  }

  function renderSwitches(box, space) {
    const section = el(doc, 'section', { cls: 'bo-spazi-section' });
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
          await load().then(render);
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

  function render() {
    clear();
    const space = activeSpace();
    renderHeader(mount);
    renderSpaces(mount);
    if (space === null) {
      mount.appendChild(el(doc, 'p', {
        text: 'Scegli uno spazio per vederne il team e i permessi AI.',
        cls: 'bo-muted',
      }));
      return;
    }
    renderTeam(mount, space);
    renderSwitches(mount, space);
  }

  async function renderView() {
    await load();
    render();
  }

  return { render: renderView };
}