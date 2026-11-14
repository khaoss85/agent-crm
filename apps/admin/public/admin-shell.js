// @ts-check

import { sessionRoleLabel } from './admin-session.js';
import { el, uiAddOption, uiBusy, uiIcon, uiTabs } from './admin-ui.js'; // BO-F6-02: the single component library.
import { createCommandMenu } from './admin-cmdk.js';
import { moduleScreenLabel } from './admin-labels.js';
import { AGENT_MENTION_NEUTRAL, agentMentionPlaceholder } from './admin-agenti.js'; // MEM_ACC_REUSE: the team-agent placeholder lives with the team.

// BO-F0-02 — Backoffice shell and navigation model (sidebar, topbar, spaces).
//
// Reference: the approved backoffice prototype (sidebar on every screen with
// a space selector, Oggi, the "Moduli nativi / Moduli personalizzati" groups,
// "+ Nuovo modulo", "Impostazioni" with a badge and a user row with logout;
// topbar with the path and the AI bar entry). The bar opens the BO-F0-04
// assistant panel (apps/admin/public/admin-assistant.js); without an
// onAiSubmit callback it stays a plain entry that asks for a description.
//
// Conventions follow apps/admin/public/admin-core.js: the model builders are
// pure and DOM-free (unit-tested under node:test without a browser) and the
// renderer uses DOM APIs only — createElement + textContent/setAttribute —
// never innerHTML with data, so hostile space, user or module names are inert
// text, never markup.

/** Route for the settings entry. Its tabs land in BO-F0-03. */
export const SETTINGS_ROUTE = '#/impostazioni';

// BO-F6-01 icons and the element helper come from the single component
// library (BO-F6-02, apps/admin/public/admin-ui.js): `el` keeps the bo-*
// classes and adds the ui-* system ones, `uiIcon` covers every shell voice.
// No local icon geometry here (MEM_ACC_REUSE).

/** Storage keys for the local shell state (space selection only). */
export const ACTIVE_SPACE_KEY = 'accordo.activeSpace';
export const SPACES_KEY = 'accordo.spaces';

/**
 * Fixed sidebar voices from the prototype, in Italian, in prototype order.
 * `route: null` in this static table means the voice cannot link on its own:
 * `buildShellNav` resolves what the composition allows (Clienti, Pipeline,
 * Sequenze) and the rest renders disabled with the story named, never as a
 * dead link. Calendario links unconditionally like Reporting: the screen
 * itself renders honest states (not composed, no members named, empty week),
 * so it is never a dead link to a blank screen.
 * @typedef {{ id: string, label: string, group: 'home' | 'native' | 'custom' | 'settings', route: string | null, story: string, icon: string }} ShellItem
 */
export const SHELL_ITEMS = Object.freeze([
  { id: 'oggi', label: 'Oggi', group: 'home', route: '#/', story: 'BO-F0-02', icon: 'oggi' },
  { id: 'clienti', label: 'Clienti', group: 'native', route: '#/customer-data', story: 'BO-F1', icon: 'clienti' },
  { id: 'pipeline', label: 'Pipeline', group: 'native', route: null, story: 'BO-F2', icon: 'pipeline' },
  { id: 'calendario', label: 'Calendario', group: 'native', route: '#/calendario', story: 'BO-F3', icon: 'calendario' },
  // backlog:33782ba68747 put «Agenti» in the sidebar; backlog:b368bbf992ce
  // (Dan 11/11) gives Sequenze its voice back when the sequences module is
  // composed: `nav: false` here, and buildShellNav lifts it only then.
  { id: 'agenti', label: 'Agenti', group: 'native', route: null, story: 'backlog:33782ba68747', icon: 'agenti' },
  { id: 'sequenze', label: 'Sequenze', group: 'native', route: null, story: 'BO-F3', icon: 'sequenze', nav: false },
  { id: 'reporting', label: 'Reporting', group: 'custom', route: '#/reporting', story: 'BO-F5-01', icon: 'reporting' },
  // No voice of its own (prototype, design pass 6): the dashed "+ Nuovo modulo"
  // button under the voices is the entry, and its "Compila manualmente" opens
  // this route. Kept here so the route still resolves to a known screen.
  { id: 'nuovo-modulo', label: 'Nuovo modulo', group: 'custom', route: '#/nuovo-modulo', story: 'BO-F5-01', icon: 'nuovo-modulo', nav: false },
  // The Impostazioni voice opens the Personalizzazione tab directly (its
  // first area), never the settings index: the sidebar stays highlighted
  // through screenLabelFor('personalizzazione'). SETTINGS_ROUTE still names
  // the index for the space-manage entry.
  { id: 'impostazioni', label: 'Impostazioni', group: 'settings', route: '#/personalizzazione', story: 'BO-F0-02', icon: 'impostazioni' },
]);

/** Sidebar group headers, in render order. `null` renders no header. */
export const SHELL_GROUPS = Object.freeze([
  { id: 'home', header: null },
  { id: 'native', header: 'Moduli nativi' },
  { id: 'custom', header: 'Moduli personalizzati' },
  { id: 'settings', header: null },
]);

/**
 * The four settings areas from the prototype. Stato sync opens its own
 * screen (BO-F1-03, #/stato-sync) — the indicator, the fix list and the
 * channel table — once the customer-data package is composed, and stays an
 * honest note otherwise; Personalizzazione opens the
 * Skill/Connettori/Pacchetti screen (BO-F4-01), Catalogo prodotti opens
 * the product table delivered by BO-F2-05, and Spazi e accessi opens the
 * team screen delivered by BO-F0-06.
 */
export const SETTINGS_AREAS = Object.freeze([
  { id: 'personalizzazione', label: 'Personalizzazione', route: '#/personalizzazione', story: 'BO-F4-01' },
  { id: 'catalogo', label: 'Catalogo prodotti', route: '#/catalogo', story: 'BO-F2 (catalogo)' },
  { id: 'stato-sync', label: 'Stato sync', route: '#/stato-sync', story: 'BO-F1-03' },
  { id: 'spazi-accessi', label: 'Spazi e accessi', route: '#/spazi-accessi', story: 'BO-F0-06' },
  // backlog:8618ad3f72db: Profilo is a settings tab too, not only the name
  // at the foot of the sidebar.
  { id: 'profilo', label: 'Profilo', route: '#/profilo', story: 'BO-F6 (profilo)' },
]);

/**
 * Reason shown when the customer-data package is not composed in the space:
 * Clienti and Stato sync stay disabled instead of opening a blank screen.
 */
export const CUSTOMER_DATA_UNAVAILABLE_REASON = 'Clienti non composto in questo spazio';

/** AI-bar entry placeholder per screen, in Italian, from the prototype. */
const AI_PLACEHOLDERS = Object.freeze({
  oggi: 'Chiedi: «cosa è più urgente oggi?»',
  clienti: 'Chiedi: «chi devo ricontattare oggi?»',
  pipeline: 'Chiedi: «quanto posso chiudere questo mese?»',
  calendario: 'Scrivi: «trova 45 minuti con Marco e Sara»',
  sequenze: 'Scrivi: «crea una sequenza per i lead del sito»',
  // backlog:f06d06f242d6: no agent of the team can work yet (or the team is
  // still unknown): no example @name that would reach nobody.
  agenti: AGENT_MENTION_NEUTRAL,
  reporting: 'Chiedi: «chi ha gestito più call questo mese?»',
  'nuovo-modulo': 'Descrivi: «un modulo sonde per i KPI del pilota»',
  impostazioni: 'Chiedi: «cosa può fare l\u2019AI senza chiedermi?»',
  // BO-F6-16: the sync screen asks about sync, never the generic fallback.
  'stato-sync': 'Chiedi: «c\u2019è qualcosa che non si è sincronizzato?»',
});

export const AI_ENTRY_FALLBACK = 'Chiedi o fai qualcosa… (⌘K)';

/**
 * Backlog 7d169a3b1dd2: on the Agenti screen the placeholder names an
 * agent of this team that can work (backlog:f06d06f242d6), so «@Nome»
 * always reaches somebody; otherwise a neutral line.
 * @param {string} screenId
 * @param {string} [agentName]
 */
export function aiPlaceholder(screenId, agentName = '') {
  if (typeof screenId !== 'string') return AI_ENTRY_FALLBACK;
  if (screenId === 'agenti' && typeof agentName === 'string' && agentName.trim() !== '') {
    return agentMentionPlaceholder([{ name: agentName.trim() }]);
  }
  return AI_PLACEHOLDERS[screenId] ?? AI_ENTRY_FALLBACK;
}

/**
 * Breadcrumb for the topbar: "<space> / <screen>", as in the prototype.
 * @param {string} spaceName
 * @param {string} screenLabel
 */
export function crumb(spaceName, screenLabel) {
  return `${spaceName} / ${screenLabel}`;
}

/**
 * Badge text for the Impostazioni entry. The badge lights up only from a
 * real count of things to fix: zero (or unknown) renders no badge at all.
 * @param {unknown} fixCount
 */
export function settingsBadge(fixCount) {
  if (typeof fixCount !== 'number' || !Number.isInteger(fixCount) || fixCount <= 0) return '';
  return String(fixCount);
}

/**
 * Badge text for the Clienti entry (BO-F6-01): the live client count, like
 * the prototype's grey pill. Unknown (or uncomposed) renders no badge at
 * all — never 0-as-none. A partial server scan keeps its "+" so the pill
 * never claims an exactness the read does not have.
 * @param {unknown} count
 * @param {unknown} [exact]
 */
export function clientBadge(count, exact = true) {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return '';
  return exact === false ? `${count}+` : String(count);
}

/**
 * Read the live client count for the badge: the smallest supported page
 * over the same customer list the Clienti screen reads, keeping only its
 * `total`. pageSize=1 is rejected by parseCustomerListQuery (400: only 10,
 * 25 and 50 are accepted), so the badge asks for pageSize=10 — the endpoint
 * default — and never for an unsupported size.
 * Returns null (unknown) when the customer-data package is not composed or
 * a read fails — an unknown count must never light the badge.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @returns {Promise<{ count: number, exact: boolean } | null>}
 */
export async function loadClientCount(client) {
  try {
    const page = await client.request('/api/customer-data/customers?pageSize=10');
    const total = page?.total;
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return null;
    return { count: total, exact: page?.totalIsExact !== false };
  } catch (error) {
    // Review gate (AGENTS.md): a swallowed failure must leave its cause
    // diagnosable. Only the error name is logged — never record bodies,
    // cookies or personal data here.
    try {
      console.warn('bo-shell client count unreadable:', error instanceof Error ? error.name : 'unknown');
    } catch {
      // Logging must never break the badge read.
    }
    return null;
  }
}

/**
 * Count the real "things to fix": open data-quality issues plus unresolved
 * duplicate candidates. Same predicates the customer-data section renders
 * (`status === 'open'` / `status === 'unresolved'`), counted from the rows
 * actually read — never invented.
 * @param {{ issues?: Array<{ status?: unknown }>, candidates?: Array<{ status?: unknown }> }} rows
 */
export function countFixes({ issues = [], candidates = [] } = {}) {
  const openIssues = issues.filter((row) => row != null && row.status === 'open').length;
  const openCandidates = candidates.filter((row) => row != null && row.status === 'unresolved').length;
  return openIssues + openCandidates;
}

/**
 * Which space the Impostazioni badge counts for. The live session space
 * wins: under a real session the stored local space is empty (or belongs
 * to the development identity), and counting with it would silently drop
 * the sync half of the badge. Without a session the stored selection is
 * the space; with neither, the sync half stays unknown.
 * @param {unknown} sessionSpaceId the live session's space id, if any
 * @param {{ getItem?: unknown } | null | undefined} storage
 * @param {string} [key]
 * @returns {string} the space id to count for, or '' when unknown
 */
export function resolveBadgeSpaceId(sessionSpaceId, storage, key = ACTIVE_SPACE_KEY) {
  if (typeof sessionSpaceId === 'string' && sessionSpaceId !== '') return sessionSpaceId;
  try {
    const stored = storage?.getItem?.(key);
    if (typeof stored === 'string' && stored !== '') return stored;
  } catch {
    // A broken storage never breaks the badge: the count degrades to the
    // quality half, like an unknown space.
  }
  return '';
}

/**
 * Read the real fix count for the badge. Returns null (unknown) when the
 * customer-data package is not composed or a read fails: an unknown count
 * must never light the badge, and it must never render as "none" either.
 * With a selected space the count also adds the sync attention rows the
 * Stato sync screen lists (quarantined inbox rows plus open dead letters,
 * read from the same activity payload); a failed or uncomposed sync read
 * keeps the quality count instead of failing the badge — the screen shows
 * its own honest note for that half.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @param {{ spaceId?: unknown }} [options]
 * @returns {Promise<number | null>}
 */
export async function loadFixCount(client, options = {}) {
  try {
    const [issuesRead, candidatesRead] = await Promise.all([
      client.request('/api/modules/data-quality-issue/records?limit=100'),
      client.request('/api/modules/duplicate-candidate/records?limit=100'),
    ]);
    if (!Array.isArray(issuesRead?.items) || !Array.isArray(candidatesRead?.items)) return null;
    const base = countFixes({ issues: issuesRead.items, candidates: candidatesRead.items });
    const spaceId = typeof options?.spaceId === 'string' ? options.spaceId.trim() : '';
    if (spaceId === '') return base;
    try {
      const activity = await client.request(
        `/api/connectors/activity?spaceId=${encodeURIComponent(spaceId)}&feedLimit=1`,
      );
      const extra = activity !== null && typeof activity === 'object'
        && Number.isInteger(activity.needsFix) && activity.needsFix > 0 ? activity.needsFix : 0;
      return base + extra;
    } catch (error) {
      // Review gate (AGENTS.md): a swallowed failure must leave its cause
      // diagnosable. Only the error name and the workspace id are logged —
      // never record bodies, cookies or personal data here.
      try {
        console.warn('bo-shell sync count unreadable:', error instanceof Error ? error.name : 'unknown', `spaceId=${spaceId}`);
      } catch {
        // Logging must never break the badge read.
      }
      return base;
    }
  } catch (error) {
    // Review gate (AGENTS.md): a swallowed failure must leave its cause
    // diagnosable. Only the error name is logged — never record bodies,
    // cookies or personal data here.
    try {
      console.warn('bo-shell fix count unreadable:', error instanceof Error ? error.name : 'unknown');
    } catch {
      // Logging must never break the badge read.
    }
    return null;
  }
}

/**
 * A single local space, used until space records exist (BO-F0-06). Extra
 * spaces can be injected (tests, future backend); the switcher only moves
 * among the user's own spaces.
 */
export function defaultSpaces() {
  return [{ id: 'locale', name: 'Spazio locale', initials: 'SL' }];
}

/**
 * Read the spaces this browser actually stored — visited space mounts —
 * without any fallback: missing, corrupt or empty data is an empty list,
 * never a fictitious space. Use it when another source (the session
 * profile) already names the person's spaces; the development fallback
 * would leak a «Spazio locale» into a real session and persist it.
 * @param {{ getItem?: (key: string) => string | null } | null | undefined} storage
 */
export function readStoredSpaces(storage) {
  try {
    const raw = storage?.getItem?.(SPACES_KEY);
    if (typeof raw !== 'string' || raw === '') return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry != null && typeof entry.id === 'string' && entry.id !== ''
        && typeof entry.name === 'string' && entry.name !== '')
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        initials: typeof entry.initials === 'string' && entry.initials !== ''
          ? entry.initials.slice(0, 2).toUpperCase()
          : spaceInitialsFor(entry.name),
      }));
  } catch {
    return [];
  }
}

/**
 * Read user spaces from a storage-like object. Corrupt or missing data
 * falls back to the single local space — never an empty list. Sessionless
 * shell only: under a session use readStoredSpaces so the fallback never
 * merges into the person's real spaces.
 * @param {{ getItem?: (key: string) => string | null } | null | undefined} storage
 */
export function readSpaces(storage) {
  const stored = readStoredSpaces(storage);
  return stored.length > 0 ? stored : defaultSpaces();
}

/**
 * Join two space lists into one menu list (backlog:029409ff): the primary
 * source first (the session profile's spaces), then any extra the secondary
 * source names (spaces this browser already opened, under a session that
 * only carries the current space). Entries keep the readSpaces shape;
 * blanks are dropped, duplicates collapse on id, order is stable — the
 * menu never renders a blank or doubled row, and the result is never
 * empty: with nothing usable it falls back to the single local space.
 * @param {unknown} primary
 * @param {unknown} secondary
 */
export function mergeSpaces(primary, secondary) {
  const clean = (value) => {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue;
      const id = typeof /** @type {any} */ (entry).id === 'string'
        ? /** @type {any} */ (entry).id.trim() : '';
      const name = typeof /** @type {any} */ (entry).name === 'string'
        ? /** @type {any} */ (entry).name.trim() : '';
      if (id === '' || name === '') continue;
      if (out.some((known) => known.id === id)) continue;
      const initials = typeof /** @type {any} */ (entry).initials === 'string'
        && /** @type {any} */ (entry).initials.trim() !== ''
        ? /** @type {any} */ (entry).initials.trim().slice(0, 2).toUpperCase()
        : spaceInitialsFor(name);
      out.push({ id, name, initials });
    }
    return out;
  };
  const merged = [...clean(primary)];
  for (const entry of clean(secondary)) {
    if (merged.some((known) => known.id === entry.id)) continue;
    merged.push(entry);
  }
  return merged.length > 0 ? merged : defaultSpaces();
}

/**
 * Resolve a ⌘1/2/3 (or Ctrl+1/2/3) keypress to a space id among the user's
 * spaces. Anything else — no modifier, another key, out of range — is null.
 * @param {{ metaKey?: boolean, ctrlKey?: boolean, key?: string }} event
 * @param {Array<{ id: string }>} spaces
 */
export function resolveSpaceShortcut(event, spaces) {
  if (event == null || (event.metaKey !== true && event.ctrlKey !== true)) return null;
  const key = event.key;
  if (typeof key !== 'string' || !/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  if (!Array.isArray(spaces) || index < 0 || index >= spaces.length) return null;
  const target = spaces[index];
  return target != null && typeof target.id === 'string' ? target.id : null;
}

/**
 * Space badge initials from the space name (backlog:ecb26347d12c): the
 * first letter of the first two words («Presti Group» → «PG»), else the
 * first two alphanumeric characters («Presti» → «PR»). The same word rule
 * as `nameInitials` in admin-spazi-accessi.js — reused here, never a new
 * rule — so «Spazio locale» reads «SL» like defaultSpaces().
 * @param {unknown} name
 */
export function spaceInitialsFor(name) {
  if (typeof name !== 'string') return '·';
  const words = name.split(/\s+/)
    .map((word) => word.replace(/[^0-9a-zA-ZÀ-Þà-ÿ]/g, ''))
    .filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  const clean = name.replace(/[^0-9a-zA-ZÀ-Þà-ÿ]/g, '');
  if (clean === '') return '·';
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Badge color for one space (backlog:ecb26347d12c): a deterministic hue
 * from the space id, so two spaces never share the badge color and the
 * same space reads the same everywhere. White text stays readable on it.
 * @param {unknown} id
 */
export function spaceBadgeColor(id) {
  const text = typeof id === 'string' ? id : '';
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 45% 42%)`;
}

/**
 * The «Cambia spazio» button label (backlog:ecb26347d12c): it lists only
 * the shortcuts that exist — «Cambia spazio (⌘1/2)» with two spaces,
 * never the fixed «(⌘1/2/3)». Past nine spaces only ⌘1…⌘9 exist.
 * @param {unknown} spaces
 */
export function spaceSwitcherLabel(spaces) {
  const count = Array.isArray(spaces) ? spaces.length : 0;
  const shown = Math.max(0, Math.min(count, 9));
  if (shown < 2) return 'Cambia spazio';
  const parts = [];
  for (let n = 1; n <= shown; n++) parts.push(String(n));
  return `Cambia spazio (⌘${parts.join('/')})`;
}

/**
 * Space-menu rows with the ⌘N hint, in order. Only the first nine spaces
 * get a hint; the rest render without one. Display initials never repeat
 * (backlog:ecb26347d12c): the stored sigla wins while it is unique, then
 * the word rule («Prova Validazione B1» → «PV»), then longer slices of
 * the name — the first unused candidate, so «Presti Group» and «Prova
 * Validazione B1» read differently even when both arrive as «PR».
 * @param {Array<{ id: string, name: string, initials?: string }>} spaces
 * @param {string} activeId
 */
export function spaceMenuItems(spaces, activeId) {
  const list = Array.isArray(spaces) ? spaces : [];
  const seen = new Set();
  return list.map((space, index) => {
    const name = typeof space?.name === 'string' ? space.name : '';
    const stored = typeof space?.initials === 'string' && space.initials.trim() !== ''
      ? space.initials.trim().toUpperCase()
      : '';
    const word = spaceInitialsFor(name);
    const clean = name.replace(/[^0-9a-zA-ZÀ-Þà-ÿ]/g, '').toUpperCase();
    const candidates = stored !== '' ? [stored, word] : [word];
    if (clean.length >= 3) candidates.push(clean.slice(0, 3));
    if (clean.length >= 3) candidates.push(`${clean[0]}${clean[clean.length - 1]}`);
    let initials = candidates[0] ?? '·';
    for (const candidate of candidates) {
      if (candidate !== '' && !seen.has(candidate)) {
        initials = candidate;
        break;
      }
    }
    seen.add(initials);
    return {
      id: space.id,
      name: space.name,
      initials,
      color: spaceBadgeColor(space?.id),
      keyHint: index < 9 ? `⌘${index + 1}` : '',
      active: space.id === activeId,
    };
  });
}

/**
 * Whether the open screen must re-render when the operator switches space
 * (review #661): every screen that reads or writes space-scoped rows. The
 * card shows space-scoped calls, Stato sync pulls for one space, the
 * mounted home greets with the space name, and Agenti / Sequenze read and
 * write the space's agents and sequences — left alone they would keep the
 * space just left behind. Calendario too (review #664): its week and its
 * queued phrase search belong to one space.
 * @param {unknown} view the routed view id
 * @param {{ mounted?: boolean }} [options]
 */
export function rerendersOnSpaceSwitch(view, { mounted = false } = {}) {
  if (view === 'dashboard') return mounted === true;
  return view === 'customer-card' || view === 'sync' || view === 'agenti' || view === 'sequenze' || view === 'calendario';
}

/**
 * Build the sidebar model: fixed prototype voices plus the user's custom
 * modules (opt-in bundles are the "personalizzati" group). BO-F6-01: kernel
 * generated tables (channel inbox rows, import state, quality rows and the
 * like) never list — only entries the server marks `origin: 'bundle'` join
 * the sidebar, so an unknown or kernel origin stays out fail-closed. The
 * Pipeline voice resolves to the first composed pipeline; every other
 * not-yet delivered voice stays disabled with its story named. Clienti is
 * available only when the customer-data package is composed in the space
 * (customerDataAvailable), Sequenze only when the sequences package is
 * composed (sequencesAvailable): otherwise each stays disabled with its
 * story, like Pipeline/Calendario, never as a dead link to a blank screen.
 * Agenti only when the agents package is composed (agentsAvailable).
 * @param {{ pipelines?: Array<{ name?: unknown, label?: unknown }>, customModules?: Array<{ name?: unknown, origin?: unknown }>, customerDataAvailable?: boolean, sequencesAvailable?: boolean, agentsAvailable?: boolean }} input
 */
export function buildShellNav({ pipelines = [], customModules = [], customerDataAvailable = false, sequencesAvailable = false, agentsAvailable = false } = {}) {
  const firstPipeline = pipelines.find(
    (pipeline) => typeof pipeline?.name === 'string' && /^[a-z][a-z0-9-]*$/.test(pipeline.name),
  );
  const items = SHELL_ITEMS.map((item) => {
    if (item.id === 'clienti') {
      if (customerDataAvailable) {
        return { ...item, available: true, disabledReason: '' };
      }
      return { ...item, route: null, available: false, disabledReason: CUSTOMER_DATA_UNAVAILABLE_REASON };
    }
    if (item.id === 'pipeline') {
      if (firstPipeline) {
        return { ...item, route: `#/pipelines/${firstPipeline.name}`, available: true, disabledReason: '' };
      }
      return { ...item, route: null, available: false, disabledReason: 'Nessuna pipeline composta' };
    }
    if (item.id === 'agenti') {
      if (agentsAvailable) {
        return { ...item, route: '#/agenti', available: true, disabledReason: '' };
      }
      return { ...item, route: null, available: false, disabledReason: 'Agenti non attivi in questo spazio' };
    }
    if (item.id === 'sequenze') {
      if (sequencesAvailable) {
        return { ...item, route: '#/sequenze', available: true, disabledReason: '', nav: true };
      }
      return { ...item, route: null, available: false, disabledReason: 'In arrivo con BO-F3' };
    }
    if (item.route === null) {
      return { ...item, available: false, disabledReason: `In arrivo con ${item.story}` };
    }
    return { ...item, available: true, disabledReason: '' };
  });
  for (const module of customModules) {
    if (module == null || typeof module.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(module.name)) continue;
    if (module.origin !== 'bundle') continue;
    items.push({
      id: `module-${module.name}`,
      label: module.name,
      group: 'custom',
      route: `#/modules/${module.name}`,
      story: 'BO-F0-02',
      icon: 'module',
      available: true,
      disabledReason: '',
    });
  }
  return items;
}

/**
 * Render the BO-F0-02 shell chrome (sidebar + topbar) into the given
 * mounts. All labels come from the model above; every value that can carry
 * user or tenant data is inserted as text.
 *
 * @param {{
 *   doc: object,
 *   sidebar: object,
 *   topbar: object,
 *   spaces?: Array<{ id: string, name: string, initials?: string }>,
 *   user?: { name?: string, email?: string, role?: string },
 *   screenId?: string,
 *   screenLabel?: string,
 *   navigate?: (hash: string) => void,
 *   notify?: (message: string) => void,
 *   onLogout?: () => void,
 *   onPickSpace?: (id: string) => void,
 *   onAiSubmit?: ((text: string) => void) | null,
 *   commandSearch?: { customers?: (query: string) => Promise<Array<any> | null>, offers?: () => Promise<Array<any> | null>, agents?: () => Promise<Array<any> | null> } | null,
 *   schedule?: (fn: () => void, ms: number) => any,
 *   win?: { addEventListener?: (type: string, handler: (event: any) => void) => void } | null,
 * }} options
 */
export function createShellView({
  doc,
  sidebar,
  topbar,
  spaces: initialSpaces,
  user = {},
  screenId = 'oggi',
  screenLabel = 'Oggi',
  navigate = () => {},
  notify = () => {},
  onLogout = () => {},
  onPickSpace = () => {},
  onAiSubmit = null,
  commandSearch = null,
  schedule = undefined,
  win = null,
} = {}) {
  const state = {
    spaces: Array.isArray(initialSpaces) && initialSpaces.length > 0 ? initialSpaces : defaultSpaces(),
    activeSpaceId: null,
    activeScreenId: screenId,
    // BO-F6-16: the AI bar may ask about a screen finer than the sidebar
    // highlight (Stato sync lives under Impostazioni). Null falls back to
    // the highlighted screen id.
    aiScreenId: null,
    // Backlog 7d169a3b1dd2: first named team agent, told by the Agenti
    // screen once its read lands — the bar placeholder names the team.
    aiAgentName: '',
    screenLabel,
    fixCount: 0,
    clientCount: null,
    clientCountExact: true,
    user: user != null && typeof user === 'object' ? { ...user } : {},
    items: buildShellNav(),
    // design: shell telefono — on a phone the sidebar is a drawer behind
    // the ☰ button; desktop never shows the button, so this stays false.
    drawerOpen: false,
  };
  if (!state.spaces.some((space) => space.id === state.activeSpaceId)) {
    state.activeSpaceId = state.spaces[0].id;
  }

  const activeSpace = () => state.spaces.find((space) => space.id === state.activeSpaceId) ?? state.spaces[0];

  function clearMount(mount) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** The live ☰ button: the top bar repaints on every update. */
  let menuToggle = null;
  const sidebarId = () => {
    const id = typeof sidebar.getAttribute === 'function' ? sidebar.getAttribute('id') : null;
    if (typeof id === 'string' && id !== '') return id;
    sidebar.setAttribute('id', 'boSidebar');
    return 'boSidebar';
  };

  function paintToggle() {
    if (menuToggle === null) return;
    menuToggle.setAttribute('aria-expanded', state.drawerOpen ? 'true' : 'false');
    menuToggle.setAttribute('aria-label', state.drawerOpen ? 'Chiudi il menu' : 'Apri il menu');
  }

  /** The sidebar's own landmark label, restored when the drawer closes. */
  let landmarkLabel = null;

  /**
   * The drawer's focusable controls in document order: links with an href
   * and enabled buttons, skipping closed menus (`.hidden` subtrees). A tree
   * walk, so it reads the same in a browser and in the test DOM.
   */
  function drawerFocusables() {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes ?? []) {
        if (child.classList?.contains?.('hidden')) continue;
        const tag = String(child.tagName ?? '').toLowerCase();
        if ((tag === 'a' && child.getAttribute('href')) || (tag === 'button' && !child.disabled)) out.push(child);
        walk(child);
      }
    };
    walk(sidebar);
    return out;
  }

  function openDrawer() {
    state.drawerOpen = true;
    sidebar.classList.add('bo-drawer-open');
    // A modal drawer: announced as the «Menu» dialog, the page behind it
    // locked until it closes (the lock rule lives in the phone block only).
    landmarkLabel = sidebar.getAttribute('aria-label');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    sidebar.setAttribute('aria-label', 'Menu');
    doc.body?.classList?.add('bo-scroll-lock');
    paintToggle();
    // Focus moves into the drawer: its first control is the space switcher.
    const first = sidebar.querySelector('button');
    if (first && typeof first.focus === 'function') first.focus();
  }

  /** @param {{ refocus?: boolean }} [options] */
  function closeDrawer({ refocus = false } = {}) {
    if (!state.drawerOpen) return;
    state.drawerOpen = false;
    sidebar.classList.remove('bo-drawer-open');
    sidebar.removeAttribute('role');
    sidebar.removeAttribute('aria-modal');
    if (landmarkLabel === null) sidebar.removeAttribute('aria-label');
    else sidebar.setAttribute('aria-label', landmarkLabel);
    doc.body?.classList?.remove('bo-scroll-lock');
    paintToggle();
    if (refocus && menuToggle !== null && typeof menuToggle.focus === 'function') menuToggle.focus();
  }

  /** Every route chosen inside the sidebar closes the drawer first. */
  const go = (hash) => {
    closeDrawer();
    navigate(hash);
  };

  function renderSidebar() {
    clearMount(sidebar);
    // backlog:ecb26347d12c: the menu rows carry de-duplicated initials and
    // per-space colors, so two spaces never read the same; the button label
    // lists only the shortcuts that exist.
    const items = spaceMenuItems(state.spaces, state.activeSpaceId);
    const space = items.find((entry) => entry.active) ?? items[0];
    const switcherLabel = spaceSwitcherLabel(state.spaces);

    const spaceButton = el(doc, 'button', 'bo-space');
    spaceButton.setAttribute('aria-haspopup', 'true');
    spaceButton.setAttribute('title', switcherLabel);
    spaceButton.setAttribute('aria-label', switcherLabel);
    const badge = el(doc, 'span', 'bo-space-badge', space.initials);
    badge.setAttribute('style', `background: ${space.color}`);
    // BO-F6-01: the switcher shows the space name with the member's role
    // under it, like the prototype ("Studio Aurora / Titolare").
    const spaceText = el(doc, 'span', 'bo-space-text');
    spaceText.appendChild(el(doc, 'span', 'bo-space-name', space.name));
    // BO-F6-03: the role label comes from the session contract
    // (Titolare/Operatore/Osservatore), reused here, never raw text.
    const spaceRole = sessionRoleLabel(state.user.role);
    if (spaceRole !== '') spaceText.appendChild(el(doc, 'span', 'bo-space-role', spaceRole));
    spaceButton.appendChild(badge);
    spaceButton.appendChild(spaceText);
    spaceButton.appendChild(el(doc, 'span', 'bo-space-chevron', '▾'));
    spaceButton.addEventListener('click', () => {
      menu.classList.toggle('hidden', !menu.classList.contains('hidden'));
    });
    sidebar.appendChild(spaceButton);

    const menu = el(doc, 'div', 'bo-space-menu hidden');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Spazi di lavoro');
    for (const entry of items) {
      const pick = el(doc, 'button', entry.active ? 'bo-space-pick active' : 'bo-space-pick');
      pick.setAttribute('role', 'menuitem');
      const ini = el(doc, 'span', 'bo-space-badge', entry.initials);
      ini.setAttribute('style', `background: ${entry.color}`);
      const label = el(doc, 'span', 'bo-space-pick-name', entry.name);
      pick.appendChild(ini);
      pick.appendChild(label);
      if (entry.keyHint !== '') pick.appendChild(el(doc, 'span', 'bo-space-key', entry.keyHint));
      if (entry.active) pick.appendChild(el(doc, 'span', 'bo-space-check', '✓'));
      else pick.addEventListener('click', () => {
        state.activeSpaceId = entry.id;
        onPickSpace(entry.id);
        renderSidebar();
        renderTopbar();
      });
      menu.appendChild(pick);
    }
    const manage = el(doc, 'button', 'bo-space-manage', 'Gestisci spazi e accessi');
    manage.addEventListener('click', () => go(SETTINGS_ROUTE));
    menu.appendChild(manage);
    sidebar.appendChild(menu);

    // One voice row: icon, label, then the voice's live badge, if any.
    // Clienti carries the live client count (grey pill, BO-F6-01);
    // Impostazioni carries the real "things to fix" count (yellow pill).
    function appendVoice(container, item) {
      const link = el(doc, item.available ? 'a' : 'span', 'bo-nav-item'
        + (item.id === state.activeScreenId ? ' active' : '')
        + (item.available ? '' : ' disabled'));
      if (item.available) {
        link.setAttribute('href', item.route);
        if (item.id === state.activeScreenId) link.setAttribute('aria-current', 'page');
        link.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          go(item.route);
        });
      } else {
        link.setAttribute('aria-disabled', 'true');
        link.setAttribute('title', item.disabledReason);
      }
      // BO-F6-02: voices use the single component-library icon (MEM_ACC_REUSE);
      // custom modules (no icon named) fall back to the neutral glyph inside uiIcon.
      link.appendChild(uiIcon(doc, item.icon === 'nuovo-modulo' ? 'nuovo' : item.icon));
      link.appendChild(el(doc, 'span', 'bo-nav-label', item.label));
      if (item.id === 'clienti') {
        const countText = clientBadge(state.clientCount, state.clientCountExact);
        if (countText !== '') {
          const pill = el(doc, 'span', 'bo-count', countText);
          if (state.clientCountExact === false) pill.setAttribute('title', 'conteggio parziale: la scansione è limitata');
          link.appendChild(pill);
        }
      }
      if (item.id === 'impostazioni') {
        const badgeText = settingsBadge(state.fixCount);
        if (badgeText !== '') link.appendChild(el(doc, 'span', 'bo-badge', badgeText));
      }
      container.appendChild(link);
    }

    function appendGroups(container, groupIds) {
      for (const group of SHELL_GROUPS.filter((candidate) => groupIds.includes(candidate.id))) {
        if (group.header !== null) container.appendChild(el(doc, 'div', 'bo-nav-header', group.header));
        for (const item of state.items.filter((candidate) => candidate.group === group.id && candidate.nav !== false)) {
          appendVoice(container, item);
        }
      }
    }

    const nav = el(doc, 'nav', 'bo-nav');
    nav.setAttribute('aria-label', 'Sezioni');
    appendGroups(nav, ['home', 'native', 'custom']);
    sidebar.appendChild(nav);

    const addWrap = el(doc, 'div', 'bo-add');
    const addButton = el(doc, 'button', 'bo-add-button', '+ Nuovo modulo');
    addButton.setAttribute('aria-haspopup', 'true');
    const addMenu = el(doc, 'div', 'bo-add-menu ui-add-menu hidden');
    const aiOption = uiAddOption(doc, { kind: 'ai', title: 'Crea con l\u2019AI',
      line: 'Descrivi il modulo, il tuo agente di coding lo genera come bundle separato' });
    aiOption.addEventListener('click', () => {
      addMenu.classList.toggle('hidden', true);
      if (typeof onAiSubmit === 'function') {
        onAiSubmit('');
      } else {
        focusAiEntry();
        notify('Descrivi il modulo nella barra AI e premi Invio.');
      }
    });
    const manualOption = uiAddOption(doc, { kind: 'manual', title: 'Compila manualmente',
      line: 'Nome, dati usati e chi può vederlo' });
    manualOption.addEventListener('click', () => {
      addMenu.classList.toggle('hidden', true);
      go('#/nuovo-modulo');
    });
    addMenu.appendChild(aiOption);
    addMenu.appendChild(manualOption);
    addButton.addEventListener('click', () => {
      addMenu.classList.toggle('hidden', !addMenu.classList.contains('hidden'));
    });
    addWrap.appendChild(addButton);
    addWrap.appendChild(addMenu);
    sidebar.appendChild(addWrap);

    const spacer = el(doc, 'div', 'bo-spacer');
    sidebar.appendChild(spacer);

    // BO-F6-01: Impostazioni sits at the bottom, above the user row, like
    // the prototype — with its yellow "things to fix" badge when lit.
    const bottomNav = el(doc, 'nav', 'bo-nav bo-nav-bottom');
    bottomNav.setAttribute('aria-label', 'Impostazioni');
    appendGroups(bottomNav, ['settings']);
    sidebar.appendChild(bottomNav);

    const member = state.user;
    const userRow = el(doc, 'div', 'bo-user');
    const initials = typeof member.name === 'string' && member.name.trim() !== ''
      ? member.name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
      : 'LO';
    const userBadge = el(doc, 'span', 'bo-user-badge', initials);
    const who = el(doc, 'div', 'bo-user-who');
    who.appendChild(el(doc, 'div', 'bo-user-name', typeof member.name === 'string' && member.name !== '' ? member.name : 'Operatore locale'));
    who.appendChild(el(doc, 'div', 'bo-user-email', typeof member.email === 'string' && member.email !== '' ? member.email : 'sviluppo locale'));
    // BO-F6-03: the session role travels with the user (Titolare/Operatore/
    // Osservatore). Absent without a session — never a development string.
    const roleLabel = sessionRoleLabel(member.role);
    if (roleLabel !== '') who.appendChild(el(doc, 'div', 'bo-user-role', roleLabel));
    // Design pass 8: the person opens their profile (#/profilo); the exit
    // stays its own button beside it.
    const profileLink = el(doc, 'a', 'bo-user-link');
    profileLink.setAttribute('href', '#/profilo');
    profileLink.setAttribute('aria-label', 'Il tuo profilo');
    profileLink.setAttribute('title', 'Il tuo profilo');
    profileLink.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      go('#/profilo');
    });
    profileLink.appendChild(userBadge);
    profileLink.appendChild(who);
    userRow.appendChild(profileLink);
    // BO-F6-01: the exit keeps the prototype's icon; the visible label names
    // the action (BO-F6-03 reviewed behavior), labelled for assistive tech.
    const logout = el(doc, 'button', 'bo-logout', 'Esci');
    logout.appendChild(uiIcon(doc, 'logout'));
    logout.setAttribute('title', 'Esci');
    logout.setAttribute('aria-label', 'Esci');
    logout.addEventListener('click', () => onLogout());
    userRow.appendChild(logout);
    sidebar.appendChild(userRow);
  }

  /** @type {object | null} */
  let aiInput = null;
  /** @type {any} */
  let aiForm = null;
  /** The space the ⌘K list last read for; undefined before the first bar. */
  let commandSpaceId;

  /**
   * backlog:be99004b06e4: the bar finds before it asks. Pages come from the
   * shell's own voices and settings areas; customers, offers and (backlog
   * 1f7cb20d3c30) the space's agents from the reads app.js already makes
   * (commandSearch). The AI is the last row.
   */
  function commandPages() {
    const customerData = state.items.some((item) => item.id === 'clienti' && item.available === true);
    const pages = [];
    for (const item of state.items) {
      if (item.available === true && typeof item.route === 'string' && item.route.startsWith('#/')) {
        pages.push({ label: item.label, href: item.route });
      }
    }
    for (const area of SETTINGS_AREAS) {
      if (area.id === 'stato-sync' && !customerData) continue;
      pages.push({ label: area.label, href: area.route, sub: 'Impostazioni' });
    }
    pages.push({ label: 'Connettori', href: '#/connettori', sub: 'Impostazioni' });
    return pages;
  }

  const commandMenu = createCommandMenu({
    doc,
    pages: commandPages,
    search: commandSearch,
    navigate: (href) => go(href),
    ask: (text) => {
      if (typeof onAiSubmit === 'function') onAiSubmit(text);
      else notify('Barra AI: descrivi cosa fare e premi Invio.');
    },
    ...(typeof schedule === 'function' ? { schedule, cancel: () => {} } : {}),
  });

  function focusAiEntry() {
    commandMenu.focus();
  }

  function renderTopbar() {
    clearMount(topbar);
    const space = activeSpace();
    // design: shell telefono — on a phone the top bar names the space
    // (badge, name, role, where the sidebar switcher sits) and the ☰ button
    // opens the sidebar as a drawer. Both hidden above 560px by the
    // stylesheet, so desktop is unchanged.
    const phoneSpace = el(doc, 'div', 'bo-phonebar-space');
    // backlog:ecb26347d12c: the phone bar shows the same de-duplicated
    // initials and color as the sidebar switcher.
    const phoneItems = spaceMenuItems(state.spaces, state.activeSpaceId);
    const phoneSpaceEntry = phoneItems.find((entry) => entry.active) ?? phoneItems[0];
    const phoneBadge = el(doc, 'span', 'bo-space-badge', phoneSpaceEntry.initials);
    phoneBadge.setAttribute('style', `background: ${phoneSpaceEntry.color}`);
    phoneSpace.appendChild(phoneBadge);
    const phoneSpaceText = el(doc, 'span', 'bo-space-text');
    phoneSpaceText.appendChild(el(doc, 'span', 'bo-space-name', space.name));
    const phoneRole = sessionRoleLabel(state.user.role);
    if (phoneRole !== '') phoneSpaceText.appendChild(el(doc, 'span', 'bo-space-role', phoneRole));
    phoneSpace.appendChild(phoneSpaceText);
    topbar.appendChild(phoneSpace);
    menuToggle = el(doc, 'button', 'bo-menu-toggle', '☰');
    menuToggle.setAttribute('type', 'button');
    menuToggle.setAttribute('aria-controls', sidebarId());
    paintToggle();
    menuToggle.addEventListener('click', () => {
      if (state.drawerOpen) closeDrawer();
      else openDrawer();
    });
    topbar.appendChild(menuToggle);
    const path = el(doc, 'div', 'bo-crumb', crumb(space.name, screenLabelFor(state.activeScreenId)));
    path.setAttribute('aria-label', 'Percorso');
    topbar.appendChild(path);

    const form = el(doc, 'form', 'bo-ai');
    form.setAttribute('role', 'search');
    // BO-F6-01: the AI bar opens with the ✦ mark, like the prototype.
    form.appendChild(el(doc, 'span', 'bo-ai-spark', '✦'));
    aiInput = doc.createElement('input');
    aiInput.setAttribute('type', 'search');
    aiInput.setAttribute('class', 'bo-ai-input ui-field'); // BO-F6-02: system field class.
    aiInput.setAttribute('aria-label', 'Barra AI: chiedi o fai qualcosa');
    aiInput.setAttribute('placeholder', aiPlaceholder(state.aiScreenId ?? state.activeScreenId, state.aiAgentName));
    aiInput.setAttribute('title', 'Barra AI (⌘K): chiedi o fai qualcosa');
    form.appendChild(aiInput);
    const hint = el(doc, 'kbd', 'bo-ai-key', '⌘K');
    form.appendChild(hint);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      // backlog:be99004b06e4 (review #779): every submit path goes through
      // the results list — the selected row opens, exactly once per Enter.
      if (commandMenu.submit()) return;
      if (typeof onAiSubmit === 'function') {
        onAiSubmit(aiInput !== null && typeof aiInput.value === 'string' ? aiInput.value : '');
      } else {
        notify('Barra AI: descrivi cosa fare e premi Invio.');
      }
    });
    topbar.appendChild(form);
    aiForm = form;
    // Review #779: what the list read belongs to one space — a switch
    // (menu, ⌘1/2/3, setSpaces) drops it before the bar is bound again.
    if (commandSpaceId !== state.activeSpaceId) {
      if (commandSpaceId !== undefined) commandMenu.invalidate();
      commandSpaceId = state.activeSpaceId;
    }
    commandMenu.attach(form, aiInput);
  }

  function screenLabelFor(id) {
    // BO-F6-16: the crumb names the open screen (Stato sync, Connettori,
    // Personalizzazione), not the sidebar section hosting it (Impostazioni):
    // the prototype reads "<SPACE> / <SCREEN>", uppercased by .bo-crumb.
    if (typeof state.screenLabel === 'string' && state.screenLabel !== '') return state.screenLabel;
    const found = state.items.find((item) => item.id === id);
    if (found) return found.label;
    return 'Oggi';
  }

  if (win != null && typeof win.addEventListener === 'function') {
    win.addEventListener('keydown', (event) => {
      if (event == null) return;
      if (event.key === 'Escape' && state.drawerOpen) {
        closeDrawer({ refocus: true });
        return;
      }
      // Focus trap: Tab and Shift+Tab cycle inside the open drawer.
      if (event.key === 'Tab' && state.drawerOpen) {
        const focusables = drawerFocusables();
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const current = doc.activeElement ?? null;
        const inside = current !== null && sidebar.contains(current);
        const wrapTo = event.shiftKey === true
          ? (!inside || current === first ? last : null)
          : (!inside || current === last ? first : null);
        if (wrapTo !== null) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          wrapTo.focus();
        }
        return;
      }
      const isShortcut = event.metaKey === true || event.ctrlKey === true;
      if (!isShortcut || typeof event.key !== 'string') return;
      if (event.key.toLowerCase() === 'k') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        focusAiEntry();
        return;
      }
      const spaceId = resolveSpaceShortcut(event, state.spaces);
      if (spaceId !== null) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        state.activeSpaceId = spaceId;
        onPickSpace(spaceId);
        renderSidebar();
        renderTopbar();
      }
    });
    // A tap outside the open drawer closes it; the ☰ button handles its own.
    // Capture phase, and the tap stops there: the scrim is only a shadow, so
    // without this the tap that dismisses the menu would also press the
    // button underneath it.
    win.addEventListener('click', (event) => {
      commandMenu.closeUnlessInside(event?.target ?? null, aiForm);
      if (!state.drawerOpen) return;
      const target = event?.target ?? null;
      if (sidebar.contains(target) || (menuToggle !== null && menuToggle.contains(target))) return;
      if (typeof event?.preventDefault === 'function') event.preventDefault();
      if (typeof event?.stopPropagation === 'function') event.stopPropagation();
      closeDrawer();
    }, true);
  }

  renderSidebar();
  renderTopbar();

  return {
    update({ fixCount, clientCount, clientCountExact, activeScreenId, aiScreenId, aiAgentName, screenLabel: nextLabel, items, user: nextUser } = {}) {
      if (fixCount !== undefined) state.fixCount = fixCount;
      if (clientCount !== undefined) state.clientCount = clientCount;
      if (clientCountExact !== undefined) state.clientCountExact = clientCountExact;
      if (typeof activeScreenId === 'string') state.activeScreenId = activeScreenId;
      if (aiScreenId === null || typeof aiScreenId === 'string') state.aiScreenId = aiScreenId;
      if (typeof aiAgentName === 'string') state.aiAgentName = aiAgentName;
      if (typeof nextLabel === 'string' && nextLabel !== '') state.screenLabel = nextLabel;
      if (Array.isArray(items)) state.items = items;
      if (nextUser != null && typeof nextUser === 'object' && !Array.isArray(nextUser)) {
        state.user = { ...state.user, ...nextUser };
      }
      renderSidebar();
      renderTopbar();
    },
    setSpaces(spaces, activeId) {
      if (Array.isArray(spaces) && spaces.length > 0) state.spaces = spaces;
      if (typeof activeId === 'string' && state.spaces.some((space) => space.id === activeId)) {
        state.activeSpaceId = activeId;
      } else if (!state.spaces.some((space) => space.id === state.activeSpaceId)) {
        state.activeSpaceId = state.spaces[0].id;
      }
      renderSidebar();
      renderTopbar();
    },
    getState() {
      return {
        activeSpaceId: state.activeSpaceId,
        activeScreenId: state.activeScreenId,
        fixCount: state.fixCount,
        clientCount: state.clientCount,
      };
    },
  };
}

/**
 * Render the screen for a backoffice address the router cannot open
 * (backlog:55985e25ddd2): plain Italian and a way back to Oggi, in the same
 * panel the old English message used.
 * @param {{ doc: object, mount: object }} options
 */
export function renderUnknownRoute({ doc, mount }) {
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const box = el(doc, 'div', 'panel');
  box.appendChild(el(doc, 'p', 'empty', 'Questa pagina non esiste.'));
  const home = el(doc, 'a', undefined, 'Vai a Oggi');
  home.setAttribute('href', '#/');
  box.appendChild(home);
  mount.appendChild(box);
}

/**
 * What the Impostazioni screen says when the «things to fix» count could not
 * be read (backlog:1d33b335fba0): what is missing, and that it may not be zero.
 */
export const SETTINGS_FIX_UNREAD_MESSAGE = 'Non sono riuscito a leggere le cose da sistemare (problemi nei dati e schede doppie): potrebbero essercene.';

/**
 * Render the Impostazioni screen: the four areas from the prototype. Areas
 * backed by an existing view link there; the rest name the story that
 * delivers them (BO-F0-03 owns the tabs). The Stato sync row carries the
 * same real fix-count badge as the sidebar entry: it renders only from a
 * count above zero, never at zero and never when the count is unknown.
 * @param {{ doc: object, mount: object, fixCount?: unknown, navigate?: (hash: string) => void, customerDataAvailable?: boolean }} options
 */
export function renderSettingsPanel({ doc, mount, fixCount = null, navigate = () => {}, customerDataAvailable = false, onRetry = null } = {}) {
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
  mount.appendChild(el(doc, 'h2', undefined, 'Impostazioni'));
  const unknown = fixCount === null || fixCount === undefined;
  const badgeText = unknown ? '' : settingsBadge(fixCount);
  const summary = el(
    doc,
    'p',
    'bo-muted',
    unknown
      // backlog:1d33b335fba0: say what was not read, in plain words, with
      // a way to try again — never «leggerle» with nothing it refers to.
      ? SETTINGS_FIX_UNREAD_MESSAGE
      : badgeText === ''
        ? 'Niente da sistemare.'
        : `${badgeText} cose da sistemare (vedi Stato sync).`,
  );
  mount.appendChild(summary);
  if (unknown && typeof onRetry === 'function') {
    summary.setAttribute('role', 'status');
    const retry = el(doc, 'button', 'ui-btn ui-btn-secondary ui-btn-small bo-settings-retry', 'Riprova');
    retry.setAttribute('type', 'button');
    retry.setAttribute('data-action', 'settings-retry');
    retry.addEventListener('click', () => {
      void uiBusy(retry, 'Riprovo…', async () => {
        let count = null;
        // Review #833 P2: the retry answers the live state, not only the
        // count — Stato sync may have become available since the first
        // paint. A bare number keeps the availability the panel had.
        let available = customerDataAvailable;
        try {
          const answer = await onRetry();
          if (answer !== null && typeof answer === 'object') {
            count = answer.fixCount ?? null;
            if (typeof answer.customerDataAvailable === 'boolean') available = answer.customerDataAvailable;
          } else {
            count = answer ?? null;
          }
        } catch {
          count = null;
        }
        // The operator may have left meanwhile: repaint only the panel
        // still on screen, never over the screen just opened.
        if (!Array.from(mount.childNodes ?? []).includes(summary)) return;
        renderSettingsPanel({ doc, mount, fixCount: count, navigate, customerDataAvailable: available, onRetry });
      });
    });
    mount.appendChild(retry);
  }
  const list = el(doc, 'div', 'bo-settings');
  for (const area of SETTINGS_AREAS) {
    const row = el(doc, 'div', 'bo-setting-row');
    row.appendChild(el(doc, 'span', 'bo-setting-label', area.label));
    // Stato sync opens its own screen (BO-F1-03, #/stato-sync): without the
    // customer-data package composed it stays an honest note, never a link
    // to a blank screen. Every other area with a route links there.
    if (area.id === 'stato-sync' && !customerDataAvailable) {
      row.appendChild(el(doc, 'span', 'bo-setting-coming', CUSTOMER_DATA_UNAVAILABLE_REASON));
    } else if (area.route !== null) {
      const link = el(doc, 'a', 'bo-setting-link', 'Apri');
      link.setAttribute('href', area.route);
      link.addEventListener('click', (event) => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate(area.route);
      });
      row.appendChild(link);
      // BO-F0-03: the Stato sync tab carries the badge with the real
      // "things to fix" count — the same text as the sidebar badge, so it
      // is absent at zero and when the count is unknown.
      if (area.id === 'stato-sync' && badgeText !== '') {
        row.appendChild(el(doc, 'span', 'bo-badge', badgeText));
      }
    } else {
      row.appendChild(el(doc, 'span', 'bo-setting-coming', `In arrivo con ${area.story}`));
    }
    list.appendChild(row);
  }
  mount.appendChild(list);
}

/**
 * The routed views that sit under the Impostazioni tab row, by the area
 * their tab opens (the `view` of parseModuleRoute → SETTINGS_AREAS id).
 */
export const SETTINGS_VIEW_AREAS = Object.freeze({
  personalizzazione: 'personalizzazione',
  catalog: 'catalogo',
  sync: 'stato-sync',
  'spazi-accessi': 'spazi-accessi',
  profilo: 'profilo',
});

/**
 * Keep the Impostazioni tabs on screen while a tab's content loads
 * (backlog:1cfc68175ab7). The router clears the shared mount and paints
 * its loading line on every navigation, so switching tab blanked the whole
 * page, tabs included, for the 3–5 s of the new tab's reads. For a settings
 * view this puts the tab row back above the loading line, the new tab
 * already underlined: only the content below reloads. Returns whether the
 * row was painted (false for any other view, or with no loading line).
 * @param {any} doc
 * @param {{ mount: any, loading: any, view: unknown, fixCount?: unknown, navigate?: (hash: string) => void }} options
 */
export function keepSettingsTabs(doc, { mount, loading, view, fixCount = null, navigate = () => {} }) {
  if (typeof view !== 'string' || !Object.hasOwn(SETTINGS_VIEW_AREAS, view)) return false;
  if (!loading || !Array.from(mount.childNodes ?? []).includes(loading)) return false;
  const tabs = settingsTabs(doc, { activeId: SETTINGS_VIEW_AREAS[view], fixCount, navigate });
  mount.removeChild(loading);
  mount.appendChild(tabs);
  mount.appendChild(loading);
  return true;
}

/**
 * The `IMPOSTAZIONI` tab row of the prototype (BO-F6-16): the four areas in
 * order with the open one underlined, plus the yellow "things to fix" badge
 * on Stato sync while its count is above zero (same count the sidebar shows,
 * absent at zero and when unknown). Tabs reuse the `ui-tabs` builders
 * (BO-F6-02); the badge reuses `.bo-badge`, like the sidebar pill.
 * @param {any} doc
 * @param {{ activeId?: string, fixCount?: unknown, navigate?: (hash: string) => void }} [options]
 */
export function settingsTabs(doc, { activeId = 'stato-sync', fixCount = null, navigate = () => {} } = {}) {
  const wrap = el(doc, 'div', 'bo-settings-tabs');
  wrap.appendChild(el(doc, 'p', 'bo-settings-label', 'IMPOSTAZIONI'));
  const bar = uiTabs(doc, SETTINGS_AREAS.map((area) => ({
    id: area.id,
    label: area.label,
    active: area.id === activeId,
  })));
  for (const area of SETTINGS_AREAS) {
    const tab = typeof bar.querySelector === 'function'
      ? bar.querySelector(`button[data-tab="${area.id}"]`)
      : null;
    if (tab === null || tab === undefined) continue;
    if (area.id !== activeId) tab.addEventListener('click', () => navigate(area.route));
    // The badge lights on the Stato sync tab (open or not) while its count
    // is above zero — the same count the sidebar pill shows for this screen.
    if (area.id === 'stato-sync') {
      const badgeText = settingsBadge(fixCount);
      if (badgeText !== '') {
        const badge = el(doc, 'span', 'bo-badge', badgeText);
        badge.setAttribute('aria-label', `${badgeText} da sistemare`);
        tab.appendChild(badge);
      }
    }
  }
  wrap.appendChild(bar);
  return wrap;
}

/**
 * The sidebar voice and topbar crumb of one routed view (moved here from
 * app.js so the mapping is testable). backlog:8618ad3f72db: every view
 * under the Impostazioni tab row — Catalogo prodotti and Profilo included —
 * keeps «Impostazioni» highlighted in the sidebar.
 * @param {{ view?: string, moduleName?: string, from?: unknown }} target
 */
export function shellScreenFor(target) {
  switch (target.view) {
    case 'dashboard': return { id: 'oggi', label: 'Oggi' };
    case 'customer-data':
    case 'customer-card': return { id: 'clienti', label: 'Clienti' };
    case 'customer-import': return { id: 'clienti', label: 'Importa clienti' };
    case 'customer-new': return { id: 'clienti', label: 'Nuovo cliente' };
    case 'pipeline': return { id: 'pipeline', label: 'Pipeline' };
    case 'sequenze': return { id: 'sequenze', label: 'Sequenze' };
    case 'agenti': return { id: 'agenti', label: 'Agenti' };
    case 'settings': return { id: 'impostazioni', label: 'Impostazioni' };
    case 'list':
    case 'new':
    case 'detail':
      // backlog:1d99c8207f90: the crumb (uppercased by .bo-crumb) read
      // «OPPORTUNITY» on Nuova offerta: a module route names its screen in
      // Italian, never the raw module key.
      return target.moduleName
        ? { id: `module-${target.moduleName}`, label: moduleScreenLabel(target.view, target.moduleName) }
        : { id: null, label: 'Modulo' };
    // Admin views outside the backoffice prototype: an honest crumb with no
    // sidebar highlight, never the previous screen left stale.
    case 'spine': return { id: null, label: 'Identità e accessi' };
    case 'work': return { id: null, label: 'Lavoro' };
    case 'work-task': return { id: null, label: 'Attività' };
    case 'marketing': return { id: null, label: 'Proposte' };
    case 'marketing-proposal': return { id: null, label: 'Proposta' };
    case 'quotes': return { id: null, label: 'Preventivi' };
    case 'catalog': return { id: 'impostazioni', label: 'Catalogo prodotti' };
    // backlog:bfc070243427: the quote lives on the offer's board — Pipeline
    // stays highlighted on the preventivo, like on the offer.
    case 'quote-detail': return { id: 'pipeline', label: 'Preventivo' };
    // backlog:96c7b56001ba: an offer opened from a scheda stays under Clienti.
    case 'offer-detail': return { id: target.from ? 'clienti' : 'pipeline', label: 'Offerta' };
    case 'connectors': return { id: 'impostazioni', label: 'Connettori' };
    case 'connector-detail': return { id: 'impostazioni', label: 'Dettaglio connettore' };
    // BO-F6-16: the sidebar still highlights Impostazioni, but the AI bar
    // asks about sync (its own placeholder), not the generic settings one.
    case 'sync': return { id: 'impostazioni', label: 'Stato sync', ai: 'stato-sync' };
    case 'reporting': return { id: 'reporting', label: 'Reporting' };
    case 'calendario': return { id: 'calendario', label: 'Calendario' };
    case 'nuovo-modulo': return { id: 'nuovo-modulo', label: 'Nuovo modulo' };
    case 'personalizzazione': return { id: 'impostazioni', label: 'Personalizzazione' };
    case 'skill-detail': return { id: 'impostazioni', label: 'Dettaglio skill' };
    case 'spazi-accessi': return { id: 'impostazioni', label: 'Spazi e accessi' };
    case 'profilo': return { id: 'impostazioni', label: 'Profilo' };
    case 'componenti': return { id: null, label: 'Componenti' };
    case 'invalid': return { id: null, label: 'Percorso non valido' };
    default: return { id: null, label: 'Vista' };
  }
}

