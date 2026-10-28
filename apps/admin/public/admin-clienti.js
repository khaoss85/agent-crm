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

/** Fallbacks before the first server answer names the real menus. */
const FALLBACK_VIEWS = Object.freeze([
  { id: 'tutti', label: 'Tutti' },
  { id: 'nuovi-lead', label: 'Nuovi lead' },
  { id: 'clienti-attivi', label: 'Clienti attivi' },
  { id: 'ricontattare-oggi', label: 'Da ricontattare oggi' },
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

const channelLabel = (system) => CHANNEL_LABELS[String(system ?? '').toLowerCase()] ?? String(system ?? 'canale');

/**
 * Page numbers with ellipses, like the prototype: first, last and the
 * neighbours of the current page, gaps collapsed to "…".
 * @param {number} pages @param {number} page
 */
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
 *   onAskAi?: ((question: string) => void) | null, storage?: any}} deps
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

  function menuBox(label, build, title) {
    const wrap = el('div', 'bo-clienti-menuwrap');
    const button = el('button', 'bo-clienti-menubutton', label);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('title', title ?? label);
    const menu = el('div', 'bo-clienti-menu hidden');
    button.addEventListener('click', () => {
      menu.classList.toggle('hidden', !menu.classList.contains('hidden'));
    });
    build(menu);
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  function drawShell() {
    clearMount();
    const panel = el('section', 'bo-clienti');
    const total = data && Number.isFinite(Number(data.total)) ? Number(data.total) : null;
    panel.appendChild(el('h1', undefined, total === null ? 'Clienti' : `Clienti ${total}`));
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
      const button = el('button', 'bo-clienti-view' + (state.vista === view.id ? ' active' : ''), view.label);
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
    panel.appendChild(viewsRow);

    // ── toolbar: search, grouped filters, AI filter, sort, columns ──────
    const toolbar = el('div', 'bo-clienti-toolbar');
    const form = el('form', 'bo-clienti-search');
    form.setAttribute('role', 'search');
    const input = doc.createElement('input');
    input.setAttribute('type', 'search');
    input.setAttribute('class', 'ui-field'); // BO-F6-02: system field class.
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
    toolbar.appendChild(form);

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
    panel.appendChild(toolbar);

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
        return el('span', undefined, row.channels.map(channelLabel).join(' · '));
      }
      case 'stato': {
        const node = el('span', undefined, STATO_LABELS[row.status?.value] ?? row.status?.value ?? '—');
        if (row.status?.reason) node.setAttribute('title', row.status.reason);
        return node;
      }
      case 'ultimo': {
        if (!row.lastContactAt) return el('span', 'bo-muted', 'mai');
        const day = String(row.lastContactAt).slice(0, 10);
        const channel = row.lastContactChannel ? ` · ${channelLabel(row.lastContactChannel)}` : '';
        return el('span', undefined, `${day}${channel}`);
      }
      case 'prossimo': {
        if (!row.nextStep) return el('span', 'bo-muted', '—');
        const text = `${row.nextStep.title ?? 'attività'}${row.nextStep.dueAt ? ` · ${String(row.nextStep.dueAt).slice(0, 10)}` : ''}${row.nextStep.overdue ? ' (in ritardo)' : ''}`;
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
        : `${range} clienti`;
      if (data.totalIsExact === false) statusLine.setAttribute('title', 'conteggio parziale: la scansione è limitata');
    }
    const visible = columnsMeta.filter((column) => !column.always && state.columns[column.id] === true);
    const head = el('div', 'bo-clienti-thead');
    head.setAttribute('role', 'row');
    head.appendChild(el('span', 'bo-clienti-th', 'Cliente'));
    for (const column of visible) head.appendChild(el('span', 'bo-clienti-th', column.label));
    panel.appendChild(head);
    const list = el('div', 'bo-clienti-list');
    for (const row of items) {
      const card = el('article', 'bo-clienti-row');
      card.setAttribute('data-customer', `${row.resource}:${row.id}`);
      const head = el('div', 'bo-clienti-head');
      head.appendChild(link(
        `#/customer-card/${encodeURIComponent(row.resource)}/${encodeURIComponent(row.id)}`,
        row.name ?? `${row.resource} ${row.id}`,
        'open-customer-card',
      ));
      if (row.company?.name) head.appendChild(el('span', 'bo-muted', ` · ${row.company.name}`));
      card.appendChild(head);
      for (const column of visible) {
        const line = el('p', 'bo-clienti-fact');
        line.setAttribute('data-column', column.id);
        line.appendChild(el('span', 'bo-clienti-label', `${column.label}: `));
        line.appendChild(cellFor(row, column.id));
        card.appendChild(line);
      }
      list.appendChild(card);
    }
    panel.appendChild(list);

    // ── pagination: 10/25/50 with ellipses ──────────────────────────────
    const pager = el('nav', 'bo-clienti-pager');
    pager.setAttribute('aria-label', 'Paginazione');
    pager.appendChild(el('span', 'bo-clienti-range', range));
    const prev = el('button', undefined, '‹');
    prev.setAttribute('data-page', 'prev');
    prev.setAttribute('aria-label', 'Pagina precedente');
    if (page <= 1) prev.setAttribute('disabled', 'true');
    else prev.addEventListener('click', () => { state.page = page - 1; void load(); });
    pager.appendChild(prev);
    for (const num of pageNumbers(pages, page)) {
      if (num === '…') {
        pager.appendChild(el('span', 'bo-clienti-gap', '…'));
        continue;
      }
      const button = el('button', 'bo-clienti-page' + (num === page ? ' active' : ''), String(num));
      button.setAttribute('data-page', String(num));
      if (num !== page) button.addEventListener('click', () => { state.page = num; void load(); });
      else {
        button.setAttribute('aria-current', 'page');
        button.setAttribute('aria-label', `Pagina ${num}`);
      }
      pager.appendChild(button);
    }
    const next = el('button', undefined, '›');
    next.setAttribute('data-page', 'next');
    next.setAttribute('aria-label', 'Pagina successiva');
    if (page >= pages) next.setAttribute('disabled', 'true');
    else next.addEventListener('click', () => { state.page = page + 1; void load(); });
    pager.appendChild(next);
    pager.appendChild(el('span', 'bo-clienti-sizeslabel', 'Righe per pagina'));
    for (const size of sizes) {
      const button = el('button', 'bo-clienti-size' + (pageSize === size ? ' active' : ''), String(size));
      button.setAttribute('data-size', String(size));
      button.setAttribute('aria-label', `${size} righe per pagina`);
      button.addEventListener('click', () => {
        state.pageSize = size;
        reload();
      });
      pager.appendChild(button);
    }
    panel.appendChild(pager);
  }

  return { render: load, reload, getState: () => ({ ...state }) };
}
