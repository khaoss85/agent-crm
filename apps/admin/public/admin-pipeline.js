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
// Search, Referente (owner), Stato (pipeline stage) and expected-close date
// bounds filter both views client-side; "Azzera filtri" resets them. The
// summary (count + per-currency totals) and the forecast always describe the
// filtered set. The forecast is a declared heuristic — value weighted by the
// stage probability of open stages — labeled as a stima, never a commitment.
//
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
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/** Day (YYYY-MM-DD) of an ISO timestamp, or null when absent/unparseable. */
function dayOf(value) {
  if (typeof value !== 'string' || !value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * @param {Record<string, any>} record
 * @param {{q: string, owner: string, stage: string, closeFrom: string, closeTo: string}} filters
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
  if (filters.closeFrom || filters.closeTo) {
    const day = dayOf(record.expectedCloseDate);
    if (!day) return false;
    if (filters.closeFrom && day < filters.closeFrom) return false;
    if (filters.closeTo && day > filters.closeTo) return false;
  }
  return true;
}

/**
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, toast?: (message: string, error?: boolean) => void}} deps
 */
export function createPipelineBoard(deps) {
  const { doc, mount } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});

  /** Guard against stale async responses overwriting a newer board. */
  let renderToken = 0;

  /** Toolbar + view state; records are cached so filtering never refetches. */
  const state = { view: 'kanban', q: '', owner: '', stage: '', closeFrom: '', closeTo: '' };
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
      toast(`Spostata in ${toStage}.`);
      await renderBoard(pipeline.name); // re-render: server state is the truth
    } catch (error) {
      toast(error?.message ?? 'Spostamento non riuscito', true);
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
        showMessage(`Pipeline non trovata: ${pipelineName}`);
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
      // or date bound from pipeline A cannot silently empty pipeline B.
      filteredPipeline = pipeline.name;
      state.q = '';
      state.owner = '';
      state.stage = '';
      state.closeFrom = '';
      state.closeTo = '';
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
    // names the routed pipeline. Unknown pipelines still fail honestly in
    // renderBoard (`Pipeline not found`), where the name aids diagnosis.
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Pipeline' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Offerte' }));
    titleBox.appendChild(el(doc, 'p', {
      class: 'lede',
      text: "Apri una card per vedere com'è composta e costruire l'offerta. Trascinala per cambiarne lo stato.",
    }));
    // Honest bounds: the board loads at most BOARD_LIMIT records, and records
    // not on this pipeline are excluded by documented behavior, not hidden.
    if (records.length >= BOARD_LIMIT) {
      titleBox.appendChild(el(doc, 'p', {
        class: 'hint',
        text: `Mostro solo i primi ${BOARD_LIMIT} record — gli altri non sono in questa vista.`,
      }));
    }
    if (offPipeline > 0) {
      titleBox.appendChild(el(doc, 'p', {
        class: 'hint',
        text: `${offPipeline} record non in questa pipeline (non mostrat${offPipeline === 1 ? 'o' : 'i'}).`,
      }));
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

  /** View toggle + search + Referente/Stato/date filters + Azzera filtri. */
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

    const owners = [...new Set(onBoard.map((record) => record.owner).filter((owner) => typeof owner === 'string' && owner))].sort();
    const ownerSelect = el(doc, 'select', { attrs: { 'aria-label': 'Referente', 'data-filter': 'owner' } });
    ownerSelect.appendChild(el(doc, 'option', { text: 'Tutti i referenti', attrs: { value: '' } }));
    for (const owner of owners) {
      const option = el(doc, 'option', { text: owner, attrs: { value: owner } });
      if (owner === state.owner) option.setAttribute('selected', 'selected');
      ownerSelect.appendChild(option);
    }
    ownerSelect.value = state.owner;
    ownerSelect.addEventListener('change', () => {
      state.owner = String(ownerSelect.value ?? '');
      renderAll(renderToken);
    });
    toolbar.appendChild(ownerSelect);

    const stageSelect = el(doc, 'select', { attrs: { 'aria-label': 'Stato', 'data-filter': 'stage' } });
    stageSelect.appendChild(el(doc, 'option', { text: 'Tutti gli stati', attrs: { value: '' } }));
    for (const stage of pipeline.stages) {
      const option = el(doc, 'option', { text: stage.label ?? stage.key, attrs: { value: stage.key } });
      if (stage.key === state.stage) option.setAttribute('selected', 'selected');
      stageSelect.appendChild(option);
    }
    stageSelect.value = state.stage;
    stageSelect.addEventListener('change', () => {
      state.stage = String(stageSelect.value ?? '');
      renderAll(renderToken);
    });
    toolbar.appendChild(stageSelect);

    for (const bound of ['closeFrom', 'closeTo']) {
      const input = el(doc, 'input', {
        attrs: {
          type: 'date',
          'aria-label': bound === 'closeFrom' ? 'Chiusura prevista da' : 'Chiusura prevista a',
          'data-filter': bound,
        },
      });
      input.value = state[bound];
      input.addEventListener('change', () => {
        state[bound] = String(input.value ?? '');
        renderAll(renderToken);
      });
      toolbar.appendChild(input);
    }

    // BO-F6-10 C11: `Azzera filtri` exists only while a filter or search is
    // active, so the toolbar never offers a no-op reset.
    if (state.q || state.owner || state.stage || state.closeFrom || state.closeTo) {
      const reset = el(doc, 'button', {
        class: 'small secondary', text: 'Azzera filtri',
        attrs: { type: 'button', 'data-action': 'clear-filters' },
      });
      reset.addEventListener('click', () => {
        state.q = '';
        state.owner = '';
        state.stage = '';
        state.closeFrom = '';
        state.closeTo = '';
        renderAll(renderToken);
      });
      toolbar.appendChild(reset);
    }

    return toolbar;
  }

  /** Count + per-currency totals over the filtered set (currencies never summed). */
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
   * Heuristic forecast over open stages: value weighted by stage
   * probability, per currency. Labeled as a stima — an estimate from the
   * configured probabilities, never a commitment.
   */
  function renderForecast(pipeline, visible) {
    const box = el(doc, 'div', { class: 'pipeline-forecast', attrs: { 'data-forecast': 'estimate' } });
    box.appendChild(el(doc, 'h3', { text: '✦ Previsione · stima' }));
    const probabilityOf = new Map(pipeline.stages.map((stage) => [stage.key, stage.probability]));
    const openKeys = new Set(pipeline.stages.filter((stage) => stage.type === 'open').map((stage) => stage.key));
    const weighted = new Map();
    for (const record of visible) {
      if (!openKeys.has(record.pipelineStage)) continue;
      if (!Number.isSafeInteger(record.valueCents)) continue;
      const probability = probabilityOf.get(record.pipelineStage);
      if (typeof probability !== 'number' || probability < 0 || probability > 100) continue;
      const share = Math.round((record.valueCents * probability) / 100);
      weighted.set(record.currency, (weighted.get(record.currency) ?? 0) + share);
    }
    if (!weighted.size) {
      box.appendChild(el(doc, 'p', { class: 'hint', text: 'Nessun valore aperto da stimare — stima euristica dalle probabilità di fase, non un impegno.' }));
      return box;
    }
    for (const [currency, total] of [...weighted.entries()].sort()) {
      box.appendChild(el(doc, 'p', { class: 'forecast-total', text: formatAmount(total, currency) }));
    }
    box.appendChild(el(doc, 'p', {
      class: 'hint',
      text: 'Stima euristica dalle probabilità di fase — non un impegno.',
    }));
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
    if (typeof record.owner === 'string' && record.owner) {
      card.appendChild(el(doc, 'p', { class: 'card-owner', text: record.owner }));
    }
    const closeDay = dayOf(record.expectedCloseDate);
    if (closeDay) {
      card.appendChild(el(doc, 'p', { class: 'card-close', text: closeDay }));
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
        toast(`Spostata in ${select.value}.`);
        await renderBoard(pipeline.name); // re-render: server state is the truth
      } catch (error) {
        busy = false;
        moveButton.disabled = false;
        moveButton.setAttribute('aria-busy', 'false');
        errorNode.textContent = error?.message ?? 'Spostamento non riuscito';
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
