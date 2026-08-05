// @ts-check

import { formatMinorUnits } from './admin-core.js';

/**
 * Quote builder Admin (ADR-016), built on the ADR-009 override seam: a small
 * focused view because generic action forms cannot browse a catalog. Rules
 * unchanged from the rest of the Admin: every value renders as text (never
 * HTML), the server is authoritative for every amount, controls disable while
 * a request is in flight (no double submit), and a render token discards
 * stale responses. The Admin lists at most {@link LIST_LIMIT} records per
 * collection and says so — a display bound, never a correctness bound.
 */

const LIST_LIMIT = 200;

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createQuoteView({ doc, mount, client, navigate = () => {} }) {
  let renderToken = 0;

  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined) node.textContent = String(text);
    return node;
  };
  const clear = () => {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  };
  const money = (cents, currency) => (typeof cents === 'number' ? formatMinorUnits(cents, currency) : '—');

  async function fetchRows(module, filter) {
    const result = await client.request(`/api/modules/${module}/records?limit=${LIST_LIMIT}`);
    const rows = (result.items ?? []).filter(filter ?? (() => true));
    return { rows, truncated: (result.items ?? []).length >= LIST_LIMIT };
  }

  async function renderQuoteList() {
    const token = ++renderToken;
    clear();
    mount.appendChild(el('h2', 'panel-title', 'Quotes'));
    const status = el('p', 'muted', 'Loading quotes…');
    mount.appendChild(status);
    let schema;
    let quotes;
    let books;
    try {
      schema = await client.request('/api/schema');
      quotes = await fetchRows('quote');
      books = await fetchRows('price-book', (book) => book.active === true);
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = `Could not load quotes: ${error?.message ?? 'request failed'}`;
      return;
    }
    if (token !== renderToken) return;
    if (!schema.commercial) {
      status.textContent = 'Commercial Operations is not enabled in this project.';
      return;
    }
    status.textContent = quotes.truncated ? `Showing the first ${LIST_LIMIT} quotes only.` : `${quotes.rows.length} quote(s).`;

    // Create form: opportunity id + active price book → the server action.
    const form = el('div', 'quote-create');
    form.appendChild(el('h3', undefined, 'New quote'));
    const opportunityInput = el('input');
    opportunityInput.setAttribute('name', 'opportunityId');
    opportunityInput.setAttribute('placeholder', 'Opportunity id');
    const bookSelect = el('select');
    bookSelect.setAttribute('name', 'priceBookId');
    for (const book of books.rows) {
      const option = el('option', undefined, `${book.name} (${book.currency})`);
      option.setAttribute('value', book.id);
      bookSelect.appendChild(option);
      if (bookSelect.value === undefined || bookSelect.value === '') bookSelect.value = book.id;
    }
    const createButton = el('button', undefined, 'Create quote');
    const createError = el('small', 'field-error', '');
    createButton.addEventListener('click', async () => {
      const opportunityId = String(opportunityInput.value ?? '').trim();
      if (!opportunityId) {
        createError.textContent = 'Opportunity id is required';
        return;
      }
      createButton.disabled = true;
      try {
        const created = await client.request(
          `/api/modules/opportunity/records/${encodeURIComponent(opportunityId)}/actions/create-quote`,
          { method: 'POST', body: JSON.stringify({ priceBookId: bookSelect.value }) },
        );
        navigate(`#/quotes/${created.result.quote.id}`);
      } catch (error) {
        createError.textContent = error?.message ?? 'Create failed';
      } finally {
        createButton.disabled = false;
      }
    });
    form.appendChild(opportunityInput);
    form.appendChild(bookSelect);
    form.appendChild(createButton);
    form.appendChild(createError);
    mount.appendChild(form);

    const list = el('div', 'quote-list');
    for (const quote of quotes.rows) {
      const row = el('div', 'quote-row');
      row.setAttribute('data-quote', quote.id);
      const link = el('a', undefined, `${quote.id} — ${quote.status} — ${money(quote.totalCents, quote.currency)}`);
      link.setAttribute('href', `#/quotes/${quote.id}`);
      row.appendChild(link);
      list.appendChild(row);
    }
    mount.appendChild(list);
  }

  async function renderQuoteDetail(quoteId) {
    const token = ++renderToken;
    clear();
    const heading = el('h2', 'panel-title', `Quote ${quoteId}`);
    mount.appendChild(heading);
    const status = el('p', 'muted', 'Loading quote…');
    mount.appendChild(status);
    let schema;
    let quote;
    let lines;
    let entries;
    let versions;
    try {
      schema = await client.request('/api/schema');
      quote = await client.request(`/api/modules/quote/records/${encodeURIComponent(quoteId)}`);
      lines = (await fetchRows('quote-line', (line) => line.quoteId === quote.id && line.removed === false)).rows
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      entries = (await fetchRows('price-book-entry', (entry) => entry.priceBookId === quote.priceBookId && entry.active === true)).rows;
      versions = (await fetchRows('quote-version', (version) => version.quoteId === quote.id)).rows
        .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
    } catch (error) {
      if (token !== renderToken) return;
      status.textContent = `Could not load the quote: ${error?.message ?? 'request failed'}`;
      return;
    }
    if (token !== renderToken) return;
    status.textContent = '';

    const summary = el('div', 'quote-summary');
    summary.setAttribute('data-status', quote.status);
    for (const [label, value] of [
      ['Status', quote.status],
      ['Currency', quote.currency],
      ['Draft revision', quote.draftRevision],
      ['Subtotal', money(quote.subtotalCents, quote.currency)],
      ['Discount', money(quote.discountCents, quote.currency)],
      ['Total', money(quote.totalCents, quote.currency)],
    ]) {
      const row = el('p', 'quote-fact');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined, value ?? '—'));
      summary.appendChild(row);
    }
    summary.appendChild(el('p', 'muted', 'All amounts are server-calculated (1/100 currency units, two decimals).'));
    mount.appendChild(summary);

    const errorLine = el('small', 'field-error', '');
    mount.appendChild(errorLine);
    const busy = [];
    const withBusy = async (fn) => {
      for (const control of busy) control.disabled = true;
      errorLine.textContent = '';
      try {
        await fn();
        await renderQuoteDetail(quoteId); // re-render from server state
      } catch (error) {
        errorLine.textContent = error?.message ?? 'Request failed';
        for (const control of busy) control.disabled = false;
      }
    };
    const act = (action, input) =>
      client.request(`/api/modules/quote/records/${encodeURIComponent(quoteId)}/actions/${action}`, {
        method: 'POST',
        body: JSON.stringify(input),
      });

    // Draft lines with controlled edit/remove.
    const linesPanel = el('div', 'quote-lines');
    linesPanel.appendChild(el('h3', undefined, `Lines (${lines.length})`));
    for (const line of lines) {
      const row = el('div', 'quote-line');
      row.setAttribute('data-line', line.id);
      row.appendChild(el('span', undefined,
        `${line.sku} · ${line.name} · qty ${line.quantity} · list ${money(line.listUnitAmountCents, quote.currency)} · discount ${(line.discountBps / 100).toFixed(2)}% · total ${money(line.lineTotalCents, quote.currency)}`));
      if (quote.status === 'draft') {
        const quantityInput = el('input');
        quantityInput.setAttribute('type', 'number');
        quantityInput.value = String(line.quantity);
        const discountInput = el('input');
        discountInput.setAttribute('type', 'number');
        discountInput.value = String(line.discountBps);
        discountInput.setAttribute('title', 'Discount in basis points: 1000 = 10.00%');
        const updateButton = el('button', undefined, 'Update');
        const removeButton = el('button', undefined, 'Remove');
        busy.push(updateButton, removeButton);
        updateButton.addEventListener('click', () => withBusy(() => act('update-line', {
          lineId: line.id,
          quantity: Number(quantityInput.value),
          discountBps: Number(discountInput.value),
          expectedRevision: quote.draftRevision,
        })));
        removeButton.addEventListener('click', () => withBusy(() => act('remove-line', {
          lineId: line.id,
          expectedRevision: quote.draftRevision,
        })));
        row.appendChild(quantityInput);
        row.appendChild(discountInput);
        row.appendChild(updateButton);
        row.appendChild(removeButton);
        row.__update = () => withBusy(() => act('update-line', { lineId: line.id, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
        row.__quantity = quantityInput;
        row.__discount = discountInput;
      }
      linesPanel.appendChild(row);
    }
    mount.appendChild(linesPanel);

    if (quote.status === 'draft') {
      const addPanel = el('div', 'quote-add-line');
      addPanel.appendChild(el('h3', undefined, 'Add line'));
      const entrySelect = el('select');
      for (const entry of entries) {
        const option = el('option', undefined, `${entry.logicalKey} — ${money(entry.unitAmountCents, entry.currency)} (${entry.pricingMode}${entry.recurringInterval ? `/${entry.recurringInterval}` : ''})`);
        option.setAttribute('value', entry.id);
        entrySelect.appendChild(option);
        if (entrySelect.value === undefined || entrySelect.value === '') entrySelect.value = entry.id;
      }
      const quantityInput = el('input');
      quantityInput.setAttribute('type', 'number');
      quantityInput.value = '1';
      const discountInput = el('input');
      discountInput.setAttribute('type', 'number');
      discountInput.value = '0';
      const hint = el('small', 'muted', 'Discount in basis points (integer 0–10000): 1000 = 10.00%.');
      const addButton = el('button', undefined, 'Add line');
      busy.push(addButton);
      addButton.addEventListener('click', () => withBusy(() => act('add-line', {
        priceBookEntryId: entrySelect.value,
        quantity: Number(quantityInput.value),
        discountBps: Number(discountInput.value),
        expectedRevision: quote.draftRevision,
      })));
      addPanel.appendChild(entrySelect);
      addPanel.appendChild(quantityInput);
      addPanel.appendChild(discountInput);
      addPanel.appendChild(hint);
      addPanel.appendChild(addButton);
      addPanel.__add = () => withBusy(() => act('add-line', { priceBookEntryId: entrySelect.value, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
      addPanel.__entry = entrySelect;
      addPanel.__quantity = quantityInput;
      addPanel.__discountBps = discountInput;
      mount.appendChild(addPanel);

      const submitPanel = el('div', 'quote-submit');
      submitPanel.appendChild(el('h3', undefined, 'Submit for approval'));
      const policySelect = el('select');
      for (const policy of schema.commercial?.discountPolicies ?? []) {
        const option = el('option', undefined, `${policy.label} (v${policy.version})`);
        option.setAttribute('value', `${policy.name}@${policy.version}`);
        policySelect.appendChild(option);
        if (policySelect.value === undefined || policySelect.value === '') policySelect.value = `${policy.name}@${policy.version}`;
      }
      const submitButton = el('button', undefined, 'Submit');
      busy.push(submitButton);
      submitButton.addEventListener('click', () => withBusy(() => {
        const [name, version] = String(policySelect.value).split('@');
        return act('submit', { policy: name, version: Number(version), expectedRevision: quote.draftRevision });
      }));
      submitPanel.appendChild(policySelect);
      submitPanel.appendChild(submitButton);
      submitPanel.__submit = () => withBusy(() => {
        const [name, version] = String(policySelect.value).split('@');
        return act('submit', { policy: name, version: Number(version), expectedRevision: quote.draftRevision });
      });
      mount.appendChild(submitPanel);
    }

    if (quote.status === 'pending_approval') {
      const decidePanel = el('div', 'quote-decide');
      decidePanel.appendChild(el('h3', undefined, 'Pending human approval'));
      decidePanel.appendChild(el('p', 'muted', 'Decisions are made as the local Admin user actor; role enforcement waits for the Production Spine.'));
      const reasonInput = el('input');
      reasonInput.setAttribute('placeholder', 'Decision reason (required to reject)');
      const approveButton = el('button', undefined, 'Approve');
      const rejectButton = el('button', undefined, 'Reject');
      busy.push(approveButton, rejectButton);
      approveButton.addEventListener('click', () => withBusy(() => act('approve', reasonInput.value ? { reason: reasonInput.value } : {})));
      rejectButton.addEventListener('click', () => withBusy(() => act('reject', { reason: reasonInput.value })));
      decidePanel.appendChild(reasonInput);
      decidePanel.appendChild(approveButton);
      decidePanel.appendChild(rejectButton);
      decidePanel.__approve = () => withBusy(() => act('approve', {}));
      decidePanel.__reject = () => withBusy(() => act('reject', { reason: reasonInput.value }));
      decidePanel.__reason = reasonInput;
      mount.appendChild(decidePanel);
    }

    if (quote.status === 'rejected') {
      const revisePanel = el('div', 'quote-revise');
      const reviseButton = el('button', undefined, 'Revise (back to draft)');
      busy.push(reviseButton);
      reviseButton.addEventListener('click', () => withBusy(() => act('revise', {})));
      revisePanel.appendChild(reviseButton);
      revisePanel.__revise = () => withBusy(() => act('revise', {}));
      mount.appendChild(revisePanel);
    }

    if (quote.status === 'approved') {
      mount.appendChild(el('p', 'quote-approved', 'Approved — this quote is read-only in this milestone.'));
    }

    const versionsPanel = el('div', 'quote-versions');
    versionsPanel.appendChild(el('h3', undefined, `Versions (${versions.length})`));
    for (const version of versions) {
      const row = el('div', 'quote-version-row');
      row.setAttribute('data-version', version.id);
      const link = el('a', undefined,
        `v${version.versionNumber} · ${version.policyDecision} · ${version.policy}@${version.policyVersion} · total ${money(version.totalCents, version.currency)}`);
      link.setAttribute('href', `#/modules/quote-version/${version.id}`);
      row.appendChild(link);
      if (version.decisionReason) row.appendChild(el('span', 'muted', ` — ${version.decisionReason}`));
      versionsPanel.appendChild(row);
    }
    mount.appendChild(versionsPanel);
  }

  return { renderQuoteList, renderQuoteDetail };
}
