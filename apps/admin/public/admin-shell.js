// @ts-check

// BO-F0-02 — Backoffice shell and navigation model (sidebar, topbar, spaces).
//
// Reference: the approved backoffice prototype (sidebar on every screen with
// a space selector, Oggi, the "Moduli nativi / Moduli personalizzati" groups,
// "+ Nuovo modulo", "Impostazioni" with a badge and a user row with logout;
// topbar with the path and the AI bar entry). The assistant behind the AI
// bar is BO-F0-04 and stays out of this story: the bar is an entry only.
//
// Conventions follow apps/admin/public/admin-core.js: the model builders are
// pure and DOM-free (unit-tested under node:test without a browser) and the
// renderer uses DOM APIs only — createElement + textContent/setAttribute —
// never innerHTML with data, so hostile space, user or module names are inert
// text, never markup.

/** Route for the settings entry. Its tabs land in BO-F0-03. */
export const SETTINGS_ROUTE = '#/impostazioni';

/** Storage keys for the local shell state (space selection only). */
export const ACTIVE_SPACE_KEY = 'accordo.activeSpace';
export const SPACES_KEY = 'accordo.spaces';

/**
 * Fixed sidebar voices from the prototype, in Italian, in prototype order.
 * `route: null` means the screen is delivered by a later story: the item
 * renders disabled with the story named, never as a dead link.
 * @typedef {{ id: string, label: string, group: 'home' | 'native' | 'custom' | 'settings', route: string | null, story: string }} ShellItem
 */
export const SHELL_ITEMS = Object.freeze([
  { id: 'oggi', label: 'Oggi', group: 'home', route: '#/', story: 'BO-F0-02' },
  { id: 'clienti', label: 'Clienti', group: 'native', route: '#/customer-data', story: 'BO-F1' },
  { id: 'pipeline', label: 'Pipeline', group: 'native', route: null, story: 'BO-F2' },
  { id: 'calendario', label: 'Calendario', group: 'native', route: null, story: 'BO-F3' },
  { id: 'sequenze', label: 'Sequenze', group: 'native', route: null, story: 'BO-F3' },
  { id: 'reporting', label: 'Reporting', group: 'custom', route: null, story: 'BO-F5' },
  { id: 'impostazioni', label: 'Impostazioni', group: 'settings', route: SETTINGS_ROUTE, story: 'BO-F0-02' },
]);

/** Sidebar group headers, in render order. `null` renders no header. */
export const SHELL_GROUPS = Object.freeze([
  { id: 'home', header: null },
  { id: 'native', header: 'Moduli nativi' },
  { id: 'custom', header: 'Moduli personalizzati' },
  { id: 'settings', header: null },
]);

/**
 * The four settings areas from the prototype. Stato sync is backed by the
 * data-quality queue that already exists in the customer-data section;
 * the other three name the story that delivers them.
 */
export const SETTINGS_AREAS = Object.freeze([
  { id: 'personalizzazione', label: 'Personalizzazione', route: null, story: 'BO-F1 (connettori)' },
  { id: 'catalogo', label: 'Catalogo prodotti', route: null, story: 'BO-F2 (catalogo)' },
  { id: 'stato-sync', label: 'Stato sync', route: '#/customer-data', story: 'BO-F1' },
  { id: 'spazi-accessi', label: 'Spazi e accessi', route: null, story: 'BO-F0-06' },
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
  impostazioni: 'Chiedi: «cosa può fare l\u2019AI senza chiedermi?»',
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
 * Read the real fix count for the badge. Returns null (unknown) when the
 * customer-data package is not composed or a read fails: an unknown count
 * must never light the badge, and it must never render as "none" either.
 * @param {{ request: (path: string, options?: object) => Promise<any> }} client
 * @returns {Promise<number | null>}
 */
export async function loadFixCount(client) {
  try {
    const [issuesRead, candidatesRead] = await Promise.all([
      client.request('/api/modules/data-quality-issue/records?limit=100'),
      client.request('/api/modules/duplicate-candidate/records?limit=100'),
    ]);
    if (!Array.isArray(issuesRead?.items) || !Array.isArray(candidatesRead?.items)) return null;
    return countFixes({ issues: issuesRead.items, candidates: candidatesRead.items });
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
 * modules (generated modules are the "personalizzati" group). The Pipeline
 * voice resolves to the first composed pipeline; every other not-yet
 * delivered voice stays disabled with its story named. Clienti is available
 * only when the customer-data package is composed in the space
 * (customerDataAvailable): otherwise it stays disabled with its story,
 * like Pipeline/Calendario, never as a dead link to a blank screen.
 * @param {{ pipelines?: Array<{ name?: unknown, label?: unknown }>, customModules?: Array<{ name?: unknown }>, customerDataAvailable?: boolean }} input
 */
export function buildShellNav({ pipelines = [], customModules = [], customerDataAvailable = false } = {}) {
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
    if (item.route === null) {
      return { ...item, available: false, disabledReason: `In arrivo con ${item.story}` };
    }
    return { ...item, available: true, disabledReason: '' };
  });
  for (const module of customModules) {
    if (module == null || typeof module.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(module.name)) continue;
    items.push({
      id: `module-${module.name}`,
      label: module.name,
      group: 'custom',
      route: `#/modules/${module.name}`,
      story: 'BO-F0-02',
      available: true,
      disabledReason: '',
    });
  }
  return items;
}

/**
 * @param {object} doc DOM document (real or fake).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = text;
  return node;
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
 *   user?: { name?: string, email?: string },
 *   screenId?: string,
 *   screenLabel?: string,
 *   navigate?: (hash: string) => void,
 *   notify?: (message: string) => void,
 *   onLogout?: () => void,
 *   onPickSpace?: (id: string) => void,
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
  win = null,
} = {}) {
  const state = {
    spaces: Array.isArray(initialSpaces) && initialSpaces.length > 0 ? initialSpaces : defaultSpaces(),
    activeSpaceId: null,
    activeScreenId: screenId,
    screenLabel,
    fixCount: 0,
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
    const spaceName = el(doc, 'span', 'bo-space-name', space.name);
    const chevron = el(doc, 'span', 'bo-space-chevron', '▾');
    spaceButton.appendChild(badge);
    spaceButton.appendChild(spaceName);
    spaceButton.appendChild(chevron);
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

    const nav = el(doc, 'nav', 'bo-nav');
    nav.setAttribute('aria-label', 'Sezioni');
    for (const group of SHELL_GROUPS) {
      if (group.header !== null) nav.appendChild(el(doc, 'div', 'bo-nav-header', group.header));
      for (const item of state.items.filter((candidate) => candidate.group === group.id)) {
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
        link.appendChild(el(doc, 'span', 'bo-nav-label', item.label));
        if (item.id === 'impostazioni') {
          const badgeText = settingsBadge(state.fixCount);
          if (badgeText !== '') link.appendChild(el(doc, 'span', 'bo-badge', badgeText));
        }
        nav.appendChild(link);
      }
    }
    sidebar.appendChild(nav);

    const addWrap = el(doc, 'div', 'bo-add');
    const addButton = el(doc, 'button', 'bo-add-button', '+ Nuovo modulo');
    addButton.setAttribute('aria-haspopup', 'true');
    const addMenu = el(doc, 'div', 'bo-add-menu hidden');
    const aiOption = el(doc, 'button', 'bo-add-option', '✦ Crea con l\u2019AI');
    aiOption.addEventListener('click', () => {
      addMenu.classList.toggle('hidden', true);
      focusAiEntry();
      notify('Descrivi il modulo nella barra AI: l\u2019assistente arriva con BO-F0-04.');
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

    const userRow = el(doc, 'div', 'bo-user');
    const initials = typeof user.name === 'string' && user.name.trim() !== ''
      ? user.name.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
      : 'LO';
    userRow.appendChild(el(doc, 'span', 'bo-user-badge', initials));
    const who = el(doc, 'div', 'bo-user-who');
    who.appendChild(el(doc, 'div', 'bo-user-name', typeof user.name === 'string' && user.name !== '' ? user.name : 'Operatore locale'));
    who.appendChild(el(doc, 'div', 'bo-user-email', typeof user.email === 'string' && user.email !== '' ? user.email : 'sviluppo locale'));
    userRow.appendChild(who);
    const logout = el(doc, 'button', 'bo-logout', 'Esci');
    logout.setAttribute('title', 'Esci (reimposta lo spazio locale)');
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
    aiInput = doc.createElement('input');
    aiInput.setAttribute('type', 'search');
    aiInput.setAttribute('class', 'bo-ai-input');
    aiInput.setAttribute('aria-label', 'Barra AI (solo ingresso)');
    aiInput.setAttribute('placeholder', aiPlaceholder(state.activeScreenId));
    aiInput.setAttribute('title', 'Barra AI (⌘K): solo ingresso, l\u2019assistente arriva con BO-F0-04');
    form.appendChild(aiInput);
    const hint = el(doc, 'kbd', 'bo-ai-key', '⌘K');
    form.appendChild(hint);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      notify('Barra AI: solo ingresso. L\u2019assistente arriva con BO-F0-04.');
    });
    topbar.appendChild(form);
  }

  function screenLabelFor(id) {
    const found = state.items.find((item) => item.id === id);
    if (found) return found.label;
    if (typeof state.screenLabel === 'string' && state.screenLabel !== '') return state.screenLabel;
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
    update({ fixCount, activeScreenId, screenLabel: nextLabel, items } = {}) {
      if (fixCount !== undefined) state.fixCount = fixCount;
      if (typeof activeScreenId === 'string') state.activeScreenId = activeScreenId;
      if (typeof nextLabel === 'string' && nextLabel !== '') state.screenLabel = nextLabel;
      if (Array.isArray(items)) state.items = items;
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
      };
    },
  };
}

/**
 * Render the Impostazioni screen: the four areas from the prototype. Areas
 * backed by an existing view link there; the rest name the story that
 * delivers them (BO-F0-03 owns the tabs).
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
    // Stato sync opens the customer-data quality queue: without the package
    // composed it stays an honest note, never a link to a blank screen.
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
    } else {
      row.appendChild(el(doc, 'span', 'bo-setting-coming', `In arrivo con ${area.story}`));
    }
    list.appendChild(row);
  }
  mount.appendChild(list);
}
