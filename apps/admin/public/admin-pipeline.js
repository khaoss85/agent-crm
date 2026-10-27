// @ts-check

// Pipeline board (ADR-014) for BO-F2-01. Rendered entirely from /api/schema
// `pipelines` metadata plus the target module's list endpoint — no
// per-pipeline code. Every value is inserted through textContent/setAttribute,
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

import { formatMinorUnits, humanReadError } from './admin-core.js';
import { bindAdminMutations } from './admin-submission.js';

const BOARD_LIMIT = 200;

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {{text?: string, class?: string, attrs?: Record<string, string>}} [options]
 */
function el(doc, tag, options = {}) {
  const node = doc.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text; // safe: text, not HTML
  if (options.class) node.setAttribute('class', options.class);
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  return node;
}

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

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message @param {{retry?: () => void}} [options] */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { class: 'panel' });
    box.appendChild(el(doc, 'p', { class: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { class: 'small secondary', text: 'Retry' });
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
      toast('That card moved meanwhile — the board will refresh.', true);
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
        controls.errorNode.textContent = 'Enter a reason for Lost, then press Move.';
        controls.errorNode.setAttribute('class', 'field-error');
        if (typeof controls.reasonInput.focus === 'function') controls.reasonInput.focus();
      } else {
        toast('Moving to Lost needs a reason — open the card first.', true);
      }
      return;
    }
    try {
      await postMove(pipeline, recordId, fromStage, toStage);
      toast(`Moved to ${toStage}.`);
      await renderBoard(pipeline.name); // re-render: server state is the truth
    } catch (error) {
      toast(error?.message ?? 'Move failed', true);
    }
  }

  /** @param {string} pipelineName */
  async function renderBoard(pipelineName) {
    const token = ++renderToken;
    showMessage('Loading…');
    let pipeline;
    let records;
    try {
      const schema = await client.request('/api/schema');
      if (schema?.pipelineContract !== 1) {
        showMessage('This Admin needs an update to render pipelines.');
        return;
      }
      pipeline = (schema.pipelines ?? []).find((candidate) => candidate.name === pipelineName);
      if (!pipeline) {
        showMessage(`Pipeline not found: ${pipelineName}`);
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
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Pipeline' }));
    titleBox.appendChild(el(doc, 'h2', { text: pipeline.label }));
    titleBox.appendChild(el(doc, 'p', {
      class: 'lede',
      text: `${placed.length} record${placed.length === 1 ? '' : 's'} on this board`,
    }));
    // Honest bounds: the board loads at most BOARD_LIMIT records, and records
    // not on this pipeline are excluded by documented behavior, not hidden.
    if (records.length >= BOARD_LIMIT) {
      titleBox.appendChild(el(doc, 'p', {
        class: 'hint',
        text: `Showing the first ${BOARD_LIMIT} records only — later records are not on this board view.`,
      }));
    }
    if (offPipeline > 0) {
      titleBox.appendChild(el(doc, 'p', {
        class: 'hint',
        text: `${offPipeline} record${offPipeline === 1 ? '' : 's'} not on this pipeline (not shown).`,
      }));
    }
    heading.appendChild(titleBox);
    panel.appendChild(heading);

    panel.appendChild(renderToolbar(pipeline, onBoard));
    panel.appendChild(renderSummary(visible));
    panel.appendChild(renderForecast(pipeline, visible));

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
      drift.appendChild(el(doc, 'h3', { text: `Off-definition (${offDefinition.length})` }));
      drift.appendChild(el(doc, 'p', {
        class: 'hint',
        text: 'These records store a stage key that is not in the current pipeline definition. Stage keys are persistent identifiers: renaming or removing one requires an explicit data migration.',
      }));
      for (const record of offDefinition) {
        const row = el(doc, 'p', { class: 'drift-record' });
        row.appendChild(el(doc, 'strong', { text: String(record.name ?? record.id) }));
        row.appendChild(el(doc, 'span', { text: ` — stored stage: ${String(record.pipelineStage)}` }));
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
        type: 'search', placeholder: 'Search name, company, contact',
        'aria-label': 'Search records', 'data-filter': 'q', value: state.q,
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
    ownerSelect.appendChild(el(doc, 'option', { text: 'All referenti', attrs: { value: '' } }));
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
    stageSelect.appendChild(el(doc, 'option', { text: 'All stati', attrs: { value: '' } }));
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
          'aria-label': bound === 'closeFrom' ? 'Expected close from' : 'Expected close to',
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
    const parts = [`${visible.length} record${visible.length === 1 ? '' : 's'}`];
    for (const [currency, total] of [...totals.entries()].sort()) {
      parts.push(formatMinorUnits(total, currency));
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
    box.appendChild(el(doc, 'h3', { text: 'Forecast · stima' }));
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
      box.appendChild(el(doc, 'p', { class: 'hint', text: 'No open value to forecast — heuristic estimate from stage probabilities, not a commitment.' }));
      return box;
    }
    for (const [currency, total] of [...weighted.entries()].sort()) {
      box.appendChild(el(doc, 'p', { class: 'forecast-total', text: formatMinorUnits(total, currency) }));
    }
    box.appendChild(el(doc, 'p', {
      class: 'hint',
      text: 'Heuristic estimate from stage probabilities — not a commitment.',
    }));
    return box;
  }

  /** Read-only Lista table over the same filtered records (moves stay on Kanban). */
  function renderList(pipeline, visible) {
    const wrap = el(doc, 'div', { class: 'pipeline-list', attrs: { 'data-listview': 'records' } });
    const table = el(doc, 'table', { class: 'pipeline-table' });
    const head = el(doc, 'thead');
    const headRow = el(doc, 'tr');
    for (const label of ['Record', 'Stato', 'Referente', 'Expected close', 'Value']) {
      headRow.appendChild(el(doc, 'th', { text: label }));
    }
    head.appendChild(headRow);
    table.appendChild(head);
    const body = el(doc, 'tbody');
    const stageLabel = new Map(pipeline.stages.map((stage) => [stage.key, stage.label ?? stage.key]));
    for (const record of visible) {
      const row = el(doc, 'tr', { attrs: { 'data-record': String(record.id) } });
      row.appendChild(el(doc, 'td', { text: String(record.name ?? record.id) }));
      row.appendChild(el(doc, 'td', { text: stageLabel.get(record.pipelineStage) ?? String(record.pipelineStage) }));
      row.appendChild(el(doc, 'td', { text: typeof record.owner === 'string' && record.owner ? record.owner : '—' }));
      row.appendChild(el(doc, 'td', { text: dayOf(record.expectedCloseDate) ?? '—' }));
      row.appendChild(el(doc, 'td', { text: formatMinorUnits(record.valueCents, record.currency) }));
      body.appendChild(row);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    if (!visible.length) {
      wrap.appendChild(el(doc, 'p', { class: 'empty', text: 'No records match the current filters.' }));
    }
    return wrap;
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
    const badge = stage.type === 'won' ? 'Won ✓' : stage.type === 'lost' ? 'Lost ✕' : 'Open';
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
      column.appendChild(el(doc, 'p', { class: 'stage-total', text: formatMinorUnits(total, currency) }));
    }

    column.addEventListener('dragover', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
    column.addEventListener('drop', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const payload = event?.dataTransfer?.getData?.('text/plain') ?? '';
      void handleDrop(pipeline, stage.key, payload);
    });
    // Test hook: drive a drop without a real DataTransfer.
    column.__drop = (payload) => handleDrop(pipeline, stage.key, payload);

    if (!records.length) {
      column.appendChild(el(doc, 'p', { class: 'empty', text: 'No records.' }));
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
    card.appendChild(el(doc, 'p', { class: 'card-value', text: formatMinorUnits(record.valueCents, record.currency) }));
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
    });

    // Terminal stages have no move control (server enforces it regardless).
    if (stage.type !== 'open') return card;

    const controls = el(doc, 'div', { class: 'card-move' });
    const selectId = `move-${record.id}`;
    const label = el(doc, 'label', { text: 'Move to', attrs: { for: selectId } });
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
      attrs: { type: 'text', placeholder: 'Reason (required for Lost)', 'aria-label': 'Close reason' },
    });
    const lostStage = pipeline.stages.find((candidate) => candidate.type === 'lost');
    select.addEventListener('change', () => {
      const isLost = lostStage && select.value === lostStage.key;
      reasonInput.setAttribute('class', isLost ? '' : 'hidden');
    });
    const moveButton = el(doc, 'button', { class: 'small primary', text: 'Move', attrs: { type: 'button' } });
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
        toast(`Moved to ${select.value}.`);
        await renderBoard(pipeline.name); // re-render: server state is the truth
      } catch (error) {
        busy = false;
        moveButton.disabled = false;
        moveButton.setAttribute('aria-busy', 'false');
        errorNode.textContent = error?.message ?? 'Move failed';
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
