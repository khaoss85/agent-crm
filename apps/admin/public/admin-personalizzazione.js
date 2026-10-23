// @ts-check

// Personalizzazione (BO-F4-01, backlog:7543aabbd901): Skill, Connettori e
// Pacchetti per spazio.
//
// Ref "02 Personalizzazione" del prototipo: schede Skill/Connettori/
// Pacchetti, viste I tuoi/Scopri, ricerca, filtri e ordinamento, card con
// "Prova" e +/✓, tabella degli stati, stato vuoto Pacchetti,
// "Sviluppa per Accordo".
//
// La schermata riusa quello che esiste già e non duplica nulla:
// - il catalogo unità (pacchetti + skill) lo pubblica il server su
//   GET /api/space-packages/catalog (`packages/space-permissions`);
// - l'attivazione per spazio è una riga `space-package` (POST
//   /api/space-packages/activate, replay identico; disattivazione con
//   deactivate, mai cancellazione);
// - "Prova" è GET /api/space-packages/preview: una dimostrazione sui dati
//   veri dello spazio che per costruzione non scrive nulla;
// - la scheda Connettori riusa il riepilogo di GET /api/connectors e rimanda
//   al flusso guidato di `#/connettori` (BO-F1-02), senza rifarlo qui.
//
// Convenzioni da apps/admin/public/admin-core.js: i costruttori di modello
// sono puri e senza DOM (testati con node:test senza browser) e il renderer
// usa solo DOM API — createElement + textContent/setAttribute — mai innerHTML
// con dati, così un nome o un blurb ostile resta testo, mai markup.

import { bindAdminMutations } from './admin-submission.js';
import { CONNECTOR_CATALOG } from './admin-connectors.js';

/** The three tabs, in prototype order. */
export const PERSONALIZZAZIONE_TABS = Object.freeze(['pacchetti', 'skill', 'connettori']);

/** @type {Record<string, string>} */
export const PERSONALIZZAZIONE_TAB_LABELS = Object.freeze({
  pacchetti: 'Pacchetti',
  skill: 'Skill',
  connettori: 'Connettori',
});

/** The two views: yours (active in this space) and discover. */
export const PERSONALIZZAZIONE_VIEWS = Object.freeze(['tuoi', 'scopri']);

/** @param {unknown} tab */
export function isPersonalizzazioneTab(tab) {
  return tab === 'pacchetti' || tab === 'skill' || tab === 'connettori';
}

/**
 * One contextual tip per tab: the static slot where the prototype runs its
 * carousel. A single honest tip, never rotating claims.
 * @param {unknown} tab
 */
export function bannerFor(tab) {
  if (tab === 'skill') return 'Le skill insegnano all\u2019AI come lavorare nel tuo studio: la Prova non scrive nulla.';
  if (tab === 'connettori') return 'Collega i canali una volta sola: i nuovi messaggi entrano da soli nelle schede.';
  return 'Un pacchetto mette insieme capacità del framework per il tuo settore: attivalo per questo spazio.';
}

/**
 * Join catalog units with the space's composition rows.
 * @param {{units?: Array<any>, rows?: Array<any>}} input
 * @returns {Map<string, any>} unit name → active row
 */
export function activeByUnit({ units = [], rows = [] } = {}) {
  const known = new Set((Array.isArray(units) ? units : []).map((entry) => entry && entry.name));
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.unit !== 'string' || row.status !== 'active') continue;
    if (!known.has(row.unit)) continue;
    if (!out.has(row.unit)) out.set(row.unit, row);
  }
  return out;
}

/**
 * @param {{entry: any, row?: any}} input
 * @returns {'attiva' | 'da-attivare'}
 */
export function unitStatus({ entry, row } = {}) {
  void entry;
  return row && row.status === 'active' ? 'attiva' : 'da-attivare';
}

/**
 * Filter and sort one tab. `view` is the prototype's I tuoi/Scopri filter;
 * `query` matches label, blurb and unit name case-insensitively; `sort` is
 * `nome` or `stato` (active first, then name).
 */
export function filterUnits({ units = [], active = new Map(), tab = 'pacchetti', view = 'scopri', query = '', sort = 'nome' } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  const kind = tab === 'skill' ? 'skill' : 'package';
  const mine = view === 'tuoi';
  const list = [];
  for (const entry of Array.isArray(units) ? units : []) {
    if (!entry || typeof entry.name !== 'string' || entry.kind !== kind) continue;
    const row = active.get(entry.name) ?? null;
    if (mine && !row) continue;
    if (!mine && row) continue;
    if (needle !== '') {
      const hay = `${entry.label ?? ''} ${entry.blurb ?? ''} ${entry.name}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    list.push({ entry, row });
  }
  list.sort((left, right) => {
    if (sort === 'stato') {
      const rank = (item) => (item.row ? 0 : 1);
      const byState = rank(left) - rank(right);
      if (byState !== 0) return byState;
    }
    return String(left.entry.label ?? left.entry.name).localeCompare(String(right.entry.label ?? right.entry.name), 'it');
  });
  return list;
}

/** @param {unknown} count @param {string} singular @param {string} plural */
export function pluralize(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Lines for the Prova panel from a preview payload. The payload already
 * carries the headline; counts become one line each, uncomposed modules one
 * honest line — never invented detail.
 * @param {any} preview
 */
export function previewLines(preview) {
  if (!preview || typeof preview !== 'object') return [];
  const lines = [];
  if (typeof preview.headline === 'string' && preview.headline !== '') lines.push(preview.headline);
  for (const row of Array.isArray(preview.counts) ? preview.counts : []) {
    if (!row || typeof row.module !== 'string') continue;
    lines.push(`${row.module}: ${pluralize(Number(row.count) || 0, 'riga', 'righe')}`);
  }
  for (const name of Array.isArray(preview.uncomposed) ? preview.uncomposed : []) {
    if (typeof name === 'string' && name !== '') lines.push(`${name}: non composto in questo progetto`);
  }
  if (preview.kind === 'skill' && preview.requires && typeof preview.requires === 'object') {
    lines.push(`Richiede «${preview.requires.command ?? ''}» (${preview.requires.tier ?? ''}).`);
  }
  lines.push('La Prova non ha scritto nulla.');
  return lines;
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
 * A view controller for the Personalizzazione screen. Injecting `doc`,
 * `client` and `nav` keeps it testable without a browser.
 *
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, navigate: (hash: string) => void, spaceId?: () => string | null, toast?: (message: string, error?: boolean) => void, storage?: any}} deps
 */
export function createPersonalizzazioneView(deps) {
  const { doc, mount, navigate } = deps;
  // POSTs go through the submission controller with idempotency, like every
  // other admin view; GETs stay on the raw client.
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});
  const readSpace = () => {
    try {
      const id = deps.spaceId ? deps.spaceId() : null;
      return typeof id === 'string' ? id : '';
    } catch {
      return '';
    }
  };

  const state = {
    tab: 'pacchetti',
    view: 'scopri',
    query: '',
    sort: 'nome',
    /** @type {Array<any> | null} */ units: null,
    /** @type {Array<any> | null} */ rows: null,
    notComposed: false,
    /** @type {Array<any> | null} */ connectors: null,
    connectorsMissing: false,
    /** @type {string | null} */ previewFor: null,
    /** @type {any} */ preview: null,
    busy: false,
  };

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {unknown} error */
  function errorOf(error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error;
    return { code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error) };
  }

  async function load() {
    const space = readSpace().trim();
    state.units = null;
    state.rows = null;
    state.notComposed = false;
    state.previewFor = null;
    state.preview = null;
    if (space === '') return;
    try {
      const catalog = await client.request('/api/space-packages/catalog');
      state.units = Array.isArray(catalog?.units) ? catalog.units : [];
    } catch (error) {
      const failure = errorOf(error);
      if (failure.code === 'NOT_FOUND' || failure.status === 404) state.notComposed = true;
      else state.units = [];
    }
    if (state.notComposed) return;
    try {
      const records = await client.request(
        `/api/modules/space-package/records?filter.spaceId=${encodeURIComponent(space)}`,
      );
      state.rows = Array.isArray(records?.items) ? records.items : (Array.isArray(records) ? records : []);
    } catch {
      state.rows = [];
    }
  }

  async function loadConnectors() {
    const space = readSpace().trim();
    state.connectors = null;
    state.connectorsMissing = false;
    if (space === '') return;
    try {
      const sync = await client.request(`/api/connectors?spaceId=${encodeURIComponent(space)}`);
      state.connectors = Array.isArray(sync?.connectors) ? sync.connectors : [];
    } catch (error) {
      const failure = errorOf(error);
      if (failure.code === 'NOT_FOUND' || failure.status === 404) state.connectorsMissing = true;
      else state.connectors = [];
    }
  }

  /** @param {string} message @param {boolean} [isError] */
  function say(message, isError = false) {
    toast(message, isError);
  }

  async function mutate(path, body) {
    state.busy = true;
    render();
    try {
      const answer = await client.request(path, { method: 'POST', body });
      return answer;
    } finally {
      state.busy = false;
    }
  }

  function channelLabel(channel) {
    const found = CONNECTOR_CATALOG.find((entry) => entry.channel === channel);
    return found ? found.label : String(channel);
  }

  function renderHeader(box) {
    box.appendChild(el(doc, 'h2', { text: 'Personalizzazione', cls: 'panel-title' }));
    box.appendChild(el(doc, 'p', {
      text: 'Skill, connettori e pacchetti di questo spazio. La Prova mostra dati veri senza scrivere nulla.',
      cls: 'muted',
    }));
  }

  function renderTabs(box) {
    const tabs = el(doc, 'div', { cls: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Personalizzazione' } });
    for (const tab of PERSONALIZZAZIONE_TABS) {
      const button = el(doc, 'button', {
        text: PERSONALIZZAZIONE_TAB_LABELS[tab],
        cls: `tab${state.tab === tab ? ' active' : ''}`,
        attrs: { role: 'tab', 'aria-selected': state.tab === tab ? 'true' : 'false', type: 'button' },
      });
      button.disabled = state.busy;
      button.addEventListener('click', () => {
        state.tab = tab;
        state.previewFor = null;
        state.preview = null;
        if (tab === 'connettori' && state.connectors === null && !state.connectorsMissing) {
          void loadConnectors().then(render);
        }
        render();
      });
      tabs.appendChild(button);
    }
    box.appendChild(tabs);
  }

  function renderToolbar(box, count) {
    const bar = el(doc, 'div', { cls: 'toolbar' });
    if (state.tab !== 'connettori') {
      for (const view of PERSONALIZZAZIONE_VIEWS) {
        const button = el(doc, 'button', {
          text: view === 'tuoi' ? 'I tuoi' : 'Scopri',
          cls: `tab${state.view === view ? ' active' : ''}`,
          attrs: { type: 'button', 'aria-pressed': state.view === view ? 'true' : 'false' },
        });
        button.disabled = state.busy;
        button.addEventListener('click', () => { state.view = view; state.previewFor = null; state.preview = null; render(); });
        bar.appendChild(button);
      }
      const search = el(doc, 'input', {
        cls: 'search',
        attrs: { type: 'search', placeholder: 'Cerca per nome…', 'aria-label': 'Cerca', value: state.query },
      });
      search.value = state.query;
      search.addEventListener('input', () => { state.query = String(search.value ?? ''); renderList(); });
      bar.appendChild(search);
      const sort = el(doc, 'select', { cls: 'sort', attrs: { 'aria-label': 'Ordina per' } });
      for (const [value, label] of [['nome', 'Ordina: nome'], ['stato', 'Ordina: stato']]) {
        const option = el(doc, 'option', { text: label, attrs: { value } });
        if (state.sort === value) option.setAttribute('selected', 'selected');
        sort.appendChild(option);
      }
      // A real select element reports its choice; the fake keeps first.
      try { sort.value = state.sort; } catch { /* keep rendered order */ }
      sort.addEventListener('change', () => { state.sort = String(sort.value === 'stato' ? 'stato' : 'nome'); renderList(); });
      bar.appendChild(sort);
      const add = el(doc, 'button', { text: 'Aggiungi ▾', cls: 'add', attrs: { type: 'button' } });
      add.disabled = state.busy;
      add.addEventListener('click', () => {
        if (state.tab === 'skill') {
          say('Le skill personalizzate arrivano con BO-F4-02: intanto copia il prompt dalla Prova di una skill.');
        } else {
          say('I pacchetti personalizzati si creano con `accordo module:create` (vedi docs/MODULE_FACTORY.md).');
        }
      });
      bar.appendChild(add);
    }
    const total = el(doc, 'span', { text: pluralize(count, 'voce', 'voci'), cls: 'muted' });
    bar.appendChild(total);
    box.appendChild(bar);
    const banner = el(doc, 'p', { text: bannerFor(state.tab), cls: 'banner' });
    box.appendChild(banner);
  }

  function renderList() {
    const existing = mount.querySelector('.plist');
    if (existing && existing.parentNode === mount) mount.removeChild(existing);
    const stalePreview = mount.querySelector('.preview');
    if (stalePreview && stalePreview.parentNode === mount) mount.removeChild(stalePreview);
    const box = el(doc, 'div', { cls: 'plist' });
    const space = readSpace().trim();
    if (space === '') {
      box.appendChild(el(doc, 'p', { text: 'Scegli uno spazio per vedere la sua personalizzazione.', cls: 'empty' }));
      mount.appendChild(box);
      return;
    }
    if (state.notComposed) {
      box.appendChild(el(doc, 'p', {
        text: 'Personalizzazione non composta in questo progetto: il server non pubblica il catalogo (manca il pacchetto space-permissions).',
        cls: 'empty',
      }));
      mount.appendChild(box);
      return;
    }
    if (state.tab === 'connettori') {
      renderConnectorsTab(box);
      mount.appendChild(box);
      return;
    }
    if (state.units === null || state.rows === null) {
      box.appendChild(el(doc, 'p', { text: 'Lettura della personalizzazione…', cls: 'muted' }));
      mount.appendChild(box);
      return;
    }
    const units = state.units ?? [];
    const rows = state.rows ?? [];
    const known = activeByUnit({ units, rows });
    const items = filterUnits({ units, active: known, tab: state.tab, view: state.view, query: state.query, sort: state.sort });
    if (items.length === 0) {
      const emptyTitle = state.view === 'tuoi'
        ? (state.tab === 'skill' ? 'Attiva le tue prime skill' : 'Aggiungi il tuo primo pacchetto')
        : 'Nessun risultato';
      const emptySub = state.view === 'tuoi'
        ? (state.tab === 'skill'
          ? 'Le skill insegnano all\u2019AI come lavorare nel tuo studio.'
          : 'Un pacchetto mette insieme capacità del framework per il tuo settore.')
        : 'Prova a cambiare ricerca o scheda.';
      box.appendChild(el(doc, 'p', { text: emptyTitle, cls: 'empty-title' }));
      box.appendChild(el(doc, 'p', { text: emptySub, cls: 'empty' }));
      mount.appendChild(box);
      return;
    }
    if (state.view === 'tuoi') renderMineTable(box, items);
    else renderDiscoverCards(box, items);
    mount.appendChild(box);
    if (state.previewFor) renderPreview(box);
  }

  /** @param {any} box @param {Array<{entry: any, row: any}>} items */
  function renderMineTable(box, items) {
    const table = el(doc, 'table', { cls: 'mine' });
    const head = el(doc, 'tr');
    head.appendChild(el(doc, 'th', { text: state.tab === 'skill' ? 'Skill' : 'Pacchetto' }));
    head.appendChild(el(doc, 'th', { text: 'Stato' }));
    head.appendChild(el(doc, 'th', { text: '' }));
    table.appendChild(head);
    for (const { entry, row } of items) {
      const line = el(doc, 'tr');
      line.appendChild(el(doc, 'td', { text: String(entry.label ?? entry.name) }));
      line.appendChild(el(doc, 'td', { text: unitStatus({ entry, row }) === 'attiva' ? 'Attiva ✓' : 'Da attivare' }));
      const cell = el(doc, 'td');
      const toggle = el(doc, 'button', { text: 'Disattiva', attrs: { type: 'button' } });
      toggle.disabled = state.busy;
      toggle.addEventListener('click', async () => {
        try {
          await mutate('/api/space-packages/deactivate', { spaceId: readSpace().trim(), unit: entry.name });
          say(`«${entry.label}» disattivata in questo spazio.`);
          await load();
        } catch (error) {
          const failure = errorOf(error);
          say(failure.message || 'Disattivazione non riuscita.', true);
          state.busy = false;
        }
        render();
      });
      cell.appendChild(toggle);
      line.appendChild(cell);
      table.appendChild(line);
    }
    box.appendChild(table);
  }

  /** @param {any} box @param {Array<{entry: any, row: any}>} items */
  function renderDiscoverCards(box, items) {
    for (const { entry, row } of items) {
      const card = el(doc, 'article', { cls: 'card', attrs: { 'data-unit': entry.name } });
      card.appendChild(el(doc, 'h3', { text: String(entry.label ?? entry.name) }));
      if (entry.blurb) card.appendChild(el(doc, 'p', { text: String(entry.blurb), cls: 'muted' }));
      const actions = el(doc, 'div', { cls: 'card-actions' });
      const proof = el(doc, 'button', { text: 'Prova', attrs: { type: 'button' } });
      proof.disabled = state.busy;
      proof.addEventListener('click', async () => {
        state.previewFor = entry.name;
        state.preview = null;
        renderList();
        try {
          const space = readSpace().trim();
          const preview = await client.request(
            `/api/space-packages/preview?spaceId=${encodeURIComponent(space)}&unit=${encodeURIComponent(entry.name)}`,
          );
          state.preview = preview;
        } catch (error) {
          const failure = errorOf(error);
          state.preview = { headline: failure.message || 'Prova non riuscita.', counts: [], uncomposed: [], writes: 0 };
        }
        renderList();
      });
      actions.appendChild(proof);
      const active = unitStatus({ entry, row }) === 'attiva';
      const add = el(doc, 'button', { text: active ? '✓' : '+', attrs: { type: 'button', 'aria-label': active ? 'Attiva (già attiva)' : `Attiva ${entry.label ?? entry.name}` } });
      add.disabled = state.busy || active;
      if (!active) {
        add.addEventListener('click', async () => {
          try {
            await mutate('/api/space-packages/activate', { spaceId: readSpace().trim(), unit: entry.name });
            say(`«${entry.label}» attiva in questo spazio.`);
            state.view = 'tuoi';
            await load();
          } catch (error) {
            const failure = errorOf(error);
            say(failure.message || 'Attivazione non riuscita.', true);
            state.busy = false;
          }
          render();
        });
      }
      actions.appendChild(add);
      card.appendChild(actions);
      box.appendChild(card);
    }
    const dev = el(doc, 'article', { cls: 'card dev' });
    dev.appendChild(el(doc, 'h3', { text: 'Sviluppa per Accordo' }));
    dev.appendChild(el(doc, 'p', { text: 'Hai un settore con esigenze sue? Impacchetta capacità esistenti.', cls: 'muted' }));
    const go = el(doc, 'button', { text: 'Come pubblicare un pacchetto', attrs: { type: 'button' } });
    go.addEventListener('click', () => {
      say('I pacchetti personalizzati si creano con `accordo module:create` (vedi docs/MODULE_FACTORY.md).');
    });
    dev.appendChild(go);
    box.appendChild(dev);
  }

  /** @param {any} box */
  function renderPreview(box) {
    const panel = el(doc, 'section', { cls: 'preview', attrs: { 'aria-live': 'polite' } });
    panel.appendChild(el(doc, 'h3', { text: `Prova · ${state.previewFor}` }));
    if (!state.preview) {
      panel.appendChild(el(doc, 'p', { text: 'Dimostrazione in corso…', cls: 'muted' }));
    } else {
      const lines = el(doc, 'ul');
      for (const line of previewLines(state.preview)) {
        lines.appendChild(el(doc, 'li', { text: line }));
      }
      panel.appendChild(lines);
    }
    const close = el(doc, 'button', { text: 'Chiudi', attrs: { type: 'button' } });
    close.addEventListener('click', () => { state.previewFor = null; state.preview = null; renderList(); });
    panel.appendChild(close);
    box.appendChild(panel);
  }

  /** @param {any} box */
  function renderConnectorsTab(box) {
    if (state.connectorsMissing) {
      box.appendChild(el(doc, 'p', {
        text: 'Connettori non composti in questo progetto: il server non pubblica lo stato (manca il pacchetto channels).',
        cls: 'empty',
      }));
      return;
    }
    const entries = state.connectors ?? [];
    if (state.connectors === null) {
      box.appendChild(el(doc, 'p', { text: 'Lettura dei collegamenti…', cls: 'muted' }));
      return;
    }
    if (entries.length === 0) {
      box.appendChild(el(doc, 'p', { text: 'Nessun canale collegato in questo spazio.', cls: 'empty' }));
    } else {
      const table = el(doc, 'table', { cls: 'mine' });
      const head = el(doc, 'tr');
      head.appendChild(el(doc, 'th', { text: 'Canale' }));
      head.appendChild(el(doc, 'th', { text: 'Stato' }));
      table.appendChild(head);
      for (const entry of entries) {
        const line = el(doc, 'tr');
        line.appendChild(el(doc, 'td', { text: channelLabel(entry.channel ?? entry.connectionKey) }));
        line.appendChild(el(doc, 'td', { text: String(entry.status ?? '—') }));
        table.appendChild(line);
      }
      box.appendChild(table);
    }
    const open = el(doc, 'button', { text: 'Apri connettori', attrs: { type: 'button' } });
    open.disabled = state.busy;
    open.addEventListener('click', () => navigate('#/connettori'));
    box.appendChild(open);
  }

  function render() {
    clear();
    const box = el(doc, 'div', { cls: 'panel personalizzazione' });
    renderHeader(box);
    if (readSpace().trim() === '') {
      box.appendChild(el(doc, 'p', { text: 'Scegli uno spazio per vedere la sua personalizzazione.', cls: 'empty' }));
      mount.appendChild(box);
      return;
    }
    renderTabs(box);
    const units = state.units ?? [];
    const rows = state.rows ?? [];
    const known = activeByUnit({ units, rows });
    let count = 0;
    if (state.tab !== 'connettori') {
      count = filterUnits({ units, active: known, tab: state.tab, view: state.view, query: state.query, sort: state.sort }).length;
    } else if (Array.isArray(state.connectors)) {
      count = state.connectors.length;
    }
    renderToolbar(box, count);
    mount.appendChild(box);
    renderList();
  }

  async function renderView() {
    render();
    if (readSpace().trim() === '') return;
    await load();
    if (state.tab === 'connettori') await loadConnectors();
    render();
  }

  return {
    render: renderView,
    /** Test seam: drive the pure state without a browser. */
    test: { state, filterUnits, activeByUnit, unitStatus, previewLines, bannerFor },
  };
}
