// @ts-check

// Pipeline board (ADR-014) for BO-F2-01, restyled to the BO-F6-10 prototype
// (specs/pipeline.md, fetta 1: intestazione e riepilogo). Rendered entirely
// from /api/schema `pipelines` metadata plus the target module's list
// endpoint — no per-pipeline code. Page chrome follows the spec's fixed
// Italian texts (`Pipeline` / `Offerte`); stage labels, counts and totals
// stay data-driven. Every value is inserted through textContent/setAttribute,
// never innerHTML, so hostile stage labels or record names are inert text.
//
// Views: Kanban columns plus a Lista table over the same filtered records.
// Search plus the Referente, Creata and Stati pills filter both views
// client-side; "Azzera filtri" resets them. The
// summary (count + per-currency totals) and the forecast always describe the
// filtered set. The forecast is a declared heuristic — won and paid at face
// value plus 60% of the open ones — labeled as a stima, never a commitment.
//
// C4/C5 forecast: `✦ Previsione di <mese>` over the filtered set — won and
// paid record values at face value plus 60% of the open ones, per currency
// (currencies are never summed). The risk line names the owner or customer of
// the highest-value open offer. A stima, never a commitment.
// Cards move through the same server `move-stage` action as the Move button,
// including drag-and-drop onto a column: the drop posts { toStage, fromStage }
// with the actor audited server-side (the action runtime records it). A drop
// onto the lost stage does not invent a reason: it reveals the card's reason
// input and asks for one before posting. The Lista rows are read-only; moves
// happen on Kanban cards.
//
// BO-F6-10 fetta Lista (backlog:31bed527): testi esatti C7/C16/C21, intestazioni
// C19 nell'ordine del prototipo, pill di stato con pallino e percentuale di
// probabilità C20, `Azzera filtri` solo a filtri attivi C11, ganci di stile
// `drop-target`/`dragging` per il trascinamento C18 (il tratteggio visivo è CSS).

import { formatAmount, humanReadError } from './admin-core.js';
import { bindAdminMutations } from './admin-submission.js';

const BOARD_LIMIT = 200;

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, class?: string, attrs?: Record<string, string>}} [options]
 */
import { el, uiAddOption, uiButton, uiIcon } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * Italian month names for the `✦ Previsione di <mese>` title (C4). A static
 * list keeps the title deterministic without ICU locale data.
 */
const MONTHS_IT = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

/** Day (YYYY-MM-DD) of an ISO timestamp, or null when absent/unparseable. */
function dayOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Two-letter initials of the referente name for the card badge, like the
 * prototype (C15): the badge shows the initials, the accessible title the
 * full name. Same word rule as `initialsOf` in admin-clienti.js (first
 * letter of the first two lettered words, `·` when none), kept local like
 * the other views — no cross-view import for a presentation mark.
 */
function ownerInitials(name) {
  const words = String(name ?? '').trim().split(/\s+/).filter((word) => /\p{L}/u.test(word));
  return words.slice(0, 2).map((word) => (word.match(/\p{L}/u)?.[0] ?? '').toUpperCase()).join('') || '·';
}

/**
 * @param {Record<string, any>} record
 * @param {{q: string, owner: string, stage: string, created: string}} filters
 */
function matchesFilters(record, filters) {
  if (filters.owner && record.owner !== filters.owner) return false;
  if (filters.stage && record.pipelineStage !== filters.stage) return false;
  if (filters.q) {
    const haystack = [record.name, record.companyName, record.contactName]
      .filter((part) => typeof part === 'string' && part)
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(filters.q.toLowerCase())) return false;
  }
  // BO-F6-10 C8: the `Creata` pill filters by creation recency. A record
  // without a parseable creation day never matches an active interval
  // (fail closed, like every other filter here); an unknown interval value
  // matches nothing rather than silently lifting the filter.
  if (filters.created) {
    const days = filters.created === '7d' ? 7 : filters.created === '30d' ? 30 : 0;
    const day = dayOf(record.createdAt);
    if (!days || !day) return false;
    const now = new Date();
    const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
      .toISOString().slice(0, 10);
    if (day < cutoff) return false;
  }
  return true;
}

/**
 * `Creata` intervals (C8): the prototype filters by creation recency —
 * `Sempre`, then recent days. DECISION (to be confirmed): the recent
 * buckets are 7 and 30 days; the expected-close range inputs are gone
 * with the raw controls (no prototype shape for them).
 */
const CREATED_OPTIONS = [
  { value: '', label: 'Sempre' },
  { value: '7d', label: 'Ultimi 7 giorni' },
  { value: '30d', label: 'Ultimi 30 giorni' },
];

/**
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, toast?: (message: string, error?: boolean) => void, navigate?: (hash: string) => void, onAskAi?: (screenId: string, description: string) => void}} deps
 */
export function createPipelineBoard(deps) {
  const { doc, mount } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});

  /** Guard against stale async responses overwriting a newer board. */
  let renderToken = 0;

  /** Toolbar + view state; records are cached so filtering never refetches. */
  const state = { view: 'kanban', q: '', owner: '', stage: '', created: '' };
  /** @type {{pipeline: any, records: Array<Record<string, any>>}} */
  let cached = { pipeline: null, records: [] };
  /** Name of the pipeline the current filter state belongs to. A filter set
   * on pipeline A must never silently empty pipeline B after a switch. */
  let filteredPipeline = null;
  /** Record id → live card controls (reason reveal on drops to lost). */
  const cardNodes = new Map();
  /** Live stage columns of the current render: drop and dragend sweep their
   * drop-target hook, so a cancelled drag never leaves a column marked. */
  const columnNodes = [];
  /** Clear the C18 drop-target hook from every live column. */
  function unmarkDropTargets() {
    for (const column of columnNodes) toggleHook(column, 'drop-target', false);
  }

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message @param {{retry?: () => void}} [options] */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { class: 'panel' });
    box.appendChild(el(doc, 'p', { class: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { class: 'small secondary', text: 'Riprova' });
      button.addEventListener('click', retry);
      box.appendChild(button);
    }
    mount.appendChild(box);
  }

  /** POST one move-stage transition — shared by the Move button and drops. */
  async function postMove(pipeline, recordId, fromStage, toStage, reason) {
    const input = { toStage, fromStage };
    if (reason) input.reason = reason;
    await client.request(
      `/api/modules/${encodeURIComponent(pipeline.module)}/records/${encodeURIComponent(recordId)}/actions/move-stage`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  /**
   * Drop handler for a column: same server action as the Move button, with
   * the actor audited server-side. Same-stage drops are ignored (the server
   * would 409 SAME_STAGE); drops onto lost without a reason reveal the
   * card's reason input instead of posting.
   */
  async function handleDrop(pipeline, toStage, payload) {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const recordId = typeof parsed?.id === 'string' ? parsed.id : null;
    const fromStage = typeof parsed?.fromStage === 'string' ? parsed.fromStage : null;
    if (!recordId || !fromStage || toStage === fromStage) return;
    const record = cached.records.find((candidate) => candidate.id === recordId);
    if (!record || record.pipelineStage !== fromStage) {
      toast('Questa card è cambiata nel frattempo — la pagina si aggiorna.', true);
      await renderBoard(pipeline.name);
      return;
    }
    const target = pipeline.stages.find((stage) => stage.key === toStage);
    if (!target) return;
    if (target.type === 'lost') {
      const controls = cardNodes.get(recordId);
      if (controls) {
        controls.select.value = toStage;
        controls.reasonInput.setAttribute('class', '');
        controls.errorNode.textContent = 'Scrivi il motivo della perdita, poi premi Sposta.';
        controls.errorNode.setAttribute('class', 'field-error');
        if (typeof controls.reasonInput.focus === 'function') controls.reasonInput.focus();
      } else {
        toast('Per la perdita serve un motivo — apri prima la card.', true);
      }
      return;
    }
    try {
      await postMove(pipeline, recordId, fromStage, toStage);
      toast(`Spostata in ${stageLabel(pipeline, toStage)}.`);
      await renderBoard(pipeline.name); // re-render: server state is the truth
    } catch (error) {
      toast(moveFailureText(error), true);
    }
  }

  /** @param {string} pipelineName */
  async function renderBoard(pipelineName) {
    const token = ++renderToken;
    showMessage('Caricamento…');
    let pipeline;
    let records;
    try {
      const schema = await client.request('/api/schema');
      if (schema?.pipelineContract !== 1) {
        showMessage('Questo pannello va aggiornato per mostrare le pipeline.');
        return;
      }
      pipeline = (schema.pipelines ?? []).find((candidate) => candidate.name === pipelineName);
      if (!pipeline) {
        if (typeof console !== 'undefined' && typeof console.error === 'function') {
          console.error('[bo] pipeline non composta', { pipelineName });
        }
        showMessage('Nessuna pipeline da mostrare in questo spazio.');
        return;
      }
      // The board currently supports the core opportunity module's list
      // endpoint; a generated staged module would use its records route.
      const listPath = pipeline.module === 'opportunity'
        ? `/api/opportunities?limit=${BOARD_LIMIT}`
        : `/api/modules/${encodeURIComponent(pipeline.module)}/records?limit=${BOARD_LIMIT}`;
      records = (await client.request(listPath)).items ?? [];
    } catch (error) {
      if (token !== renderToken) return;
      showMessage(humanReadError(error, { failed: 'La pipeline non si è potuta leggere. Riprova più tardi.' }), { retry: () => renderBoard(pipelineName) });
      return;
    }
    if (token !== renderToken) return;
    if (filteredPipeline !== pipeline.name) {
      // New pipeline: drop the previous board's filters so a stage, owner
      // or creation interval from pipeline A cannot silently empty pipeline B.
      filteredPipeline = pipeline.name;
      state.q = '';
      state.owner = '';
      state.stage = '';
      state.created = '';
    }
    cached = { pipeline, records };
    return renderAll(token);
  }

  function renderAll(token) {
    const { pipeline, records } = cached;
    clear();
    cardNodes.clear();
    columnNodes.length = 0;

    const onBoard = records.filter((record) => record.pipelineKey === pipeline.name);
    const stageKeys = new Set(pipeline.stages.map((stage) => stage.key));
    // Records whose stored stage key no longer belongs to the definition
    // (definition drift / out-of-band writes) are shown explicitly, never
    // silently hidden or misclassified into a column.
    const offDefinition = onBoard.filter((record) => !stageKeys.has(record.pipelineStage));
    const placed = onBoard.filter((record) => stageKeys.has(record.pipelineStage));
    const offPipeline = records.length - onBoard.length;
    const visible = placed.filter((record) => matchesFilters(record, state));

    const panel = el(doc, 'section', { class: 'panel panel-wide pipeline-board-panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    // BO-F6-10 C1/C2: fixed page chrome from the spec. The pipeline label
    // is not painted: the /bo voice is the offers board, and the nav already
    // names the routed pipeline. Unknown pipelines show a friendly line in
    // renderBoard (the name aids diagnosis in the console only).
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Pipeline' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Offerte' }));
    titleBox.appendChild(el(doc, 'p', {
      class: 'lede',
      text: "Apri una card per vedere com'è composta e costruire l'offerta. Trascinala per cambiarne lo stato.",
    }));
    // C3: the green `Nuova offerta` button sits under the description,
    // like the prototype. The violet forecast stays beside the title.
    titleBox.appendChild(renderNewOfferMenu(pipeline));
    // Honest bounds: the board loads at most BOARD_LIMIT records, and records
    // not on this pipeline are excluded by documented behavior, not hidden.
    if (records.length >= BOARD_LIMIT) {
      titleBox.appendChild(el(doc, 'p', {
        class: 'hint',
        text: `Mostro solo i primi ${BOARD_LIMIT} record — gli altri non sono in questa vista.`,
      }));
    }
    if (offPipeline > 0) {
      titleBox.appendChild(renderOffPipelineNote(records, pipeline.name, offPipeline));
    }
    heading.appendChild(titleBox);
    // Supervisor design pass (prototype 06): the forecast is the violet card
    // beside the title, the count and totals close the single tool row.
    heading.appendChild(renderForecast(pipeline, visible));
    panel.appendChild(heading);

    const tools = renderToolbar(pipeline, onBoard);
    tools.appendChild(renderSummary(visible));
    panel.appendChild(tools);

    if (state.view === 'lista') {
      panel.appendChild(renderList(pipeline, visible));
    } else {
      const board = el(doc, 'div', { class: 'pipeline-board' });
      for (const stage of pipeline.stages) {
        board.appendChild(renderColumn(pipeline, stage, visible.filter((record) => record.pipelineStage === stage.key), token));
      }
      panel.appendChild(board);
    }

    if (offDefinition.length) {
      const drift = el(doc, 'div', { class: 'pipeline-drift', attrs: { 'data-drift': String(offDefinition.length) } });
      drift.appendChild(el(doc, 'h3', { text: `Fuori definizione (${offDefinition.length})` }));
      drift.appendChild(el(doc, 'p', {
        class: 'hint',
        text: 'Questi record hanno una fase che non è più nella definizione della pipeline. Le chiavi di fase sono identificativi stabili: rinominarne o toglierne una richiede una migrazione dati esplicita.',
      }));
      for (const record of offDefinition) {
        const row = el(doc, 'p', { class: 'drift-record' });
        row.appendChild(el(doc, 'strong', { text: String(record.name ?? record.id) }));
        row.appendChild(el(doc, 'span', { text: ` — fase registrata: ${String(record.pipelineStage)}` }));
        drift.appendChild(row);
      }
      panel.appendChild(drift);
    }
    mount.appendChild(panel);
    return panel;
  }

  /**
   * `Nuova offerta` menu button (C3): the green button under the page
   * description, opening the prototype's two voices. The buttons are the
   * shared `ui-add-option` voices (MEM_ACC_REUSE: same pattern as the
   * Clienti add menu and the shell `+ Nuovo` menu), positioned by the
   * generic `ui-conn-addwrap` / `ui-conn-addmenu` pair — no screen CSS.
   * Both voices do real work: `Crea con l'AI` opens the BO-F0-04
   * assistant on the pipeline screen (or says where the AI bar is when
   * the shell offers no entry), `Compila manualmente` navigates to the
   * governed module create form. Nothing is previewed or written here.
   */
  function renderNewOfferMenu(pipeline) {
    const wrap = el(doc, 'div', { class: 'ui-conn-addwrap', attrs: { 'data-newoffer': 'menu' } });
    const button = uiButton(doc, {
      variant: 'cta',
      attrs: { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-action': 'new-offer' },
    });
    button.appendChild(el(doc, 'span', { text: 'Nuova offerta' }));
    button.appendChild(uiIcon(doc, 'chevron'));
    const menu = el(doc, 'div', { class: 'ui-add-menu ui-conn-addmenu hidden', attrs: { role: 'menu' } });
    const isHidden = () => String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
    const sync = () => button.setAttribute('aria-expanded', isHidden() ? 'false' : 'true');
    const close = () => {
      menu.setAttribute('class', 'ui-add-menu ui-conn-addmenu hidden');
      sync();
    };
    button.addEventListener('click', () => {
      menu.setAttribute('class', isHidden() ? 'ui-add-menu ui-conn-addmenu' : 'ui-add-menu ui-conn-addmenu hidden');
      sync();
    });
    const closeOnEscape = (event) => {
      if (event?.key === 'Escape') close();
    };
    button.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', closeOnEscape);
    const aiVoice = uiAddOption(doc, {
      kind: 'ai', title: "Crea con l'AI", line: 'Es. «cucina per Giulia, 27.500 €»',
      attrs: { 'data-voice': 'ai' },
    });
    aiVoice.addEventListener('click', () => {
      close();
      if (typeof deps.onAskAi === 'function') {
        deps.onAskAi('pipeline', 'Voglio creare un\u2019offerta: ti incollo i dettagli.');
      } else {
        toast('Apri la barra AI (⌘K) e descrivi l\u2019offerta che vuoi creare.');
      }
    });
    const manualVoice = uiAddOption(doc, {
      kind: 'manual', title: 'Compila manualmente', line: 'Titolo, cliente, valore e scadenza',
      attrs: { 'data-voice': 'manual' },
    });
    manualVoice.addEventListener('click', () => {
      close();
      if (typeof deps.navigate === 'function') {
        deps.navigate(`#/modules/${encodeURIComponent(pipeline.module)}/new`);
      } else {
        toast('La creazione manuale non è disponibile da qui.');
      }
    });
    menu.appendChild(aiVoice);
    menu.appendChild(manualVoice);
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  /**
   * One voice of a filter pill menu (C8): the shared `ui-add-option` shape
   * (tile + bold title, no new classes — the dress stays in styles.css),
   * with a ✓ tile on the active option like the prototype's check mark.
   * The title travels through textContent only, so hostile owner or stage
   * names stay inert text.
   */
  function filterVoice(key, { value, title, active, onPick }) {
    const node = doc.createElement('button');
    node.setAttribute('class', 'ui-add-option');
    node.setAttribute('type', 'button');
    node.setAttribute('role', 'menuitemradio');
    node.setAttribute('aria-checked', active ? 'true' : 'false');
    node.setAttribute('data-menu-voice', key);
    node.setAttribute('data-value', value);
    const tile = doc.createElement('span');
    tile.setAttribute('class', 'ui-add-tile');
    tile.setAttribute('aria-hidden', 'true');
    tile.textContent = active ? '✓' : '';
    node.appendChild(tile);
    const words = doc.createElement('span');
    words.setAttribute('class', 'ui-add-words');
    const name = doc.createElement('span');
    name.setAttribute('class', 'ui-add-title');
    name.textContent = String(title);
    words.appendChild(name);
    node.appendChild(words);
    node.addEventListener('click', () => onPick(value));
    return node;
  }

  /**
   * Prototype filter pill (C8): `Referente Tutti` — a menu-button with the
   * grey label and the bold value, opening the shared `ui-add-menu` voice
   * list. Same wrap/menu pair as `Nuova offerta` (MEM_ACC_REUSE: no screen
   * CSS, no raw browser select or date input). A non-default value marks
   * the pill with the established `active` hook, like `ui-seg`.
   */
  function renderFilterMenu({ key, label, valueText, filterLabel, current, voices, onPick }) {
    const wrap = el(doc, 'div', { class: 'ui-conn-addwrap', attrs: { 'data-filtermenu': key } });
    const button = uiButton(doc, {
      variant: 'secondary',
      attrs: {
        type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        'aria-label': filterLabel,
      },
    });
    if (current !== '') button.setAttribute('class', `${button.getAttribute('class')} active`);
    button.appendChild(el(doc, 'span', { text: `${label} ` }));
    button.appendChild(el(doc, 'strong', { text: valueText }));
    button.appendChild(uiIcon(doc, 'chevron'));
    const menu = el(doc, 'div', { class: 'ui-add-menu ui-conn-addmenu hidden', attrs: { role: 'menu' } });
    const isHidden = () => String(menu.getAttribute('class') ?? '').split(/\s+/).includes('hidden');
    const sync = () => button.setAttribute('aria-expanded', isHidden() ? 'false' : 'true');
    button.addEventListener('click', () => {
      menu.setAttribute('class', isHidden() ? 'ui-add-menu ui-conn-addmenu' : 'ui-add-menu ui-conn-addmenu hidden');
      sync();
    });
    const closeOnEscape = (event) => {
      if (event?.key === 'Escape') {
        menu.setAttribute('class', 'ui-add-menu ui-conn-addmenu hidden');
        sync();
      }
    };
    button.addEventListener('keydown', closeOnEscape);
    menu.addEventListener('keydown', closeOnEscape);
    for (const voice of voices) {
      menu.appendChild(filterVoice(key, {
        value: voice.value,
        title: voice.title,
        active: voice.value === current,
        onPick: (picked) => {
          onPick(picked);
          renderAll(renderToken);
        },
      }));
    }
    wrap.appendChild(button);
    wrap.appendChild(menu);
    return wrap;
  }

  /** View toggle + search + Referente/Creata/Stati pills + Azzera filtri. */
  function renderToolbar(pipeline, onBoard) {
    const toolbar = el(doc, 'div', { class: 'pipeline-toolbar', attrs: { 'data-toolbar': 'pipeline' } });

    for (const view of ['kanban', 'lista']) {
      const button = el(doc, 'button', {
        class: `small ${state.view === view ? 'primary' : 'secondary'}`,
        text: view === 'kanban' ? 'Kanban' : 'Lista',
        attrs: { type: 'button', 'data-view': view, 'aria-pressed': String(state.view === view) },
      });
      button.addEventListener('click', () => {
        state.view = view;
        renderAll(renderToken);
      });
      toolbar.appendChild(button);
    }

    const search = el(doc, 'input', {
      attrs: {
        type: 'search', placeholder: 'Cerca offerta o cliente',
        'aria-label': 'Cerca offerta o cliente', 'data-filter': 'q', value: state.q,
      },
    });
    search.value = state.q;
    search.addEventListener('input', () => {
      state.q = String(search.value ?? '');
      const cursor = typeof search.selectionStart === 'number' ? search.selectionStart : search.value.length;
      renderAll(renderToken);
      // The toolbar is rebuilt on every keystroke: hand focus back to the
      // new search input so typing is not interrupted after one character.
      // mount is a real Element in production (no findAll — that exists only
      // on the fake-dom test double), so query the real DOM API with a guard.
      const next = typeof mount.querySelector === 'function'
        ? mount.querySelector('input[data-filter="q"]')
        : null;
      if (next) {
        if (typeof next.focus === 'function') next.focus();
        try {
          if (typeof next.setSelectionRange === 'function') next.setSelectionRange(cursor, cursor);
        } catch {
          // Non-text inputs or test doubles: caret restore is best-effort.
        }
      }
    });
    toolbar.appendChild(search);

    // BO-F6-10 C8: the three prototype pills — `Referente Tutti`,
    // `Creata Sempre`, `Stati Tutti` — with the check on the active voice.
    const owners = [...new Set(onBoard.map((record) => record.owner).filter((owner) => typeof owner === 'string' && owner))].sort();
    toolbar.appendChild(renderFilterMenu({
      key: 'owner',
      label: 'Referente',
      valueText: state.owner || 'Tutti',
      filterLabel: 'Filtra per referente',
      current: state.owner,
      voices: [{ value: '', title: 'Tutti' }, ...owners.map((owner) => ({ value: owner, title: owner }))],
      onPick: (picked) => { state.owner = picked; },
    }));
    toolbar.appendChild(renderFilterMenu({
      key: 'created',
      label: 'Creata',
      valueText: (CREATED_OPTIONS.find((option) => option.value === state.created) ?? CREATED_OPTIONS[0]).label,
      filterLabel: 'Filtra per data di creazione',
      current: state.created,
      voices: CREATED_OPTIONS.map((option) => ({ value: option.value, title: option.label })),
      onPick: (picked) => { state.created = picked; },
    }));
    toolbar.appendChild(renderFilterMenu({
      key: 'stage',
      label: 'Stati',
      valueText: pipeline.stages.find((stage) => stage.key === state.stage)?.label
        ?? pipeline.stages.find((stage) => stage.key === state.stage)?.key
        ?? 'Tutti',
      filterLabel: 'Filtra per stato',
      current: state.stage,
      voices: [{ value: '', title: 'Tutti' }, ...pipeline.stages.map((stage) => ({ value: stage.key, title: stage.label ?? stage.key }))],
      onPick: (picked) => { state.stage = picked; },
    }));

    // BO-F6-10 C11: `Azzera filtri` exists only while a filter or search is
    // active, so the toolbar never offers a no-op reset.
    if (state.q || state.owner || state.stage || state.created) {
      const reset = el(doc, 'button', {
        class: 'small secondary', text: 'Azzera filtri',
        attrs: { type: 'button', 'data-action': 'clear-filters' },
      });
      reset.addEventListener('click', () => {
        state.q = '';
        state.owner = '';
        state.stage = '';
        state.created = '';
        renderAll(renderToken);
      });
      toolbar.appendChild(reset);
    }

    return toolbar;
  }

  /** Count + per-currency totals over the filtered set (currencies never summed). */
  /**
   * Off-pipeline disclosure: records of other pipelines are excluded by
   * documented behavior, never silently hidden. The count names offers —
   * the page is the offers board, and the summary beside it counts the
   * shown cards — and every other pipeline with a routable name gets a
   * link to its own board, so the operator can go see them. A key outside
   * the route grammar cannot be linked: it stays in the count, never in
   * an href. Every value renders as text, never HTML.
   * @param {Array<Record<string, any>>} records
   */
  function renderOffPipelineNote(records, pipelineName, offPipeline) {
    const one = offPipeline === 1;
    const note = el(doc, 'p', { class: 'hint' });
    note.textContent = `${offPipeline} offert${one ? 'a' : 'e'} di ${one ? "un'altra" : 'altre'} pipeline (non mostrat${one ? 'a' : 'e'}).`;
    const others = [...new Set(records.map((record) => (typeof record?.pipelineKey === 'string' ? record.pipelineKey : '')))]
      .filter((key) => key !== pipelineName && /^[a-z][a-z0-9-]*$/.test(key))
      .sort();
    others.forEach((key, index) => {
      note.appendChild(el(doc, 'span', { text: index === 0 ? ' ' : ' · ' }));
      const link = el(doc, 'a', { attrs: { href: `#/pipelines/${encodeURIComponent(key)}` } });
      link.textContent = `Vedi ${key}`;
      note.appendChild(link);
    });
    return note;
  }

  function renderSummary(visible) {
    const summary = el(doc, 'p', { class: 'pipeline-summary', attrs: { 'data-summary': String(visible.length) } });
    const totals = new Map();
    for (const record of visible) {
      if (!Number.isSafeInteger(record.valueCents)) continue;
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.valueCents);
    }
    // BO-F6-10 C9: `<n> offerte · <totale>`, updated by every filter/search.
    const parts = [`${visible.length} offert${visible.length === 1 ? 'a' : 'e'}`];
    for (const [currency, total] of [...totals.entries()].sort()) {
      parts.push(formatAmount(total, currency));
    }
    summary.textContent = parts.join(' · ');
    return summary;
  }

  /**
   * Forecast over the filtered set (C4/C5): won and paid records at face
   * value plus 60% of the open ones, per currency — currencies are never
   * summed. The risk line names the owner or customer of the highest-value
   * open offer. Labeled as a stima, never a commitment. Class hooks
   * (`pipeline-forecast`, `forecast-total`) are unchanged: the supervisor
   * owns the visual dress (ANSWER 28/10).
   */
  function renderForecast(pipeline, visible) {
    const box = el(doc, 'div', { class: 'pipeline-forecast', attrs: { 'data-forecast': 'estimate' } });
    box.appendChild(el(doc, 'h3', { text: `✦ Previsione di ${MONTHS_IT[new Date().getMonth()]}` }));
    const closedKeys = new Set(
      pipeline.stages.filter((stage) => stage.type === 'won' || stage.type === 'paid').map((stage) => stage.key),
    );
    const openKeys = new Set(pipeline.stages.filter((stage) => stage.type === 'open').map((stage) => stage.key));
    const closed = new Map();
    const waiting = new Map();
    const openCurrencies = new Set();
    let riskiest = null;
    for (const record of visible) {
      if (!Number.isSafeInteger(record.valueCents)) continue;
      if (closedKeys.has(record.pipelineStage)) {
        closed.set(record.currency, (closed.get(record.currency) ?? 0) + record.valueCents);
      } else if (openKeys.has(record.pipelineStage)) {
        waiting.set(record.currency, (waiting.get(record.currency) ?? 0) + record.valueCents);
        openCurrencies.add(record.currency);
        if (!riskiest || record.valueCents > riskiest.valueCents) riskiest = record;
      }
    }
    const total = new Map();
    for (const [currency, amount] of closed.entries()) {
      total.set(currency, (total.get(currency) ?? 0) + amount);
    }
    for (const [currency, amount] of waiting.entries()) {
      total.set(currency, (total.get(currency) ?? 0) + Math.round(amount * 0.6));
    }
    if (!total.size) {
      box.appendChild(el(doc, 'p', { class: 'hint', text: 'Nessuna offerta da stimare — non un impegno.' }));
      return box;
    }
    for (const [currency, amount] of [...total.entries()].sort()) {
      box.appendChild(el(doc, 'p', { class: 'forecast-total', text: formatAmount(amount, currency) }));
    }
    box.appendChild(el(doc, 'p', {
      class: 'hint',
      text: 'Vinte e pagate, più il 60% di quelle in attesa — stima, non un impegno.',
    }));
    // No global ranking across currencies: raw cents are not comparable
    // without exchange rates, so the risk line shows only when every valued
    // open offer shares one currency (Codex P2 on #467).
    const riskName = openCurrencies.size === 1 && typeof riskiest?.owner === 'string' && riskiest.owner
      ? riskiest.owner
      : openCurrencies.size === 1 && typeof riskiest?.companyName === 'string' && riskiest.companyName
        ? riskiest.companyName
        : null;
    if (riskName) {
      box.appendChild(el(doc, 'p', { class: 'hint', text: `Il rischio più alto è ${riskName}.` }));
    }
    return box;
  }

  /**
   * Read-only Lista table over the same filtered records (moves stay on Kanban).
   * Headers follow the prototype order (BO-F6-10 C19); every row shows the
   * state pill with its dot, the value, the stage probability, the expected
   * close, the creation day and the referente (BO-F6-10 C20). Values are set
   * through textContent/setAttribute only, never innerHTML.
   */
  function renderList(pipeline, visible) {
    const wrap = el(doc, 'div', { class: 'pipeline-list', attrs: { 'data-listview': 'records' } });
    const table = el(doc, 'table', { class: 'pipeline-table' });
    const head = el(doc, 'thead');
    const headRow = el(doc, 'tr');
    for (const label of ['Offerta', 'Stato', 'Valore', 'Probabilità', 'Chiusura', 'Creata', 'Referente']) {
      headRow.appendChild(el(doc, 'th', { text: label }));
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el(doc, 'tbody');
    const stageOf = new Map(pipeline.stages.map((stage) => [stage.key, stage]));
    for (const record of visible) {
      const stage = stageOf.get(record.pipelineStage);
      const row = el(doc, 'tr', { attrs: { 'data-record': String(record.id) } });
      row.appendChild(el(doc, 'td', { text: String(record.name ?? record.id) }));
      const stateCell = el(doc, 'td');
      stateCell.appendChild(renderStagePill(stage, record.pipelineStage));
      row.appendChild(stateCell);
      row.appendChild(el(doc, 'td', { text: formatAmount(record.valueCents, record.currency) }));
      row.appendChild(el(doc, 'td', { text: probabilityText(stage) }));
      row.appendChild(el(doc, 'td', { text: dayOf(record.expectedCloseDate) ?? '—' }));
      row.appendChild(el(doc, 'td', { text: dayOf(record.createdAt) ?? '—' }));
      row.appendChild(el(doc, 'td', { text: typeof record.owner === 'string' && record.owner ? record.owner : '—' }));
      body.appendChild(row);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    if (!visible.length) {
      wrap.appendChild(el(doc, 'p', { class: 'empty', text: 'Nessuna offerta con questi filtri.' }));
    }
    return wrap;
  }

  /** State pill with its dot (BO-F6-10 C12/C20): the dot color is CSS, the hook is markup. */
  function renderStagePill(stage, stageKey) {
    const pill = el(doc, 'span', { class: 'pill' });
    pill.appendChild(el(doc, 'span', { class: `stage-dot type-${stage?.type ?? 'unknown'}` }));
    pill.appendChild(el(doc, 'span', { text: stage?.label ?? String(stageKey) }));
    return pill;
  }

  /** Stage probability as `NN%`, or an em dash when the stage is unknown. */
  function probabilityText(stage) {
    const probability = stage?.probability;
    if (typeof probability !== 'number' || probability < 0 || probability > 100) return '—';
    return `${probability}%`;
  }

  /**
   * BO-F6-10 C25: the board never paints technical text — no stage keys, no
   * error codes (`SAME_STAGE`), no raw server messages. The technical detail
   * goes to the console only; the DOM gets a friendly Italian line.
   */
  function stageLabel(pipeline, key) {
    return pipeline.stages.find((stage) => stage.key === key)?.label ?? key;
  }

  function moveFailureText(error) {
    const record = error !== null && typeof error === 'object' ? error : {};
    const code = typeof record.code === 'string' ? record.code : '';
    const field = record.details && typeof record.details.field === 'string' ? record.details.field : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[bo] spostamento non riuscito', { code: code || 'UNKNOWN', status: record.status ?? null, message });
    }
    if (code === 'SAME_STAGE') return 'Questa offerta è già in questo stato.';
    if (field === 'reason' || /reason is required/i.test(message)) return "Per segnare un'offerta come persa serve il motivo.";
    return 'Spostamento non riuscito. Riprova più tardi.';
  }

  /** Toggle one hook class on a node without touching its other classes. */
  function toggleHook(node, hook, on) {
    const current = String(node.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const next = on ? [...new Set([...current, hook])] : current.filter((cls) => cls !== hook);
    node.setAttribute('class', next.join(' '));
  }

  /**
   * One stage column: badge-distinguished type (never color alone), count,
   * per-currency totals (currencies are never summed together), cards.
   * Open and terminal columns alike accept drops — the shared handler posts
   * the same move-stage action; drops onto lost reveal the reason input.
   */
  function renderColumn(pipeline, stage, records, token) {
    const column = el(doc, 'div', { class: `pipeline-column type-${stage.type}`, attrs: { 'data-stage': stage.key } });
    const header = el(doc, 'div', { class: 'pipeline-column-header' });
    const badge = stage.type === 'won' ? 'Vinta ✓' : stage.type === 'lost' ? 'Persa ✕' : 'Aperta';
    // BO-F6-10 C12: state dot hook beside the name; the color itself is CSS.
    header.appendChild(el(doc, 'span', { class: `stage-dot type-${stage.type}` }));
    header.appendChild(el(doc, 'h3', { text: stage.label }));
    header.appendChild(el(doc, 'span', { class: `stage-type stage-${stage.type}`, text: badge }));
    header.appendChild(el(doc, 'span', { class: 'stage-count', text: String(records.length), attrs: { 'data-count': stage.key } }));
    column.appendChild(header);

    // Per-currency totals — deliberately one line per currency.
    /** @type {Map<string, number>} */
    const totals = new Map();
    for (const record of records) {
      if (!Number.isSafeInteger(record.valueCents)) continue;
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.valueCents);
    }
    for (const [currency, total] of [...totals.entries()].sort()) {
      column.appendChild(el(doc, 'p', { class: 'stage-total', text: formatAmount(total, currency) }));
    }

    // BO-F6-10 C18: the drop target is marked while a card hovers it, so CSS
    // can paint the dashed outline; the dragged card is attenuated the same way.
    columnNodes.push(column);
    column.addEventListener('dragover', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      toggleHook(column, 'drop-target', true);
    });
    column.addEventListener('dragleave', (event) => {
      // Entering a child card still hovers this column: only a true exit
      // unmarks it, otherwise the marker flickers while crossing children.
      if (event?.relatedTarget && column.contains(event.relatedTarget)) return;
      toggleHook(column, 'drop-target', false);
    });
    column.addEventListener('drop', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      unmarkDropTargets();
      const payload = event?.dataTransfer?.getData?.('text/plain') ?? '';
      void handleDrop(pipeline, stage.key, payload);
    });
    // Test hook: drive a drop without a real DataTransfer.
    column.__drop = (payload) => handleDrop(pipeline, stage.key, payload);

    if (!records.length) {
      column.appendChild(el(doc, 'p', { class: 'empty', text: "Trascina qui un'offerta" }));
      return column;
    }
    for (const record of records) {
      column.appendChild(renderCard(pipeline, stage, record, token));
    }
    return column;
  }

  /** One card: safe minimal summary plus the accessible move control; draggable. */
  function renderCard(pipeline, stage, record, token) {
    const card = el(doc, 'div', {
      class: 'pipeline-card',
      attrs: { 'data-record': String(record.id), draggable: 'true' },
    });
    card.appendChild(el(doc, 'strong', { text: String(record.name ?? record.id) }));
    card.appendChild(el(doc, 'p', { class: 'card-company', text: String(record.companyName ?? record.companyId ?? '—') }));
    card.appendChild(el(doc, 'p', { class: 'card-value', text: formatAmount(record.valueCents, record.currency) }));
    // BO-F6-10 C15: the referente badge shows the initials; the accessible
    // title carries the full name. Class hook unchanged (supervisor owns CSS).
    if (typeof record.owner === 'string' && record.owner) {
      card.appendChild(el(doc, 'p', {
        class: 'card-owner',
        text: ownerInitials(record.owner),
        attrs: { title: record.owner },
      }));
    }
    // BO-F6-10 C13: the close line follows the spec pattern `chiusura <data>`.
    const closeDay = dayOf(record.expectedCloseDate);
    if (closeDay) {
      card.appendChild(el(doc, 'p', { class: 'card-close', text: `chiusura ${closeDay}` }));
    }
    if (stage.type === 'lost' && record.closeReason) {
      card.appendChild(el(doc, 'p', { class: 'card-reason', text: String(record.closeReason) }));
    }
    card.addEventListener('dragstart', (event) => {
      event?.dataTransfer?.setData?.('text/plain', JSON.stringify({ id: record.id, fromStage: stage.key }));
      toggleHook(card, 'dragging', true);
    });
    card.addEventListener('dragend', () => {
      toggleHook(card, 'dragging', false);
      unmarkDropTargets();
    });

    // Terminal stages have no move control (server enforces it regardless).
    if (stage.type !== 'open') return card;

    const controls = el(doc, 'div', { class: 'card-move' });
    const selectId = `move-${record.id}`;
    const label = el(doc, 'label', { text: 'Sposta in', attrs: { for: selectId } });
    const select = el(doc, 'select', { attrs: { id: selectId } });
    for (const target of pipeline.stages) {
      if (target.key === stage.key) continue;
      // Reason for "lost" is collected via prompt-free minimal UX: the lost
      // option is labeled so the requirement is visible; the reason input
      // appears when selected.
      select.appendChild(el(doc, 'option', { text: target.label, attrs: { value: target.key } }));
    }
    const reasonInput = el(doc, 'input', {
      class: 'hidden',
      attrs: { type: 'text', placeholder: 'Motivo (obbligatorio per la perdita)', 'aria-label': 'Motivo di chiusura' },
    });
    const lostStage = pipeline.stages.find((candidate) => candidate.type === 'lost');
    select.addEventListener('change', () => {
      const isLost = lostStage && select.value === lostStage.key;
      reasonInput.setAttribute('class', isLost ? '' : 'hidden');
    });
    const moveButton = el(doc, 'button', { class: 'small primary', text: 'Sposta', attrs: { type: 'button' } });
    const errorNode = el(doc, 'small', { class: 'field-error hidden' });
    let busy = false;
    const submit = async () => {
      if (busy) return;
      busy = true;
      moveButton.disabled = true;
      moveButton.setAttribute('aria-busy', 'true');
      errorNode.textContent = '';
      errorNode.setAttribute('class', 'field-error hidden');
      try {
        const reason = lostStage && select.value === lostStage.key && reasonInput.value
          ? reasonInput.value
          : undefined;
        await postMove(pipeline, record.id, stage.key, select.value, reason);
        toast(`Spostata in ${stageLabel(pipeline, select.value)}.`);
        await renderBoard(pipeline.name); // re-render: server state is the truth
      } catch (error) {
        busy = false;
        moveButton.disabled = false;
        moveButton.setAttribute('aria-busy', 'false');
        errorNode.textContent = moveFailureText(error);
        errorNode.setAttribute('class', 'field-error');
      }
    };
    moveButton.addEventListener('click', submit);
    controls.appendChild(label);
    controls.appendChild(select);
    controls.appendChild(reasonInput);
    controls.appendChild(moveButton);
    controls.appendChild(errorNode);
    card.appendChild(controls);
    cardNodes.set(String(record.id), { select, reasonInput, errorNode });
    card.__move = submit; // test hook
    card.__select = select;
    card.__reason = reasonInput;
    return card;
  }

  return { renderBoard };
}
