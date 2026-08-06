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

/** Server-generated evidence blobs; malformed data degrades to empty, never throws. */
function parseJson(text, fallback) {
  if (typeof text !== 'string' || text === '') return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
const parseTotals = (text) => {
  const totals = parseJson(text, {});
  return {
    oneTimeTotal: totals.oneTimeTotal ?? null,
    recurringTotals: Array.isArray(totals.recurringTotals) ? totals.recurringTotals : [],
  };
};
const parseBreakdown = (text) => {
  const breakdown = parseJson(text, {});
  return Array.isArray(breakdown.components) ? breakdown.components : [];
};

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
      const quoteTotals = parseTotals(quote.totalsJson);
      const recurringSummary = quoteTotals.recurringTotals
        .map((group) => `${money(group.netAmountCents, quote.currency)}/${group.intervalCount}${group.interval[0]}`)
        .join(' + ') || 'no recurring';
      const link = el('a', undefined,
        `${quote.id} — ${quote.status} — one-time ${money(quoteTotals.oneTimeTotal?.netAmountCents ?? 0, quote.currency)} · ${recurringSummary}`);
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
      entries = (await fetchRows('offer', (offer) => offer.priceBookId === quote.priceBookId && offer.active === true && offer.quoteEligible === true)).rows;
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
    ]) {
      const row = el('p', 'quote-fact');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined, value ?? '—'));
      summary.appendChild(row);
    }
    mount.appendChild(summary);

    // Grouped totals: the one-time group and each recurring period are shown
    // SEPARATELY — unlike periods are never summed, and no ARR/MRR/TCV is
    // derived (contract term and normalization are not modeled).
    const totals = parseTotals(quote.totalsJson);
    const totalsPanel = el('div', 'quote-totals');
    totalsPanel.setAttribute('data-recurring-groups', String(totals.recurringTotals.length));
    totalsPanel.appendChild(el('h3', undefined, 'Totals by commercial period'));
    const totalRow = (label, group) => {
      const row = el('p', 'quote-total-row');
      row.setAttribute('data-total', label);
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined,
        `${money(group.netAmountCents, group.currency ?? quote.currency)} net (list ${money(group.listAmountCents, group.currency ?? quote.currency)}, discount ${money(group.discountAmountCents, group.currency ?? quote.currency)})`));
      totalsPanel.appendChild(row);
    };
    if (totals.oneTimeTotal) totalRow('One-time', totals.oneTimeTotal);
    for (const group of totals.recurringTotals) {
      totalRow(`Recurring every ${group.intervalCount} ${group.interval}(s)`, group);
    }
    if (!totals.oneTimeTotal && totals.recurringTotals.length === 0) {
      totalsPanel.appendChild(el('p', 'empty', 'No lines yet.'));
    }
    totalsPanel.appendChild(el('p', 'muted', 'All amounts are server-calculated (1/100 currency units, two decimals). Periods are never combined into a single total, and no annualized or contract-value figure is derived (contract term is not modeled).'));
    mount.appendChild(totalsPanel);

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
      row.appendChild(el('span', 'quote-line-head',
        `${line.sku} · ${line.offerName} (rev ${line.offerRevision}) · qty ${line.quantity} · discount ${(line.discountBps / 100).toFixed(2)}% · net ${money(line.netAmountCents, quote.currency)}`));
      // Every price component of the offer, with its tier breakdown.
      const breakdown = parseBreakdown(line.breakdownJson);
      const componentList = el('div', 'quote-components');
      for (const component of breakdown) {
        const recurrence = component.chargeType === 'one_time'
          ? 'one-time'
          : `every ${component.intervalCount} ${component.interval}(s)`;
        const componentRow = el('p', 'quote-component');
        componentRow.setAttribute('data-component', component.componentId ?? component.componentKey ?? '');
        componentRow.textContent =
          `${component.label ?? component.componentKey} · ${component.pricingModel} · ${recurrence} · list ${money(component.listAmountCents, quote.currency)} · net ${money(component.netAmountCents, quote.currency)}`;
        componentList.appendChild(componentRow);
        for (const band of component.tierBreakdown ?? []) {
          const bandRow = el('p', 'quote-tier');
          bandRow.textContent =
            `tier ${band.position}: ${band.from}–${band.to ?? '∞'} · ${band.quantity} × ${money(band.unitAmountCents, quote.currency)}${band.flatAmountCents ? ` + ${money(band.flatAmountCents, quote.currency)} flat` : ''} = ${money(band.amountCents, quote.currency)}`;
          componentList.appendChild(bandRow);
        }
      }
      row.appendChild(componentList);
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
        const option = el('option', undefined, `${entry.name} — ${entry.componentCount} component(s)`);
        option.setAttribute('value', entry.id);
        entrySelect.appendChild(option);
        if (entrySelect.value === undefined || entrySelect.value === '') entrySelect.value = entry.id;
      }
      if (entries.length === 0) addPanel.appendChild(el('p', 'empty', 'No quote-eligible offers in this price book.'));
      const quantityInput = el('input');
      quantityInput.setAttribute('type', 'number');
      quantityInput.value = '1';
      const discountInput = el('input');
      discountInput.setAttribute('type', 'number');
      discountInput.value = '0';
      const hint = el('small', 'muted', 'Quantity applies to per-unit and tiered components; flat fees are charged once. Discount in basis points (integer 0–10000): 1000 = 10.00%.');
      const addButton = el('button', undefined, 'Add line');
      busy.push(addButton);
      addButton.addEventListener('click', () => withBusy(() => act('add-line', {
        offerId: entrySelect.value,
        quantity: Number(quantityInput.value),
        discountBps: Number(discountInput.value),
        expectedRevision: quote.draftRevision,
      })));
      addPanel.appendChild(entrySelect);
      addPanel.appendChild(quantityInput);
      addPanel.appendChild(discountInput);
      addPanel.appendChild(hint);
      addPanel.appendChild(addButton);
      addPanel.__add = () => withBusy(() => act('add-line', { offerId: entrySelect.value, quantity: Number(quantityInput.value), discountBps: Number(discountInput.value), expectedRevision: quote.draftRevision }));
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
      mount.appendChild(el('p', 'quote-approved', 'Approved — the commercial content of this quote is read-only.'));
      await renderSignature({ quote, schema, mount, el, client, withBusy, busy, money });
    }

    const versionsPanel = el('div', 'quote-versions');
    versionsPanel.appendChild(el('h3', undefined, `Versions (${versions.length})`));
    for (const version of versions) {
      const row = el('div', 'quote-version-row');
      row.setAttribute('data-version', version.id);
      const versionTotals = parseTotals(version.totalsJson);
      const periods = [
        `one-time ${money(versionTotals.oneTimeTotal?.netAmountCents ?? 0, version.currency)}`,
        ...versionTotals.recurringTotals.map((group) => `${money(group.netAmountCents, version.currency)} / ${group.intervalCount} ${group.interval}(s)`),
      ].join(' · ');
      const link = el('a', undefined,
        `v${version.versionNumber} · ${version.policyDecision} · ${version.policy}@${version.policyVersion} · ${periods}`);
      link.setAttribute('href', `#/modules/quote-version/${version.id}`);
      row.appendChild(link);
      if (version.decisionReason) row.appendChild(el('span', 'muted', ` — ${version.decisionReason}`));
      versionsPanel.appendChild(row);
    }
    mount.appendChild(versionsPanel);
  }

  /**
   * Signature and Order section (ADR-017), shown only on an approved quote.
   * Everything here is read-only evidence except the single Request signature
   * control, which is an explicit human action with its caveat stated in the
   * UI. No payment, invoice or delivery control exists.
   */
  async function renderSignature({ quote, schema, mount, el, client, withBusy, busy, money }) {
    const panel = el('div', 'quote-signature');
    panel.appendChild(el('h3', undefined, 'Signature'));
    mount.appendChild(panel);
    if (!schema.signature) {
      panel.appendChild(el('p', 'muted', 'Signature is not enabled in this project.'));
      return;
    }
    let envelopes;
    let signers;
    let artifacts;
    let orders;
    let orderTotals;
    try {
      envelopes = (await fetchRows('signature-envelope', (row) => row.quoteId === quote.id)).rows;
      signers = (await fetchRows('signature-signer')).rows;
      artifacts = (await fetchRows('signed-artifact', (row) => row.quoteId === quote.id)).rows;
      orders = (await fetchRows('order', (row) => row.quoteId === quote.id)).rows;
      orderTotals = (await fetchRows('order-total')).rows;
    } catch (error) {
      panel.appendChild(el('p', 'field-error', `Could not load signature state: ${error?.message ?? 'request failed'}`));
      return;
    }
    const envelope = envelopes[0] ?? null;

    if (!envelope) {
      const form = el('div', 'signature-request');
      form.appendChild(el('p', 'muted', 'Sending for signature is a real external side effect: it requires a human user actor. This is a human-actor boundary, not Sales or Legal role enforcement — real roles need the Production Spine.'));
      const providerSelect = el('select');
      for (const provider of schema.signature.providers ?? []) {
        const option = el('option', undefined, `${provider.label} (v${provider.version})`);
        option.setAttribute('value', `${provider.name}@${provider.version}`);
        providerSelect.appendChild(option);
        if (providerSelect.value === undefined || providerSelect.value === '') providerSelect.value = `${provider.name}@${provider.version}`;
      }
      const nameInput = el('input');
      nameInput.setAttribute('name', 'signerName');
      nameInput.setAttribute('placeholder', 'Signer name');
      const emailInput = el('input');
      emailInput.setAttribute('name', 'signerEmail');
      emailInput.setAttribute('placeholder', 'Signer email');
      const roleInput = el('input');
      roleInput.setAttribute('name', 'signerRole');
      roleInput.setAttribute('placeholder', 'Role (optional)');
      const requestButton = el('button', undefined, 'Request signature');
      busy.push(requestButton);
      const request = () => withBusy(() => {
        const [provider, version] = String(providerSelect.value).split('@');
        return client.request(`/api/modules/quote/records/${encodeURIComponent(quote.id)}/actions/request-signature`, {
          method: 'POST',
          body: JSON.stringify({
            quoteVersionId: quote.currentVersionId,
            provider,
            providerVersion: Number(version),
            signers: [{ name: nameInput.value, email: emailInput.value, role: roleInput.value || undefined, order: 1 }],
          }),
        });
      });
      requestButton.addEventListener('click', request);
      for (const control of [providerSelect, nameInput, emailInput, roleInput, requestButton]) form.appendChild(control);
      form.appendChild(el('small', 'muted', 'All signers are required to sign; the declared order is recorded, not sequentially enforced. Signer identity assurance is not claimed.'));
      form.__request = request;
      form.__name = nameInput;
      form.__email = emailInput;
      panel.appendChild(form);
      return;
    }

    const state = el('div', 'signature-envelope');
    state.setAttribute('data-envelope', envelope.id);
    state.setAttribute('data-status', envelope.status);
    for (const [label, value] of [
      ['Status', envelope.status],
      ['Provider', `${envelope.provider} v${envelope.providerVersion}`],
      ['Provider envelope', envelope.providerEnvelopeId ?? '—'],
      ['Document hash', envelope.documentHash],
      ['Document format', envelope.documentFormat],
    ]) {
      const row = el('p', 'signature-fact');
      row.appendChild(el('strong', undefined, `${label}: `));
      row.appendChild(el('span', undefined, String(value ?? '—')));
      state.appendChild(row);
    }
    // Uncertainty is stated, never smoothed over: whether the provider has the
    // envelope is a different fact from whether the local phase failed.
    const TERMINAL = ['completed', 'declined', 'voided'];
    if (envelope.failureCode) {
      const outcome = envelope.failureCode === 'PROVIDER_ENVELOPE_ABSENT'
        ? 'The provider does not have this envelope: it was never accepted. This quote version cannot be sent again in this milestone — its signature request is closed.'
        : envelope.providerEnvelopeId
          ? 'The provider DID accept this envelope; only the local step after it failed. Reconcile to pick the outcome back up.'
          : 'Whether the provider accepted this envelope is UNKNOWN. Reconcile to find out — never request a second signature.';
      state.appendChild(el('p', 'signature-failure', `The ${envelope.failurePhase} phase failed (${envelope.failureCode}). ${outcome}`));
    }
    if (!TERMINAL.includes(envelope.status)) {
      const reconcileButton = el('button', undefined, 'Reconcile with provider');
      busy.push(reconcileButton);
      const reconcile = () => withBusy(() => client.request(`/api/signature/envelopes/${encodeURIComponent(envelope.id)}/reconcile`, { method: 'POST', body: '{}' }));
      reconcileButton.addEventListener('click', reconcile);
      state.appendChild(reconcileButton);
      state.__reconcile = reconcile;
    }
    panel.appendChild(state);

    const signerList = el('div', 'signature-signers');
    for (const signer of signers.filter((row) => row.envelopeId === envelope.id).sort((a, b) => (a.signingOrder ?? 0) - (b.signingOrder ?? 0))) {
      const row = el('p', 'signature-signer');
      row.setAttribute('data-signer', signer.signerKey);
      row.textContent = `${signer.signingOrder}. ${signer.name} <${signer.email}> · ${signer.role} · ${signer.status}`;
      signerList.appendChild(row);
    }
    panel.appendChild(signerList);

    const artifact = artifacts[0] ?? null;
    if (artifact) {
      const evidence = el('div', 'signed-artifact');
      evidence.setAttribute('data-artifact', artifact.id);
      evidence.appendChild(el('h4', undefined, 'Signed artifact evidence'));
      for (const [label, value] of [
        ['Provider artifact', artifact.providerArtifactId ?? '—'],
        ['Document hash', artifact.documentHash],
        ['Artifact hash', artifact.artifactHash ?? '—'],
        ['Type', artifact.mimeType ?? '—'],
        ['Completed at', artifact.completedAt ?? '—'],
        ['Reference', artifact.storageRef ?? '—'],
      ]) {
        const row = el('p', 'artifact-fact');
        row.appendChild(el('strong', undefined, `${label}: `));
        row.appendChild(el('span', undefined, String(value ?? '—')));
        evidence.appendChild(row);
      }
      evidence.appendChild(el('p', 'muted', 'The artifact bytes are held by the provider: this record stores hashes, metadata and a reference. Long-term object-storage durability is not claimed, and this is not a legally qualified signature.'));
      panel.appendChild(evidence);
    }

    const order = orders[0] ?? null;
    if (order) {
      const orderPanel = el('div', 'quote-order');
      orderPanel.setAttribute('data-order', order.id);
      orderPanel.appendChild(el('h3', undefined, 'Order'));
      const idRow = el('p', 'order-fact');
      idRow.appendChild(el('strong', undefined, 'Order: '));
      idRow.appendChild(el('span', undefined, `${order.id} · ${order.status} · accepted ${order.acceptedAt ?? '—'}`));
      orderPanel.appendChild(idRow);
      for (const total of orderTotals.filter((row) => row.orderId === order.id)) {
        const row = el('p', 'order-total');
        row.setAttribute('data-total', total.kind === 'one_time' ? 'One-time' : `Recurring every ${total.intervalCount} ${total.interval}(s)`);
        row.textContent = total.kind === 'one_time'
          ? `One-time: ${money(total.netAmountCents, total.currency)} net`
          : `Recurring every ${total.intervalCount} ${total.interval}(s): ${money(total.netAmountCents, total.currency)} net`;
        orderPanel.appendChild(row);
      }
      orderPanel.appendChild(el('p', 'muted', 'Order figures are copied from the signed quote version and are never recalculated from the current catalog. Periods are never combined, and no annualized or contract-value figure is derived. No billing, invoice, payment or fulfillment state exists in this milestone.'));
      panel.appendChild(orderPanel);
    }
  }

  return { renderQuoteList, renderQuoteDetail };
}
