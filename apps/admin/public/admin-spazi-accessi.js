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

import { humanReadError, humanWriteError } from './admin-core.js';
import { bindAdminMutations } from './admin-submission.js';
import { CONNECTOR_BADGES, CONNECTOR_CATALOG } from './admin-connectors.js';
import { loadFixCount, settingsTabs } from './admin-shell.js';
import { loadSpaceAgents, renderTeamAgentRows } from './admin-agenti.js';
import { memberText } from './admin-labels.js';

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

/**
 * The master AI switch of one space (backlog:2c3156a47f8e): one on/off for
 * the whole AI, above the five single switches. Key and default mirror
 * `packages/space-permissions` — the drift test pins the pair. With the
 * master off every AI action becomes a proposal to approve, no matter what
 * the five say; with it on, the five decide one by one.
 */
export const SPAZI_AI_MASTER = Object.freeze({
  key: 'ai-enabled',
  label: 'AI dello spazio',
  line: 'Accende e spegne tutta l\u2019AI di questo spazio. Da spenta, ogni azione diventa una proposta da approvare.',
});

/** Master default, mirrored from the package — a space with no master row runs with the AI on. */
export const SPAZI_AI_MASTER_DEFAULT = true;

/**
 * Italian names for the control-plane membership roles the spine mirrors —
 * the same words the shell prints under the space name and the user
 * (admin-session.js), so one screen never calls the same role «Titolare»
 * in the sidebar and something else in the card (prototype 08: «Tu:
 * Titolare»).
 */
export const SPACE_ROLE_LABELS = Object.freeze({
  owner: 'Titolare',
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
 * backlog:67e14a50efb6 (specs/account.md C13): the shared calendar state of
 * one space, read from the same `GET /api/connectors` answer the cards
 * already count — never a new request and never a per-person invention (the
 * framework stores no per-member connection). Only an `active` calendar
 * entry reads as collegato; a suspended or revoked one reads scollegato; a
 * pending entry, or no calendar entry at all, reads da collegare. Anything
 * but an array (unreadable connectors) yields null, and the row says so
 * instead of inventing a line.
 * @param {unknown} connectors
 */
export function teamCalendarState(connectors) {
  if (!Array.isArray(connectors)) return null;
  const calendars = connectors.filter((entry) => entry !== null && typeof entry === 'object'
    && /** @type {{channel?: unknown}} */ (entry).channel === 'calendar');
  if (calendars.some((entry) => /** @type {{status?: unknown}} */ (entry).status === 'active')) {
    return 'Calendario condiviso: collegato';
  }
  if (calendars.some((entry) => /** @type {{status?: unknown}} */ (entry).status === 'suspended'
    || /** @type {{status?: unknown}} */ (entry).status === 'revoked')) {
    return 'Calendario condiviso: scollegato';
  }
  return 'Calendario condiviso: da collegare';
}

/**
 * backlog:67e14a50efb6 (specs/account.md C14): one tile per active channel
 * of the space, in the same vocabulary the Connettori rows paint
 * (`CONNECTOR_BADGES`, `CONNECTOR_CATALOG` — reused, never redefined). The
 * calendar is not a tile: it keeps its own state line above. Sorted by
 * channel so the row is stable regardless of store order; an entry without
 * a usable channel never tiles, and an unknown channel tiles «?» like the
 * Connettori rows instead of inventing one. Anything but an array tiles
 * nothing.
 * @param {unknown} connectors
 */
export function teamChannelTiles(connectors) {
  if (!Array.isArray(connectors)) return [];
  const seen = new Set();
  const tiles = [];
  for (const entry of connectors) {
    if (entry === null || typeof entry !== 'object') continue;
    const shaped = /** @type {{channel?: unknown, status?: unknown}} */ (entry);
    if (typeof shaped.channel !== 'string' || shaped.channel === '' || shaped.channel === 'calendar') continue;
    if (shaped.status !== 'active') continue;
    if (seen.has(shaped.channel)) continue;
    seen.add(shaped.channel);
    const badge = /** @type {Record<string, {tile: string, tint: string}>} */ (CONNECTOR_BADGES)[shaped.channel]
      ?? { tile: '?', tint: 'ui-chip-plain' };
    const catalog = CONNECTOR_CATALOG.find((candidate) => candidate.channel === shaped.channel) ?? null;
    tiles.push({
      channel: shaped.channel,
      tile: badge.tile,
      tint: badge.tint,
      label: catalog !== null ? catalog.label : shaped.channel,
    });
  }
  return tiles.sort((left, right) => (left.channel < right.channel ? -1 : left.channel > right.channel ? 1 : 0));
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
      // Prototype 08 prints a line under the name («Interior design ·
      // Milano»). Only a space that carries one shows it: the shell's
      // space list holds no description today, and none is ever invented.
      description: typeof /** @type {any} */ (space).description === 'string'
        && /** @type {any} */ (space).description.trim() !== ''
        ? /** @type {any} */ (space).description.trim()
        : null,
      initials: typeof space.initials === 'string' && space.initials !== '' ? space.initials : '·',
      role: spaceRoleLabel(role),
      roleKnown: typeof role === 'string' && role !== '',
      active: space.id === activeSpaceId,
    }));
}

/**
 * Avatar initials for a team subject: the first two alphanumeric characters,
 * uppercased. The spine store itself carries no display name; when the
 * roster arrives without the enriched displayName/email, the subject is the
 * only honest source — never a prettier invention (buildTeamRows uses the
 * person name when the roster carries one).
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

/** Strongest role first: a person holding two subjects shows the higher one. */
const ROLE_RANK = Object.freeze(['owner', 'operator', 'observer']);

/** Liveliest status first: a person reads «sospeso» only when no subject is live. */
const STATUS_RANK = Object.freeze(['active', 'invited', 'pending']);

/**
 * Avatar initials for a person name: the first letter of the first two
 * words («Daniele Pelleri» → «DP»), or the subject rule for one word.
 * @param {string} name
 */
function nameInitials(name) {
  const words = name.split(/\s+/).map((word) => word.replace(/[^0-9a-zA-ZÀ-Þà-ÿ]/g, '')).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return memberInitials(name);
}

/**
 * backlog:810ed0bfd505 AC-2 — the control-plane same-person key of a roster
 * row (`operatorAccountId`, one per human), or null when the roster carries
 * none. The same union the Calendario team reads (`personRows` there): this
 * key unites one member's identities (broker, github, google) even when
 * they carry different mailboxes. Only this documented key merges —
 * generic `personKey`/`userId`-style fields have no producer contract here,
 * and two unrelated humans sharing one would fold into a single row.
 * @param {unknown} member
 */
function rosterPersonKey(member) {
  if (!member || typeof member !== 'object') return null;
  const value = /** @type {{operatorAccountId?: unknown}} */ (member).operatorAccountId;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * One team row per PERSON. The roster (`GET /api/spine/memberships`) may
 * carry, beside each opaque subject, the control-plane displayName, email
 * and `operatorAccountId` the pilot enriches it with — the same fields the
 * Calendario team reads. One human can hold several subjects (an adopted
 * broker member, the github one and the Google one: prod 07/11 listed
 * «Daniele Pelleri» twice with `broker+…@accordo.invalid` mailboxes).
 * Subjects merge into one row on the control-plane person key first
 * (backlog:810ed0bfd505 AC-2: `operatorAccountId`, one per human), then —
 * only without that key — when both the mailbox and the display name match
 * (trimmed, case-insensitive). Two explicit person keys never fold into one
 * row: the mailbox fallback joins only a group with no key of its own, or
 * the same key. A mailbox alone never merges: a shared mailbox (info@…)
 * or stale enrichment could fold a different human into the row, hide them
 * and let «Rimuovi» suspend them. A name alone never merges either: two
 * homonyms without email are two people. Nothing merges
 * in the backend: the row keeps every subject, and removal suspends each
 * of them. Internal broker mailboxes (`…@accordo.invalid`) never paint:
 * the row shows the person's first real mailbox, or no email line when
 * the roster carries none — the name is then the profile displayName.
 *
 * Without enrichment the subject is the name when it reads as one, else
 * «Membro del team» — never a technical subject (production 10/11) — and
 * the status sits under it. Sorted by name, then subject, so the
 * list is stable regardless of store order.
 * @param {Array<{subject?: unknown, role?: unknown, status?: unknown, displayName?: unknown, email?: unknown, operatorAccountId?: unknown}>} members
 */
export function buildTeamRows(members = []) {
  const list = Array.isArray(members) ? members : [];
  /** @type {Array<{subjects: string[], live: string[], displayName: string|null, email: string|null, key: string|null, roles: unknown[], statuses: unknown[]}>} */
  const people = [];
  const byIdentity = new Map();
  const byPersonKey = new Map();
  const seen = new Set();
  for (const member of list) {
    if (!member || typeof member !== 'object' || typeof member.subject !== 'string' || member.subject === '') continue;
    if (seen.has(member.subject)) continue;
    seen.add(member.subject);
    // Never a technical identity on screen (production 10/11: the team read
    // «broker+…@accordo.invalid»): the shared member filter drops a broker
    // mailbox or a provider id the enrichment carried as name or email.
    const email = memberText(member.email);
    const displayName = memberText(member.displayName);
    const personKey = rosterPersonKey(member);
    const key = email === null || displayName === null
      ? null
      : `${email.toLowerCase()}\u0000${displayName.replace(/\s+/g, ' ').toLowerCase()}`;
    let person = (personKey !== null && byPersonKey.get(personKey)) || null;
    if (person === null && key !== null) {
      const candidate = byIdentity.get(key) ?? null;
      // Two explicit operator keys never fold into one row: the mailbox
      // fallback only joins a group with no key of its own, or the same
      // key — otherwise a shared mailbox would bridge two operator
      // accounts and «Rimuovi» would suspend a stranger (Codex P2 on
      // backlog:ed0552dc1933).
      if (candidate !== null && (personKey === null || candidate.key === null || candidate.key === personKey)) {
        person = candidate;
      }
    }
    if (person === null) {
      person = { subjects: [], live: [], displayName: null, email: null, key: null, roles: [], statuses: [] };
      people.push(person);
    }
    if (person.key === null) person.key = personKey;
    if (personKey !== null && !byPersonKey.has(personKey)) byPersonKey.set(personKey, person);
    if (key !== null && !byIdentity.has(key)) byIdentity.set(key, person);
    person.subjects.push(member.subject);
    if (member.status !== 'suspended') person.live.push(member.subject);
    person.roles.push(member.role);
    person.statuses.push(member.status);
    if (person.displayName === null) person.displayName = displayName;
    // The row shows a real mailbox only (`memberText` already dropped the
    // broker/technical ones), so the first real mailbox of the person wins
    // whatever the store order.
    if (person.email === null) person.email = email;
  }
  return people
    .map((person) => {
      const subject = [...person.subjects].sort()[0];
      // No readable name or mailbox: the subject when it reads as a word,
      // else a generic label — never a technical subject (`google|…`,
      // `broker+…`), the same fallback the Calendario team uses.
      const readable = person.displayName ?? person.email ?? memberText(subject);
      const name = readable ?? 'Membro del team';
      const known = person.roles.filter((role) => typeof role === 'string' && ROLE_RANK.includes(role));
      const role = known.length > 0
        ? [...known].sort((a, b) => ROLE_RANK.indexOf(/** @type {string} */ (a)) - ROLE_RANK.indexOf(/** @type {string} */ (b)))[0]
        : person.roles[0];
      // Deterministic, whatever the store order: the liveliest status wins,
      // and «sospeso» only when every subject of the person is suspended.
      const other = person.statuses.findIndex((status) => status !== 'suspended');
      const rawStatus = STATUS_RANK.find((status) => person.statuses.includes(status))
        ?? (other >= 0 ? person.statuses[other] : 'suspended');
      return {
        subject,
        subjects: [...person.subjects].sort(),
        // What «Rimuovi» suspends: every subject of the person not already
        // suspended (all of them when none is live, so a retry still asks).
        removable: [...(person.live.length > 0 ? person.live : person.subjects)].sort(),
        name,
        email: person.email,
        initials: person.displayName !== null
          ? nameInitials(person.displayName)
          : (readable !== null ? memberInitials(readable) : '·'),
        role: spaceRoleLabel(role),
        status: MEMBER_STATUS[/** @type {keyof typeof MEMBER_STATUS} */ (rawStatus)] ?? (typeof rawStatus === 'string' && rawStatus !== '' ? rawStatus : 'sconosciuto'),
      };
    })
    .sort((left, right) => {
      const a = left.name.toLowerCase();
      const b = right.name.toLowerCase();
      if (a !== b) return a < b ? -1 : 1;
      return left.subject < right.subject ? -1 : left.subject > right.subject ? 1 : 0;
    });
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
 * The master AI state of one space: the flipped master row wins, the
 * package default (on) covers a space with no master row. Rows of another
 * space never leak in — only rows carrying this space id are honored.
 * @param {string} spaceId
 * @param {Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>} [overrideRows]
 * @returns {boolean} true while the space AI is on
 */
export function masterEnabled(spaceId, overrideRows = []) {
  const rows = Array.isArray(overrideRows) ? overrideRows : [];
  const flipped = rows.find(
    (row) => row && typeof row === 'object' && row.spaceId === spaceId && row.permission === SPAZI_AI_MASTER.key,
  );
  return flipped ? flipped.enabled === true : SPAZI_AI_MASTER_DEFAULT === true;
}

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, cls?: string, attrs?: Record<string, string>}} [options]
 */
import { el, uiAddOption } from './admin-ui.js'; // BO-F6-02: the single component library.

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
    /** The invite menu (C21) opens above the inline form. */
    inviteMenuOpen: false,
    /** The new-space menu (C20) opens from the dashed box (C11). */
    newSpaceMenuOpen: false,
    /** @type {string|null} honest note when space creation is picked */
    newSpaceNote: null,
    /** @type {string|null} my membership role, or null when unknown */
    myRole: null,
    /** @type {Array<string>|null} roles the server advertises, or null */
    roles: null,
    /** @type {Array<any>|null} team rows, or null when unread */
    members: null,
    /** @type {Array<any>|null} this space's agents (backlog:33782ba68747), null when unread */
    agents: null,
    /** @type {string|null} why the team is not shown */
    membersUnavailable: null,
    /** @type {Array<any>|null} override rows, or null when unread */
    overrides: null,
    /** @type {string|null} why the switches are not shown */
    switchesUnavailable: null,
    /** @type {Map<string, string>} card statistic by space id; a space with
     * an unknown count simply has no entry, never an invented row */
    stats: new Map(),
    /**
     * backlog:67e14a50efb6: the raw connector entries behind each space's
     * statistic, so every team row paints this space's calendar state and
     * channel tiles from what production produced — no second request. An
     * unreadable space keeps `{entries: null}` with why, and the rows say
     * so instead of tiling nothing silently.
     * @type {Map<string, {entries: Array<any>|null, unreadable: 'not-composed'|'failed'|null}>}
     */
    spaceConns: new Map(),
    /** @type {string|null} subject armed for the two-step removal */
    confirmRemove: null,
    /** @type {{subject: string, reason: string, note: string}|null} a removal with refused subjects, offered again as «Riprova» */
    removeRetry: null,
    /** @type {{key: string, to: boolean}|null} switch flip armed for confirm */
    confirmFlip: null,
    busy: false,
    /**
     * backlog:7d30fb517785 (production 10/11: a refused AI switch printed its
     * refusal twice, once under the invite form, which opened by itself):
     * each refusal belongs to the control that failed and shows only there.
     * @type {string|null} last refused invite, shown inside the invite form
     */
    inviteRefusal: null,
    /** @type {{key: string, message: string}|null} last refused switch flip, shown under that switch */
    switchRefusal: null,
    // Voce 19c2e22a64a1 (1): the current space's own live fix count for the
    // Stato sync badge on the tab row — explicit, never another space's.
    /** @type {number | null} */ fixCount: null,
    /** @type {string | null} */ fixSpace: null,
  };

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /**
   * backlog:7d30fb517785: the text for a write the server answered but could
   * not take. A 5xx carrying the server's own code (production 10/11: 503
   * OPERATION_APP_UNAVAILABLE) is a server that cannot save right now, never
   * a refusal and never a connection fault; anything else keeps `refused`.
   * @param {any} failure @param {string} refused
   */
  function writeFailedText(failure, refused) {
    const status = typeof failure?.status === 'number' ? failure.status : null;
    return status !== null && status >= 500 ? 'Non riesco a salvare la modifica adesso, riprova tra poco.' : refused;
  }

  /** @param {string} message @param {boolean} [isError] */
  function say(message, isError = false) {
    toast(message, isError);
  }

  /**
   * Whether the last render put a write refusal next to its control. Review
   * #746 (P1): when it could not (the reload after the failure failed too,
   * or the control is gone), the refusal falls back to one toast with the
   * same text — there is always exactly one visible message.
   */
  let refusalPainted = false;

  /** After the post-failure render: the toast only when no inline copy shows. @param {string} message */
  function sayIfHidden(message) {
    if (!refusalPainted) say(message, true);
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
      // A fetch that never got an answer rejects with a TypeError: it keeps
      // the NETWORK code, so it is the one failure that reads «Connessione
      // non riuscita» (backlog:7d30fb517785).
      /** @type {{code: string, message: string, status?: number}} */
      const normalized = { code: error instanceof TypeError ? 'NETWORK' : 'UNKNOWN', message: error.message };
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
      // backlog:67e14a50efb6: keep the raw entries beside the statistic, so
      // the team rows tile this space's calendar and channels from the same
      // answer — no second request, no new failure mode.
      const entries = Array.isArray(channelsAnswer?.connectors) ? channelsAnswer.connectors : null;
      state.spaceConns.set(spaceId, { entries, unreadable: entries === null ? 'failed' : null });
      return formatSpaceStat({
        channels: countSpaceChannels(channelsAnswer),
        members: memberCount,
        customers: countSpaceCustomers(customersAnswer),
      });
    } catch (error) {
      // A missing row is not a page error, but a swallowed read nobody can
      // diagnose is: log the safe fields (code/status plus the space id,
      // never a message that could carry personal data), like AGENTS.md asks.
      const record = error !== null && typeof error === 'object' ? error : {};
      const code = typeof /** @type {{code?: unknown}} */ (record).code === 'string'
        ? /** @type {{code?: unknown}} */ (record).code
        : 'UNKNOWN';
      const status = typeof /** @type {{status?: unknown}} */ (record).status === 'number'
        ? /** @type {{status?: unknown}} */ (record).status
        : null;
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[bo] lettura fallita', { code, status, spaceId });
      }
      // backlog:67e14a50efb6: the team rows read this too — a 404 (the
      // connectors are not composed here) is honest scope, anything else a
      // transient failure — and both say so on the row, never silently bare.
      state.spaceConns.set(spaceId, {
        entries: null,
        unreadable: code === 'NOT_FOUND' || status === 404 ? 'not-composed' : 'failed',
      });
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
    state.spaceConns = new Map();
    state.confirmRemove = null;
    state.removeRetry = null;
    state.confirmFlip = null;
    state.inviteRefusal = null;
    state.switchRefusal = null;
    state.inviteMenuOpen = false;
    state.newSpaceMenuOpen = false;
    state.newSpaceNote = null;
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
    // backlog:33782ba68747: agents sit beside people; a failed or absent
    // read leaves the Team exactly as it was.
    state.agents = await loadSpaceAgents(client, space);
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
    // The statistic counts what the team list shows: rendered rows only, so a
    // malformed membership never leaks into the card number.
    const memberCount = Array.isArray(state.members) ? buildTeamRows(state.members).length : null;
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
      text: 'Passa da un\u2019attivit\u00E0 all\u2019altra senza uscire. Ogni spazio ha i suoi canali e clienti, e nessuno vede i dati degli altri; il team invece \u00E8 uno solo per tutta l\u2019organizzazione.',
      cls: 'bo-muted bo-spazi-lede',
    }));
  }

  function renderSpaces(box) {
    const cards = buildSpaziCards({ spaces: readSpaces(), activeSpaceId: readActiveSpace(), role: state.myRole });
    const grid = el(doc, 'div', { cls: 'bo-spazi-grid' });
    if (cards.length === 0) {
      grid.appendChild(el(doc, 'p', {
        text: 'Nessuno spazio in questa organizzazione: aggiungi uno spazio prima di continuare.',
        cls: 'bo-muted',
      }));
    }
    for (const card of cards) {
      const cell = el(doc, 'div', { cls: 'bo-spazi-card' });
      const head = el(doc, 'div', { cls: 'bo-spazi-head' });
      head.appendChild(el(doc, 'span', { text: card.initials, cls: 'bo-spazi-initials' }));
      const names = el(doc, 'div', { cls: 'bo-spazi-names' });
      names.appendChild(el(doc, 'div', { text: card.name, cls: 'bo-spazi-name' }));
      if (card.description !== null) {
        names.appendChild(el(doc, 'div', { text: card.description, cls: 'bo-muted bo-spazi-desc' }));
      }
      head.appendChild(names);
      cell.appendChild(head);
      const stat = state.stats.get(card.id) ?? null;
      if (stat !== null) {
        // Visible text keeps the prototype pattern (C7); the title qualifies
        // the org-wide numbers so no card reads as per-space customers.
        cell.appendChild(el(doc, 'div', {
          text: stat,
          cls: 'bo-spazi-stat bo-muted',
          attrs: { title: 'canali di questo spazio; persone e clienti dell\u2019intera organizzazione' },
        }));
      }
      // Prototype 08: the card foot pairs \u00abTu: <ruolo>\u00bb with the badge or
      // the small dark \u00abApri\u00bb on the right.
      const foot = el(doc, 'div', { cls: 'bo-spazi-foot' });
      const you = el(doc, 'span', { text: 'Tu: ', cls: 'bo-muted bo-spazi-you' });
      you.appendChild(el(doc, 'strong', { text: card.roleKnown ? card.role : 'ruolo non riconosciuto' }));
      foot.appendChild(you);
      if (card.active) {
        foot.appendChild(el(doc, 'span', { text: 'Stai lavorando qui', cls: 'bo-spazi-here' }));
      } else if (typeof deps.onPickSpace === 'function') {
        const open = el(doc, 'button', { text: 'Apri', cls: 'ui-btn ui-btn-primary ui-btn-small bo-spazi-open', attrs: { type: 'button' } });
        open.disabled = state.busy;
        open.addEventListener('click', () => {
          deps.onPickSpace(card.id);
          if (typeof navigate === 'function') navigate('#/');
          void refresh();
        });
        foot.appendChild(open);
      }
      cell.appendChild(foot);
      grid.appendChild(cell);
    }
    // C11: the dashed box stays last; its menu carries the verbatim C20
    // voices. Creation itself lives in the control plane (no capability
    // here), so picking a voice never invents a space.
    const adder = el(doc, 'div', { cls: 'bo-spazi-card bo-spazi-adder' });
    const adderToggle = el(doc, 'button', {
      text: '+ Nuovo spazio di lavoro',
      cls: 'bo-spazi-quiet',
      attrs: {
        type: 'button',
        'aria-haspopup': 'true',
        'aria-expanded': state.newSpaceMenuOpen ? 'true' : 'false',
      },
    });
    adderToggle.disabled = state.busy;
    adderToggle.addEventListener('click', () => {
      state.newSpaceMenuOpen = !state.newSpaceMenuOpen;
      state.newSpaceNote = null;
      render();
    });
    adder.appendChild(adderToggle);
    if (state.newSpaceMenuOpen) {
      const menu = el(doc, 'div', { cls: 'ui-add-menu', attrs: { role: 'menu', 'aria-label': 'Nuovo spazio di lavoro' } });
      const aiVoice = uiAddOption(doc, { kind: 'ai', title: 'Crea con l\u2019AI', line: 'Descrivi l\u2019attivit\u00E0, propongo canali e team' });
      aiVoice.addEventListener('click', () => {
        state.newSpaceMenuOpen = false;
        state.newSpaceNote = null;
        say('La creazione con l\u2019AI non \u00E8 ancora disponibile: lo spazio si crea dal control plane.');
        render();
      });
      const manualVoice = uiAddOption(doc, { kind: 'manual', title: 'Compila manualmente', line: 'Nome e settore' });
      manualVoice.addEventListener('click', () => {
        state.newSpaceMenuOpen = false;
        state.newSpaceNote = 'La creazione di uno spazio vive nel control plane e non \u00E8 ancora esposta qui: nessuno spazio \u00E8 stato creato.';
        render();
      });
      menu.appendChild(aiVoice);
      menu.appendChild(manualVoice);
      adder.appendChild(menu);
    }
    if (state.newSpaceNote !== null) {
      adder.appendChild(el(doc, 'p', { text: state.newSpaceNote, cls: 'bo-muted' }));
    }
    grid.appendChild(adder);
    box.appendChild(grid);
  }

  /**
   * backlog:67e14a50efb6 (specs/account.md C13/C14): the calendar-and-channels
   * line of one team row — the shared state from `conns`, painted with text
   * only (createElement + textContent, never markup). An unreadable space
   * says why on the row instead of staying silently bare.
   * @param {{entries: Array<any>|null, unreadable: 'not-composed'|'failed'|null}} conns
   */
  function renderTeamConns(conns) {
    const line = el(doc, 'div', { cls: 'bo-spazi-conns' });
    if (conns.entries !== null) {
      line.appendChild(el(doc, 'span', { text: teamCalendarState(conns.entries), cls: 'bo-spazi-calendar' }));
      for (const tile of teamChannelTiles(conns.entries)) {
        line.appendChild(el(doc, 'span', {
          text: tile.tile,
          cls: `ui-chip ${tile.tint} bo-spazi-tile`,
          attrs: { title: `${tile.label} di questo spazio` },
        }));
      }
      return line;
    }
    line.appendChild(el(doc, 'span', {
      text: conns.unreadable === 'not-composed'
        ? 'Canali e calendario non sono attivi in questo spazio.'
        : 'Canali e calendario non leggibili al momento.',
      cls: 'bo-spazi-calendar',
    }));
    return line;
  }

  function renderTeam(box) {
    const section = el(doc, 'section', { cls: 'bo-spazi-section bo-spazi-panel bo-spazi-team-panel' });
    // Prototype 08: the team card head carries the green «Invita persona»,
    // which opens the invite form in place.
    const teamHead = el(doc, 'div', { cls: 'bo-spazi-teamhead' });
    teamHead.appendChild(el(doc, 'h3', { text: 'Team dell\u2019organizzazione' }));
    // C21: «Invita persona» opens a two-voice menu with verbatim subtitles.
    // Manual entry opens the existing inline spine form below; the AI voice
    // stays honest (no invention) until a capability exists.
    const inviteToggle = el(doc, 'button', { text: 'Invita persona ▾', cls: 'cta bo-spazi-invite-toggle', attrs: { type: 'button', 'aria-haspopup': 'true', 'aria-expanded': (state.inviteMenuOpen || state.inviteOpen) ? 'true' : 'false' } });
    inviteToggle.addEventListener('click', () => {
      if (state.inviteMenuOpen) {
        state.inviteMenuOpen = false;
      } else if (state.inviteOpen) {
        state.inviteOpen = false;
      } else {
        state.inviteMenuOpen = true;
      }
      render();
    });
    teamHead.appendChild(inviteToggle);
    section.appendChild(teamHead);
    if (state.inviteMenuOpen) {
      const inviteMenu = el(doc, 'div', { cls: 'ui-add-menu bo-spazi-invite-menu', attrs: { role: 'menu', 'aria-label': 'Invita persona' } });
      const inviteAi = uiAddOption(doc, { kind: 'ai', title: 'Crea con l\u2019AI', line: 'Es. \u00ABLuca, vendite, solo Instagram e WhatsApp\u00BB' });
      inviteAi.addEventListener('click', () => {
        state.inviteMenuOpen = false;
        say('Gli inviti con l\u2019AI non sono ancora disponibili: usa Compila manualmente.');
        render();
      });
      const inviteManual = uiAddOption(doc, { kind: 'manual', title: 'Compila manualmente', line: 'Email e ruolo' });
      inviteManual.addEventListener('click', () => {
        state.inviteMenuOpen = false;
        state.inviteOpen = true;
        render();
      });
      inviteMenu.appendChild(inviteAi);
      inviteMenu.appendChild(inviteManual);
      section.appendChild(inviteMenu);
    }
    section.appendChild(el(doc, 'p', {
      text: 'Lo stesso team per tutta l\u2019organizzazione: rimuovere sospende la persona nell\u2019intera organizzazione, non nel singolo spazio.',
      cls: 'bo-muted',
    }));
    if (state.members === null) {
      section.appendChild(el(doc, 'p', { text: state.membersUnavailable ?? 'Team non disponibile.', cls: 'bo-muted' }));
      box.appendChild(section);
      return;
    }
    const rows = buildTeamRows(state.members);
    // backlog:67e14a50efb6 (specs/account.md C13/C14): every team row paints
    // this space's shared calendar state and channel tiles from the same
    // connectors answer the cards counted — the team is one per organization
    // while the channels live per space, so the line repeats on each row and
    // the titles say whose it is.
    const conns = state.spaceConns.get(readActiveSpace()) ?? { entries: null, unreadable: 'failed' };
    const list = el(doc, 'div', { cls: 'bo-spazi-team' });
    if (rows.length === 0) {
      list.appendChild(el(doc, 'p', { text: 'Nessun membro oltre a te.', cls: 'bo-muted' }));
    }
    for (const row of rows) {
      const item = el(doc, 'div', { cls: 'bo-spazi-member' });
      const identity = el(doc, 'div', { cls: 'bo-spazi-identity' });
      identity.appendChild(el(doc, 'span', { text: row.initials, cls: 'bo-spazi-avatar', attrs: { 'aria-hidden': 'true' } }));
      const names = el(doc, 'div', { cls: 'bo-spazi-names' });
      // Prototype 08: name over email. The email line carries the
      // ellipsis (C13) with the full address in its title; a non-active
      // status joins it. A roster without email keeps the status line.
      names.appendChild(el(doc, 'div', { text: row.name, cls: 'bo-spazi-subject' }));
      if (row.email !== null) {
        const line = row.status === 'attivo' ? row.email : `${row.email} \u00b7 ${row.status}`;
        names.appendChild(el(doc, 'div', { text: line, cls: 'bo-spazi-status bo-spazi-email', attrs: { title: row.email } }));
      } else {
        names.appendChild(el(doc, 'div', { text: row.status, cls: 'bo-spazi-status' }));
      }
      names.appendChild(renderTeamConns(conns));
      identity.appendChild(names);
      item.appendChild(identity);
      item.appendChild(el(doc, 'span', { text: row.role, cls: 'bo-spazi-role' }));
      if (state.confirmRemove !== null && row.subjects.includes(state.confirmRemove)) {
        const retry = state.removeRetry !== null && row.subjects.includes(state.removeRetry.subject)
          ? state.removeRetry
          : null;
        const confirmBox = el(doc, 'div', { cls: 'bo-spazi-confirm' });
        confirmBox.appendChild(el(doc, 'p', {
          text: `Rimuovere ${row.name} dal team? La sospensione vale per l\u2019intera organizzazione. Il motivo resta registrato.`,
          cls: 'bo-muted',
        }));
        if (retry !== null) {
          confirmBox.appendChild(el(doc, 'p', { text: retry.note, cls: 'bo-spazi-refusal', attrs: { role: 'alert' } }));
          refusalPainted = true;
        }
        const reason = el(doc, 'input', {
          cls: 'bo-spazi-input',
          attrs: { type: 'text', placeholder: 'Motivo (obbligatorio)', 'aria-label': `Motivo della rimozione di ${row.name}` },
        });
        if (retry !== null) reason.value = retry.reason;
        confirmBox.appendChild(reason);
        const yes = el(doc, 'button', {
          text: retry !== null ? 'Riprova' : 'Conferma rimozione',
          cls: 'bo-spazi-danger',
          attrs: { type: 'button' },
        });
        yes.disabled = state.busy;
        yes.addEventListener('click', async () => {
          const motive = String(reason.value ?? '').trim();
          if (motive === '') {
            say('Serve un motivo: senza, il server rifiuta la rimozione.', true);
            return;
          }
          // One person may hold several subjects: each is suspended through
          // the same spine route, one at a time (mutate holds the busy flag),
          // and every outcome is collected — a refusal never hides what
          // already happened. Riprova then asks only for what was refused:
          // the reloaded roster no longer lists a suspended subject as live.
          /** @type {Array<{subject: string, failure: any}>} */
          const refused = [];
          for (const subjectId of row.removable) {
            try {
              await mutate(`/api/spine/memberships/${encodeURIComponent(subjectId)}/suspend`, { reason: motive });
            } catch (error) {
              refused.push({ subject: subjectId, failure: errorOf(error) });
            }
          }
          if (refused.length === 0) {
            say(`${row.name} rimosso dal team.`);
            state.confirmRemove = null;
            state.removeRetry = null;
            await refresh();
            return;
          }
          const total = row.removable.length;
          const done = total - refused.length;
          const why = humanWriteError(refused[0].failure, {
            failed: writeFailedText(refused[0].failure, total === 1
              ? 'La rimozione non \u00E8 riuscita. Riprova pi\u00F9 tardi.'
              : 'Il server ha rifiutato la sospensione.'),
          });
          const note = total === 1
            ? why
            : done === 0
              ? `Nessuno dei ${total} account di ${row.name} \u00E8 stato sospeso. ${why}`
              : `${row.name}: account sospesi ${done} su ${total}, rifiutati ${refused.length}. ${why} Riprova sospende solo quelli rifiutati.`;
          // One message, inside the row that failed; a toast only if it cannot show.
          await load();
          // load() closes every confirmation: reopen this one on a subject
          // that is still there, with the refusal and the motive kept.
          state.confirmRemove = refused[0].subject;
          state.removeRetry = { subject: refused[0].subject, reason: motive, note };
          render();
          sayIfHidden(note);
        });
        const no = el(doc, 'button', { text: 'Annulla', cls: 'bo-spazi-quiet', attrs: { type: 'button' } });
        no.addEventListener('click', () => { state.confirmRemove = null; state.removeRetry = null; render(); });
        confirmBox.appendChild(yes);
        confirmBox.appendChild(no);
        item.appendChild(confirmBox);
      } else {
        const remove = el(doc, 'button', { text: 'Rimuovi', cls: 'bo-spazi-quiet', attrs: { type: 'button' } });
        remove.disabled = state.busy;
        remove.addEventListener('click', () => { state.confirmRemove = row.subject; state.removeRetry = null; render(); });
        item.appendChild(remove);
      }
      list.appendChild(item);
    }
    section.appendChild(list);
    const agentRows = renderTeamAgentRows(doc, state.agents);
    if (agentRows) section.appendChild(agentRows);

    const invite = el(doc, 'div', { cls: `bo-spazi-invite${state.inviteOpen || state.inviteRefusal !== null ? ' open' : ''}` });
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
        const message = humanWriteError(failure, { failed: writeFailedText(failure, 'L’invito non è riuscito. Riprova più tardi.') });
        // One message, inside the form that failed; a toast only if it cannot show.
        await load();
        state.inviteRefusal = message;
        render();
        sayIfHidden(message);
        return;
      }
      await refresh();
    });
    invite.appendChild(send);
    if (state.inviteRefusal !== null) {
      invite.appendChild(el(doc, 'p', { text: state.inviteRefusal, cls: 'bo-spazi-refusal', attrs: { role: 'alert' } }));
      refusalPainted = true;
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
    if (state.overrides === null) {
      section.appendChild(el(doc, 'p', { text: state.switchesUnavailable ?? 'Permessi non disponibili.', cls: 'bo-muted' }));
      box.appendChild(section);
      return;
    }
    // The master switch (backlog:2c3156a47f8e) renders first and its state
    // is the panel's headline: with the master off the five stay visible
    // with their own honest values but disabled, because they decide
    // nothing until the master is back on.
    const master = masterEnabled(space.id, state.overrides);
    section.appendChild(el(doc, 'p', {
      text: master
        ? `AI dello spazio: accesa. Vale per tutto lo spazio ${space.name}. Quello che \u00E8 spento diventa una proposta da approvare.`
        : `AI dello spazio: spenta. Vale per tutto lo spazio ${space.name}: ogni azione diventa una proposta da approvare, finch\u00E9 non la riaccendi.`,
      cls: 'bo-muted',
    }));
    const switches = [
      {
        key: SPAZI_AI_MASTER.key,
        label: SPAZI_AI_MASTER.label,
        line: SPAZI_AI_MASTER.line,
        enabled: master,
        master: true,
      },
      ...effectiveSwitches(space.id, state.overrides),
    ];
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
      toggle.disabled = state.busy || (master === false && entry.master !== true);
      toggle.addEventListener('click', () => {
        state.confirmFlip = { key: entry.key, to: !entry.enabled };
        state.switchRefusal = null;
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
          text: entry.master === true
            ? (pending.to
              ? 'Accendere l\u2019AI dello spazio? Da accesa, i cinque interruttori decidono uno per uno.'
              : 'Spegnere l\u2019AI dello spazio? Da spenta, ogni azione diventa una proposta da approvare.')
            : (pending.to
              ? `Accendere \u00AB${entry.label}\u00BB? Da accesa, l\u2019AI agisce da sola.`
              : `Spegnere \u00AB${entry.label}\u00BB? Da spenta, diventa una proposta da approvare.`),
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
            // A server that cannot take the change right now (a 5xx with
            // its own code, e.g. OPERATION_APP_UNAVAILABLE) says so; a
            // refusal keeps its text; «Connessione non riuscita» only when
            // no answer came at all (humanWriteError draws that line).
            const message = humanWriteError(failure, { failed: writeFailedText(failure, 'La modifica non \u00E8 riuscita. Riprova pi\u00F9 tardi.') });
            // One message, under the switch that failed; a toast only if it cannot show.
            await load();
            state.confirmFlip = null;
            state.switchRefusal = { key: pending.key, message };
            render();
            sayIfHidden(message);
            return;
          }
          state.confirmFlip = null;
          await refresh();
        });
        const no = el(doc, 'button', { text: 'Annulla', cls: 'bo-spazi-quiet', attrs: { type: 'button' } });
        no.addEventListener('click', () => { state.confirmFlip = null; state.switchRefusal = null; render(); });
        confirmBox.appendChild(yes);
        confirmBox.appendChild(no);
        list.appendChild(confirmBox);
      }
      if (state.switchRefusal !== null && state.switchRefusal.key === entry.key && state.confirmFlip === null) {
        list.appendChild(el(doc, 'p', { text: state.switchRefusal.message, cls: 'bo-spazi-refusal', attrs: { role: 'alert' } }));
        refusalPainted = true;
      }
    }
    section.appendChild(list);
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
    refusalPainted = false;
    clear();
    const space = activeSpace();
    mount.appendChild(settingsTabs(doc, { activeId: 'spazi-accessi', fixCount: state.fixCount, navigate: typeof navigate === 'function' ? navigate : () => {} }));
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
    const space = readActiveSpace().trim();
    // A space change drops the previous space's count before anything
    // paints: the tabs never wear another space's badge, not even briefly.
    if (state.fixSpace !== space) {
      state.fixSpace = space;
      state.fixCount = null;
    }
    await load();
    if (mine !== generation) return;
    if (space !== '') {
      // Voce 19c2e22a64a1 (1): the badge counts this space live. A space
      // move mid-read keeps the unknown state instead of painting another
      // space's late count.
      const count = await loadFixCount(client, { spaceId: space });
      if (mine !== generation) return;
      if (readActiveSpace().trim() === space) state.fixCount = count;
    }
    const now = childrenOf();
    if (now.length !== before.length || now.some((node, index) => node !== before[index])) return;
    render();
  }

  async function renderView() {
    await refresh();
  }

  return { render: renderView };
}
