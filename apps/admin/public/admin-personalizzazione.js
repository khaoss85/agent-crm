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
// - la scheda Connettori rende il contenuto del prototipo (hero Kit social,
//   sezioni Canali di conversazione e Agenda, lead e pagamenti da
//   CONNETTORI_SECTIONS) con lo stato ✓/+ letto da GET /api/connectors, e
//   rimanda al flusso guidato di `#/connettori` (BO-F1-02) o alle schermate
//   di Calendario e Preventivi, senza rifare il wizard qui.
//
// Convenzioni da apps/admin/public/admin-core.js: i costruttori di modello
// sono puri e senza DOM (testati con node:test senza browser) e il renderer
// usa solo DOM API — createElement + textContent/setAttribute — mai innerHTML
// con dati, così un nome o un blurb ostile resta testo, mai markup.

import { bindAdminMutations } from './admin-submission.js';
import { CONNECTOR_CATALOG, matchConnections } from './admin-connectors.js';
import { humanReadError } from './admin-core.js';

/** The three tabs, in prototype order (spec C7): Skill AI, Connettori, Pacchetti. */
export const PERSONALIZZAZIONE_TABS = Object.freeze(['skill', 'connettori', 'pacchetti']);

/** @type {Record<string, string>} */
export const PERSONALIZZAZIONE_TAB_LABELS = Object.freeze({
  skill: 'Skill AI',
  connettori: 'Connettori',
  pacchetti: 'Pacchetti',
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
import { el, uiBadge, uiButton, uiChannelChip } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * The Connettori tab content, from the approved prototype (shots-2026-10-24,
 * `02 Personalizzazione`, Connettori): the Kit-social hero plus the
 * `Canali di conversazione` and `Agenda, lead e pagamenti` card sections.
 * Copy is presentational and static (Italian, like the prototype); only the
 * ✓/+ state reads the live connector rows, so demo fixtures and the real
 * server render the same structure.
 *
 * Entries with a `channel` reuse the guided `#/connettori` flow for that
 * channel; the channel must be a CONNECTOR_CATALOG member (pinned by test),
 * otherwise the card falls back to the hub link instead of a deep link.
 * Google Calendar and Stripe live on their own screens, so their cards link
 * there (DECISION to be confirmed: `#/calendario` and `#/quotes`).
 */
export const CONNETTORI_SECTIONS = Object.freeze([
  {
    id: 'conversazione',
    title: 'Canali di conversazione',
    entries: Object.freeze([
      {
        key: 'whatsapp', label: 'WhatsApp', chip: 'WA', channel: 'whatsapp',
        lines: Object.freeze(['Messaggi, note vocali e allegati del numero aziendale.', 'di Meta · ↔ bidirezionale']),
      },
      {
        key: 'instagram', label: 'Instagram', chip: 'IG', channel: 'instagram',
        lines: Object.freeze(['DM, risposte alle storie e commenti ai post.', 'di Meta · ↔ bidirezionale']),
      },
      {
        key: 'facebook', label: 'Facebook', chip: 'FB', channel: 'facebook',
        lines: Object.freeze(['Messenger e lead dalle inserzioni.', 'di Meta · ↔ bidirezionale']),
      },
      {
        key: 'tiktok', label: 'TikTok', chip: 'TT', channel: 'tiktok',
        lines: Object.freeze(['Messaggi diretti e lead dai moduli TikTok.', 'di TikTok · ← in entrata']),
      },
      {
        key: 'email', label: 'Email', chip: '@', channel: 'email',
        lines: Object.freeze(['Gmail o Outlook: conversazioni e allegati.', 'Gmail e Outlook · ↔ bidirezionale']),
      },
      {
        key: 'telefono', label: 'Telefono', chip: 'TEL', channel: 'voice',
        lines: Object.freeze(['Chiamate in entrata e in uscita, con trascrizione AI.', 'di Accordo · ↔ bidirezionale']),
      },
    ]),
  },
  {
    id: 'agenda',
    title: 'Agenda, lead e pagamenti',
    entries: Object.freeze([
      {
        key: 'form', label: 'Form sito', chip: 'WEB', channel: 'site-form',
        lines: Object.freeze(['Ogni invio del form crea o aggiorna un contatto.', 'di Accordo · ← in entrata']),
      },
      {
        key: 'calendar', label: 'Google Calendar', chip: 'CAL', channel: null, href: '#/calendario',
        lines: Object.freeze(['Appuntamenti del team e disponibilità condivisa.', 'di Google · ↔ bidirezionale']),
      },
      {
        key: 'stripe', label: 'Stripe', chip: 'S', channel: null, href: '#/quotes',
        lines: Object.freeze(['Pagamenti, abbonamenti e rinnovi.', 'di Stripe · ↔ pagamenti e link']),
      },
    ]),
  },
]);

const CONNETTORI_CATALOG_CHANNELS = new Set(CONNECTOR_CATALOG.map((entry) => entry && entry.channel));

/**
 * Where a card leads: the guided `#/connettori/<canale>` detail for a live
 * catalog channel (the detail forwards to the wizard), the entry's own
 * screen otherwise, the hub when nothing else applies.
 * @param {{ channel?: unknown, href?: unknown }} entry
 */
export function connettoriHref(entry) {
  if (entry && typeof entry.channel === 'string' && CONNETTORI_CATALOG_CHANNELS.has(entry.channel)) {
    return `#/connettori/${entry.channel}`;
  }
  if (entry && typeof entry.href === 'string' && entry.href !== '') return entry.href;
  return '#/connettori';
}

/**
 * The card state from the live rows: `collegato` when an active row serves
 * the entry's channel, `da-collegare` otherwise (and always for entries
 * without a channel, which no `/api/connectors` row can serve).
 * @param {{ channel?: unknown }} entry
 * @param {unknown} connectors
 */
export function connettoriCardState(entry, connectors) {
  const channel = entry && typeof entry.channel === 'string' ? entry.channel : '';
  if (channel === '') return 'da-collegare';
  const rows = matchConnections(channel, Array.isArray(connectors) ? connectors : []);
  return rows.some((row) => row && row.status === 'active') ? 'collegato' : 'da-collegare';
}

/**
 * Filter and sort the Connettori cards. Pure: the query matches label and
 * lines case-insensitively, `stato` sorts connected cards first.
 */
export function filterConnettori({ connectors = [], query = '', sort = 'nome' } = {}) {
  const needle = String(query ?? '').trim().toLowerCase();
  return CONNETTORI_SECTIONS.map((section) => {
    const cards = [];
    for (const entry of section.entries) {
      if (needle !== '') {
        const hay = `${entry.label} ${entry.lines.join(' ')}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      cards.push({ entry, state: connettoriCardState(entry, connectors) });
    }
    cards.sort((left, right) => {
      if (sort === 'stato') {
        const rank = (card) => (card.state === 'collegato' ? 0 : 1);
        const byState = rank(left) - rank(right);
        if (byState !== 0) return byState;
      }
      return String(left.entry.label).localeCompare(String(right.entry.label), 'it');
    });
    return { section, cards };
  });
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
    tab: 'connettori',
    view: 'scopri',
    query: '',
    sort: 'nome',
    /** @type {Array<any> | null} */ units: null,
    /** @type {Array<any> | null} */ rows: null,
    notComposed: false,
    /** @type {string | null} human text for a failed catalog read, with a retry */
    unitsError: null,
    /** @type {Array<any> | null} */ connectors: null,
    connectorsMissing: false,
    /** @type {string | null} */ previewFor: null,
    /** @type {any} */ preview: null,
    busy: false,
  };

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
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

  async function load() {
    const space = readSpace().trim();
    state.units = null;
    state.rows = null;
    state.notComposed = false;
    state.unitsError = null;
    state.previewFor = null;
    state.preview = null;
    if (space === '') return;
    try {
      const catalog = await client.request('/api/space-packages/catalog');
      state.units = Array.isArray(catalog?.units) ? catalog.units : [];
    } catch (error) {
      const failure = errorOf(error);
      if (failure.code === 'NOT_FOUND' || failure.status === 404) state.notComposed = true;
      else {
        // A failed catalog read is not an empty catalog: keep the human
        // text (the technical detail stays in the console) with a retry.
        // The original error goes to humanReadError, never the normalized
        // copy, so code, status and message all survive.
        state.units = [];
        state.unitsError = humanReadError(error, {
          failed: 'La personalizzazione non si è potuta leggere. Riprova più tardi.',
        });
      }
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
      // 404 means the server does not publish connector state (package not
      // composed): render the directory with every card as `+`, the honest
      // zero-state, and let the wizard surface its own note. Any other
      // failure is an outage: the Italian error with Riprova, never cards
      // pretending every channel is disconnected.
      if (failure.code === 'NOT_FOUND' || failure.status === 404) state.connectors = [];
      else state.connectorsMissing = true;
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

  /** @param {string} hash */
  function go(hash) {
    navigate(hash);
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
    }
    const search = el(doc, 'input', {
      cls: 'search',
      attrs: { type: 'search', placeholder: 'Cerca', 'aria-label': 'Cerca', value: state.query },
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
    // The green CTA opens where a unit is added: the guided wizard for a
    // channel, the module factory note for packages, the skill note.
    const add = uiButton(doc, { variant: 'cta', label: 'Aggiungi ▾', attrs: { type: 'button' } });
    add.disabled = state.busy;
    add.addEventListener('click', () => {
      if (state.tab === 'connettori') {
        go('#/connettori');
      } else if (state.tab === 'skill') {
        say('Le skill personalizzate arrivano con BO-F4-02: intanto copia il prompt dalla Prova di una skill.');
      } else {
        say('I pacchetti personalizzati si creano con `accordo module:create` (vedi docs/MODULE_FACTORY.md).');
      }
    });
    bar.appendChild(add);
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
        text: 'Personalizzazione non composta in questo progetto: il catalogo non è pubblicato.',
        cls: 'empty',
      }));
      mount.appendChild(box);
      return;
    }
    if (state.unitsError !== null) {
      box.appendChild(el(doc, 'p', { text: state.unitsError, cls: 'empty' }));
      const retry = uiButton(doc, { variant: 'secondary', label: 'Riprova', attrs: { type: 'button' } });
      retry.addEventListener('click', () => {
        state.unitsError = null;
        state.units = null;
        state.rows = null;
        renderList();
        // Same reload as the first paint: catalog, rows, and connectors on
        // the connectors tab.
        void (async () => {
          await load();
          if (state.tab === 'connettori') await loadConnectors();
          render();
        })();
      });
      box.appendChild(retry);
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
    head.appendChild(el(doc, 'th', { text: state.tab === 'skill' ? 'Skill AI' : 'Pacchetto' }));
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
        text: 'Non riesco a caricare i connettori. Riprova.',
        cls: 'empty',
      }));
      const retry = uiButton(doc, { variant: 'secondary', label: 'Riprova', attrs: { type: 'button' } });
      retry.addEventListener('click', () => {
        state.connectorsMissing = false;
        state.connectors = null;
        renderList();
        void loadConnectors().then(render);
      });
      box.appendChild(retry);
      return;
    }
    if (state.connectors === null) {
      box.appendChild(el(doc, 'p', { text: 'Lettura dei collegamenti…', cls: 'muted' }));
      return;
    }
    renderConnettoriHero(box);
    const connectors = state.connectors ?? [];
    const groups = filterConnettori({ connectors, query: state.query, sort: state.sort });
    const sections = el(doc, 'div', { cls: 'connettori-sections' });
    let shown = 0;
    for (const group of groups) {
      if (group.cards.length === 0) continue;
      shown += group.cards.length;
      renderConnettoriSection(sections, group);
    }
    box.appendChild(sections);
    if (shown === 0) {
      box.appendChild(el(doc, 'p', { text: 'Nessun risultato per questa ricerca.', cls: 'empty' }));
    }
  }

  /** @param {any} box */
  function renderConnettoriHero(box) {
    const hero = el(doc, 'section', { cls: 'ui-hero', attrs: { 'aria-label': 'Kit social' } });
    const copy = el(doc, 'div', { cls: 'ui-hero-copy' });
    copy.appendChild(el(doc, 'p', { text: 'CURATO DA ACCORDO', cls: 'ui-hero-eyebrow' }));
    copy.appendChild(el(doc, 'h3', { text: 'Kit social', cls: 'ui-hero-title' }));
    copy.appendChild(el(doc, 'p', {
      text: 'Instagram, Facebook, TikTok e WhatsApp in un\u2019unica inbox, con risposte che partono dal canale originale.',
      cls: 'ui-hero-text',
    }));
    const explore = uiButton(doc, { variant: 'secondary', label: 'Esplora', attrs: { type: 'button' } });
    explore.addEventListener('click', () => {
      try {
        const sections = mount.querySelector('.connettori-sections');
        if (sections && typeof sections.scrollIntoView === 'function') sections.scrollIntoView();
      } catch { /* the fake DOM has no scrolling: the sections render below */ }
    });
    copy.appendChild(explore);
    hero.appendChild(copy);
    const tiles = el(doc, 'div', { cls: 'ui-hero-tiles', attrs: { 'aria-hidden': 'true' } });
    for (const chip of ['IG', 'FB', 'TT', 'WA']) tiles.appendChild(uiChannelChip(doc, chip));
    hero.appendChild(tiles);
    const dots = el(doc, 'div', { cls: 'ui-hero-dots', attrs: { 'aria-hidden': 'true' } });
    for (let index = 0; index < 3; index += 1) {
      dots.appendChild(el(doc, 'span', { cls: index === 0 ? 'on' : undefined }));
    }
    hero.appendChild(dots);
    box.appendChild(hero);
  }

  /** @param {any} box @param {{ section: any, cards: Array<{ entry: any, state: string }> }} group */
  function renderConnettoriSection(box, group) {
    const head = el(doc, 'div', { cls: 'ui-conn-head' });
    head.appendChild(el(doc, 'h3', { text: group.section.title }));
    head.appendChild(el(doc, 'span', {
      text: String(group.cards.length),
      cls: 'ui-conn-count',
      attrs: { 'aria-label': `${group.cards.length} canali` },
    }));
    const all = el(doc, 'button', { text: 'Mostra tutto →', cls: 'ui-conn-all', attrs: { type: 'button' } });
    all.addEventListener('click', () => go('#/connettori'));
    head.appendChild(all);
    box.appendChild(head);
    const grid = el(doc, 'div', { cls: 'ui-conn-grid' });
    for (const card of group.cards) {
      const article = el(doc, 'article', { cls: 'ui-card ui-conn-card' });
      article.appendChild(uiChannelChip(doc, card.entry.chip));
      const body = el(doc, 'div', { cls: 'ui-conn-body' });
      body.appendChild(el(doc, 'strong', { text: card.entry.label, cls: 'ui-conn-label' }));
      for (const line of card.entry.lines) {
        body.appendChild(el(doc, 'p', { text: line, cls: 'ui-conn-lines' }));
      }
      article.appendChild(body);
      const state = el(doc, 'div', { cls: 'ui-conn-state' });
      if (card.state === 'collegato') {
        const badge = uiBadge(doc, { authority: 'accord', text: '✓' });
        badge.setAttribute('title', 'Collegato');
        state.appendChild(badge);
      } else {
        const add = uiButton(doc, {
          variant: 'secondary', small: true, label: '+',
          attrs: { type: 'button', 'aria-label': `Collega ${card.entry.label}` },
        });
        const href = connettoriHref(card.entry);
        add.addEventListener('click', () => go(href));
        state.appendChild(add);
      }
      article.appendChild(state);
      grid.appendChild(article);
    }
    box.appendChild(grid);
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
      count = filterConnettori({ connectors: state.connectors, query: state.query, sort: state.sort })
        .reduce((total, group) => total + group.cards.length, 0);
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
    test: {
      state, filterUnits, activeByUnit, unitStatus, previewLines, bannerFor,
      filterConnettori, connettoriCardState, connettoriHref, sections: CONNETTORI_SECTIONS,
    },
  };
}
