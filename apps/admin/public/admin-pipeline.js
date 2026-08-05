// @ts-check

// Pipeline board (ADR-014). Rendered entirely from /api/schema `pipelines`
// metadata plus the target module's list endpoint — no per-pipeline code.
// Every value is inserted through textContent/setAttribute, never innerHTML,
// so hostile stage labels or record names are inert text.

import { formatMinorUnits } from './admin-core.js';

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

/**
 * @param {{doc: Document, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, toast?: (message: string, error?: boolean) => void}} deps
 */
export function createPipelineBoard(deps) {
  const { doc, mount, client } = deps;
  const toast = deps.toast ?? (() => {});

  /** Guard against stale async responses overwriting a newer board. */
  let renderToken = 0;

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
      showMessage(error?.message ?? 'Failed to load the pipeline.', { retry: () => renderBoard(pipelineName) });
      return;
    }
    if (token !== renderToken) return;
    clear();

    const onBoard = records.filter((record) => record.pipelineKey === pipeline.name);
    const panel = el(doc, 'section', { class: 'panel panel-wide pipeline-board-panel' });
    const heading = el(doc, 'div', { class: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { class: 'kicker', text: 'Pipeline' }));
    titleBox.appendChild(el(doc, 'h2', { text: pipeline.label }));
    titleBox.appendChild(el(doc, 'p', {
      class: 'lede',
      text: `${onBoard.length} record${onBoard.length === 1 ? '' : 's'} on this board`,
    }));
    heading.appendChild(titleBox);
    panel.appendChild(heading);

    const board = el(doc, 'div', { class: 'pipeline-board' });
    for (const stage of pipeline.stages) {
      board.appendChild(renderColumn(pipeline, stage, onBoard.filter((record) => record.pipelineStage === stage.key), token));
    }
    panel.appendChild(board);
    mount.appendChild(panel);
    return panel;
  }

  /**
   * One stage column: badge-distinguished type (never color alone), count,
   * per-currency totals (currencies are never summed together), cards.
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

    if (!records.length) {
      column.appendChild(el(doc, 'p', { class: 'empty', text: 'No records.' }));
      return column;
    }
    for (const record of records) {
      column.appendChild(renderCard(pipeline, stage, record, token));
    }
    return column;
  }

  /** One card: safe minimal summary plus the accessible move control. */
  function renderCard(pipeline, stage, record, token) {
    const card = el(doc, 'div', { class: 'pipeline-card', attrs: { 'data-record': String(record.id) } });
    card.appendChild(el(doc, 'strong', { text: String(record.name ?? record.id) }));
    card.appendChild(el(doc, 'p', { class: 'card-company', text: String(record.companyName ?? record.companyId ?? '—') }));
    card.appendChild(el(doc, 'p', { class: 'card-value', text: formatMinorUnits(record.valueCents, record.currency) }));
    if (stage.type === 'lost' && record.closeReason) {
      card.appendChild(el(doc, 'p', { class: 'card-reason', text: String(record.closeReason) }));
    }

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
        const input = { toStage: select.value, fromStage: stage.key };
        if (lostStage && select.value === lostStage.key && reasonInput.value) input.reason = reasonInput.value;
        await client.request(
          `/api/modules/${encodeURIComponent(pipeline.module)}/records/${encodeURIComponent(record.id)}/actions/move-stage`,
          { method: 'POST', body: JSON.stringify(input) },
        );
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
    card.__move = submit; // test hook
    card.__select = select;
    card.__reason = reasonInput;
    return card;
  }

  return { renderBoard };
}
