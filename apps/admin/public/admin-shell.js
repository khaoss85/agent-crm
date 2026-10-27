// @ts-check

import { sessionRoleLabel } from './admin-session.js';
import { el, uiIcon, uiTabs } from './admin-ui.js'; // BO-F6-02: the single component library.

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
  { id: 'sequenze', label: 'Sequenze', group: 'native', route: null, story: 'BO-F3', icon: 'sequenze' },
  { id: 'reporting', label: 'Reporting', group: 'custom', route: '#/reporting', story: 'BO-F5-01', icon: 'reporting' },
  { id: 'nuovo-modulo', label: 'Nuovo modulo', group: 'custom', route: '#/nuovo-modulo', story: 'BO-F5-01', icon: 'nuovo-modulo' },
  { id: 'impostazioni', label: 'Impostazioni', group: 'settings', route: SETTINGS_ROUTE, story: 'BO-F0-02', icon: 'impostazioni' },
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
  reporting: 'Chiedi: «chi ha gestito più call questo mese?»',
  'nuovo-modulo': 'Descrivi: «un modulo sonde per i KPI del pilota»',
  impostazioni: 'Chiedi: «cosa può fare l\u2019AI senza chiedermi?»',
  // BO-F6-16: the sync screen asks about sync, never the generic fallback.
  'stato-sync': 'Chiedi: «c\u2019è qualcosa che non si è sincronizzato?»',
});

export const AI_ENTRY_FALLBACK = 'Chiedi o fai qualcosa… (⌘K)';

/**
 * @param {string} screenId
 */
export function aiPlaceholder(screenId) {
  if (typeof screenId !== 'string') return AI_ENTRY_FALLBACK;
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
 * Read user spaces from a storage-like object. Corrupt or missing data
 * falls back to the single local space — never an empty list.
 * @param {{ getItem?: (key: string) => string | null } | null | undefined} storage
 */
export function readSpaces(storage) {
  const fallback = defaultSpaces();
  try {
    const raw = storage?.getItem?.(SPACES_KEY);
    if (typeof raw !== 'string' || raw === '') return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const cleaned = parsed
      .filter((entry) => entry != null && typeof entry.id === 'string' && entry.id !== ''
        && typeof entry.name === 'string' && entry.name !== '')
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        initials: typeof entry.initials === 'string' && entry.initials !== ''
          ? entry.initials.slice(0, 2).toUpperCase()
          : entry.name.slice(0, 2).toUpperCase(),
      }));
    return cleaned.length > 0 ? cleaned : fallback;
  } catch {
    return fallback;
  }
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
 * Space-menu rows with the ⌘N hint, in order. Only the first nine spaces
 * get a hint; the rest render without one.
 * @param {Array<{ id: string, name: string, initials?: string }>} spaces
 * @param {string} activeId
 */
export function spaceMenuItems(spaces, activeId) {
  return spaces.map((space, index) => ({
    id: space.id,
    name: space.name,
    initials: space.initials ?? space.name.slice(0, 2).toUpperCase(),
    keyHint: index < 9 ? `⌘${index + 1}` : '',
    active: space.id === activeId,
  }));
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
 * @param {{ pipelines?: Array<{ name?: unknown, label?: unknown }>, customModules?: Array<{ name?: unknown, origin?: unknown }>, customerDataAvailable?: boolean, sequencesAvailable?: boolean }} input
 */
export function buildShellNav({ pipelines = [], customModules = [], customerDataAvailable = false, sequencesAvailable = false } = {}) {
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
    if (item.id === 'sequenze') {
      if (sequencesAvailable) {
        return { ...item, route: '#/sequenze', available: true, disabledReason: '' };
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
    screenLabel,
    fixCount: 0,
    clientCount: null,
    clientCountExact: true,
    user: user != null && typeof user === 'object' ? { ...user } : {},
    items: buildShellNav(),
  };
  if (!state.spaces.some((space) => space.id === state.activeSpaceId)) {
    state.activeSpaceId = state.spaces[0].id;
  }

  const activeSpace = () => state.spaces.find((space) => space.id === state.activeSpaceId) ?? state.spaces[0];

  function clearMount(mount) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  function renderSidebar() {
    clearMount(sidebar);
    const space = activeSpace();

    const spaceButton = el(doc, 'button', 'bo-space');
    spaceButton.setAttribute('aria-haspopup', 'true');
    spaceButton.setAttribute('title', 'Cambia spazio (⌘1/2/3)');
    const badge = el(doc, 'span', 'bo-space-badge', space.initials ?? space.name.slice(0, 2).toUpperCase());
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
    for (const entry of spaceMenuItems(state.spaces, state.activeSpaceId)) {
      const pick = el(doc, 'button', entry.active ? 'bo-space-pick active' : 'bo-space-pick');
      pick.setAttribute('role', 'menuitem');
      const ini = el(doc, 'span', 'bo-space-badge', entry.initials);
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
    manage.addEventListener('click', () => navigate(SETTINGS_ROUTE));
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
          navigate(item.route);
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
        for (const item of state.items.filter((candidate) => candidate.group === group.id)) {
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
    const addMenu = el(doc, 'div', 'bo-add-menu hidden');
    const aiOption = el(doc, 'button', 'bo-add-option', '✦ Crea con l\u2019AI');
    aiOption.addEventListener('click', () => {
      addMenu.classList.toggle('hidden', true);
      if (typeof onAiSubmit === 'function') {
        onAiSubmit('');
      } else {
        focusAiEntry();
        notify('Descrivi il modulo nella barra AI e premi Invio.');
      }
    });
    const manualOption = el(doc, 'button', 'bo-add-option', 'Compila manualmente');
    manualOption.addEventListener('click', () => {
      addMenu.classList.toggle('hidden', true);
      notify('Modulo manuale: npm run crm -- module create <modulo>.module.json --apply (vedi docs/ADMIN.md).');
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
    userRow.appendChild(el(doc, 'span', 'bo-user-badge', initials));
    const who = el(doc, 'div', 'bo-user-who');
    who.appendChild(el(doc, 'div', 'bo-user-name', typeof member.name === 'string' && member.name !== '' ? member.name : 'Operatore locale'));
    who.appendChild(el(doc, 'div', 'bo-user-email', typeof member.email === 'string' && member.email !== '' ? member.email : 'sviluppo locale'));
    // BO-F6-03: the session role travels with the user (Titolare/Operatore/
    // Osservatore). Absent without a session — never a development string.
    const roleLabel = sessionRoleLabel(member.role);
    if (roleLabel !== '') who.appendChild(el(doc, 'div', 'bo-user-role', roleLabel));
    userRow.appendChild(who);
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

  function focusAiEntry() {
    if (aiInput !== null && typeof aiInput.focus === 'function') aiInput.focus();
  }

  function renderTopbar() {
    clearMount(topbar);
    const space = activeSpace();
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
    aiInput.setAttribute('placeholder', aiPlaceholder(state.aiScreenId ?? state.activeScreenId));
    aiInput.setAttribute('title', 'Barra AI (⌘K): chiedi o fai qualcosa');
    form.appendChild(aiInput);
    const hint = el(doc, 'kbd', 'bo-ai-key', '⌘K');
    form.appendChild(hint);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof onAiSubmit === 'function') {
        onAiSubmit(aiInput !== null && typeof aiInput.value === 'string' ? aiInput.value : '');
      } else {
        notify('Barra AI: descrivi cosa fare e premi Invio.');
      }
    });
    topbar.appendChild(form);
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
  }

  renderSidebar();
  renderTopbar();

  return {
    update({ fixCount, clientCount, clientCountExact, activeScreenId, aiScreenId, screenLabel: nextLabel, items, user: nextUser } = {}) {
      if (fixCount !== undefined) state.fixCount = fixCount;
      if (clientCount !== undefined) state.clientCount = clientCount;
      if (clientCountExact !== undefined) state.clientCountExact = clientCountExact;
      if (typeof activeScreenId === 'string') state.activeScreenId = activeScreenId;
      if (aiScreenId === null || typeof aiScreenId === 'string') state.aiScreenId = aiScreenId;
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
 * Render the Impostazioni screen: the four areas from the prototype. Areas
 * backed by an existing view link there; the rest name the story that
 * delivers them (BO-F0-03 owns the tabs). The Stato sync row carries the
 * same real fix-count badge as the sidebar entry: it renders only from a
 * count above zero, never at zero and never when the count is unknown.
 * @param {{ doc: object, mount: object, fixCount?: unknown, navigate?: (hash: string) => void, customerDataAvailable?: boolean }} options
 */
export function renderSettingsPanel({ doc, mount, fixCount = null, navigate = () => {}, customerDataAvailable = false } = {}) {
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  mount.appendChild(el(doc, 'p', 'bo-kicker', 'Backoffice'));
  mount.appendChild(el(doc, 'h2', undefined, 'Impostazioni'));
  const unknown = fixCount === null || fixCount === undefined;
  const badgeText = unknown ? '' : settingsBadge(fixCount);
  mount.appendChild(el(
    doc,
    'p',
    'bo-muted',
    unknown
      ? 'Non è stato possibile leggerle (non è detto che non ce ne siano).'
      : badgeText === ''
        ? 'Niente da sistemare.'
        : `${badgeText} cose da sistemare (vedi Stato sync).`,
  ));
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
