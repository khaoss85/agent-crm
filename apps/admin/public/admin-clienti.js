// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.

// BO-F1-05 — Elenco Clienti: viste rapide, ricerca, filtri raggruppati con
// "Crea un filtro con l'AI", × sui filtri, ordinamento, colonne configurabili
// (tra cui "Budget dichiarato" estratto dall'AI con fonte) e paginazione
// 10/25/50 con ellissi.
//
// Reference: the approved backoffice prototype ("04 Clienti"). The list is a
// read-only projection over `GET /api/customer-data/customers`, which owns
// views (saved query descriptors), filters, sorting and server pagination —
// this view sends the query and renders the page, nothing else. Like every
// admin view, values travel as text, never HTML, so hostile customer names or
// AI excerpts stay inert text. Rows link to the scheda cliente (BO-F1-06).
//
// AI functions ("Crea un filtro con l'AI", natural-language search) run
// through the BO-F0-04 assistant panel via `onAskAi`: without an LLM backend
// the panel stays usable and those questions answer with the key notice —
// the entry point never breaks. The deterministic channel-word search
// ("marco whatsapp") needs no LLM and always works.

import { humanReadError } from './admin-core.js';

const CHANNEL_LABELS = Object.freeze({
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Messenger',
  tiktok: 'TikTok',
  email: 'Email',
  phone: 'Telefono',
});

const STATO_LABELS = Object.freeze({ cliente: 'Cliente', contatto: 'Contatto' });

/** localStorage key for the visible columns (operator-local, like the shell). */
export const CLIENTI_COLUMNS_KEY = 'accordo.clienti.columns';

/** Fallbacks before the first server answer names the real menus, in prototype order. */
const FALLBACK_VIEWS = Object.freeze([
  { id: 'tutti', label: 'Tutti' },
  { id: 'ricontattare-oggi', label: 'Da ricontattare oggi' },
  { id: 'nuovi-lead', label: 'Nuovi lead' },
  { id: 'clienti-attivi', label: 'Clienti attivi' },
  { id: 'rinnovi-30-giorni', label: 'Rinnovi entro 30 giorni' },
]);
const FALLBACK_SORTS = Object.freeze([
  { id: 'recent', label: 'Ultimo contatto' },
  { id: 'name', label: 'Nome A–Z' },
  { id: 'value', label: 'Valore offerta' },
  { id: 'status', label: 'Stato' },
]);
const FALLBACK_COLUMNS = Object.freeze([
  { id: 'canali', label: 'Canali', always: false, ai: false, def: true },
  { id: 'stato', label: 'Stato', always: false, ai: false, def: true },
  { id: 'ultimo', label: 'Ultimo contatto', always: false, ai: false, def: true },
  { id: 'prossimo', label: 'Prossimo passo', always: false, ai: false, def: true },
  { id: 'email', label: 'Email', always: false, ai: false, def: false },
  { id: 'telefono', label: 'Telefono', always: false, ai: false, def: false },
  { id: 'offerta', label: 'Valore offerta', always: false, ai: false, def: false },
  { id: 'budget', label: 'Budget dichiarato', always: false, ai: true, def: false },
]);
const FALLBACK_SIZES = Object.freeze([10, 25, 50]);

// The prototype's channel tiles: a short mono mark, the full name in the title.
const CHANNEL_MARKS = Object.freeze({ whatsapp: 'WA', instagram: 'IG', facebook: 'FB', email: '@', tiktok: 'TT', phone: 'TEL', sms: 'SMS', web: 'WEB' });
const channelMark = (system) => CHANNEL_MARKS[String(system ?? '').toLowerCase()] ?? String(system ?? '·').slice(0, 3).toUpperCase();
const ROME_DAY = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' });
/** «20 ott» for a stored date or timestamp; the raw value only when it does not parse. */
const shortDay = (value) => {
  const raw = String(value ?? '');
  const date = new Date(raw.length === 10 ? `${raw}T12:00:00Z` : raw);
  return Number.isNaN(date.getTime()) ? raw.slice(0, 10) : ROME_DAY.format(date).replace('.', '');
};
const channelLabel = (system) => CHANNEL_LABELS[String(system ?? '').toLowerCase()] ?? String(system ?? 'canale');

/**
 * Page numbers with ellipses, like the prototype: first, last and the
 * neighbours of the current page, gaps collapsed to "…".
 * @param {number} pages @param {number} page
 */
/** Two-letter initials for the row avatar, like the prototype. */
function initialsOf(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.slice(0, 2).map((word) => (word.match(/\p{L}/u)?.[0] ?? '').toUpperCase()).join('') || '·';
}

export function pageNumbers(pages, page) {
  const nums = [];
  for (let candidate = 1; candidate <= pages; candidate += 1) {
    if (candidate === 1 || candidate === pages || Math.abs(candidate - page) <= 1) nums.push(candidate);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return nums;
}

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void,
 *   notify?: (message: string) => void, spaceId?: string | (() => (string | null | undefined)),
 *   onAskAi?: ((question: string) => void) | null,
 *   onManualAdd?: (() => void) | null, storage?: any}} deps
 */
export function createCustomerListView(deps) {
  const { doc, mount, navigate = () => {}, notify = () => {}, onAskAi = null } = deps;
  void navigate;
  const { client } = deps;
  const activeSpaceId = () => {
    const raw = typeof deps.spaceId === 'function' ? deps.spaceId() : deps.spaceId;
    return typeof raw === 'string' && raw !== '' ? raw : null;
  };
  const store = deps.storage ?? null;

  const el = elFor(doc); // BO-F6-02: shared element builder.
  const link = (href, text, action) => {
    const node = el('a', undefined, text);
    node.setAttribute('href', href);
    if (action) node.setAttribute('data-action', action);
    return node;
  };

  const state = {
    vista: 'tutti', q: '', canale: 'all', stato: 'all', sort: 'recent',
    page: 1, pageSize: 10, columns: null,
  };
  let data = null;
  let renderToken = 0;

  /**
   * Every known column carries an explicit boolean: a stored choice where the
   * operator made one, the server default otherwise. A missing key must read
   * as off (`=== true` everywhere below), never as on — otherwise an opt-in
   * column like the AI budget renders before the operator asks for it, and
   * its toggle can never switch it on.
   */
  function normalizeColumns(columnsMeta, stored) {
    const normalized = {};
    for (const column of columnsMeta) {
      if (column.always) continue;
      if (stored && typeof stored[column.id] === 'boolean') normalized[column.id] = stored[column.id];
      else normalized[column.id] = column.def === true;
    }
    return normalized;
  }

  function readStoredColumns() {
    try {
      const raw = store?.getItem?.(CLIENTI_COLUMNS_KEY);
      if (typeof raw !== 'string' || raw === '') return null;
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeStoredColumns() {
    try {
      store?.setItem?.(CLIENTI_COLUMNS_KEY, JSON.stringify(state.columns));
    } catch {
      // Private mode: the columns still apply to this tab.
    }
  }

  function clearMount() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  function queryString() {
    const params = new URLSearchParams();
    params.set('vista', state.vista);
    params.set('sort', state.sort);
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    if (state.q !== '') params.set('q', state.q);
    if (state.canale !== 'all') params.set('canale', state.canale);
    if (state.stato !== 'all') params.set('stato', state.stato);
    const spaceId = activeSpaceId();
    if (spaceId) params.set('spaceId', spaceId);
    return params.toString();
  }

  async function load() {
    const token = ++renderToken;
    drawShell();
    const statusLine = mount.querySelector?.('.bo-clienti-status');
    if (statusLine) statusLine.textContent = 'Caricamento…';
    try {
      data = await client.request(`/api/customer-data/customers?${queryString()}`);
    } catch (error) {
      if (token !== renderToken) return;
      data = { error: humanReadError(error, { failed: 'L\u2019elenco non si \u00E8 potuto leggere. Riprova pi\u00F9 tardi.' }), status: error?.status ?? null };
    }
    if (token !== renderToken) return;
    drawShell();
  }

  function reload(resetPage = true) {
    if (resetPage) state.page = 1;
    void load();
  }

  // Pop-up menus: one open at a time, Escape closes, a click outside closes.
  // Each view instance owns its handler (no global doc flag): the handler
  // only touches this view's menus, so navigation away/back never leaves a
  // view without outside-close. Clicks inside a menu wrap (including the
  // opening click, which bubbles to the document in a real browser) are
  // ignored via the wrap guard plus stopPropagation on the toggles.
  const openMenus = [];
  const isInsideMenuWrap = (node) => {
    let current = node ?? null;
    while (current) {
      const classes = typeof current.getAttribute === 'function'
        ? String(current.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
        : [];
      if (classes.includes('bo-clienti-menuwrap')) return true;
      current = current.parentNode ?? null;
    }
    return false;
  };
  const syncAllMenus = () => {
    for (const entry of openMenus) entry.sync();
  };
  if (doc && typeof doc.addEventListener === 'function') {
    doc.addEventListener('click', (event) => {
      if (isInsideMenuWrap(event?.target ?? null)) return;
      for (const entry of openMenus) entry.menu.classList.add('hidden');
      syncAllMenus();
    });
  }

  function closeMenus(except = null) {
    for (const entry of openMenus) {
      if (entry.menu !== except) {
        entry.menu.classList.add('hidden');
        entry.sync();
      }
    }
  }

  function menuBox(label, build, title, buttonClass = 'bo-clienti-menubutton') {
    const wrap = el('div', 'bo-clienti-menuwrap');
    const button = el('button', buttonClass, label);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('title', title ?? label);
    const menu = el('div', 'bo-clienti-menu hidden');
    const syncExpanded = () => {
      button.setAttribute('aria-expanded', menu.classList.contains('hidden') ? 'false' : 'true');
    };
    openMenus.push({ menu, sync: syncExpanded });
    button.addEventListener('click', (event) => {
      event?.stopPropagation?.();
      const willOpen = menu.classList.contains('hidden');
      closeMenus(menu);
      menu.classList.toggle('hidden', !willOpen);
      syncExpanded();
    });
    const closeOnEscape = (event) => {
      if (event?.key === 'Escape') {
        menu.classList.add('hidden');
        syncExpanded();
      }
    };
    button.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('click', (event) => {
      event?.stopPropagation?.();
    });
    build(menu, () => {
      menu.classList.add('hidden');
      syncExpanded();
    });
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  function drawShell() {
    clearMount();
    openMenus.length = 0;
    const panel = el('section', 'bo-clienti');
    const total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : null;
    const title = el('h1', 'bo-clienti-title', total === null ? 'Clienti' : 'Clienti ');
    if (total !== null) title.appendChild(el('span', 'bo-clienti-count', String(total)));
    const headRow = el('div', 'bo-clienti-bar');
    headRow.appendChild(title);
    // "Aggiungi cliente": AI paste writes nothing until applied (preview is
    // the plan-then-confirm surface below), manual entry is the host contact
    // module factory — the list owns no record creation of its own.
    headRow.appendChild(menuBox('Aggiungi cliente', (menu, closeMenu) => {
      const addItem = (action, label, hint, onPick) => {
        const item = el('button', 'bo-clienti-item', label);
        item.setAttribute('data-action', action);
        item.appendChild(el('span', 'bo-muted', hint));
        item.addEventListener('click', () => {
          closeMenu();
          onPick();
        });
        menu.appendChild(item);
      };
      addItem('add-ai', "Crea con l'AI", 'Incolla un messaggio o un biglietto da visita', () => {
        if (typeof onAskAi === 'function') {
          onAskAi('Voglio creare un cliente: ti incollo un messaggio o un biglietto da visita.');
        } else {
          notify('Apri la barra AI (⌘K) e incolla un messaggio o un biglietto da visita.');
        }
      });
      addItem('add-manual', 'Compila manualmente', 'Nome, recapiti e canale di provenienza', () => {
        if (typeof deps.onManualAdd === 'function') {
          deps.onManualAdd();
        } else {
          notify('Aggiungi il cliente dal form Import qui sotto: una riga con nome, recapiti e canale di provenienza.');
        }
      });
    }, 'Aggiungi cliente', 'bo-clienti-menubutton ui-btn-primary'));
    panel.appendChild(headRow);
    panel.appendChild(el('p', 'bo-muted bo-clienti-status', ''));

    const views = data?.views ?? FALLBACK_VIEWS;
    const sorts = data?.sorts ?? FALLBACK_SORTS;
    const columnsMeta = data?.columns ?? FALLBACK_COLUMNS;
    const sizes = data?.pageSizes ?? FALLBACK_SIZES;
    if (state.columns === null) state.columns = normalizeColumns(columnsMeta, readStoredColumns());
    else state.columns = normalizeColumns(columnsMeta, state.columns);

    // ── quick views ─────────────────────────────────────────────────────
    const viewsRow = el('div', 'bo-clienti-views');
    viewsRow.setAttribute('role', 'tablist');
    viewsRow.setAttribute('aria-label', 'Viste rapide');
    for (const view of views) {
      // The server names no per-view counts today, so pills render labels
      // only; the day it ships a finite `count` per view the pill shows it.
      const count = Number(view.count);
      const label = view.label + (Number.isFinite(count) ? ` ${count}` : '');
      const button = el('button', 'bo-clienti-view' + (state.vista === view.id ? ' active' : ''), label);
      button.setAttribute('role', 'tab');
      button.setAttribute('data-view', view.id);
      if (state.vista === view.id) button.setAttribute('aria-selected', 'true');
      button.addEventListener('click', () => {
        if (state.vista === view.id) return;
        state.vista = view.id;
        reload();
      });
      viewsRow.appendChild(button);
    }
    // ── search (the prototype's ✦ field), then views and tools on one bar ──
    const toolbar = el('div', 'bo-clienti-toolbar');
    const form = el('form', 'bo-clienti-search');
    form.appendChild(el('span', 'bo-clienti-spark', '✦'));
    form.setAttribute('role', 'search');
    const input = el('input', 'ui-field'); // BO-F6-02: through the library, never raw.
    input.setAttribute('type', 'search');
    input.setAttribute('name', 'q');
    input.setAttribute('aria-label', 'Cerca clienti');
    input.setAttribute('placeholder', 'Cerca per nome o chiedi: «lead da Instagram», «chi è di Milano»');
    input.value = state.q;
    const clearSearch = el('button', 'bo-clienti-searchclear', 'Azzera');
    clearSearch.setAttribute('type', 'button');
    clearSearch.setAttribute('data-action', 'clear-search');
    const syncClearSearch = () => {
      clearSearch.classList.toggle('hidden', String(input.value ?? '') === '');
    };
    input.addEventListener('input', syncClearSearch);
    syncClearSearch();
    clearSearch.addEventListener('click', () => {
      input.value = '';
      state.q = '';
      syncClearSearch();
      reload();
    });
    const go = el('button', undefined, 'Cerca');
    go.setAttribute('type', 'submit');
    form.appendChild(input);
    form.appendChild(clearSearch);
    form.appendChild(go);
    form.addEventListener('submit', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      state.q = String(input.value ?? '').trim().replace(/\s+/g, ' ');
      reload();
    });
    panel.appendChild(form);
    const bar = el('div', 'bo-clienti-bar');
    bar.appendChild(viewsRow);
    bar.appendChild(toolbar);

    toolbar.appendChild(menuBox('Filtri', (menu) => {
      menu.appendChild(el('p', 'bo-clienti-group', 'Canale'));
      for (const value of ['all', 'whatsapp', 'instagram', 'facebook', 'email', 'tiktok', 'phone']) {
        const item = el('button', 'bo-clienti-item' + (state.canale === value ? ' active' : ''),
          value === 'all' ? 'Tutti i canali' : channelLabel(value));
        item.setAttribute('data-filter', `canale:${value}`);
        item.addEventListener('click', () => {
          state.canale = value;
          reload();
        });
        menu.appendChild(item);
      }
      menu.appendChild(el('p', 'bo-clienti-group', 'Stato'));
      for (const value of ['all', 'cliente', 'contatto']) {
        const item = el('button', 'bo-clienti-item' + (state.stato === value ? ' active' : ''),
          value === 'all' ? 'Tutti gli stati' : STATO_LABELS[value]);
        item.setAttribute('data-filter', `stato:${value}`);
        item.addEventListener('click', () => {
          state.stato = value;
          reload();
        });
        menu.appendChild(item);
      }
      menu.appendChild(el('p', 'bo-muted', 'Es. «clienti di Milano con offerta sopra 10.000 €»'));
    }));

    const aiButton = el('button', 'bo-clienti-ai', '✦ Crea un filtro con l\u2019AI');
    aiButton.setAttribute('data-action', 'ai-filter');
    aiButton.setAttribute('title', 'Descrivi chi vuoi vedere: senza chiave LLM il pannello resta utilizzabile e la domanda libera è spenta');
    aiButton.addEventListener('click', () => {
      if (typeof onAskAi === 'function') {
        onAskAi('Crea un filtro per i clienti: chi devo vedere?');
      } else {
        notify('Apri la barra AI (⌘K) e descrivi chi vuoi vedere.');
      }
    });
    toolbar.appendChild(aiButton);

    toolbar.appendChild(menuBox('Ordina', (menu) => {
      menu.appendChild(el('p', 'bo-clienti-group', 'Ordina per'));
      for (const sort of sorts) {
        const item = el('button', 'bo-clienti-item' + (state.sort === sort.id ? ' active' : ''), sort.label);
        item.setAttribute('data-sort', sort.id);
        item.addEventListener('click', () => {
          state.sort = sort.id;
          reload();
        });
        menu.appendChild(item);
      }
    }));

    const configurable = columnsMeta.filter((column) => !column.always);
    const visibleCount = configurable.filter((column) => state.columns[column.id] === true).length;
    toolbar.appendChild(menuBox(`Colonne ${visibleCount}/${configurable.length}`, (menu) => {
      menu.appendChild(el('p', 'bo-clienti-group', 'Colonne visibili'));
      for (const column of columnsMeta) {
        if (!column.always) continue;
        const fixed = el('span', 'bo-muted', `${column.label} · sempre visibile`);
        fixed.setAttribute('aria-disabled', 'true');
        menu.appendChild(fixed);
      }
      for (const column of columnsMeta) {
        if (column.always) continue;
        const on = state.columns[column.id] === true;
        const label = `${on ? '✓' : '○'} ${column.label}${column.ai ? ' ✦' : ''}`;
        const item = el('button', 'bo-clienti-item', label);
        item.setAttribute('data-column', column.id);
        item.addEventListener('click', () => {
          state.columns = { ...state.columns, [column.id]: state.columns[column.id] !== true };
          writeStoredColumns();
          drawShell();
        });
        menu.appendChild(item);
      }
      const reset = el('button', 'bo-clienti-item', 'Ripristina');
      reset.setAttribute('data-action', 'reset-columns');
      reset.addEventListener('click', () => {
        state.columns = normalizeColumns(columnsMeta, null);
        writeStoredColumns();
        drawShell();
      });
      menu.appendChild(reset);
    }, 'Colonne'));
    panel.appendChild(bar);

    // ── active filter chips with × ────────────────────────────────────────
    const chips = el('div', 'bo-clienti-chips');
    const chip = (label, clear) => {
      const node = el('span', 'bo-clienti-chip');
      node.appendChild(el('span', undefined, label));
      const button = el('button', 'bo-clienti-chipx', '×');
      button.setAttribute('aria-label', `Rimuovi filtro ${label}`);
      button.addEventListener('click', clear);
      node.appendChild(button);
      chips.appendChild(node);
    };
    if (state.canale !== 'all') chip(channelLabel(state.canale), () => { state.canale = 'all'; reload(); });
    if (state.stato !== 'all') chip(STATO_LABELS[state.stato] ?? state.stato, () => { state.stato = 'all'; reload(); });
    if (state.q !== '') chip(`«${state.q}»`, () => { state.q = ''; reload(); });
    if (chips.childNodes.length > 0) {
      const clearAll = el('button', 'bo-clienti-clear', 'Azzera');
      clearAll.addEventListener('click', () => {
        state.canale = 'all';
        state.stato = 'all';
        state.q = '';
        reload();
      });
      chips.appendChild(clearAll);
      panel.appendChild(chips);
    }

    mount.appendChild(panel);
    if (!data) return;
    if (data.error) {
      const unavailable = data.status === 404;
      panel.querySelector('.bo-clienti-status').textContent = unavailable
        ? 'Clienti non composto in questo spazio'
        : data.error;
      return;
    }
    drawList(panel, columnsMeta, sizes);
  }

  function cellFor(row, columnId) {
    switch (columnId) {
      case 'canali': {
        if (row.channels.length === 0) return el('span', 'bo-muted', '—');
        const tiles = el('span', 'bo-clienti-tiles');
        for (const system of row.channels) {
          const tile = el('span', `bo-clienti-tile bo-tile-${String(system).toLowerCase()}`, channelMark(system));
          tile.setAttribute('title', channelLabel(system));
          tile.setAttribute('aria-label', channelLabel(system));
          tiles.appendChild(tile);
        }
        return tiles;
      }
      case 'stato': {
        const value = String(row.status?.value ?? '');
        const node = el('span', `bo-clienti-pill bo-pill-${value || 'none'}`, STATO_LABELS[value] ?? (value || '—'));
        if (row.status?.reason) node.setAttribute('title', row.status.reason);
        return node;
      }
      case 'ultimo': {
        if (!row.lastContactAt) return el('span', 'bo-muted', 'mai');
        const channel = row.lastContactChannel ? `${channelLabel(row.lastContactChannel)} · ` : '';
        return el('span', 'bo-clienti-when', `${channel}${shortDay(row.lastContactAt)}`);
      }
      case 'prossimo': {
        if (!row.nextStep) return el('span', 'bo-muted', '—');
        const text = `✦ ${row.nextStep.title ?? 'attività'}${row.nextStep.dueAt ? ` · ${shortDay(row.nextStep.dueAt)}` : ''}${row.nextStep.overdue ? ' (in ritardo)' : ''}`;
        return el('span', undefined, text);
      }
      case 'email':
        return row.email ? el('span', undefined, row.email) : el('span', 'bo-muted', '—');
      case 'telefono':
        return row.phone?.value ? el('span', undefined, `${row.phone.value} (${channelLabel(row.phone.system)})`) : el('span', 'bo-muted', '—');
      case 'offerta': {
        if (row.offerValueCents === null || row.offerValueCents === undefined) return el('span', 'bo-muted', '—');
        const amount = (Number(row.offerValueCents) / 100).toLocaleString('it-IT', { minimumFractionDigits: 2 });
        return el('span', undefined, `${amount} ${row.offerCurrency ?? ''}`.trim());
      }
      case 'budget': {
        if (row.budget?.available !== true) return el('span', 'bo-muted', row.budget?.reason ?? 'non disponibile');
        const wrap = el('span', undefined, `✦ ${row.budget.value ?? ''} `);
        const source = link(`#/customer-card/${encodeURIComponent(row.resource)}/${encodeURIComponent(row.id)}`, 'fonte', 'open-budget-source');
        wrap.appendChild(source);
        return wrap;
      }
      default:
        return el('span', 'bo-muted', '—');
    }
  }

  function drawList(panel, columnsMeta, sizes) {
    const items = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total ?? 0);
    const page = Number(data.page ?? 1);
    const pages = Math.max(1, Number(data.pages ?? 1));
    const pageSize = Number(data.pageSize ?? state.pageSize);
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);
    const prefix = data.totalIsExact === false ? 'almeno ' : '';
    const range = total === 0 ? '0 di 0' : `${from}–${to} di ${prefix}${total}`;
    const statusLine = panel.querySelector('.bo-clienti-status');
    if (statusLine) {
      statusLine.textContent = total === 0
        ? 'Nessun cliente corrisponde. Prova con un nome, una città o un canale.'
        : '';
      if (data.totalIsExact === false) statusLine.setAttribute('title', 'conteggio parziale: la scansione è limitata');
    }
    const visible = columnsMeta.filter((column) => !column.always && state.columns[column.id] === true);
    const grid = `minmax(200px, 1.6fr) ${visible.map(() => 'minmax(0, 1fr)').join(' ')} 16px`;
    const table = el('div', 'bo-clienti-table');
    const head = el('div', 'bo-clienti-thead');
    head.setAttribute('style', `grid-template-columns: ${grid}`);
    head.setAttribute('role', 'row');
    head.appendChild(el('span', 'bo-clienti-th', 'Cliente'));
    for (const column of visible) head.appendChild(el('span', 'bo-clienti-th', column.label));
    head.appendChild(el('span', undefined, ''));
    table.appendChild(head);
    const list = el('div', 'bo-clienti-list');
    for (const row of items) {
      const card = el('article', 'bo-clienti-row');
      card.setAttribute('data-customer', `${row.resource}:${row.id}`);
      card.setAttribute('style', `grid-template-columns: ${grid}`);
      const head = el('div', 'bo-clienti-head');
      const name = String(row.name ?? '');
      head.appendChild(el('span', 'bo-clienti-avatar', initialsOf(name)));
      const who = el('div', 'bo-clienti-who');
      who.appendChild(link(
        `#/customer-card/${encodeURIComponent(row.resource)}/${encodeURIComponent(row.id)}`,
        row.name ?? 'Cliente senza nome',
        'open-customer-card',
      ));
      if (row.company?.name) who.appendChild(el('span', 'bo-muted bo-clienti-sub', String(row.company.name)));
      head.appendChild(who);
      card.appendChild(head);
      for (const column of visible) {
        const line = el('p', 'bo-clienti-fact');
        line.setAttribute('data-column', column.id);
        line.appendChild(el('span', 'bo-clienti-label', `${column.label}: `));
        line.appendChild(cellFor(row, column.id));
        card.appendChild(line);
      }
      card.appendChild(el('span', 'bo-clienti-chevron', '›'));
      list.appendChild(card);
    }
    table.appendChild(list);
    panel.appendChild(table);

    // ── pagination: 10/25/50 with ellipses ──────────────────────────────
    const pager = el('nav', 'bo-clienti-pager');
    pager.setAttribute('aria-label', 'Paginazione');
    pager.appendChild(el('span', 'bo-clienti-range', range));
    const pagesBox = el('div', 'bo-clienti-pages');
    const sizesBox = el('div', 'bo-clienti-sizes');
    const prev = el('button', undefined, '‹');
    prev.setAttribute('data-page', 'prev');
    prev.setAttribute('aria-label', 'Pagina precedente');
    if (page <= 1) prev.setAttribute('disabled', 'true');
    else prev.addEventListener('click', () => { state.page = page - 1; void load(); });
    pagesBox.appendChild(prev);
    for (const num of pageNumbers(pages, page)) {
      if (num === '…') {
        pagesBox.appendChild(el('span', 'bo-clienti-gap', '…'));
        continue;
      }
      const button = el('button', 'bo-clienti-page' + (num === page ? ' active' : ''), String(num));
      button.setAttribute('data-page', String(num));
      if (num !== page) button.addEventListener('click', () => { state.page = num; void load(); });
      else {
        button.setAttribute('aria-current', 'page');
        button.setAttribute('aria-label', `Pagina ${num}`);
      }
      pagesBox.appendChild(button);
    }
    const next = el('button', undefined, '›');
    next.setAttribute('data-page', 'next');
    next.setAttribute('aria-label', 'Pagina successiva');
    if (page >= pages) next.setAttribute('disabled', 'true');
    else next.addEventListener('click', () => { state.page = page + 1; void load(); });
    pagesBox.appendChild(next);
    pager.appendChild(pagesBox);
    sizesBox.appendChild(el('span', 'bo-clienti-sizeslabel', 'Righe per pagina'));
    const sizeGroup = el('div', 'bo-clienti-sizegroup');
    for (const size of sizes) {
      const button = el('button', 'bo-clienti-size' + (pageSize === size ? ' active' : ''), String(size));
      button.setAttribute('data-size', String(size));
      button.setAttribute('aria-label', `${size} righe per pagina`);
      button.addEventListener('click', () => {
        state.pageSize = size;
        reload();
      });
      sizeGroup.appendChild(button);
    }
    sizesBox.appendChild(sizeGroup);
    pager.appendChild(sizesBox);
    panel.appendChild(pager);
  }

  return { render: load, reload, getState: () => ({ ...state }) };
}
